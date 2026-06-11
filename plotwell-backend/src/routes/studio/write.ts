/**
 * Studio v2 - Write Phase Stream
 *
 * Agentic screenplay writing endpoint. The AI can read the current script
 * structure and write or rewrite scenes directly into the DB as tool side
 * effects. Each mutation emits an SSE event so the frontend canvas refreshes.
 *
 * Tools: get_script_outline, get_scene_content, write_scene, rewrite_scene,
 *        delete_scene, update_character
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../../middleware/auth';
import { extractUserId, addPricingService, PricingRequest } from '../../middleware/pricingMiddleware';
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { createScriptVersionSnapshot } from '../../services/scriptVersionService';
import { isEpisodic } from '../../utils/projectType';
import {
  applyScriptContentToActiveRoom,
  flushActiveScriptRoomToDatabase,
  getActiveScriptRoomContent,
  hasActiveCollaborationRoom,
} from '../../services/collaborationServer';
import { extractTextFromTipTapJSON } from '../../utils/aiHelpers';
import {
  canonicalizeCharacterName,
  getCharacterIdentityKey,
  normalizeCharacterCue,
} from '../../utils/characterIdentity';
import {
  canonicalizeLocationName,
  getLocationIdentityKey,
  getLocationNameFromSceneHeading,
  parseSceneHeadingIdentity,
} from '../../utils/locationIdentity';
import {
  createPendingToolApprovalStore,
  createToolApprovalId,
  requiresToolApproval,
  toApprovedToolSet,
} from './toolHelpers';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const APPROVAL_REQUIRED_TOOLS = new Set(['rewrite_scene', 'delete_scene']);
const pendingToolApprovals = createPendingToolApprovalStore();

function getToolApprovalSummary(toolName: string, args: Record<string, any>) {
  if (toolName === 'write_scene') {
    return {
      action: 'insert_script',
      title: 'Insert scene',
      description: args.insert_before_scene
        ? `Insert "${args.scene_heading || 'new scene'}" before scene ${args.insert_before_scene}.`
        : `Insert "${args.scene_heading || 'new scene'}" at the end of the script.`,
      primaryLabel: 'Insert',
    };
  }
  if (toolName === 'rewrite_scene') {
    return {
      action: 'edit_script',
      title: 'Edit scene',
      description: `Rewrite scene ${args.scene_number || ''}${args.new_heading ? ` as "${args.new_heading}"` : ''}.`,
      primaryLabel: 'Apply edit',
    };
  }
  if (toolName === 'delete_scene') {
    return {
      action: 'delete_script',
      title: 'Delete scene',
      description: `Delete scene ${args.scene_number || ''} from the script.`,
      primaryLabel: 'Delete',
    };
  }
  return {
    action: 'script_tool',
    title: 'Run tool',
    description: `Run ${toolName}.`,
    primaryLabel: 'Allow',
  };
}

// =============================================================================
// Fountain → TipTap converter
// =============================================================================

/**
 * Parse fountain-formatted screenplay text into TipTap JSON nodes.
 * Handles: scene heading, action, character, dialogue, parenthetical, transition.
 */
function fountainToNodes(heading: string, body: string): any[] {
  const nodes: any[] = [];
  const normalizedHeading = parseSceneHeadingIdentity(heading)?.heading || heading.trim().toUpperCase();

  nodes.push({
    type: 'sceneHeading',
    content: [{ type: 'text', text: normalizedHeading }],
  });

  const lines = body.split('\n');
  // States: 'action' | 'after_character' | 'dialogue'
  type State = 'action' | 'after_character' | 'dialogue';
  let state: State = 'action';
  let prevBlank = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      if (state === 'dialogue' || state === 'after_character') state = 'action';
      prevBlank = true;
      continue;
    }

    // Transition — detect English standard terms + common Spanish translations,
    // normalising them all to canonical English screenplay form.
    const normalizedTransition = (() => {
      if (line.startsWith('>')) return line.replace(/^>\s*/, '');
      if (/^(FADE OUT|FADE IN|FADE TO|CUT TO|SMASH CUT|MATCH CUT|DISSOLVE TO|IRIS|WIPE TO)[.:]/.test(line)) return line;
      if (line === 'FADE OUT.' || line === 'THE END') return line;
      // Spanish → English
      const clean = line.replace(/[.:\s]+$/, '').toUpperCase();
      const spanishMap: Record<string, string> = {
        'CORTE A': 'CUT TO:', 'CORTE DIRECTO A': 'CUT TO:', 'CORTE': 'CUT TO:',
        'FUNDIDO A NEGRO': 'FADE OUT.', 'FUNDIDO EN NEGRO': 'FADE OUT.', 'FUNDIDO': 'FADE OUT.',
        'FUNDIDO DE ENTRADA': 'FADE IN:', 'FUNDIDO DE APERTURA': 'FADE IN:',
        'ENCADENADO A': 'DISSOLVE TO:', 'FUNDIDO ENCADENADO A': 'DISSOLVE TO:', 'FUNDIDO ENCADENADO': 'DISSOLVE TO:',
        'FIN': 'THE END',
      };
      for (const [es, en] of Object.entries(spanishMap)) {
        if (clean === es) return en;
      }
      return null;
    })();
    if (normalizedTransition !== null) {
      nodes.push({ type: 'transition', content: [{ type: 'text', text: normalizedTransition }] });
      state = 'action';
      prevBlank = false;
      continue;
    }

    // Parenthetical (inside character/dialogue block)
    if (
      (state === 'after_character' || state === 'dialogue') &&
      line.startsWith('(') &&
      line.endsWith(')')
    ) {
      // Strip outer parens — the editor adds them via CSS ::before/::after
      const parenText = line.replace(/^\(/, '').replace(/\)$/, '');
      nodes.push({ type: 'parenthetical', content: [{ type: 'text', text: parenText }] });
      prevBlank = false;
      continue;
    }

    // Dialogue continuation
    if (state === 'after_character') {
      nodes.push({ type: 'dialogue', content: [{ type: 'text', text: line }] });
      state = 'dialogue';
      prevBlank = false;
      continue;
    }

    if (state === 'dialogue') {
      nodes.push({ type: 'dialogue', content: [{ type: 'text', text: line }] });
      prevBlank = false;
      continue;
    }

    // Character cue detection: ALL CAPS, preceded by blank, not a scene heading.
    // A cue may carry an extension — (O.S.), (V.O.), (CONT'D), etc. — which we strip
    // from the name before the ALL-CAPS check.
    const charExt = /\((?:V\.?O\.?|O\.?S\.?|O\.?C\.?|CONT'?D\.?|CONT|SUPER|SUBTITLE|FILTER|PRE-?LAP|MORE)\)$/i;
    const hasCharExt = charExt.test(line);
    const trailingParen = line.match(/\s*\([^)]*\)$/);
    const namePart = trailingParen ? line.slice(0, line.length - trailingParen[0].length).trim() : line;
    const namePartIsCaps = namePart.length > 0 && namePart === namePart.toUpperCase() && /[A-Z]/.test(namePart);
    const isSceneHeading = /^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\s)/i.test(line);
    // Real character cues never end in a period. Sound effects / onomatopoeia
    // (e.g. "CLICK.", "PUM.") are ALL CAPS too, but the trailing period rules them out.
    const endsWithPeriod = /\.$/.test(line);

    if (prevBlank && namePartIsCaps && !isSceneHeading) {
      // A recognised extension (O.S./V.O./CONT'D) is a definitive cue signal, even
      // when the dialogue that follows is itself ALL CAPS (e.g. shouting "¡MIAUUUUU!").
      if (hasCharExt) {
        nodes.push({ type: 'character', content: [{ type: 'text', text: normalizeCharacterCue(line) }] });
        state = 'after_character';
        prevBlank = false;
        continue;
      }

      if (!endsWithPeriod) {
        // Peek: is the next non-blank line dialogue (not ALL CAPS / not a heading)?
        let nextContent = '';
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          if (lines[j].trim()) { nextContent = lines[j].trim(); break; }
        }
        // Treat the next line as dialogue if it isn't ALL CAPS, OR if it reads like
        // spoken text (ends in terminal punctuation / opens with ¡ ¿) — this catches
        // all-caps shouting that would otherwise look like a second cue.
        const nextIsDialogue = nextContent && (
          !(
            nextContent === nextContent.toUpperCase() &&
            /[A-Z]/.test(nextContent) &&
            !/^(INT\.|EXT\.)/i.test(nextContent)
          ) ||
          /[.!?…]$/.test(nextContent) ||
          /^[¡¿]/.test(nextContent)
        );

        if (nextIsDialogue || !nextContent) {
          nodes.push({ type: 'character', content: [{ type: 'text', text: normalizeCharacterCue(line) }] });
          state = 'after_character';
          prevBlank = false;
          continue;
        }
      }
    }

    // Default: action
    nodes.push({ type: 'action', content: [{ type: 'text', text: line }] });
    state = 'action';
    prevBlank = false;
  }

  return nodes;
}

// =============================================================================
// Script helpers
// =============================================================================

interface ScriptInfo {
  scriptId: string;
  content: any;
  nodes: any[];
}

async function getScriptForProject(projectId: string, episodeId?: string): Promise<ScriptInfo | null> {
  let scriptId: string | null = null;

  if (episodeId) {
    const { data: ep } = await supabase.from('episodes').select('script_id').eq('id', episodeId).single();
    scriptId = ep?.script_id || null;
  } else {
    const { data: proj } = await supabase.from('projects').select('prod_script_id, project_type').eq('id', projectId).single();
    scriptId = proj?.prod_script_id || null;
    if (!scriptId && isEpisodic(proj?.project_type)) {
      const { data: seasons } = await supabase
        .from('seasons')
        .select('id, season_number, episodes(id, episode_number, script_id)')
        .eq('project_id', projectId)
        .order('season_number', { ascending: true });
      const firstEpisode = (seasons || [])
        .flatMap((season: any) => season.episodes || [])
        .sort((a: any, b: any) => (a.episode_number || 0) - (b.episode_number || 0))[0];
      scriptId = firstEpisode?.script_id || null;
    }
  }

  if (!scriptId) return null;

  const { data: script } = await supabase.from('scripts').select('id, content').eq('id', scriptId).single();
  if (!script) return null;

  const activeContent = hasActiveCollaborationRoom(projectId, 'script', scriptId)
    ? getActiveScriptRoomContent(projectId, scriptId)
    : null;
  const content = activeContent || script.content || { type: 'doc', content: [] };
  return { scriptId, content, nodes: content.content || [] };
}

async function createPreChangeSnapshot(
  projectId: string,
  scriptId: string,
  userId: string | undefined,
  changeSummary: string
) {
  if (hasActiveCollaborationRoom(projectId, 'script', scriptId)) {
    await flushActiveScriptRoomToDatabase(projectId, scriptId, {
      userId,
      changeSummary,
      createVersion: true,
    });
    return;
  }

  await createScriptVersionSnapshot(supabase, {
    scriptId,
    userId,
    changeSummary,
  });
}

/**
 * Strip empty text nodes from a ProseMirror doc. ProseMirror forbids text nodes with
 * an empty string ("Empty text nodes are not allowed"), and generated scene content
 * can produce them (e.g. an empty heading, a "()" parenthetical, or a ">" transition).
 * Block nodes are allowed to be empty, so we just drop the offending text nodes.
 */
function stripEmptyTextNodes(node: any): any | null {
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'text') {
    return typeof node.text === 'string' && node.text.length > 0 ? node : null;
  }
  if (Array.isArray(node.content)) {
    const content = node.content
      .map(stripEmptyTextNodes)
      .filter((child: any) => child !== null);
    return { ...node, content };
  }
  return node;
}

async function persistScriptContent(
  projectId: string,
  scriptId: string,
  rawContent: any,
  userId: string | undefined,
  changeSummary: string
) {
  const content = stripEmptyTextNodes(rawContent);
  if (hasActiveCollaborationRoom(projectId, 'script', scriptId)) {
    const result = await applyScriptContentToActiveRoom(projectId, scriptId, content, {
      userId,
      changeSummary,
      flush: true,
    });

    if (!result.appliedToRoom) {
      throw new Error(`Could not apply update to active collaboration room for script ${scriptId}`);
    }
    return;
  }

  await supabase
    .from('scripts')
    .update({ content })
    .eq('id', scriptId);
}

/** Returns array of { sceneNumber, heading } for all scene headings in a script. */
function extractSceneOutline(nodes: any[]): { sceneNumber: number; heading: string }[] {
  const outline: { sceneNumber: number; heading: string }[] = [];
  let n = 0;
  for (const node of nodes) {
    if (node.type === 'sceneHeading') {
      n++;
      const text = node.content?.map((c: any) => c.text || '').join('') || '';
      outline.push({ sceneNumber: n, heading: text });
    }
  }
  return outline;
}

/**
 * Extract nodes for scene N (1-based) — from the sceneHeading up to (not
 * including) the next sceneHeading.
 */
function extractSceneNodes(nodes: any[], sceneNumber: number): { startIdx: number; endIdx: number } | null {
  let count = 0;
  let startIdx = -1;

  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].type === 'sceneHeading') {
      count++;
      if (count === sceneNumber) {
        startIdx = i;
        break;
      }
    }
  }

  if (startIdx < 0) return null;

  let endIdx = nodes.length;
  for (let i = startIdx + 1; i < nodes.length; i++) {
    if (nodes[i].type === 'sceneHeading') {
      endIdx = i;
      break;
    }
  }

  return { startIdx, endIdx };
}

function extractCharacterNamesFromNodes(nodes: any[]): string[] {
  const names = new Map<string, string>();

  for (const node of nodes) {
    if (node.type !== 'character') continue;
    const rawName = node.content?.map((c: any) => c.text || '').join('') || '';
    const normalized = canonicalizeCharacterName(rawName);
    if (!normalized) continue;
    names.set(normalized, normalized);
  }

  return Array.from(names.values());
}

async function syncSceneCharacters(
  projectId: string,
  sceneNodes: any[]
): Promise<{ created: Array<{ id: string; name: string }> }> {
  const names = extractCharacterNamesFromNodes(sceneNodes);
  if (names.length === 0) return { created: [] };

  const { data: existingChars } = await supabase
    .from('characters')
    .select('id, name')
    .eq('project_id', projectId);

  const existingNames = new Set(
    (existingChars || []).map((c: any) => getCharacterIdentityKey(c.name)).filter(Boolean)
  );

  const missingNames = names.filter(name => !existingNames.has(getCharacterIdentityKey(name)));
  if (missingNames.length === 0) return { created: [] };

  const rows = missingNames.map(name => ({
    project_id: projectId,
    name,
    description: '',
    primary_role: '',
    character_type: 'minor',
    importance_level: 3,
    status: 'active',
  }));

  const { data, error } = await supabase
    .from('characters')
    .insert(rows)
    .select('id, name');

  if (error) {
    console.error('❌ Studio write: failed to sync script characters:', error);
    return { created: [] };
  }

  return { created: data || [] };
}

async function syncSceneLocations(
  projectId: string,
  sceneNodes: any[]
): Promise<{ created: Array<{ id: string; name: string }> }> {
  const locationNames = new Map<string, string>();
  for (const node of sceneNodes) {
    if (node.type !== 'sceneHeading') continue;
    const headingText = node.content?.map((c: any) => c.text || '').join('') || '';
    const locationName = getLocationNameFromSceneHeading(headingText);
    const key = getLocationIdentityKey(locationName);
    if (locationName && key && !locationNames.has(key)) locationNames.set(key, locationName);
  }
  if (locationNames.size === 0) return { created: [] };

  const { data: existingLocs } = await supabase
    .from('locations')
    .select('id, name')
    .eq('project_id', projectId);

  const existingKeys = new Set(
    (existingLocs || []).map((l: any) => getLocationIdentityKey(l.name)).filter(Boolean)
  );

  const missingNames = Array.from(locationNames.entries())
    .filter(([key]) => !existingKeys.has(key))
    .map(([, name]) => name);
  if (missingNames.length === 0) return { created: [] };

  const rows = missingNames.map(name => ({
    project_id: projectId,
    name,
    description: '',
    location_type: 'both',
  }));

  const { data, error } = await supabase
    .from('locations')
    .insert(rows)
    .select('id, name');

  if (error) {
    console.error('❌ Studio write: failed to sync scene locations:', error);
    return { created: [] };
  }

  return { created: data || [] };
}

// =============================================================================
// Tool definitions
// =============================================================================

const WRITE_TOOLS: { type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }[] = [
  // --- Read tools ---
  {
    type: 'function',
    function: {
      name: 'get_project_context',
      description: 'Get all story context in one call: characters, locations, beat sheet, and available documents (synopsis, treatment, outline). Always call this before writing if you need story details.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_document',
      description: 'Read a specific project document — synopsis, treatment, outline, logline, or notes.',
      parameters: {
        type: 'object',
        properties: {
          document_type: {
            type: 'string',
            enum: ['synopsis', 'treatment', 'outline', 'logline', 'notes', 'character_breakdown'],
            description: 'Type of document to read',
          },
        },
        required: ['document_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_script_outline',
      description: 'Get a numbered list of all scene headings in the script. Call this first to understand the script structure before writing or rewriting.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_scene_content',
      description: 'Get the full text of a specific scene by its number. Use before rewriting to see what is currently there.',
      parameters: {
        type: 'object',
        properties: {
          scene_number: { type: 'integer', description: 'The 1-based scene number from get_script_outline' },
        },
        required: ['scene_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_scene',
      description: 'Write a new scene and insert it into the script. Use Fountain format for content (action lines, CHARACTER NAME lines, dialogue). Do NOT include the scene heading in the content — pass it separately as scene_heading.',
      parameters: {
        type: 'object',
        properties: {
          scene_heading: {
            type: 'string',
            description: 'Scene heading, e.g. "INT. COFFEE SHOP - DAY"',
          },
          content: {
            type: 'string',
            description: 'Scene body in Fountain format. Action lines, CHARACTER NAME (all caps) followed by dialogue. Do NOT include the scene heading here.',
          },
          insert_before_scene: {
            type: 'integer',
            description: 'Insert before this 1-based scene number. Omit to append at end.',
          },
        },
        required: ['scene_heading', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rewrite_scene',
      description: 'Replace the content of an existing scene. Provide the full new scene body in Fountain format. The scene heading stays unchanged unless you pass a new one.',
      parameters: {
        type: 'object',
        properties: {
          scene_number: { type: 'integer', description: 'The 1-based scene number to rewrite' },
          content: {
            type: 'string',
            description: 'Full new scene body in Fountain format (no scene heading — that is preserved unless you also pass new_heading)',
          },
          new_heading: {
            type: 'string',
            description: 'Optional: new scene heading. If omitted, the existing heading is kept.',
          },
        },
        required: ['scene_number', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_scene',
      description: 'Delete a scene from the script by its number.',
      parameters: {
        type: 'object',
        properties: {
          scene_number: { type: 'integer', description: 'The 1-based scene number to delete' },
        },
        required: ['scene_number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_character',
      description: 'Update a character\'s description or notes in the project. Only use this if the character already exists.',
      parameters: {
        type: 'object',
        properties: {
          character_name: { type: 'string', description: 'Exact character name' },
          description: { type: 'string', description: 'New description' },
        },
        required: ['character_name', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_location',
      description: 'Create a new location in the project. Use this when the user asks to add a location that does not exist yet.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Location name in all caps (e.g. COFFEE SHOP, CLARA\'S APARTMENT)' },
          description: { type: 'string', description: 'Brief location description' },
          location_type: {
            type: 'string',
            enum: ['interior', 'exterior', 'both'],
            description: 'INT, EXT, or both',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_character',
      description: 'Create a new character in the project. Use this when the user asks to add a character that does not exist yet.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Character name (e.g. CHICO X, DETECTIVE HAYES)' },
          description: { type: 'string', description: 'Brief character description' },
          primary_role: { type: 'string', description: 'Their role in the story (e.g. protagonist, antagonist, supporting, secondary)' },
          character_type: {
            type: 'string',
            enum: ['main', 'minor', 'ensemble', 'background'],
            description: 'Character tier',
          },
        },
        required: ['name'],
      },
    },
  },
];

// =============================================================================
// System prompt
// =============================================================================

const LANGUAGE_NAMES: Record<string, string> = {
  'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
  'it': 'Italian', 'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese',
  'zh': 'Chinese', 'hi': 'Hindi', 'ar': 'Arabic', 'ko': 'Korean',
};

function buildWritePrompt(contentLanguage: string): string {
  const langName = LANGUAGE_NAMES[contentLanguage] || 'English';
  return `You are a screenplay writing agent. You READ and WRITE the actual script — not just suggest changes.

## SCREENPLAY LANGUAGE
ALL screenplay content — action lines, character names, dialogue, parentheticals — MUST be written in ${langName}.
This is non-negotiable regardless of what language the user writes to you in.

EXCEPTION — Format keywords are ALWAYS in English, regardless of language:
- Scene heading prefixes: INT., EXT., INT./EXT., I/E
- Transitions: CUT TO:, FADE IN:, FADE OUT., FADE TO:, SMASH CUT TO:, DISSOLVE TO:, THE END
- NEVER translate these (not "CORTE A:", not "FUNDIDO A NEGRO", etc.)

Your conversational replies to the user can match the language they write in.

## YOUR JOB
- Read project context and the script structure before writing
- Write new scenes or rewrite existing ones using tools
- Every scene must have proper screenplay format: scene heading, action, dialogue
- Use Fountain format in your content arguments: ALL CAPS for character names, regular text for action, dialogue on the next line after the character name

## TOOL USAGE — READ FIRST, THEN WRITE
1. get_project_context — ALWAYS call this first if you need character details, locations, beat sheet, or a list of available documents
2. get_document("synopsis") — call to read the synopsis; similarly for treatment, outline, logline
3. get_script_outline — call to see existing scene numbers and headings before writing
4. get_scene_content — call to read a specific scene before rewriting it
5. write_scene — adds a NEW scene (pass scene_heading separately, NOT in content)
6. rewrite_scene — replaces an EXISTING scene's content
7. delete_scene — removes a scene entirely
8. update_character — updates an existing character's description
9. create_character — creates a new character that doesn't exist yet
10. create_location — creates a new location that doesn't exist yet

**Note**: When you write or rewrite a scene, characters and locations from that scene are automatically registered in the project. You only need to call create_character / create_location explicitly when the user specifically asks to add one without writing a scene.

**If the user asks you to "look at the synopsis", "read the treatment", "check the characters" — call the relevant read tool immediately. Never say you cannot access project documents.**

## TRUTHFUL EDITING RULE
- If the user asks you to correct, change, remove, rewrite, adjust, or update anything in an existing scene, you MUST call tools. Do not only describe the change.
- If the user message includes a "Scene number", first call get_scene_content for that scene, then call rewrite_scene with the complete corrected scene body.
- If you do not have enough information to identify the scene, ask which scene to edit. Do NOT say "corrected", "changed", "updated", "rewritten", or "I fixed it" unless write_scene, rewrite_scene, or delete_scene succeeded.
- If the user is only asking for feedback or discussion, you may answer conversationally, but clearly say it is feedback and not an applied edit.
- A message containing "Discuss with AI", "Discutir con IA", "Selected text", or "Texto seleccionado" is NOT automatically an edit request. Treat it as discussion/feedback unless the user's request explicitly asks you to apply, edit, rewrite, remove, delete, correct, cambiar, corregir, quitar, eliminar, reescribir, or aplicar.
- When giving feedback about text that should be removed, say plainly that the user should remove it, or ask whether they want you to rewrite the full scene. Do NOT say "voy a corregir", "corrijo", "listo", or "corregido" unless a writing tool succeeds.

## FOUNTAIN FORMAT FOR CONTENT
Action lines are plain text.
Character names are ALL CAPS on their own line.
Dialogue is on the line directly after the character name.
Parentheticals are in (parentheses) between character and dialogue.

Example content argument:
"Hayes slams the folder on the desk.

HAYES
(leaning forward)
We have twenty-four hours.

Martinez looks away.

MARTINEZ
That's not enough time.

Hayes grabs his coat."

## RESPONSE STYLE
- For actual edit/write/delete requests: call the tool immediately, then confirm what was written in 1-2 sentences.
- For feedback/discussion requests: answer directly as advice. Do not imply the script changed.
- Your conversational replies can match the user's language — but all screenplay content MUST be in ${langName}.`;
}

// =============================================================================
// Tool executor
// =============================================================================

async function executeWriteTool(
  toolName: string,
  args: Record<string, any>,
  projectId: string,
  userId: string,
  episodeId?: string
): Promise<{
  success: boolean;
  result?: string;
  scriptChanged?: boolean;
  eventType?: string;
  eventData?: any;
  entityEvents?: any[];
  error?: string;
}> {
  try {
    if (toolName === 'get_project_context') {
      // Beats are scoped to the episode for episodic projects (e.g. vertical series)
      // and project-level (episode_id IS NULL) for films. Filter accordingly so the
      // beat sheet actually loads when writing an episode.
      const beatsQuery = supabase
        .from('beats')
        .select('act, beat_type, title, description, order')
        .eq('project_id', projectId)
        .order('order');
      const scopedBeatsQuery = episodeId
        ? beatsQuery.eq('episode_id', episodeId)
        : beatsQuery.is('episode_id', null);

      const [charsRes, locsRes, beatsRes, docsRes] = await Promise.all([
        supabase.from('characters').select('name, description, character_type, primary_role, age').eq('project_id', projectId),
        supabase.from('locations').select('name, description, location_type').eq('project_id', projectId),
        scopedBeatsQuery,
        supabase.from('project_documents').select('title, document_type').eq('project_id', projectId),
      ]);

      const parts: string[] = [];

      const chars = charsRes.data || [];
      if (chars.length > 0) {
        parts.push(`=== CHARACTERS (${chars.length}) ===\n` + chars.map((c: any) =>
          `- ${c.name}${c.primary_role ? ` (${c.primary_role})` : ''}${c.character_type ? ` [${c.character_type}]` : ''}${c.age ? `, age ${c.age}` : ''}: ${c.description || ''}`
        ).join('\n'));
      } else {
        parts.push('No characters defined yet.');
      }

      const locs = locsRes.data || [];
      if (locs.length > 0) {
        parts.push(`=== LOCATIONS (${locs.length}) ===\n` + locs.map((l: any) =>
          `- ${l.name}${l.location_type ? ` (${l.location_type})` : ''}: ${l.description || ''}`
        ).join('\n'));
      }

      const beats = beatsRes.data || [];
      if (beats.length > 0) {
        parts.push(`=== BEAT SHEET ===\n` + beats.map((b: any) =>
          `[${b.act || 'Act'}${b.beat_type ? ` - ${b.beat_type}` : ''}] ${b.title}: ${b.description || ''}`
        ).join('\n'));
      }

      const docs = docsRes.data || [];
      if (docs.length > 0) {
        parts.push(`=== DOCUMENTS AVAILABLE ===\n` + docs.map((d: any) =>
          `- ${d.title} (${d.document_type}) — use get_document("${d.document_type}") to read it`
        ).join('\n'));
      }

      return { success: true, result: parts.join('\n\n') || 'No project context found yet.' };
    }

    if (toolName === 'get_document') {
      const docType = args.document_type;
      const { data: docs } = await supabase
        .from('project_documents')
        .select('title, content')
        .eq('project_id', projectId)
        .eq('document_type', docType)
        .order('created_at', { ascending: false })
        .limit(1);

      if (!docs || docs.length === 0) {
        return { success: true, result: `No ${docType} document found in this project.` };
      }

      const doc = docs[0];
      const text = doc.content ? extractTextFromTipTapJSON(doc.content) : '';
      return { success: true, result: `=== ${doc.title || docType.toUpperCase()} ===\n${text || 'Empty document.'}` };
    }

    if (toolName === 'get_script_outline') {
      const info = await getScriptForProject(projectId, episodeId);
      if (!info) return { success: true, result: 'No production script found. Ask the user to set a production script in their project first.' };

      const outline = extractSceneOutline(info.nodes);
      if (outline.length === 0) return { success: true, result: 'The script is empty — no scenes yet.' };

      const text = outline.map(s => `${s.sceneNumber}. ${s.heading}`).join('\n');
      return { success: true, result: `Script has ${outline.length} scenes:\n${text}` };
    }

    if (toolName === 'get_scene_content') {
      const info = await getScriptForProject(projectId, episodeId);
      if (!info) return { success: true, result: 'No production script found.' };

      const range = extractSceneNodes(info.nodes, args.scene_number);
      if (!range) return { success: true, result: `Scene ${args.scene_number} not found.` };

      const sceneNodes = info.nodes.slice(range.startIdx, range.endIdx);
      const text = extractTextFromTipTapJSON({ type: 'doc', content: sceneNodes }, 'labeled');
      return { success: true, result: text || 'Scene is empty.' };
    }

    if (toolName === 'write_scene') {
      const info = await getScriptForProject(projectId, episodeId);
      if (!info) return { success: false, error: 'No production script found. The user needs to set a production script.' };

      const newNodes = fountainToNodes(args.scene_heading, args.content || '');
      const [syncedCharacters, syncedLocations] = await Promise.all([
        syncSceneCharacters(projectId, newNodes),
        syncSceneLocations(projectId, newNodes),
      ]);
      const insertBefore: number | undefined = args.insert_before_scene;

      let insertIndex = info.nodes.length;

      if (insertBefore && insertBefore >= 1) {
        let sceneCount = 0;
        for (let i = 0; i < info.nodes.length; i++) {
          if (info.nodes[i].type === 'sceneHeading') {
            sceneCount++;
            if (sceneCount === insertBefore) { insertIndex = i; break; }
          }
        }
      }

      const updatedNodes = [...info.nodes];
      updatedNodes.splice(insertIndex, 0, ...newNodes);

      await createPreChangeSnapshot(
        projectId,
        info.scriptId,
        userId,
        `Before AI write scene: ${args.scene_heading}`
      );
      await persistScriptContent(
        projectId,
        info.scriptId,
        { type: 'doc', content: updatedNodes },
        userId,
        `AI write scene: ${args.scene_heading}`
      );

      const posLabel = insertBefore ? `before scene ${insertBefore}` : 'at end';
      const newEntities = syncedCharacters.created.length + syncedLocations.created.length;
      if (DEBUG_AI) console.log(`✅ Studio write: inserted "${args.scene_heading}" ${posLabel} into script ${info.scriptId} (${newEntities} new entities)`);

      return {
        success: true,
        result: `Scene "${args.scene_heading}" written ${posLabel}.` +
          (newEntities > 0
            ? ` Auto-registered ${syncedCharacters.created.length} character(s) and ${syncedLocations.created.length} location(s).`
            : ''),
        scriptChanged: true,
        eventType: 'scene_written',
        eventData: { heading: args.scene_heading, insertBefore, scriptId: info.scriptId },
        entityEvents: [
          ...syncedCharacters.created.map((char: any) => ({
            type: 'character',
            id: char.id,
            name: char.name,
            description: '',
          })),
          ...syncedLocations.created.map((loc: any) => ({
            type: 'location',
            id: loc.id,
            name: loc.name,
            description: '',
          })),
        ],
      };
    }

    if (toolName === 'rewrite_scene') {
      const info = await getScriptForProject(projectId, episodeId);
      if (!info) return { success: false, error: 'No production script found.' };

      const range = extractSceneNodes(info.nodes, args.scene_number);
      if (!range) return { success: false, error: `Scene ${args.scene_number} not found.` };

      // Preserve existing heading unless new_heading provided
      const existingHeadingNode = info.nodes[range.startIdx];
      const existingHeading = existingHeadingNode?.content?.map((c: any) => c.text || '').join('') || '';
      const heading = args.new_heading || existingHeading;

      const newNodes = fountainToNodes(heading, args.content || '');
      const [syncedCharacters, syncedLocations] = await Promise.all([
        syncSceneCharacters(projectId, newNodes),
        syncSceneLocations(projectId, newNodes),
      ]);

      const updatedNodes = [
        ...info.nodes.slice(0, range.startIdx),
        ...newNodes,
        ...info.nodes.slice(range.endIdx),
      ];

      await createPreChangeSnapshot(
        projectId,
        info.scriptId,
        userId,
        `Before AI rewrite scene ${args.scene_number}: ${heading}`
      );
      await persistScriptContent(
        projectId,
        info.scriptId,
        { type: 'doc', content: updatedNodes },
        userId,
        `AI rewrite scene ${args.scene_number}: ${heading}`
      );

      if (DEBUG_AI) console.log(`✅ Studio write: rewrote scene ${args.scene_number} "${heading}" in script ${info.scriptId}`);

      const newEntities = syncedCharacters.created.length + syncedLocations.created.length;
      if (DEBUG_AI) console.log(`✅ Studio write: rewrote scene ${args.scene_number} "${heading}" in script ${info.scriptId} (${newEntities} new entities)`);

      return {
        success: true,
        result: `Scene ${args.scene_number} "${heading}" rewritten.` +
          (newEntities > 0
            ? ` Auto-registered ${syncedCharacters.created.length} character(s) and ${syncedLocations.created.length} location(s).`
            : ''),
        scriptChanged: true,
        eventType: 'scene_rewritten',
        eventData: { sceneNumber: args.scene_number, heading, scriptId: info.scriptId },
        entityEvents: [
          ...syncedCharacters.created.map((char: any) => ({
            type: 'character',
            id: char.id,
            name: char.name,
            description: '',
          })),
          ...syncedLocations.created.map((loc: any) => ({
            type: 'location',
            id: loc.id,
            name: loc.name,
            description: '',
          })),
        ],
      };
    }

    if (toolName === 'delete_scene') {
      const info = await getScriptForProject(projectId, episodeId);
      if (!info) return { success: false, error: 'No production script found.' };

      const range = extractSceneNodes(info.nodes, args.scene_number);
      if (!range) return { success: false, error: `Scene ${args.scene_number} not found.` };

      const deletedHeading = info.nodes[range.startIdx]?.content?.map((c: any) => c.text || '').join('') || '';

      const updatedNodes = [
        ...info.nodes.slice(0, range.startIdx),
        ...info.nodes.slice(range.endIdx),
      ];

      await createPreChangeSnapshot(
        projectId,
        info.scriptId,
        userId,
        `Before AI delete scene ${args.scene_number}: ${deletedHeading}`
      );
      await persistScriptContent(
        projectId,
        info.scriptId,
        { type: 'doc', content: updatedNodes },
        userId,
        `AI delete scene ${args.scene_number}: ${deletedHeading}`
      );

      if (DEBUG_AI) console.log(`✅ Studio write: deleted scene ${args.scene_number} "${deletedHeading}" from script ${info.scriptId}`);

      return {
        success: true,
        result: `Scene ${args.scene_number} "${deletedHeading}" deleted.`,
        scriptChanged: true,
        eventType: 'scene_deleted',
        eventData: { sceneNumber: args.scene_number, heading: deletedHeading, scriptId: info.scriptId },
      };
    }

    if (toolName === 'create_location') {
      const canonicalName = canonicalizeLocationName(args.name);
      if (!canonicalName) {
        return { success: false, error: 'Missing location name.' };
      }

      const { data: existingLocations } = await supabase
        .from('locations')
        .select('id, name')
        .eq('project_id', projectId);
      const requestedKey = getLocationIdentityKey(canonicalName);
      const existing = (existingLocations || []).find(
        (location: any) => getLocationIdentityKey(location.name) === requestedKey
      );

      if (existing) {
        if (args.description) {
          await supabase
            .from('locations')
            .update({ description: args.description })
            .eq('id', existing.id)
            .eq('project_id', projectId);
        }
        return { success: true, result: `Location "${existing.name}" already exists — updated.`, entityEvents: [] };
      }

      const { data: loc, error } = await supabase
        .from('locations')
        .insert({
          project_id: projectId,
          name: canonicalName,
          description: args.description || '',
          location_type: ['interior', 'exterior', 'both'].includes(args.location_type) ? args.location_type : 'both',
        })
        .select('id, name')
        .single();

      if (error || !loc) {
        console.error('❌ Studio write: failed to create location:', error);
        return { success: false, error: error?.message || 'Failed to create location.' };
      }

      if (DEBUG_AI) console.log(`✅ Studio write: created location "${loc.name}" in project ${projectId}`);
      return {
        success: true,
        result: `Location "${loc.name}" created.`,
        entityEvents: [{ type: 'location', id: loc.id, name: loc.name, description: args.description || '' }],
      };
    }

    if (toolName === 'update_character') {
      const requestedKey = getCharacterIdentityKey(args.character_name);
      const { data: characters, error: lookupError } = await supabase
        .from('characters')
        .select('id, name')
        .eq('project_id', projectId);
      if (lookupError) return { success: false, error: lookupError.message };
      const existing = (characters || []).find(
        (character: any) => getCharacterIdentityKey(character.name) === requestedKey
      );
      if (!existing) {
        return { success: false, error: `Character "${args.character_name}" not found. Use create_character instead.` };
      }

      const { data: char, error } = await supabase
        .from('characters')
        .update({ description: args.description })
        .eq('id', existing.id)
        .eq('project_id', projectId)
        .select('id, name')
        .single();

      if (error || !char) return { success: false, error: `Character "${args.character_name}" not found. Use create_character instead.` };

      if (DEBUG_AI) console.log(`✅ Studio write: updated character "${char.name}"`);
      return { success: true, result: `Character "${char.name}" updated.` };
    }

    if (toolName === 'create_character') {
      const canonicalName = canonicalizeCharacterName(args.name);
      if (!canonicalName) {
        return { success: false, error: 'Missing character name.' };
      }

      const { data: existingCharacters } = await supabase
        .from('characters')
        .select('id, name')
        .eq('project_id', projectId);
      const requestedKey = getCharacterIdentityKey(canonicalName);
      const existing = (existingCharacters || []).find(
        (character: any) => getCharacterIdentityKey(character.name) === requestedKey
      );

      if (existing) {
        const updateData: Record<string, any> = {};
        if (args.description) updateData.description = args.description;
        if (args.primary_role) updateData.primary_role = args.primary_role;
        if (['main', 'minor', 'ensemble', 'background'].includes(args.character_type)) {
          updateData.character_type = args.character_type;
        }
        if (Object.keys(updateData).length > 0) {
          await supabase.from('characters').update(updateData).eq('id', existing.id);
        }
        return { success: true, result: `Character "${existing.name}" already exists — updated.`, entityEvents: [] };
      }

      const { data: char, error } = await supabase
        .from('characters')
        .insert({
          project_id: projectId,
          name: canonicalName,
          description: args.description || '',
          primary_role: args.primary_role || '',
          character_type: ['main', 'minor', 'ensemble', 'background'].includes(args.character_type) ? args.character_type : 'minor',
          importance_level: args.character_type === 'main' ? 5 : 3,
          status: 'active',
        })
        .select('id, name')
        .single();

      if (error || !char) {
        console.error('❌ Studio write: failed to create character:', error);
        return { success: false, error: error?.message || 'Failed to create character.' };
      }

      if (DEBUG_AI) console.log(`✅ Studio write: created character "${char.name}" in project ${projectId}`);
      return {
        success: true,
        result: `Character "${char.name}" created.`,
        entityEvents: [{ type: 'character', id: char.id, name: char.name, description: args.description || '' }],
      };
    }

    return { success: false, error: `Unknown tool: ${toolName}` };
  } catch (err: any) {
    console.error(`❌ Studio write tool error (${toolName}):`, err);
    return { success: false, error: err.message };
  }
}

// =============================================================================
// Route
// =============================================================================

router.post(
  '/write-stream',
  requireAuth,
  extractUserId,
  addPricingService,
  async (req: PricingRequest, res) => {
    const { projectId, message, history = [], conversationId, episodeId, resume = false, approvedWriteTools = [] } = req.body;
    const userId = req.userId;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });
    if (!message) return res.status(400).json({ error: 'Missing message' });

    const { data: project } = await supabase
      .from('projects')
      .select('id, name, language, content_language')
      .eq('id', projectId)
      .eq('user_id', userId)
      .eq('deleted', false)
      .single();

    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (conversationId) {
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .select('id, project_id')
        .eq('id', conversationId)
        .single();

      if (convError || !conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if (conversation.project_id !== projectId) {
        return res.status(403).json({ error: 'Conversation does not belong to this project' });
      }
    }

    const contentLanguage = (project as any).content_language || (project as any).language || 'en';
    const selectionFeedbackMode = typeof message === 'string' && (
      message.includes('MODO FEEDBACK DE SELECCION') ||
      message.includes('SELECTION FEEDBACK MODE')
    );

    // --- SSE setup ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: any) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let cancelled = false;
    const abort = new AbortController();
    req.on('close', () => { cancelled = true; abort.abort(); });

    try {
      // Conversation persistence
      let activeConvId = conversationId as string | null || null;

      if (!activeConvId) {
        const title = message.length > 50 ? message.substring(0, 50).trim() + '...' : message.trim();
        const { data: conv } = await supabase
          .from('conversations')
          .insert([{ project_id: projectId, title, phase: 'write' }])
          .select('id')
          .single();
        if (conv) activeConvId = conv.id;
      }

      if (activeConvId && !resume) {
        await supabase.from('conversation_messages')
          .insert([{ conversation_id: activeConvId, role: 'user', content: message, token_count: 0 }])
          .then(() => {}, () => {});
      }

      const messages: any[] = [
        {
          role: 'system',
          content: buildWritePrompt(contentLanguage) + (selectionFeedbackMode ? `

## ACTIVE MODE: SELECTION FEEDBACK ONLY
The current user message came from "Discuss with AI" on selected script text.
You cannot edit the script in this mode.
Do not claim that anything was corrected, updated, changed, rewritten, or applied.
Do not say "ahora dice", "listo", "corregido", "lo cambié", "I changed it", "done", or similar.
Give feedback only: explain what the user should remove/change manually, or tell them to use an explicit rewrite/apply action if they want the script edited.` : ''),
        },
        ...history.map((m: any) => ({ role: m.role, content: m.content })),
        { role: 'user', content: message },
      ];

      const routingCtx = AIModelRouter.createContext({
        requestType: 'chat',
        inputText: messages.map(m => m.content).join('\n'),
        expectedOutputTokens: 1200,
        hasAttachments: false,
        metadata: { contentScale: 'standard', userPlanId: 'paid' },
      });

      const MAX_ROUNDS = 5;
      let current = [...messages];
      let answer = '';
      let waitingForApproval = false;
      const approvedToolSet = toApprovedToolSet(approvedWriteTools);
      const studioThinkingSteps: Array<{ key: string; params?: Record<string, string> }> = [];
      const studioEntityCreations: any[] = [];
      const sendStatus = (payload: { key: string; params?: Record<string, string>; tool?: string }) => {
        studioThinkingSteps.push({ key: payload.key, params: payload.params });
        send('status', payload);
      };

      for (let round = 0; round <= MAX_ROUNDS; round++) {
        if (cancelled) break;

        const isLast = round === MAX_ROUNDS;

        const result = await aiRouter.executeStreamingCompletion(
          routingCtx,
          {
            messages: current,
            maxTokens: 1200,
            temperature: 0.7,
            tools: isLast || selectionFeedbackMode ? undefined : WRITE_TOOLS,
          },
          {
            onToken: (token: string) => {
              if (!cancelled) { answer += token; send('token', { content: token }); }
            },
            signal: abort.signal,
          }
        );

        if (!result.toolCalls || result.toolCalls.length === 0 || result.finishReason === 'stop') break;

        if (DEBUG_AI) {
          console.log(`🔧 Studio write round ${round + 1}: ${result.toolCalls.map((t: any) => t.function.name).join(', ')}`);
        }

        current.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls });

        for (const toolCall of result.toolCalls) {
          if (cancelled) break;

          let args: Record<string, any> = {};
          try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { args = {}; }
          const requiresApproval = requiresToolApproval(APPROVAL_REQUIRED_TOOLS, toolCall.function.name, approvedToolSet);

          if (requiresApproval) {
            const approvalId = createToolApprovalId('tap');
            pendingToolApprovals.set(approvalId, {
              userId,
              projectId,
              episodeId,
              toolName: toolCall.function.name,
              args,
              createdAt: Date.now(),
            });
            send('tool_approval_required', {
              id: approvalId,
              toolName: toolCall.function.name,
              ...getToolApprovalSummary(toolCall.function.name, args),
            });
            current.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Waiting for user approval to run ${toolCall.function.name}.`,
            });
            waitingForApproval = true;
            break;
          }

          // Emit status event with translation key before tool execution
          const writeStatusEvent = (() => {
            switch (toolCall.function.name) {
              case 'get_project_context': return { key: 'studio.agent.status.reading_context' };
              case 'get_document': return { key: 'studio.agent.status.reading_document', params: { type: args.document_type || '' } };
              case 'get_script_outline': return { key: 'studio.agent.status.reading_outline' };
              case 'get_scene_content': return { key: 'studio.agent.status.reading_scene', params: { n: String(args.scene_number || '') } };
              case 'write_scene': return { key: 'studio.agent.status.writing_scene', params: { heading: args.scene_heading || '' } };
              case 'rewrite_scene': return { key: 'studio.agent.status.rewriting_scene', params: { n: String(args.scene_number || '') } };
              case 'delete_scene': return { key: 'studio.agent.status.deleting_scene', params: { n: String(args.scene_number || '') } };
              case 'update_character': return { key: 'studio.agent.status.updating_character', params: { name: args.character_name || '' } };
              case 'create_character': return { key: 'studio.agent.status.creating_character', params: { name: args.name || '' } };
              case 'create_location': return { key: 'studio.agent.status.adding_location', params: { name: args.name || '' } };
              default: return null;
            }
          })();
          if (writeStatusEvent) sendStatus({ ...writeStatusEvent, tool: toolCall.function.name });

          const toolResult = await executeWriteTool(toolCall.function.name, args, projectId, userId, episodeId);

          // Emit mutation events to frontend
          if (toolResult.scriptChanged && toolResult.eventType) {
            send(toolResult.eventType, toolResult.eventData);
          }

          for (const entityEvent of toolResult.entityEvents || []) {
            studioEntityCreations.push(entityEvent);
            send('entity_created', entityEvent);
          }

          current.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.success
              ? (toolResult.result || 'Done.')
              : `Error: ${toolResult.error}`,
          });
        }
        if (waitingForApproval) break;
      }

      if (activeConvId && answer) {
        await supabase.from('conversation_messages')
          .insert([{
            conversation_id: activeConvId,
            role: 'assistant',
            content: answer,
            token_count: 0,
            attachments: {
              studio: {
                thinkingSteps: studioThinkingSteps,
                entityCreations: studioEntityCreations,
              },
            },
          }])
          .then(() => {}, () => {});
      }

      if (!cancelled) {
        send('done', { conversationId: activeConvId });
        res.end();
      }
    } catch (err: any) {
      if (err.name === 'AbortError') { if (!res.writableEnded) res.end(); return; }
      console.error('❌ Studio write-stream error:', err);
      send('error', { message: err.message || 'Something went wrong' });
      if (!res.writableEnded) res.end();
    }
  }
);

router.post(
  '/tool-approvals/:approvalId/approve',
  requireAuth,
  extractUserId,
  async (req: PricingRequest, res) => {
    const userId = req.userId;
    const { approvalId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const pending = pendingToolApprovals.get(approvalId);
    if (!pending || pending.userId !== userId) {
      return res.status(404).json({ error: 'Approval not found or expired' });
    }

    pendingToolApprovals.take(approvalId);

    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', pending.projectId)
      .eq('user_id', userId)
      .eq('deleted', false)
      .single();

    if (!project) return res.status(404).json({ error: 'Project not found' });

    const toolResult = await executeWriteTool(
      pending.toolName,
      pending.args,
      pending.projectId,
      userId,
      pending.episodeId
    );

    return res.json({
      success: toolResult.success,
      error: toolResult.error,
      result: toolResult.result,
      toolName: pending.toolName,
      scriptChanged: toolResult.scriptChanged,
      eventType: toolResult.eventType,
      eventData: toolResult.eventData,
      entityEvents: toolResult.entityEvents || [],
    });
  }
);

router.post(
  '/tool-approvals/:approvalId/deny',
  requireAuth,
  extractUserId,
  async (req: PricingRequest, res) => {
    const userId = req.userId;
    const { approvalId } = req.params;
    pendingToolApprovals.deny(approvalId, userId);
    return res.json({ success: true });
  }
);

// =============================================================================
// Insert scene from chat message
// =============================================================================

/**
 * Extract a Fountain-formatted scene from an AI chat response.
 * Finds the first INT./EXT. heading and takes everything after it.
 */
function parseSceneFromText(text: string): { heading: string; body: string } | null {
  // Strip markdown code blocks
  const clean = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1').trim();
  const lines = clean.split('\n');

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:INT\.|EXT\.|INT\.\/EXT\.|I\/E[\s.])/i.test(lines[i].trim())) {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx < 0) return null;

  const heading = lines[headingIdx].trim();

  // Collect body lines until we hit markdown formatting (AI commentary like **Write**)
  const rawBodyLines = lines.slice(headingIdx + 1);
  const bodyLines: string[] = [];
  for (const ln of rawBodyLines) {
    if (/\*\*|__|\[.*\]\(/.test(ln)) break; // markdown = chatbot commentary, stop here
    bodyLines.push(ln);
  }
  // Trim trailing blank lines
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();

  return { heading, body: bodyLines.join('\n') };
}

router.post(
  '/insert-scene',
  requireAuth,
  extractUserId,
  addPricingService,
  async (req: PricingRequest, res) => {
    const { projectId, content, episodeId } = req.body;
    const userId = req.userId;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!projectId || !content) return res.status(400).json({ error: 'Missing projectId or content' });

    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('user_id', userId)
      .eq('deleted', false)
      .single();

    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = parseSceneFromText(content);
    if (!parsed) return res.status(400).json({ error: 'No scene heading found in content' });

    const info = await getScriptForProject(projectId, episodeId);
    if (!info) return res.status(400).json({ error: 'No production script found. Set a production script in your project first.' });

    const newNodes = fountainToNodes(parsed.heading, parsed.body);
    const updatedNodes = [...info.nodes, ...newNodes];

    await createPreChangeSnapshot(
      projectId,
      info.scriptId,
      userId,
      `Before AI insert scene: ${parsed.heading}`
    );
    await persistScriptContent(
      projectId,
      info.scriptId,
      { type: 'doc', content: updatedNodes },
      userId,
      `AI insert scene: ${parsed.heading}`
    );

    if (DEBUG_AI) console.log(`✅ Studio insert-scene: appended "${parsed.heading}" to script ${info.scriptId}`);

    return res.json({ success: true, heading: parsed.heading, scriptId: info.scriptId });
  }
);

export default router;
