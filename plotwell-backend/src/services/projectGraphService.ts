import { createClient } from '@supabase/supabase-js';
import { parseScriptContent } from './scriptParsingService';
import { generateSceneId } from './sceneIdentityService';
import { BUCKETS, resolveImageUrls } from './storageService';
import { getLocationIdentityKey } from '../utils/locationIdentity';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DEBUG_AI = process.env.DEBUG_AI === 'true';

/**
 * Project relationship graph.
 *
 * This is NOT a separate data store — it is a read-only projection over the
 * existing project entities and the relationships that already live in the
 * database (FKs / junction tables) or can be derived from the active script.
 * The frontend renders it as an editable mind-map: every node is backed by a
 * real entity and every edge is backed by a real relationship, so the graph
 * "fills itself in" as the project moves through development, script and
 * production.
 *
 * Edge provenance:
 *  - "hard"  → an explicit FK or junction row in the DB.
 *  - "soft"  → derived from the screenplay text (no junction table exists for
 *              character↔scene or story-location↔scene; it lives in the script).
 */

export type GraphNodeType =
  | 'character'
  | 'location'          // story location
  | 'scene'
  | 'beat'
  | 'cast'
  | 'asset'
  | 'crew'
  | 'filming_location'  // production_locations (real-world site)
  | 'shot'              // storyboard_panels
  | 'shoot_day'
  | 'document'
  | 'episode'
  | 'script';

export type GraphEdgeType =
  | 'appears_in'
  | 'located_at'
  | 'plays'
  | 'realized_by'
  | 'uses'
  | 'filmed_at'
  | 'scheduled_on'
  | 'works_on'
  | 'shot_of'
  | 'part_of';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  entityId: string;
  label: string;
  subtitle?: string;
  imageUrl?: string | null;
  meta?: Record<string, any>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  /** Whether this edge is an explicit DB relationship or derived from the script. */
  provenance: 'hard' | 'soft';
}

export interface ProjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Uppercase + trim + strip parentheticals, mirroring scriptParsingService. */
function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Resolve the script whose scenes anchor the graph. Mirrors the priority used by
 * the storyboard/production code so the generated scene hashes line up with
 * production_cast_scenes and production_scene_data.
 */
async function resolveScriptId(
  projectId: string,
  episodeId?: string | null
): Promise<string | null> {
  if (episodeId) {
    const { data: episode } = await supabase
      .from('episodes')
      .select('script_id')
      .eq('id', episodeId)
      .single();
    if (episode?.script_id) return episode.script_id;
  }

  const { data: project } = await supabase
    .from('projects')
    .select('prod_script_id, active_script_id')
    .eq('id', projectId)
    .single();

  if (project?.active_script_id) return project.active_script_id;
  if (project?.prod_script_id) return project.prod_script_id;

  const { data: latest } = await supabase
    .from('scripts')
    .select('id')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return latest?.id ?? null;
}

export async function buildProjectGraph(
  projectId: string,
  episodeId?: string | null
): Promise<ProjectGraph> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();

  const addEdge = (
    source: string,
    target: string,
    type: GraphEdgeType,
    provenance: 'hard' | 'soft' = 'hard'
  ) => {
    const id = `${type}:${source}->${target}`;
    if (edgeKeys.has(id)) return;
    edgeKeys.add(id);
    edges.push({ id, source, target, type, provenance });
  };

  // ── Fetch every entity in parallel ───────────────────────────────────────
  const [
    charactersRes,
    locationsRes,
    beatsRes,
    castRes,
    assetsRes,
    crewRes,
    filmingRes,
    panelsRes,
    documentsRes,
    episodesRes,
    sceneDataRes,
    castScenesRes,
    castDaysRes,
    crewDaysRes,
    breakdownRes,
    epCharsRes,
    epLocsRes,
    epCastRes,
    epCrewRes,
  ] = await Promise.all([
    supabase
      .from('characters')
      .select('id, name, character_type, primary_role, image_url, episode_id, character_images(id, is_primary, image_url, position)')
      .eq('project_id', projectId),
    supabase.from('locations').select('id, name, location_type, story_importance, image_url, episode_id, production_location_id').eq('project_id', projectId),
    supabase.from('beats').select('id, title, act, color, script_id, scene_number, episode_id').eq('project_id', projectId),
    supabase.from('production_cast').select('id, character_name, actor_name, category').eq('project_id', projectId),
    supabase.from('production_assets').select('id, name, department, status').eq('project_id', projectId),
    supabase.from('production_crew').select('id, name, role, department').eq('project_id', projectId),
    supabase.from('production_locations').select('id, name, location_type').eq('project_id', projectId),
    supabase.from('storyboard_panels').select('id, scene_id, scene_heading, panel_number, shot_type, image_url, linked_location_id, linked_character_ids, episode_id').eq('project_id', projectId),
    supabase.from('project_documents').select('id, document_type, title').eq('project_id', projectId),
    supabase.from('episodes').select('id, episode_number, title, script_id').eq('project_id', projectId),
    supabase.from('production_scene_data').select('id, scene_id, scene_number, production_location_id, shoot_date').eq('project_id', projectId),
    supabase.from('production_cast_scenes').select('cast_id, scene_id').eq('project_id', projectId),
    supabase.from('production_cast_days').select('cast_id, shoot_date').eq('project_id', projectId),
    supabase.from('production_crew_days').select('crew_id, shoot_date').eq('project_id', projectId),
    supabase.from('scene_breakdown_items').select('asset_id, production_scene_data!inner(scene_id)').eq('project_id', projectId),
    supabase.from('episode_characters').select('episode_id, character_id'),
    supabase.from('episode_locations').select('episode_id, location_id'),
    supabase.from('episode_cast').select('episode_id, cast_member_id'),
    supabase.from('episode_crew').select('episode_id, crew_member_id'),
  ]);

  const inEpisode = <T extends { episode_id?: string | null }>(rows: T[] | null) =>
    (rows ?? []).filter((r) => !episodeId || !r.episode_id || r.episode_id === episodeId);

  const charactersWithPrimaryImage = inEpisode(charactersRes.data).map((character) => {
    const images = character.character_images ?? [];
    const primaryImage = images.find((image) => image.is_primary)
      ?? [...images].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];

    return {
      ...character,
      image_url: primaryImage?.image_url || character.image_url,
    };
  });

  const [characters, locations] = await Promise.all([
    resolveImageUrls(charactersWithPrimaryImage, [
      { field: 'image_url', bucket: BUCKETS.CHARACTER_IMAGES },
    ]),
    resolveImageUrls(inEpisode(locationsRes.data), [
      { field: 'image_url', bucket: BUCKETS.LOCATION_IMAGES },
    ]),
  ]);
  const beats = inEpisode(beatsRes.data);
  const cast = castRes.data ?? [];
  const assets = assetsRes.data ?? [];
  const crew = crewRes.data ?? [];
  const filmingLocations = filmingRes.data ?? [];
  const panels = inEpisode(panelsRes.data);
  const documents = documentsRes.data ?? [];
  const episodes = (episodesRes.data ?? []).filter((e) => !episodeId || e.id === episodeId);
  const sceneData = sceneDataRes.data ?? [];
  const castScenes = castScenesRes.data ?? [];
  const castDays = castDaysRes.data ?? [];
  const crewDays = crewDaysRes.data ?? [];
  const breakdownItems = breakdownRes.data ?? [];

  // Episode-scoped junction filtering (only keep rows for in-scope episodes)
  const episodeIds = new Set(episodes.map((e) => e.id));
  const epChars = (epCharsRes.data ?? []).filter((r) => episodeIds.has(r.episode_id));
  const epLocs = (epLocsRes.data ?? []).filter((r) => episodeIds.has(r.episode_id));
  const epCast = (epCastRes.data ?? []).filter((r) => episodeIds.has(r.episode_id));
  const epCrew = (epCrewRes.data ?? []).filter((r) => episodeIds.has(r.episode_id));

  // ── Nodes + lookup maps ───────────────────────────────────────────────────
  const characterByName = new Map<string, (typeof characters)[number]>();
  for (const c of characters) {
    nodes.push({
      id: `character:${c.id}`,
      type: 'character',
      entityId: c.id,
      label: c.name,
      subtitle: c.primary_role || c.character_type || undefined,
      imageUrl: c.image_url,
      meta: { characterType: c.character_type },
    });
    const key = normalizeName(c.name);
    if (key && !characterByName.has(key)) characterByName.set(key, c);
  }

  const locationByName = new Map<string, (typeof locations)[number]>();
  const storyLocsByFilming = new Map<string, (typeof locations)[number][]>();
  const locationNodeIdByEntityId = new Map<string, string>();
  const locationRepresentativeByKey = new Map<string, (typeof locations)[number]>();
  for (const l of locations) {
    const key = getLocationIdentityKey(l.name) || l.id;
    let representative = locationRepresentativeByKey.get(key);
    if (!representative) {
      representative = l;
      locationRepresentativeByKey.set(key, l);
      nodes.push({
        id: `location:${l.id}`,
        type: 'location',
        entityId: l.id,
        label: l.name,
        subtitle: l.location_type || undefined,
        imageUrl: l.image_url,
        meta: { storyImportance: l.story_importance },
      });
      if (key) locationByName.set(key, l);
    }

    const representativeNodeId = `location:${representative.id}`;
    locationNodeIdByEntityId.set(l.id, representativeNodeId);
    if (l.production_location_id) {
      const arr = storyLocsByFilming.get(l.production_location_id) ?? [];
      if (!arr.some((location) => location.id === representative!.id)) {
        arr.push(representative);
      }
      storyLocsByFilming.set(l.production_location_id, arr);
      // story location -> filming location (hard FK)
      addEdge(representativeNodeId, `filming_location:${l.production_location_id}`, 'filmed_at');
    }
  }

  for (const b of beats) {
    nodes.push({
      id: `beat:${b.id}`,
      type: 'beat',
      entityId: b.id,
      label: b.title,
      subtitle: b.act || undefined,
      meta: { color: b.color, sceneNumber: b.scene_number, scriptId: b.script_id },
    });
  }

  for (const c of cast) {
    nodes.push({
      id: `cast:${c.id}`,
      type: 'cast',
      entityId: c.id,
      label: c.actor_name || c.character_name,
      subtitle: c.character_name && c.actor_name ? c.character_name : c.category || undefined,
      meta: { category: c.category },
    });
    const charMatch = characterByName.get(normalizeName(c.character_name));
    if (charMatch) addEdge(`cast:${c.id}`, `character:${charMatch.id}`, 'plays');
  }

  for (const a of assets) {
    nodes.push({
      id: `asset:${a.id}`,
      type: 'asset',
      entityId: a.id,
      label: a.name,
      subtitle: a.department || undefined,
      meta: { department: a.department, status: a.status },
    });
  }

  for (const c of crew) {
    nodes.push({
      id: `crew:${c.id}`,
      type: 'crew',
      entityId: c.id,
      label: c.name,
      subtitle: c.role || c.department || undefined,
      meta: { department: c.department },
    });
  }

  for (const f of filmingLocations) {
    nodes.push({
      id: `filming_location:${f.id}`,
      type: 'filming_location',
      entityId: f.id,
      label: f.name,
      subtitle: f.location_type || undefined,
      meta: {},
    });
  }

  for (const d of documents) {
    nodes.push({
      id: `document:${d.id}`,
      type: 'document',
      entityId: d.id,
      label: d.title || d.document_type,
      subtitle: d.document_type || undefined,
      meta: { documentType: d.document_type },
    });
  }

  // Episode nodes + episode junctions (series)
  for (const e of episodes) {
    nodes.push({
      id: `episode:${e.id}`,
      type: 'episode',
      entityId: e.id,
      label: e.title || `Episode ${e.episode_number}`,
      subtitle: `E${e.episode_number}`,
      meta: { episodeNumber: e.episode_number, scriptId: e.script_id },
    });
  }
  for (const r of epChars) addEdge(`episode:${r.episode_id}`, `character:${r.character_id}`, 'part_of');
  for (const r of epLocs) {
    const locationNodeId = locationNodeIdByEntityId.get(r.location_id);
    if (locationNodeId) addEdge(`episode:${r.episode_id}`, locationNodeId, 'part_of');
  }
  for (const r of epCast) addEdge(`episode:${r.episode_id}`, `cast:${r.cast_member_id}`, 'part_of');
  for (const r of epCrew) addEdge(`episode:${r.episode_id}`, `crew:${r.crew_member_id}`, 'part_of');

  // Crew/cast -> shoot day (hard junctions). Shoot days keyed by date.
  const shootDayIds = new Set<string>();
  const ensureShootDay = (date: string | null | undefined): string | null => {
    if (!date) return null;
    const id = `shoot_day:${date}`;
    if (!shootDayIds.has(id)) {
      shootDayIds.add(id);
      nodes.push({
        id,
        type: 'shoot_day',
        entityId: date,
        label: date,
        subtitle: undefined,
        meta: { date },
      });
    }
    return id;
  };
  for (const cd of castDays) {
    const dayId = ensureShootDay(cd.shoot_date);
    if (dayId) addEdge(`cast:${cd.cast_id}`, dayId, 'works_on');
  }
  for (const cd of crewDays) {
    const dayId = ensureShootDay(cd.shoot_date);
    if (dayId) addEdge(`crew:${cd.crew_id}`, dayId, 'works_on');
  }

  // ── Scenes (from the active script) + the relationships anchored on them ──
  const scriptId = await resolveScriptId(projectId, episodeId);
  const sceneIdByHash = new Map<string, string>();       // hash -> scene node id
  const sceneIdByNumber = new Map<number, string>();     // scene_number -> scene node id
  /** hash -> production_scene_data row, for production location/scheduling links. */
  const sceneDataByHash = new Map<string, (typeof sceneData)[number]>();
  for (const sd of sceneData) sceneDataByHash.set(sd.scene_id, sd);

  if (scriptId) {
    // Script root node — every scene hangs off it.
    const scriptNodeId = `script:${scriptId}`;
    nodes.push({
      id: scriptNodeId,
      type: 'script',
      entityId: scriptId,
      label: episodes[0]?.title || 'Script',
      subtitle: undefined,
      meta: {},
    });
    // Link episode(s) to their script
    for (const e of episodes) {
      if (e.script_id === scriptId) addEdge(`episode:${e.id}`, scriptNodeId, 'part_of');
    }

    const { data: script } = await supabase
      .from('scripts')
      .select('content')
      .eq('id', scriptId)
      .single();

    if (script?.content) {
      let scenes: any[] = [];
      try {
        scenes = parseScriptContent(script.content);
      } catch (err) {
        if (DEBUG_AI) console.warn('projectGraph: failed to parse script', err);
      }

      // Panels grouped by scene hash (storyboard "shots")
      const panelsBySceneHash = new Map<string, (typeof panels)[number][]>();
      for (const p of panels) {
        if (!p.scene_id) continue;
        const arr = panelsBySceneHash.get(p.scene_id) ?? [];
        arr.push(p);
        panelsBySceneHash.set(p.scene_id, arr);
      }

      for (const scene of scenes) {
        const hash = generateSceneId({
          scene_number: scene.scene_number,
          heading: scene.heading,
          location: scene.location,
          time_of_day: scene.time_of_day,
          int_ext: scene.int_ext,
          action_content: scene.action_content || '',
          characters: scene.characters || [],
        });
        const nodeId = `scene:${hash}`;
        sceneIdByHash.set(hash, nodeId);
        if (typeof scene.scene_number === 'number') sceneIdByNumber.set(scene.scene_number, nodeId);

        nodes.push({
          id: nodeId,
          type: 'scene',
          entityId: hash,
          label: scene.heading || `Scene ${scene.scene_number}`,
          subtitle: scene.int_ext ? `${scene.int_ext}. ${scene.location || ''}`.trim() : scene.location || undefined,
          meta: { sceneNumber: scene.scene_number, timeOfDay: scene.time_of_day, scriptId },
        });

        // scene -> script (part_of)
        addEdge(nodeId, scriptNodeId, 'part_of');

        // character -> scene (soft, from script text)
        for (const rawName of scene.characters || []) {
          const charMatch = characterByName.get(normalizeName(rawName));
          if (charMatch) addEdge(`character:${charMatch.id}`, nodeId, 'appears_in', 'soft');
        }

        // scene -> story location, hardened by FK where available:
        //   1) storyboard panel.linked_location_id (hard)
        //   2) shared filming location via production (hard)
        //   3) exact script-name match (soft) — only if nothing harder linked
        let locationLinked = false;
        for (const p of panelsBySceneHash.get(hash) ?? []) {
          if (p.linked_location_id) {
            const locationNodeId = locationNodeIdByEntityId.get(p.linked_location_id);
            if (locationNodeId) {
              addEdge(nodeId, locationNodeId, 'located_at');
              locationLinked = true;
            }
          }
        }
        const sd = sceneDataByHash.get(hash);
        if (sd?.production_location_id) {
          // scene -> filming location (hard)
          addEdge(nodeId, `filming_location:${sd.production_location_id}`, 'filmed_at');
          for (const sl of storyLocsByFilming.get(sd.production_location_id) ?? []) {
            const locationNodeId = locationNodeIdByEntityId.get(sl.id);
            if (locationNodeId) addEdge(nodeId, locationNodeId, 'located_at');
            locationLinked = true;
          }
        }
        if (!locationLinked) {
          const match = locationByName.get(getLocationIdentityKey(scene.location));
          if (match) addEdge(nodeId, `location:${match.id}`, 'located_at', 'soft');
        }

        // scene -> shoot day (hard, via production scene data)
        if (sd?.shoot_date) {
          const dayId = ensureShootDay(sd.shoot_date);
          if (dayId) addEdge(nodeId, dayId, 'scheduled_on');
        }
      }

      // Storyboard panels (shots) — nodes + hard links to scene/location/character
      for (const p of panels) {
        const shotId = `shot:${p.id}`;
        nodes.push({
          id: shotId,
          type: 'shot',
          entityId: p.id,
          label: p.scene_heading ? `${p.scene_heading} #${p.panel_number}` : `Shot ${p.panel_number}`,
          subtitle: p.shot_type || undefined,
          imageUrl: p.image_url,
          meta: { panelNumber: p.panel_number, sceneId: p.scene_id },
        });
        const sceneNodeId = p.scene_id ? sceneIdByHash.get(p.scene_id) : undefined;
        if (sceneNodeId) addEdge(shotId, sceneNodeId, 'shot_of');
        if (p.linked_location_id) {
          const locationNodeId = locationNodeIdByEntityId.get(p.linked_location_id);
          if (locationNodeId) addEdge(shotId, locationNodeId, 'located_at');
        }
        for (const cid of (p.linked_character_ids as string[] | null) ?? []) {
          addEdge(shotId, `character:${cid}`, 'appears_in');
        }
      }
    }
  }

  // beat -> scene (hard, conversion link)
  for (const b of beats) {
    if (b.script_id === scriptId && typeof b.scene_number === 'number') {
      const sceneNodeId = sceneIdByNumber.get(b.scene_number);
      if (sceneNodeId) addEdge(`beat:${b.id}`, sceneNodeId, 'realized_by');
    }
  }

  // cast -> scene (hard junction)
  for (const cs of castScenes) {
    const sceneNodeId = sceneIdByHash.get(cs.scene_id);
    if (sceneNodeId) addEdge(`cast:${cs.cast_id}`, sceneNodeId, 'appears_in');
  }

  // scene -> asset (hard, scene breakdown items)
  for (const item of breakdownItems) {
    const sceneHash = (item as any).production_scene_data?.scene_id;
    const sceneNodeId = sceneHash ? sceneIdByHash.get(sceneHash) : undefined;
    if (sceneNodeId) addEdge(sceneNodeId, `asset:${item.asset_id}`, 'uses');
  }

  return { nodes, edges };
}
