/**
 * Scene Identity and Matching Service
 *
 * Handles stable scene identification and intelligent matching
 * between script scenes and production data across script revisions.
 */

import crypto from 'crypto';

// =====================================================
// INTERFACES
// =====================================================

export interface SceneData {
  scene_number: number;
  heading: string;
  location: string;
  time_of_day: 'day' | 'night' | 'dawn' | 'dusk' | string;
  int_ext: 'INT' | 'EXT' | string;
  action_content: string;
  characters: string[];
  dialogue_count?: number;
  estimated_pages?: number;
}

export interface ProductionSceneData {
  id: string;
  project_id: string;
  user_id: string;
  script_id: string;
  scene_number: number;
  scene_id: string;
  complexity: 'simple' | 'medium' | 'complex';
  estimated_shoot_days: number;
  budget_estimate: number;
  actual_budget?: number;
  shots: any[];
  production_notes?: string;
  status: 'planning' | 'locked' | 'shooting' | 'completed' | 'archived';
  locked_at?: Date;
  locked_by?: string;
  script_content_hash: string;
  last_synced_at: Date;
  sync_status: 'synced' | 'script_modified' | 'conflict' | 'manual';
  shoot_date?: Date;
  shoot_order?: number;
  created_at: Date;
  updated_at: Date;
}

export interface SceneMatch {
  scriptScene: SceneData;
  productionScene: ProductionSceneData | null;
  matchType: 'exact' | 'fuzzy' | 'new' | 'deleted';
  confidence: number; // 0-1
  changes?: SceneChanges;
}

export interface SceneChanges {
  heading?: { old: string; new: string };
  location?: { old: string; new: string };
  time_of_day?: { old: string; new: string };
  int_ext?: { old: string; new: string };
  characters?: { added: string[]; removed: string[] };
  scene_number?: { old: number; new: number };
  contentHash?: { old: string; new: string };
}

export interface SceneFingerprint {
  heading: string;
  location: string;
  time_of_day: string;
  int_ext: string;
  characters: string[];
  firstLineOfAction: string;
}

// =====================================================
// SCENE IDENTITY FUNCTIONS
// =====================================================

/**
 * Generates a stable scene ID based on content fingerprint
 * This ID should remain the same even if scene numbers change
 */
export function generateSceneId(scene: SceneData): string {
  const fingerprint: SceneFingerprint = {
    heading: scene.heading.trim().toLowerCase(),
    location: scene.location?.trim().toLowerCase() || '',
    time_of_day: scene.time_of_day?.trim().toLowerCase() || '',
    int_ext: scene.int_ext?.trim().toUpperCase() || '',
    characters: scene.characters.map(c => c.trim().toLowerCase()).sort(),
    firstLineOfAction: scene.action_content?.substring(0, 100).trim().toLowerCase() || ''
  };

  const content = JSON.stringify(fingerprint);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generates a hash of scene content for change detection
 * This is more comprehensive than scene_id and changes when content changes
 */
export function generateSceneContentHash(scene: SceneData): string {
  const content = JSON.stringify({
    heading: scene.heading,
    location: scene.location || '',
    time_of_day: scene.time_of_day || '',
    int_ext: scene.int_ext || '',
    characters: scene.characters.sort(),
    action_content: scene.action_content || ''
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generates a version hash for the entire script's scenes
 */
export function generateScriptVersionHash(scenes: SceneData[]): string {
  const content = scenes.map(s => generateSceneContentHash(s)).join('::');
  return crypto.createHash('sha256').update(content).digest('hex');
}

// =====================================================
// SCENE MATCHING FUNCTIONS
// =====================================================

/**
 * Calculates Levenshtein distance between two strings
 * Used for fuzzy matching of scene headings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[len1][len2];
}

/**
 * Calculates similarity score between two strings (0-1)
 */
function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  return 1 - (distance / maxLen);
}

/**
 * Calculates match confidence between a script scene and production scene
 */
function calculateMatchConfidence(
  scriptScene: SceneData,
  productionScene: ProductionSceneData
): number {
  let score = 0;
  let weights = 0;

  // Scene ID match (highest weight)
  const scriptSceneId = generateSceneId(scriptScene);
  if (scriptSceneId === productionScene.scene_id) {
    score += 0.5;
  }
  weights += 0.5;

  // Heading similarity (high weight)
  const headingSimilarity = calculateSimilarity(
    scriptScene.heading,
    extractHeadingFromProduction(productionScene)
  );
  score += headingSimilarity * 0.3;
  weights += 0.3;

  // Location match (medium weight)
  if (scriptScene.location?.toLowerCase() === extractLocationFromProduction(productionScene)?.toLowerCase()) {
    score += 0.1;
  }
  weights += 0.1;

  // Scene number proximity (low weight)
  const numberDiff = Math.abs(scriptScene.scene_number - productionScene.scene_number);
  const numberScore = Math.max(0, 1 - (numberDiff / 10)); // Close numbers get higher score
  score += numberScore * 0.1;
  weights += 0.1;

  return weights > 0 ? score / weights : 0;
}

/**
 * Helper to extract heading from production scene
 * (In the linked model, we'll fetch this from script, but for matching we might have it stored)
 */
function extractHeadingFromProduction(productionScene: ProductionSceneData): string {
  // In the new model, we'd fetch from script.scenes, but for matching we can use scene_id
  // For now, return empty and rely on scene_id matching
  return '';
}

/**
 * Helper to extract location from production scene
 */
function extractLocationFromProduction(productionScene: ProductionSceneData): string {
  return '';
}

/**
 * Matches script scenes with production scenes using multiple strategies
 */
export function matchScenes(
  scriptScenes: SceneData[],
  productionScenes: ProductionSceneData[]
): SceneMatch[] {
  const matches: SceneMatch[] = [];
  const unmatchedProduction = new Set(productionScenes.map(p => p.id));

  // Strategy 1: Exact scene_id match
  for (const scriptScene of scriptScenes) {
    const scriptSceneId = generateSceneId(scriptScene);
    const exactMatch = productionScenes.find(p => p.scene_id === scriptSceneId);

    if (exactMatch) {
      unmatchedProduction.delete(exactMatch.id);
      matches.push({
        scriptScene,
        productionScene: exactMatch,
        matchType: 'exact',
        confidence: 1.0,
        changes: detectChanges(scriptScene, exactMatch)
      });
    } else {
      // Strategy 2: Fuzzy matching by heading and location
      let bestMatch: ProductionSceneData | null = null;
      let bestConfidence = 0;

      for (const prodScene of productionScenes) {
        if (unmatchedProduction.has(prodScene.id)) {
          const confidence = calculateMatchConfidence(scriptScene, prodScene);
          if (confidence > bestConfidence && confidence > 0.6) { // Threshold for fuzzy match
            bestMatch = prodScene;
            bestConfidence = confidence;
          }
        }
      }

      if (bestMatch) {
        unmatchedProduction.delete(bestMatch.id);
        matches.push({
          scriptScene,
          productionScene: bestMatch,
          matchType: 'fuzzy',
          confidence: bestConfidence,
          changes: detectChanges(scriptScene, bestMatch)
        });
      } else {
        // New scene (no match found)
        matches.push({
          scriptScene,
          productionScene: null,
          matchType: 'new',
          confidence: 1.0
        });
      }
    }
  }

  // Strategy 3: Mark deleted scenes (in production but not in script)
  for (const prodScene of productionScenes) {
    if (unmatchedProduction.has(prodScene.id)) {
      matches.push({
        scriptScene: null as any, // Scene deleted from script
        productionScene: prodScene,
        matchType: 'deleted',
        confidence: 1.0
      });
    }
  }

  return matches;
}

/**
 * Detects specific changes between script scene and production scene
 */
export function detectChanges(
  scriptScene: SceneData,
  productionScene: ProductionSceneData
): SceneChanges {
  const changes: SceneChanges = {};
  const newContentHash = generateSceneContentHash(scriptScene);

  // Content hash changed
  if (newContentHash !== productionScene.script_content_hash) {
    changes.contentHash = {
      old: productionScene.script_content_hash,
      new: newContentHash
    };
  }

  // Scene number changed
  if (scriptScene.scene_number !== productionScene.scene_number) {
    changes.scene_number = {
      old: productionScene.scene_number,
      new: scriptScene.scene_number
    };
  }

  // Compare individual fields
  // Note: In the new architecture, we need to fetch the old values from somewhere
  // For now, we'll mark that content has changed if hash differs
  // The actual field-by-field comparison would happen in the sync service

  return Object.keys(changes).length > 0 ? changes : undefined as any;
}

/**
 * Detects character changes between scenes
 */
export function detectCharacterChanges(
  oldCharacters: string[],
  newCharacters: string[]
): { added: string[]; removed: string[] } | undefined {
  const oldSet = new Set(oldCharacters.map(c => c.toLowerCase()));
  const newSet = new Set(newCharacters.map(c => c.toLowerCase()));

  const added = newCharacters.filter(c => !oldSet.has(c.toLowerCase()));
  const removed = oldCharacters.filter(c => !newSet.has(c.toLowerCase()));

  if (added.length === 0 && removed.length === 0) {
    return undefined;
  }

  return { added, removed };
}

/**
 * Determines if a scene change is safe to auto-sync
 */
export function isSafeToAutoSync(changes: SceneChanges | undefined, isLocked: boolean): boolean {
  if (!changes) return true; // No changes
  if (isLocked) return false; // Never auto-sync locked scenes

  // Safe changes that don't affect production planning:
  // - Minor heading updates (typos, formatting)
  // - Character additions (but not removals - might affect budget)
  // - Scene renumbering

  // Not safe:
  // - Location changes (affects schedule, budget, locations)
  // - Time of day changes (affects crew, lighting, schedule)
  // - Major heading changes (might be different scene)
  // - Character removals (affects budget)

  const hasMajorChanges = Boolean(
    changes.location ||
    changes.time_of_day ||
    (changes.characters && changes.characters.removed.length > 0)
  );

  return !hasMajorChanges;
}

// =====================================================
// STORYBOARD SCENE ID SYNC
// =====================================================

/**
 * Syncs storyboard panel scene_ids after script content changes.
 * When a scene heading is renamed, the content-based scene_id hash changes,
 * orphaning storyboard panels linked to the old hash. This function detects
 * orphaned panels and re-links them using heading similarity matching.
 *
 * No-op when there are no panels or no orphans (common case for auto-saves).
 */
export async function syncStoryboardSceneIds(
  projectId: string,
  newScenes: SceneData[],
  supabaseClient: any,
  episodeId?: string | null
): Promise<{ updated: number; orphaned: number }> {
  if (newScenes.length === 0) {
    return { updated: 0, orphaned: 0 };
  }

  // 1. Get all panels' scene info for this project (single query)
  let panelQuery = supabaseClient
    .from('storyboard_panels')
    .select('scene_id, scene_heading, scene_number')
    .eq('project_id', projectId);

  if (episodeId) {
    panelQuery = panelQuery.eq('episode_id', episodeId);
  } else {
    panelQuery = panelQuery.is('episode_id', null);
  }

  const { data: panels } = await panelQuery;

  if (!panels || panels.length === 0) {
    return { updated: 0, orphaned: 0 };
  }

  // 2. Generate new scene IDs from current script content
  const newScenesWithIds = newScenes.map(scene => ({
    scene_id: generateSceneId(scene),
    heading: scene.heading,
    scene_number: scene.scene_number,
  }));

  const newSceneIdSet = new Set(newScenesWithIds.map(s => s.scene_id));

  // 3. Find orphaned panel scene_ids (exist in panels but not in current script)
  const orphanedSceneMap = new Map<string, { heading: string; scene_number: number }>();
  for (const panel of panels) {
    if (panel.scene_id && !newSceneIdSet.has(panel.scene_id) && !orphanedSceneMap.has(panel.scene_id)) {
      orphanedSceneMap.set(panel.scene_id, {
        heading: panel.scene_heading || '',
        scene_number: panel.scene_number || 0,
      });
    }
  }

  if (orphanedSceneMap.size === 0) {
    return { updated: 0, orphaned: 0 };
  }

  // 4. Find new scenes that don't already have panels (candidates for re-linking)
  const existingPanelSceneIds = new Set(
    panels.map((p: any) => p.scene_id).filter(Boolean)
  );
  const candidateScenes = newScenesWithIds.filter(
    s => !existingPanelSceneIds.has(s.scene_id)
  );

  // 5. Fuzzy match each orphan to the best candidate scene
  let updated = 0;
  const claimedSceneIds = new Set<string>();
  const orphanEntries = Array.from(orphanedSceneMap.entries());

  for (const [oldSceneId, oldData] of orphanEntries) {
    let bestMatch: typeof newScenesWithIds[0] | null = null;
    let bestScore = 0;

    for (const candidate of candidateScenes) {
      if (claimedSceneIds.has(candidate.scene_id)) continue;

      // Heading similarity (primary signal)
      const headingSim = calculateSimilarity(oldData.heading, candidate.heading);
      // Scene number proximity (secondary signal)
      const numberDiff = Math.abs(oldData.scene_number - candidate.scene_number);
      const numberSim = Math.max(0, 1 - numberDiff / 10);

      // Weighted: 80% heading, 20% scene number
      const score = headingSim * 0.8 + numberSim * 0.2;

      if (score > bestScore && score > 0.5) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    if (bestMatch) {
      claimedSceneIds.add(bestMatch.scene_id);

      // Update all panels with old scene_id to the new scene_id
      let updateQuery = supabaseClient
        .from('storyboard_panels')
        .update({
          scene_id: bestMatch.scene_id,
          scene_heading: bestMatch.heading,
          scene_number: bestMatch.scene_number,
        })
        .eq('project_id', projectId)
        .eq('scene_id', oldSceneId);

      if (episodeId) {
        updateQuery = updateQuery.eq('episode_id', episodeId);
      } else {
        updateQuery = updateQuery.is('episode_id', null);
      }

      const { error } = await updateQuery;
      if (!error) updated++;
    }
  }

  return { updated, orphaned: orphanedSceneMap.size - updated };
}

// =====================================================
// EXPORT ALL
// =====================================================

export default {
  generateSceneId,
  generateSceneContentHash,
  generateScriptVersionHash,
  matchScenes,
  detectChanges,
  detectCharacterChanges,
  isSafeToAutoSync,
  syncStoryboardSceneIds
};
