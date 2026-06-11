/**
 * Studio v2 - Develop Phase Stream
 *
 * Agentic story development endpoint. The AI interviews the user about their
 * story and autonomously creates characters, locations, and beats in the DB
 * as tool side effects. Each entity creation emits an `entity_created` SSE
 * event so the frontend canvas updates in real time.
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../../middleware/auth';
import { extractUserId, addPricingService, PricingRequest } from '../../middleware/pricingMiddleware';
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { isEpisodic } from '../../utils/projectType';
import {
  canonicalizeCharacterName,
  getCharacterIdentityKey,
} from '../../utils/characterIdentity';
import {
  canonicalizeLocationName,
  getLocationIdentityKey,
} from '../../utils/locationIdentity';
import {
  createPendingToolApprovalStore,
  createToolApprovalId,
  getEpisodeUpsertMode,
  requiresToolApproval,
  toApprovedToolSet,
} from './toolHelpers';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const DEVELOP_APPROVAL_REQUIRED_TOOLS = new Set(['change_project_type', 'delete_document', 'delete_location', 'delete_character', 'delete_episode', 'delete_season', 'delete_beat']);
const pendingDevelopToolApprovals = createPendingToolApprovalStore();

function normalizeBeatAct(act?: string | null): string {
  const normalized = String(act || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (normalized) {
    case 'act1':
    case 'act_1':
      return 'act1';
    case 'act2':
    case 'act_2':
    case 'act_2a':
    case 'act2a':
      return 'act2a';
    case 'act_2b':
    case 'act2b':
      return 'act2b';
    case 'act3':
    case 'act_3':
      return 'act3';
    case 'act4':
    case 'act_4':
      return 'act4';
    case 'act5':
    case 'act_5':
      return 'act5';
    case 'custom':
      return 'custom';
    default:
      return 'act1';
  }
}

function getDevelopToolApprovalSummary(toolName: string, args: Record<string, any>) {
  // `targetName` carries the raw entity name so the client can render a fully
  // localized description (the `title`/`description` strings are English fallbacks).
  if (toolName === 'change_project_type') {
    return {
      action: 'change_project_type',
      title: 'Change project type',
      description: `Change this project to ${args.project_type === 'series' ? 'a series' : 'a film'}.`,
      primaryLabel: 'Change',
      targetName: args.project_type === 'series' ? 'series' : 'film',
    };
  }
  if (toolName === 'delete_episode') {
    const name = args.title || (args.episode_number ? `episode ${args.episode_number}` : '');
    return {
      action: 'delete_episode',
      title: 'Delete episode',
      description: `Delete ${name ? `"${name}"` : 'this episode'}.`,
      primaryLabel: 'Delete',
      targetName: name || '',
    };
  }
  if (toolName === 'delete_season') {
    const name = args.title || (args.season_number ? `season ${args.season_number}` : '');
    return {
      action: 'delete_season',
      title: 'Delete season',
      description: `Delete ${name ? `"${name}"` : 'this season'}. Seasons with episodes cannot be deleted until their episodes are removed.`,
      primaryLabel: 'Delete',
      targetName: name || '',
    };
  }
  if (toolName === 'delete_beat') {
    const name = args.title || '';
    return {
      action: 'delete_beat',
      title: 'Delete beat',
      description: `Delete ${name ? `"${name}"` : 'this beat'}.`,
      primaryLabel: 'Delete',
      targetName: name,
    };
  }
  if (toolName === 'delete_character') {
    const name = args.name || '';
    return {
      action: 'delete_character',
      title: 'Delete character',
      description: `Delete ${name ? `"${name}"` : 'this character'}.`,
      primaryLabel: 'Delete',
      targetName: name,
    };
  }
  if (toolName === 'delete_document') {
    const name = args.title || '';
    return {
      action: 'delete_document',
      title: 'Delete document',
      description: `Delete ${name ? `"${name}"` : 'this document'}.`,
      primaryLabel: 'Delete',
      targetName: name,
    };
  }
  if (toolName === 'delete_location') {
    const name = args.name || '';
    return {
      action: 'delete_location',
      title: 'Delete location',
      description: `Delete ${name ? `"${name}"` : 'this location'}.`,
      primaryLabel: 'Delete',
      targetName: name,
    };
  }
  return {
    action: 'develop_tool',
    title: 'Run tool',
    description: `Run ${toolName}.`,
    primaryLabel: 'Allow',
    targetName: '',
  };
}

// =============================================================================
// Tool definitions for story development
// =============================================================================

const DEVELOP_TOOLS: { type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }[] = [
  {
    type: 'function',
    function: {
      name: 'get_series_structure',
      description: 'Read existing seasons and episodes for a TV series project. Call this before creating or updating seasons/episodes unless the target episode ID is already known.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_project_type',
      description: 'Change the project type between film and series after the user confirms they want that conversion. This is structural and always requires approval.',
      parameters: {
        type: 'object',
        properties: {
          project_type: {
            type: 'string',
            enum: ['film', 'series'],
            description: 'Target project type'
          },
          reason: { type: 'string', description: 'Short reason for the conversion' },
        },
        required: ['project_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_documents',
      description: 'Read existing story documents for this project, including IDs, titles, document types, and short content previews. Call this before updating or creating a document when duplicates are possible.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_characters',
      description: 'Read existing characters for this project, including IDs, names, roles, and descriptions. Call this before updating characters or when checking whether a character already exists.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_locations',
      description: 'Read existing locations for this project, including IDs, names, types, and descriptions. Call this before updating locations or when checking whether a location already exists.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_beats',
      description: 'Read existing story beats with their IDs, titles, order, act, and descriptions. Call this BEFORE updating or deleting beats so you target the right beat by beat_id and know exactly which beats currently exist. For a series, pass episode_id (or season_number + episode_number) to scope to one episode; otherwise the currently selected episode is used.',
      parameters: {
        type: 'object',
        properties: {
          episode_id: { type: 'string', description: 'Episode ID to read beats for (TV series). Defaults to the selected episode.' },
          season_number: { type: 'number', description: 'Season number, when episode_id is unknown.' },
          episode_number: { type: 'number', description: 'Episode number, when episode_id is unknown.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_character',
      description: 'Create a character in the project database. Call this when you have enough information about a character to save them (name + at least a brief description or role).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Character name (e.g. CLARA, DETECTIVE HAYES)' },
          description: { type: 'string', description: 'Brief character description' },
          primary_role: { type: 'string', description: 'Their role in the story (e.g. protagonist, antagonist, supporting)' },
          character_type: {
            type: 'string',
            enum: ['main', 'minor', 'ensemble', 'background'],
            description: 'Character tier'
          },
        },
        required: ['name', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_location',
      description: 'Create a location in the project database. Call this when the user mentions a place that will be used in the story.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Location name (e.g. THE HARBOR, CLARA\'S APARTMENT)' },
          description: { type: 'string', description: 'Brief location description' },
          location_type: {
            type: 'string',
            enum: ['interior', 'exterior', 'both'],
            description: 'INT, EXT, or both'
          },
        },
        required: ['name', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_location',
      description: 'Update an existing location in the project database. Use this to rename, merge, clarify, or correct a location the user has already created.',
      parameters: {
        type: 'object',
        properties: {
          location_id: { type: 'string', description: 'Existing location ID, if known' },
          name: { type: 'string', description: 'Current exact location name to update, if ID is not known' },
          new_name: { type: 'string', description: 'New location name, if it should change' },
          description: { type: 'string', description: 'Updated description, if it should change' },
          location_type: {
            type: 'string',
            enum: ['interior', 'exterior', 'both'],
            description: 'Updated INT, EXT, or both value'
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_location',
      description: 'Delete one existing location from the project database. Use this when the user says a location is duplicate, wrong, or should be removed. Delete only the specific target location, never all locations.',
      parameters: {
        type: 'object',
        properties: {
          location_id: { type: 'string', description: 'Existing location ID, if known' },
          name: { type: 'string', description: 'Exact location name to delete, if ID is not known' },
          reason: { type: 'string', description: 'Short reason for deletion' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_document',
      description: 'Update an existing document with revised content. Use this when the user asks to improve, rewrite, expand, or change a document that already exists. Rewrite the FULL document content, not just the changed part.',
      parameters: {
        type: 'object',
        properties: {
          document_id: { type: 'string', description: 'The ID of the document to update' },
          content: { type: 'string', description: 'The full updated document content as plain text' },
          title: { type: 'string', description: 'Updated title (optional, only if title should change)' },
        },
        required: ['document_id', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Create a story document and save it to the project. Call this once you have enough information to write a first draft — do not wait for the user to ask.',
      parameters: {
        type: 'object',
        properties: {
          document_type: {
            type: 'string',
            enum: ['logline', 'synopsis', 'treatment', 'character_breakdown', 'pitch_deck', 'mood_board', 'custom'],
            description: 'The type of document to create. Use "character_breakdown" for character sheets/profiles, "treatment" for full treatments, "custom" for anything else (outline, scene breakdown, etc.)'
          },
          title: { type: 'string', description: 'Document title (e.g. "Character Breakdown", "Story Outline")' },
          content: { type: 'string', description: 'Full document content as plain text' },
        },
        required: ['document_type', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_beat',
      description: 'Save a story beat to the beat sheet. Call this when a key plot point, act structure, or story milestone is established.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short beat title (e.g. Inciting Incident, All Is Lost)' },
          description: { type: 'string', description: 'What happens in this beat' },
          episode_id: { type: 'string', description: 'Episode ID when this beat belongs to a specific TV episode. Use the current selected episode or an ID from get_series_structure.' },
          season_number: { type: 'number', description: 'Season number if episode_id is not known. Defaults to 1.' },
          episode_number: { type: 'number', description: 'Episode number if episode_id is not known.' },
          act: {
            type: 'string',
            enum: ['act1', 'act2a', 'act2b', 'act3'],
            description: 'Which act this beat belongs to'
          },
          beat_type: { type: 'string', description: 'Beat type (e.g. inciting_incident, midpoint, climax)' },
        },
        required: ['title', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_episode',
      description: 'Update an existing episode\'s title, synopsis, or status. Use this when the user asks to revise or improve an episode that already exists. Prefer this over create_episode when the episode already has an ID in the conversation history.',
      parameters: {
        type: 'object',
        properties: {
          episode_id: { type: 'string', description: 'The ID of the episode to update (from conversation history)' },
          title: { type: 'string', description: 'Updated episode title (optional)' },
          synopsis: { type: 'string', description: 'Updated episode synopsis (optional)' },
          status: {
            type: 'string',
            enum: ['outline', 'writing', 'revision', 'complete', 'locked'],
            description: 'Updated episode status (optional)'
          },
        },
        required: ['episode_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_or_update_season',
      description: 'Create a season or update an existing season title, description, or status. This is non-destructive and should be used for season planning changes.',
      parameters: {
        type: 'object',
        properties: {
          season_id: { type: 'string', description: 'Existing season ID, if known' },
          season_number: { type: 'number', description: 'Season number. Defaults to 1 when creating.' },
          title: { type: 'string', description: 'Season title' },
          description: { type: 'string', description: 'Season description or arc summary' },
          status: {
            type: 'string',
            enum: ['planning', 'writing', 'pre_production', 'production', 'post_production', 'completed', 'aired'],
            description: 'Season status'
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_document',
      description: 'Delete one existing story document. This is destructive and always requires user approval. Use only when the user clearly asks to delete/remove a document.',
      parameters: {
        type: 'object',
        properties: {
          document_id: { type: 'string', description: 'Existing document ID, if known' },
          title: { type: 'string', description: 'Exact document title to delete, if ID is not known' },
          document_type: {
            type: 'string',
            enum: ['logline', 'synopsis', 'treatment', 'character_breakdown', 'pitch_deck', 'mood_board', 'custom'],
            description: 'Document type to narrow the target when title is not known'
          },
          reason: { type: 'string', description: 'Short reason for deletion' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_character',
      description: 'Update an existing character in the project database. Use this to rename, clarify, or correct a character the user has already created.',
      parameters: {
        type: 'object',
        properties: {
          character_id: { type: 'string', description: 'Existing character ID, if known' },
          name: { type: 'string', description: 'Current exact character name to update, if ID is not known' },
          new_name: { type: 'string', description: 'New character name, if it should change' },
          description: { type: 'string', description: 'Updated character description, if it should change' },
          primary_role: { type: 'string', description: 'Updated story role' },
          character_type: {
            type: 'string',
            enum: ['main', 'minor', 'ensemble', 'background'],
            description: 'Updated character tier'
          },
          status: { type: 'string', description: 'Updated status, if needed' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_character',
      description: 'Delete one existing character from the project database. This is destructive and always requires user approval. Delete only the specific target character, never all characters.',
      parameters: {
        type: 'object',
        properties: {
          character_id: { type: 'string', description: 'Existing character ID, if known' },
          name: { type: 'string', description: 'Exact character name to delete, if ID is not known' },
          reason: { type: 'string', description: 'Short reason for deletion' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_beat',
      description: 'Update an existing story beat. Use this when the user asks to revise a beat title, description, act, type, or episode assignment and the target beat is clear.',
      parameters: {
        type: 'object',
        properties: {
          beat_id: { type: 'string', description: 'Existing beat ID, if known from conversation history' },
          title: { type: 'string', description: 'Current beat title to find, or updated title when beat_id is provided' },
          current_title: { type: 'string', description: 'Current exact beat title if title is the new title' },
          description: { type: 'string', description: 'Updated beat description' },
          episode_id: { type: 'string', description: 'Episode ID to scope or assign the beat for TV series' },
          season_number: { type: 'number', description: 'Season number if episode_id is not known. Defaults to 1.' },
          episode_number: { type: 'number', description: 'Episode number if episode_id is not known.' },
          act: {
            type: 'string',
            enum: ['act1', 'act2a', 'act2b', 'act3'],
            description: 'Updated act'
          },
          beat_type: { type: 'string', description: 'Updated beat type' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_beat',
      description: 'Delete an existing story beat. This is destructive and always requires user approval. Only use when the user clearly asks to delete/remove a beat.',
      parameters: {
        type: 'object',
        properties: {
          beat_id: { type: 'string', description: 'Existing beat ID, if known from conversation history' },
          title: { type: 'string', description: 'Exact beat title if ID is not known' },
          episode_id: { type: 'string', description: 'Episode ID to scope the beat for TV series' },
          season_number: { type: 'number', description: 'Season number if episode_id is not known. Defaults to 1.' },
          episode_number: { type: 'number', description: 'Episode number if episode_id is not known.' },
          reason: { type: 'string', description: 'Short reason for deletion' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_season',
      description: 'Delete an existing season. This is destructive and always requires user approval. Only use when the user clearly asks to delete/remove a season.',
      parameters: {
        type: 'object',
        properties: {
          season_id: { type: 'string', description: 'Existing season ID, if known' },
          season_number: { type: 'number', description: 'Season number, if ID is not known' },
          title: { type: 'string', description: 'Season title for the approval message' },
          reason: { type: 'string', description: 'Short reason for deletion' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_episode',
      description: 'Create a new TV series episode with its title and synopsis. Use this for new episodes that do not yet exist. If the episode already exists and has an ID, use update_episode instead.',
      parameters: {
        type: 'object',
        properties: {
          season_number: { type: 'number', description: 'Season number. Defaults to 1.' },
          episode_number: { type: 'number', description: 'Episode number within the season.' },
          title: { type: 'string', description: 'Episode title' },
          synopsis: { type: 'string', description: 'Episode synopsis or summary' },
          runtime: { type: 'number', description: 'Optional target runtime in minutes' },
          status: {
            type: 'string',
            enum: ['outline', 'writing', 'revision', 'complete', 'locked'],
            description: 'Episode status'
          },
        },
        required: ['episode_number', 'title', 'synopsis'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_episode',
      description: 'Delete an existing episode. This is destructive and always requires user approval. Only use when the user clearly asks to delete/remove an episode.',
      parameters: {
        type: 'object',
        properties: {
          episode_id: { type: 'string', description: 'Existing episode ID, if known' },
          season_number: { type: 'number', description: 'Season number, if ID is not known. Defaults to 1.' },
          episode_number: { type: 'number', description: 'Episode number within the season, if ID is not known' },
          title: { type: 'string', description: 'Episode title for the approval message' },
          reason: { type: 'string', description: 'Short reason for deletion' },
        },
        required: [],
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

function hasSeriesIntent(text: string): boolean {
  return /\b(serie|series|temporada|temporadas|season|seasons|episodio|episodios|episode|episodes|capitulo|capitulos|capítulo|capítulos|vertical series|serie vertical|showrunner|pilot|piloto)\b/i.test(text);
}

function hasFilmConversionIntent(text: string): boolean {
  return /\b(peli|pelicula|película|film|movie|largometraje|feature|una sola historia|historia unica|historia única)\b/i.test(text);
}

function getProjectTypeMismatchReply(projectType: string, text: string): string | null {
  if (!isEpisodic(projectType) && hasSeriesIntent(text)) {
    return 'Este proyecto está configurado como película. Para crear temporadas y episodios necesito convertirlo a serie primero. ¿Quieres que lo cambie a serie?';
  }

  if (isEpisodic(projectType) && hasFilmConversionIntent(text)) {
    return 'Este proyecto está configurado como serie. Si quieres trabajarlo como una película única, primero tendría que convertirlo a película o elegir un episodio concreto. ¿Quieres convertirlo a película?';
  }

  return null;
}

function isConversionConfirmation(text: string): boolean {
  return /^(si|sí|s[ií],?|ok|okay|dale|hazlo|hace(lo)?|converti(lo)?|conviertelo|conviértelo|yes|do it|go ahead)\b/i.test(text.trim());
}

function getConfirmedProjectTypeChange(history: any[], text: string): 'series' | 'film' | null {
  if (!isConversionConfirmation(text)) return null;
  const lastAssistant = [...history].reverse().find((message: any) => message?.role === 'assistant')?.content || '';
  if (/convertirlo a serie|cambie a serie|cambiarlo a serie|convert it to a series/i.test(lastAssistant)) return 'series';
  if (/convertirlo a película|convertirlo a pelicula|convertirlo a film|convert it to a film/i.test(lastAssistant)) return 'film';
  return null;
}

function buildDevelopPrompt(contentLanguage: string, projectType: string): string {
  const langName = LANGUAGE_NAMES[contentLanguage] || 'English';
  return `You are a story development agent for a professional screenplay tool. You BUILD things — you don't just chat.

## CURRENT PROJECT CONFIGURATION

The current project_type is "${projectType}".

## YOUR JOB: CREATE, THEN CONFIRM

Every turn you must either call a tool to create/save something, OR ask one focused question. Never both. Never just talk.

## WHEN TO CALL EACH TOOL

**create_character** — call this when the user establishes a concrete story participant: a named character or a reusable unnamed role with narrative function. Do not create incidental people who are merely mentioned, compared, or used as background atmosphere.

**update_character** — call this when the user asks to rename, correct, or revise an existing character and the target is clear.

**delete_character** — call only when the user clearly asks to delete/remove a character. This always requires user approval before it runs.

**create_location** — call this only when the user establishes a concrete, reusable story setting. Do not create incidental places that are merely mentioned, compared, remembered, or used as background context.

**save_beat** — call when a story beat is clear (inciting incident, midpoint, climax, etc.). Use only for story structure beats inside a film or inside one selected episode. For series episode beats, pass episode_id, or season_number + episode_number. NEVER use save_beat for "Episode 1", "Episode 2", episode premises, episode synopses, or a list of episodes.

**get_beats** — call this before updating or deleting beats whenever you don't already have the exact beat_id, and whenever you need to know which beats currently exist (for example after the user approves a deletion and you must continue with the remaining ones). It returns each beat's id, title, and order. ALWAYS pass the resulting beat_id to update_beat/delete_beat instead of matching by title.

**update_beat** — call this to revise an existing beat when the target beat is clear. Prefer beat_id (from get_beats or conversation history). For series beats, include episode_id or season_number + episode_number unless beat_id is known.

**delete_beat** — call only when the user clearly asks to delete/remove a beat. Look up the beat with get_beats first and pass its beat_id so you delete the exact beat. When the user asks to remove several beats, delete them one at a time, calling delete_beat for each remaining beat; do not stop after the first. This always requires user approval before it runs.

**get_documents** — call this before updating a document if the target document ID is not already known, or before creating a document that might duplicate an existing type/title.

**get_characters** — call this before updating a character if the character ID is not already known, or when the user asks what characters already exist.

**get_locations** — call this before updating a location if the location ID is not already known, or when the user asks what locations already exist.

**create_document(logline)** — call this as soon as you know: protagonist + goal + conflict. Write it yourself. Format: "[Protagonist], a [role], must [goal] before [stakes/antagonist force]."

**create_document(synopsis)** — call when the user asks for it OR you've had 3+ exchanges knowing the premise. YOU write it: 3-5 paragraphs, setup → inciting incident → act 2 → climax → resolution.

**create_document(treatment)** — call when the user asks for a treatment or a scene-by-scene narrative breakdown. YOU write it in present tense, covering every major scene.

**create_document(character_breakdown)** — call when the user asks for a "character breakdown", "character document", "character sheet", "character profile", or similar. Write a detailed breakdown for each main character: backstory, motivation, arc, relationships.

**create_document(custom)** — use for anything else: outline, scene breakdown, theme notes, etc. Set a clear title.

**delete_document** — call only when the user clearly asks to delete/remove a document. This always requires user approval before it runs.

**get_series_structure** — call this before creating or updating seasons/episodes unless the target episode ID is already present in the conversation history.

**change_project_type** — call this when the user confirms they want to convert the project between film and series. This always requires user approval before it runs.

**create_or_update_season** — call this to create a season, rename a season, or update a season arc/description/status. This is non-destructive.

**create_episode** — call this for TV series episode slates, episode ideas, season plans, or requests like "create 4 episodes". Each whole episode must be saved as an episode with a synopsis, not as a beat.

**delete_episode** and **delete_season** — call only when the user clearly asks to delete/remove an episode or season. These tools always require user approval before they run.

## CRITICAL RULES
- Treat both "series" and "vertical_series" as episodic series with seasons, episodes, and episode scripts. All series rules below apply equally to vertical_series.
- If project_type is NOT "series" and the user asks for a series, seasons, episodes, capítulos, temporadas, episodios, show, vertical series, or a numbered episode slate, DO NOT call any create/update tools. Ask one focused question first: explain that the project is currently configured as a film and ask whether they want to convert it to a series.
- If project_type is "series" and the user asks to turn the whole project into one film/movie/película, DO NOT call any create/update tools. Ask one focused question first: explain that the project is currently configured as a series and ask whether they want to convert it to a film or work inside a specific episode.
- If the previous assistant message asked whether to convert the project type and the user says yes/sí/ok/convert it/do it, call change_project_type with the implied target type. Do not say you cannot change it.
- When the user asks for ANY document type → call create_document IMMEDIATELY. Do NOT write any text before the tool call. Do NOT say "I'll create it now" or "Let me write it". Just call the tool, then confirm in 1-2 sentences after.
- If the project is a series and the user asks for seasons, episodes, episode ideas, or a numbered episode list → first call get_series_structure unless you already have the exact target ID in conversation history.
- For seasons, use create_or_update_season. For episodes, call create_episode once per each NEW episode. If an episode already has an ID in conversation history (machine-only [saved: ...] metadata), use update_episode instead.
- If the project is a series and the user asks for beats, structure, plot points, or act breakdown for a specific episode → call get_series_structure if needed, then save beats with episode_id or season_number + episode_number. If no episode target is clear, ask one focused question instead of saving global beats.
- For a series, ALWAYS name the target episode (its number and title) in your confirmation whenever you save or edit beats, so it is obvious which episode the beats belong to. If you choose an episode that is NOT the one the user currently has selected, state which episode you are using and why.
- If the user asks to edit or delete a beat by name in a series, identify the episode first. If more than one beat could match, ask one focused question.
- Before creating a document with the same likely type/title as an existing document, call get_documents and update the existing document when the user is asking for a revision.
- Before editing characters or locations by name, call get_characters or get_locations unless the exact ID is already present in conversation history.
- Map requests correctly: "character breakdown" → character_breakdown, "outline" → custom, "treatment" → treatment, "synopsis" → synopsis, "logline" → logline
- You MUST call the tool in the same turn the user requests it. Never split into "I'll create it" followed by actually creating it next turn.
- After ALL tool calls complete, write ONE short confirmation (1-2 sentences max). Never write partial confirmations between tool calls.
- You can call multiple tools in one turn (e.g., 4 create_episode calls simultaneously for a 4-episode slate).
- Deleting documents, characters, locations, episodes, seasons, or beats is destructive. Use the delete tool only after identifying the exact target; the app will ask the user for approval.
- NEVER say "I should have called..." or apologize for not calling a tool. Just call it.
- **NEVER use create_document for screenplay scenes.** Write scenes directly in Fountain format. The user inserts them via the Write phase.

## ENTITY IDs IN HISTORY
- Your previous messages may contain lines like: [saved: document "Title" id=abc123; episode "Name" id=def456]
- These are the real database IDs of things you created. Use them when calling update_document or update_episode.
- If a user asks to update a document/episode and you see its ID in history, call the update tool with that ID immediately.
- The [saved: ...] lines are private system metadata. Never mention, quote, or reproduce them in your reply to the user.

## ENTITY CORRECTIONS
- Use update_character or update_location when the user asks to rename, merge, or correct an existing character/place.
- Use delete_character when the user identifies a duplicate or wrong character and the target is clear.
- Use delete_location when the user identifies a duplicate or wrong place and the target is clear.
- When the user points out duplicate entities, fix the database with update/delete tools in the same turn. Ask only if the duplicate target is ambiguous.
- Never say a duplicate has been removed unless you called the delete tool successfully.

## SCREENPLAY LANGUAGE
- ALL document content, character names, location names, beats, dialogue, and any screenplay content you write MUST be in ${langName}.
- EXCEPTION — Screenplay format keywords are ALWAYS in English: INT., EXT., CUT TO:, FADE IN:, FADE OUT., DISSOLVE TO:, THE END. Never translate these.
- Your conversational replies to the user should match the language they write to you in.

## RESPONSE STYLE
- 1-3 sentences max when not creating
- No lists unless presenting created items`;
}

// =============================================================================
// Markdown → TipTap JSON converter
// =============================================================================

type TiptapNode = { type: string; attrs?: Record<string, any>; content?: TiptapNode[]; marks?: { type: string }[]; text?: string };

function parseInline(text: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  // Split on **bold** and __bold__ markers
  const parts = text.split(/(\*\*[^*]+\*\*|__[^_]+__)/g);
  for (const part of parts) {
    if (!part) continue;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      const inner = part.slice(2, -2);
      if (inner) nodes.push({ type: 'text', text: inner, marks: [{ type: 'bold' }] });
    } else {
      nodes.push({ type: 'text', text: part });
    }
  }
  return nodes.filter(n => n.text);
}

function markdownToTiptap(markdown: string): { type: string; content: TiptapNode[] } {
  const lines = markdown.split('\n');
  const docNodes: TiptapNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      docNodes.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      docNodes.push({
        type: 'heading',
        attrs: { level },
        content: parseInline(headingMatch[2].trim()),
      });
      i++;
      continue;
    }

    // Bullet list — collect consecutive items
    if (/^[-*]\s/.test(line)) {
      const listItems: TiptapNode[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        const itemText = lines[i].replace(/^[-*]\s+/, '');
        listItems.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInline(itemText) }],
        });
        i++;
      }
      docNodes.push({ type: 'bulletList', content: listItems });
      continue;
    }

    // Blank line — skip (paragraph boundaries are handled by grouping below)
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].match(/^#{1,6}\s/) &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      docNodes.push({
        type: 'paragraph',
        content: parseInline(paraLines.join(' ')),
      });
    }
  }

  // Ensure at least one node so TipTap doesn't crash
  if (docNodes.length === 0) {
    docNodes.push({ type: 'paragraph', content: [] });
  }

  return { type: 'doc', content: docNodes };
}

function tiptapToPlainText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map(tiptapToPlainText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

async function resolveEpisodeIdForDevelop(
  args: Record<string, any>,
  projectId: string,
  currentEpisodeId?: string | null
): Promise<{ episodeId: string | null; seasonNumber?: number; episodeNumber?: number; error?: string }> {
  let episodeId: string | null = typeof args.episode_id === 'string' && args.episode_id.trim()
    ? args.episode_id.trim()
    : currentEpisodeId || null;

  if (episodeId) {
    const { data: episode, error } = await supabase
      .from('episodes')
      .select('id, episode_number, seasons!inner(season_number, project_id)')
      .eq('id', episodeId)
      .single();

    if (error || !episode) return { episodeId: null, error: 'Episode not found.' };
    if ((episode.seasons as any)?.project_id !== projectId) {
      return { episodeId: null, error: 'Episode does not belong to this project.' };
    }

    return {
      episodeId: episode.id,
      seasonNumber: (episode.seasons as any)?.season_number,
      episodeNumber: episode.episode_number,
    };
  }

  if (Number.isFinite(Number(args.episode_number)) && Number(args.episode_number) > 0) {
    const seasonNumber = Number.isFinite(Number(args.season_number)) && Number(args.season_number) > 0
      ? Math.floor(Number(args.season_number))
      : 1;
    const episodeNumber = Math.floor(Number(args.episode_number));

    const { data: episode, error } = await supabase
      .from('episodes')
      .select('id, episode_number, seasons!inner(season_number, project_id)')
      .eq('project_id', projectId)
      .eq('episode_number', episodeNumber)
      .eq('seasons.season_number', seasonNumber)
      .single();

    if (error || !episode) {
      return { episodeId: null, error: `Episode S${seasonNumber}E${episodeNumber} not found.` };
    }

    return { episodeId: episode.id, seasonNumber, episodeNumber: episode.episode_number };
  }

  return { episodeId: null };
}

async function resolveBeatForDevelop(
  args: Record<string, any>,
  projectId: string,
  currentEpisodeId?: string | null
): Promise<{ beat?: any; episodeId?: string | null; seasonNumber?: number; episodeNumber?: number; error?: string }> {
  const beatId = typeof args.beat_id === 'string' ? args.beat_id.trim() : '';

  if (beatId) {
    const { data: beat, error } = await supabase
      .from('beats')
      .select('id, title, description, episode_id, project_id, "order"')
      .eq('id', beatId)
      .eq('project_id', projectId)
      .single();

    if (error || !beat) return { error: error?.message || 'Beat not found' };
    return { beat, episodeId: beat.episode_id || null };
  }

  const targetTitle = (typeof args.current_title === 'string' && args.current_title.trim())
    ? args.current_title.trim()
    : typeof args.title === 'string'
      ? args.title.trim()
      : '';

  if (!targetTitle) return { error: 'Missing beat_id or title for beat lookup' };

  const { data: project } = await supabase
    .from('projects')
    .select('project_type')
    .eq('id', projectId)
    .single();

  const episodeTarget = await resolveEpisodeIdForDevelop(args, projectId, currentEpisodeId);
  if (episodeTarget.error && isEpisodic(project?.project_type)) return { error: episodeTarget.error };
  if (isEpisodic(project?.project_type) && !episodeTarget.episodeId) {
    return { error: 'Series beat lookup needs an episode target. Ask which episode the beat belongs to.' };
  }

  let query = supabase
    .from('beats')
    .select('id, title, description, episode_id, project_id, "order"')
    .eq('project_id', projectId)
    .ilike('title', targetTitle);

  query = episodeTarget.episodeId ? query.eq('episode_id', episodeTarget.episodeId) : query.is('episode_id', null);

  const { data: beats, error } = await query;
  if (error) return { error: error.message };
  if (!beats || beats.length === 0) return { error: `Beat "${targetTitle}" not found` };
  if (beats.length > 1) return { error: `Multiple beats named "${targetTitle}" found; ask which one to use` };

  return {
    beat: beats[0],
    episodeId: episodeTarget.episodeId || null,
    seasonNumber: episodeTarget.seasonNumber,
    episodeNumber: episodeTarget.episodeNumber,
  };
}

async function ensureSeriesStructureForDevelop(projectId: string): Promise<{
  seasonId?: string;
  episodeId?: string;
  scriptId?: string;
  events: any[];
  error?: string;
}> {
  const events: any[] = [];

  let { data: season, error: seasonFetchError } = await supabase
    .from('seasons')
    .select('id, title, season_number')
    .eq('project_id', projectId)
    .eq('season_number', 1)
    .maybeSingle();

  if (seasonFetchError) return { events, error: seasonFetchError.message };

  if (!season) {
    const { data: newSeason, error } = await supabase
      .from('seasons')
      .insert({ project_id: projectId, season_number: 1, title: 'Season 1', status: 'planning' })
      .select('id, title, season_number')
      .single();
    if (error || !newSeason) return { events, error: error?.message || 'Failed to create Season 1' };
    season = newSeason;
    events.push({ type: 'season', id: season.id, name: season.title || 'Season 1', description: '', seasonNumber: season.season_number || 1 });
  }

  let { data: episode, error: episodeFetchError } = await supabase
    .from('episodes')
    .select('id, title, episode_number, script_id')
    .eq('season_id', season.id)
    .eq('episode_number', 1)
    .maybeSingle();

  if (episodeFetchError) return { events, error: episodeFetchError.message };

  if (!episode) {
    const { data: newEpisode, error } = await supabase
      .from('episodes')
      .insert({ project_id: projectId, season_id: season.id, episode_number: 1, title: 'Episode 1', status: 'outline' })
      .select('id, title, episode_number, script_id')
      .single();
    if (error || !newEpisode) return { events, error: error?.message || 'Failed to create Episode 1' };
    episode = newEpisode;
    events.push({ type: 'episode', id: episode.id, name: episode.title || 'Episode 1', description: '', seasonId: season.id, seasonNumber: season.season_number || 1, episodeNumber: episode.episode_number || 1 });
  }

  let scriptId = episode.script_id || null;
  if (!scriptId) {
    const { data: existingScript } = await supabase
      .from('scripts')
      .select('id')
      .eq('project_id', projectId)
      .is('episode_id', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existingScript?.id) {
      scriptId = existingScript.id;
      await supabase.from('scripts').update({ episode_id: episode.id }).eq('id', scriptId);
    } else {
      const { data: newScript, error } = await supabase
        .from('scripts')
        .insert({
          project_id: projectId,
          episode_id: episode.id,
          title: 'Untitled Script',
          content: { type: 'doc', content: [{ type: 'action' }] },
          is_ai_generated: false,
        })
        .select('id')
        .single();
      if (error || !newScript) return { events, error: error?.message || 'Failed to create episode script' };
      scriptId = newScript.id;
    }

    await supabase.from('episodes').update({ script_id: scriptId }).eq('id', episode.id);
  }

  return { seasonId: season.id, episodeId: episode.id, scriptId, events };
}

// =============================================================================
// Tool executor
// =============================================================================

async function executeTool(
  toolName: string,
  args: Record<string, any>,
  projectId: string,
  userId: string,
  currentEpisodeId?: string | null
): Promise<{ success: boolean; id?: string; name?: string; description?: string; error?: string; entityType?: string; docType?: string; projectType?: string; seasonId?: string; episodeId?: string; seasonNumber?: number; episodeNumber?: number; resultText?: string; extraEvents?: any[] }> {
  try {
    if (toolName === 'change_project_type') {
      const targetType = args.project_type === 'series' ? 'series' : args.project_type === 'film' ? 'film' : null;
      if (!targetType) return { success: false, error: 'project_type must be "film" or "series"' };

      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('id, name, project_type')
        .eq('id', projectId)
        .eq('user_id', userId)
        .eq('deleted', false)
        .single();

      if (projectError || !project) {
        return { success: false, error: projectError?.message || 'Project not found' };
      }

      if (project.project_type === targetType) {
        return {
          success: true,
          id: project.id,
          name: project.name,
          entityType: 'project',
          projectType: targetType,
          resultText: `Project is already ${targetType}.`,
        };
      }

      const extraEvents: any[] = [];
      let seasonId: string | undefined;
      let episodeId: string | undefined;

      if (targetType === 'series') {
        const migration = await ensureSeriesStructureForDevelop(projectId);
        if (migration.error) return { success: false, error: migration.error };
        seasonId = migration.seasonId;
        episodeId = migration.episodeId;
        extraEvents.push(...migration.events);
      } else {
        const { data: seasons } = await supabase
          .from('seasons')
          .select('id, episodes(id, script_id)')
          .eq('project_id', projectId);
        const episodes = (seasons || []).flatMap((season: any) => season.episodes || []);
        if (episodes.length === 1 && episodes[0]?.script_id) {
          await supabase.from('scripts').update({ episode_id: null }).eq('id', episodes[0].script_id);
          await supabase.from('projects').update({ prod_script_id: episodes[0].script_id }).eq('id', projectId);
        }
      }

      const { data, error } = await supabase
        .from('projects')
        .update({ project_type: targetType })
        .eq('id', projectId)
        .eq('user_id', userId)
        .select('id, name, project_type')
        .single();

      if (error || !data) {
        return { success: false, error: error?.message || 'Failed to change project type' };
      }

      return {
        success: true,
        id: data.id,
        name: data.name,
        entityType: 'project',
        projectType: data.project_type,
        seasonId,
        episodeId,
        resultText: `Project converted to ${data.project_type}.`,
        extraEvents,
      };
    }

    if (toolName === 'get_beats') {
      const { data: project } = await supabase
        .from('projects')
        .select('project_type')
        .eq('id', projectId)
        .single();

      let beatQuery = supabase
        .from('beats')
        .select('id, title, description, act, beat_type, "order", episode_id')
        .eq('project_id', projectId);

      if (isEpisodic(project?.project_type)) {
        const episodeTarget = await resolveEpisodeIdForDevelop(args, projectId, currentEpisodeId);
        if (!episodeTarget.episodeId) {
          return { success: false, error: 'Series beats need an episode target. Ask the user which episode to read beats for, or pass episode_id.' };
        }
        beatQuery = beatQuery.eq('episode_id', episodeTarget.episodeId);
      } else {
        beatQuery = beatQuery.is('episode_id', null);
      }

      const { data: beats, error } = await beatQuery.order('order', { ascending: true });

      if (error) {
        console.error('Studio: Failed to read beats:', error);
        return { success: false, error: error.message };
      }

      if (!beats || beats.length === 0) {
        return { success: true, name: 'Beats', resultText: 'No beats exist yet for this target.' };
      }

      const lines = beats.map((b: any) => {
        const desc = b.description ? ` - ${String(b.description).slice(0, 120)}` : '';
        return `Beat ${b.order}: "${b.title}" [id=${b.id}; act=${b.act || 'n/a'}; type=${b.beat_type || 'plot_point'}]${desc}`;
      });

      return {
        success: true,
        name: 'Beats',
        resultText: `Existing beats (${beats.length}):\n${lines.join('\n')}`,
      };
    }

    if (toolName === 'get_series_structure') {
      const { data: project } = await supabase
        .from('projects')
        .select('project_type')
        .eq('id', projectId)
        .single();

      if (!isEpisodic(project?.project_type)) {
        return {
          success: true,
          name: 'Series structure',
          resultText: 'This project is not a series, so it has no season/episode structure.',
        };
      }

      const { data: seasons, error } = await supabase
        .from('seasons')
        .select(`
          id,
          season_number,
          title,
          description,
          status,
          episodes (
            id,
            episode_number,
            title,
            synopsis,
            status,
            runtime
          )
        `)
        .eq('project_id', projectId)
        .order('season_number', { ascending: true });

      if (error) {
        console.error('Studio: Failed to read series structure:', error);
        return { success: false, error: error.message };
      }

      if (!seasons || seasons.length === 0) {
        return {
          success: true,
          name: 'Series structure',
          resultText: 'No seasons or episodes exist yet.',
        };
      }

      const lines = seasons.flatMap((season: any) => {
        const seasonLine = `Season ${season.season_number}: ${season.title || `Season ${season.season_number}`} [id=${season.id}; status=${season.status || 'planning'}]${season.description ? ` - ${season.description}` : ''}`;
        const episodes = [...(season.episodes || [])]
          .sort((a: any, b: any) => (a.episode_number || 0) - (b.episode_number || 0))
          .map((episode: any) => {
            const synopsis = episode.synopsis ? ` - ${episode.synopsis}` : ' - no synopsis yet';
            const runtime = episode.runtime ? `; runtime=${episode.runtime}` : '';
            return `  Episode ${episode.episode_number}: ${episode.title || `Episode ${episode.episode_number}`} [id=${episode.id}; status=${episode.status || 'outline'}${runtime}]${synopsis}`;
          });
        return [seasonLine, ...episodes];
      });

      return {
        success: true,
        name: 'Series structure',
        resultText: `Existing series structure:\n${lines.join('\n')}`,
      };
    }

    if (toolName === 'get_documents') {
      const { data, error } = await supabase
        .from('project_documents')
        .select('id, title, document_type, content, updated_at')
        .eq('project_id', projectId)
        .order('updated_at', { ascending: false });

      if (error) {
        console.error('Studio: Failed to read documents:', error);
        return { success: false, error: error.message };
      }

      const documents = data || [];
      if (documents.length === 0) {
        return { success: true, name: 'Documents', resultText: 'No story documents exist yet.' };
      }

      const lines = documents.map((doc: any) => {
        const preview = tiptapToPlainText(doc.content).slice(0, 220);
        return `- ${doc.title || 'Untitled'} [id=${doc.id}; type=${doc.document_type || 'custom'}]${preview ? ` - ${preview}` : ''}`;
      });

      return {
        success: true,
        name: 'Documents',
        resultText: `Existing documents:\n${lines.join('\n')}`,
      };
    }

    if (toolName === 'get_characters') {
      const { data, error } = await supabase
        .from('characters')
        .select('id, name, description, primary_role, character_type, status')
        .eq('project_id', projectId)
        .order('name', { ascending: true });

      if (error) {
        console.error('Studio: Failed to read characters:', error);
        return { success: false, error: error.message };
      }

      const characters = data || [];
      if (characters.length === 0) {
        return { success: true, name: 'Characters', resultText: 'No characters exist yet.' };
      }

      const lines = characters.map((character: any) => {
        const role = character.primary_role ? `; role=${character.primary_role}` : '';
        const type = character.character_type ? `; type=${character.character_type}` : '';
        const status = character.status ? `; status=${character.status}` : '';
        const description = character.description ? ` - ${character.description}` : '';
        return `- ${character.name} [id=${character.id}${role}${type}${status}]${description}`;
      });

      return {
        success: true,
        name: 'Characters',
        resultText: `Existing characters:\n${lines.join('\n')}`,
      };
    }

    if (toolName === 'get_locations') {
      const { data, error } = await supabase
        .from('locations')
        .select('id, name, description, location_type')
        .eq('project_id', projectId)
        .order('name', { ascending: true });

      if (error) {
        console.error('Studio: Failed to read locations:', error);
        return { success: false, error: error.message };
      }

      const locations = data || [];
      if (locations.length === 0) {
        return { success: true, name: 'Locations', resultText: 'No locations exist yet.' };
      }

      const lines = locations.map((location: any) => {
        const type = location.location_type ? `; type=${location.location_type}` : '';
        const description = location.description ? ` - ${location.description}` : '';
        return `- ${location.name} [id=${location.id}${type}]${description}`;
      });

      return {
        success: true,
        name: 'Locations',
        resultText: `Existing locations:\n${lines.join('\n')}`,
      };
    }

    if (toolName === 'create_character') {
      const canonicalName = canonicalizeCharacterName(args.name);
      if (!canonicalName) {
        return { success: false, error: 'Missing character name' };
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
          updateData.importance_level = args.character_type === 'main' ? 5 : 3;
        }

        if (Object.keys(updateData).length > 0) {
          const { data, error } = await supabase
            .from('characters')
            .update(updateData)
            .eq('id', existing.id)
            .eq('project_id', projectId)
            .select('id, name')
            .single();

          if (error) {
            console.error('❌ Studio: Failed to update existing character:', error);
            return { success: false, error: error.message };
          }

          if (DEBUG_AI) console.log(`✅ Studio: Updated existing character "${data.name}" in project ${projectId}`);
          return { success: true, id: data.id, name: data.name };
        }

        return { success: true, id: existing.id, name: existing.name };
      }

      const { data, error } = await supabase
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

      if (error) {
        console.error('❌ Studio: Failed to create character:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`✅ Studio: Created character "${data.name}" in project ${projectId}`);
      return { success: true, id: data.id, name: data.name };
    }

    if (toolName === 'update_character') {
      const targetName = typeof args.name === 'string' ? args.name.trim() : '';
      const targetId = typeof args.character_id === 'string' ? args.character_id.trim() : '';

      if (!targetId && !targetName) {
        return { success: false, error: 'Missing character_id or name for update_character' };
      }

      let existing: { id: string; name: string; description?: string | null } | null = null;

      if (targetId) {
        const { data, error } = await supabase
          .from('characters')
          .select('id, name, description')
          .eq('id', targetId)
          .eq('project_id', projectId)
          .single();

        if (error || !data) {
          return { success: false, error: error?.message || 'Character not found' };
        }
        existing = data;
      } else {
        const { data, error } = await supabase
          .from('characters')
          .select('id, name, description')
          .eq('project_id', projectId);

        if (error) {
          return { success: false, error: error.message };
        }
        const targetKey = getCharacterIdentityKey(targetName);
        const matches = (data || []).filter(
          (character: any) => getCharacterIdentityKey(character.name) === targetKey
        );
        if (matches.length === 0) {
          return { success: false, error: `Character "${targetName}" not found` };
        }
        if (matches.length > 1) {
          return { success: false, error: `Multiple characters named "${targetName}" found; ask the user which one to update` };
        }
        existing = matches[0];
      }

      const updateData: Record<string, any> = {};
      if (typeof args.new_name === 'string' && args.new_name.trim()) {
        const canonicalName = canonicalizeCharacterName(args.new_name);
        if (!canonicalName) return { success: false, error: 'Invalid new character name' };
        updateData.name = canonicalName;
      }
      if (typeof args.description === 'string') updateData.description = args.description;
      if (typeof args.primary_role === 'string') updateData.primary_role = args.primary_role;
      if (['main', 'minor', 'ensemble', 'background'].includes(args.character_type)) {
        updateData.character_type = args.character_type;
        updateData.importance_level = args.character_type === 'main' ? 5 : 3;
      }
      if (typeof args.status === 'string' && args.status.trim()) updateData.status = args.status.trim();

      if (Object.keys(updateData).length === 0) {
        return { success: true, id: existing.id, name: existing.name, description: existing.description || '', entityType: 'character' };
      }

      if (updateData.name) {
        const { data: projectCharacters, error: duplicateError } = await supabase
          .from('characters')
          .select('id, name')
          .eq('project_id', projectId);
        if (duplicateError) return { success: false, error: duplicateError.message };
        const newKey = getCharacterIdentityKey(updateData.name);
        const duplicate = (projectCharacters || []).find(
          (character: any) =>
            character.id !== existing!.id &&
            getCharacterIdentityKey(character.name) === newKey
        );
        if (duplicate) {
          return { success: false, error: `A matching character already exists: "${duplicate.name}"` };
        }
      }

      const { data, error } = await supabase
        .from('characters')
        .update(updateData)
        .eq('id', existing.id)
        .eq('project_id', projectId)
        .select('id, name, description')
        .single();

      if (error) {
        console.error('Studio: Failed to update character:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Updated character "${data.name}" in project ${projectId}`);
      return { success: true, id: data.id, name: data.name, description: data.description || '', entityType: 'character' };
    }

    if (toolName === 'delete_character') {
      const targetName = typeof args.name === 'string' ? args.name.trim() : '';
      const targetId = typeof args.character_id === 'string' ? args.character_id.trim() : '';

      if (!targetId && !targetName) {
        return { success: false, error: 'Missing character_id or name for delete_character' };
      }

      let existing: { id: string; name: string } | null = null;

      if (targetId) {
        const { data, error } = await supabase
          .from('characters')
          .select('id, name')
          .eq('id', targetId)
          .eq('project_id', projectId)
          .single();

        if (error || !data) {
          return { success: false, error: error?.message || 'Character not found' };
        }
        existing = data;
      } else {
        const { data, error } = await supabase
          .from('characters')
          .select('id, name')
          .eq('project_id', projectId);

        if (error) {
          return { success: false, error: error.message };
        }
        const targetKey = getCharacterIdentityKey(targetName);
        const matches = (data || []).filter(
          (character: any) => getCharacterIdentityKey(character.name) === targetKey
        );
        if (matches.length === 0) {
          return { success: false, error: `Character "${targetName}" not found` };
        }
        if (matches.length > 1) {
          return { success: false, error: `Multiple characters named "${targetName}" found; ask the user which one to delete` };
        }
        existing = matches[0];
      }

      const { error } = await supabase
        .from('characters')
        .delete()
        .eq('id', existing.id)
        .eq('project_id', projectId);

      if (error) {
        console.error('Studio: Failed to delete character:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Deleted character "${existing.name}" from project ${projectId}`);
      return { success: true, id: existing.id, name: existing.name, entityType: 'character' };
    }

    if (toolName === 'create_location') {
      const canonicalName = canonicalizeLocationName(args.name);
      if (!canonicalName) {
        return { success: false, error: 'Missing location name' };
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
        return { success: true, id: existing.id, name: existing.name };
      }

      const { data, error } = await supabase
        .from('locations')
        .insert({
          project_id: projectId,
          name: canonicalName,
          description: args.description || '',
          location_type: args.location_type || 'both',
        })
        .select('id, name')
        .single();

      if (error) {
        console.error('❌ Studio: Failed to create location:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`✅ Studio: Created location "${data.name}" in project ${projectId}`);
      return { success: true, id: data.id, name: data.name };
    }

    if (toolName === 'update_location') {
      const targetName = typeof args.name === 'string' ? args.name.trim() : '';
      const targetId = typeof args.location_id === 'string' ? args.location_id.trim() : '';

      if (!targetId && !targetName) {
        return { success: false, error: 'Missing location_id or name for update_location' };
      }

      let existing: { id: string; name: string; description?: string | null } | null = null;

      if (targetId) {
        const { data, error } = await supabase
          .from('locations')
          .select('id, name, description')
          .eq('id', targetId)
          .eq('project_id', projectId)
          .single();

        if (error || !data) {
          return { success: false, error: error?.message || 'Location not found' };
        }
        existing = data;
      } else {
        const { data, error } = await supabase
          .from('locations')
          .select('id, name, description')
          .eq('project_id', projectId)
          .ilike('name', targetName);

        if (error) {
          return { success: false, error: error.message };
        }
        if (!data || data.length === 0) {
          return { success: false, error: `Location "${targetName}" not found` };
        }
        if (data.length > 1) {
          return { success: false, error: `Multiple locations named "${targetName}" found; ask the user which one to update` };
        }
        existing = data[0];
      }

      const updateData: Record<string, any> = {};
      if (typeof args.new_name === 'string' && args.new_name.trim()) updateData.name = args.new_name.trim();
      if (typeof args.description === 'string') updateData.description = args.description;
      if (['interior', 'exterior', 'both'].includes(args.location_type)) updateData.location_type = args.location_type;

      if (Object.keys(updateData).length === 0) {
        return { success: true, id: existing.id, name: existing.name, description: existing.description || '' };
      }

      const { data, error } = await supabase
        .from('locations')
        .update(updateData)
        .eq('id', existing.id)
        .eq('project_id', projectId)
        .select('id, name, description')
        .single();

      if (error) {
        console.error('Studio: Failed to update location:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Updated location "${data.name}" in project ${projectId}`);
      return { success: true, id: data.id, name: data.name, description: data.description || '' };
    }

    if (toolName === 'delete_location') {
      const targetName = typeof args.name === 'string' ? args.name.trim() : '';
      const targetId = typeof args.location_id === 'string' ? args.location_id.trim() : '';

      if (!targetId && !targetName) {
        return { success: false, error: 'Missing location_id or name for delete_location' };
      }

      let existing: { id: string; name: string } | null = null;

      if (targetId) {
        const { data, error } = await supabase
          .from('locations')
          .select('id, name')
          .eq('id', targetId)
          .eq('project_id', projectId)
          .single();

        if (error || !data) {
          return { success: false, error: error?.message || 'Location not found' };
        }
        existing = data;
      } else {
        const { data, error } = await supabase
          .from('locations')
          .select('id, name')
          .eq('project_id', projectId)
          .ilike('name', targetName);

        if (error) {
          return { success: false, error: error.message };
        }
        if (!data || data.length === 0) {
          return { success: false, error: `Location "${targetName}" not found` };
        }
        if (data.length > 1) {
          return { success: false, error: `Multiple locations named "${targetName}" found; ask the user which one to delete` };
        }
        existing = data[0];
      }

      const { error } = await supabase
        .from('locations')
        .delete()
        .eq('id', existing.id)
        .eq('project_id', projectId);

      if (error) {
        console.error('Studio: Failed to delete location:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Deleted location "${existing.name}" from project ${projectId}`);
      return { success: true, id: existing.id, name: existing.name };
    }

    if (toolName === 'create_or_update_season') {
      const seasonId = typeof args.season_id === 'string' ? args.season_id.trim() : '';
      const seasonNumber = Number.isFinite(Number(args.season_number)) && Number(args.season_number) > 0
        ? Math.floor(Number(args.season_number))
        : 1;

      const { data: project } = await supabase
        .from('projects')
        .select('project_type')
        .eq('id', projectId)
        .single();

      if (!isEpisodic(project?.project_type)) {
        return { success: false, error: 'Seasons can only be created for series projects' };
      }

      const seasonPayload: Record<string, any> = {
        season_number: seasonNumber,
        title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : `Season ${seasonNumber}`,
      };
      if (typeof args.description === 'string') seasonPayload.description = args.description;
      if (['planning', 'writing', 'pre_production', 'production', 'post_production', 'completed', 'aired'].includes(args.status)) {
        seasonPayload.status = args.status;
      }

      let existingSeason: { id: string } | null = null;
      if (seasonId) {
        const { data, error } = await supabase
          .from('seasons')
          .select('id')
          .eq('id', seasonId)
          .eq('project_id', projectId)
          .single();
        if (error || !data) {
          return { success: false, error: error?.message || 'Season not found' };
        }
        existingSeason = data;
      } else {
        const { data } = await supabase
          .from('seasons')
          .select('id')
          .eq('project_id', projectId)
          .eq('season_number', seasonNumber)
          .single();
        existingSeason = data || null;
      }

      const query = existingSeason
        ? supabase
            .from('seasons')
            .update(seasonPayload)
            .eq('id', existingSeason.id)
            .eq('project_id', projectId)
            .select('id, season_number, title, description, status')
            .single()
        : supabase
            .from('seasons')
            .insert({
              project_id: projectId,
              ...seasonPayload,
              status: seasonPayload.status || 'planning',
            })
            .select('id, season_number, title, description, status')
            .single();

      const { data, error } = await query;
      if (error) {
        console.error('Studio: Failed to create/update season:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: ${existingSeason ? 'Updated' : 'Created'} season "${data.title}" in project ${projectId}`);
      return {
        success: true,
        id: data.id,
        name: data.title,
        description: data.description || '',
        entityType: 'season',
        seasonId: data.id,
        seasonNumber: data.season_number,
      };
    }

    if (toolName === 'delete_episode') {
      const episodeId = typeof args.episode_id === 'string' ? args.episode_id.trim() : '';
      const seasonNumber = Number.isFinite(Number(args.season_number)) && Number(args.season_number) > 0
        ? Math.floor(Number(args.season_number))
        : 1;
      const episodeNumber = Number.isFinite(Number(args.episode_number)) && Number(args.episode_number) > 0
        ? Math.floor(Number(args.episode_number))
        : null;

      let episode: { id: string; title: string; episode_number: number; season_id: string; seasons?: any } | null = null;

      if (episodeId) {
        const { data, error } = await supabase
          .from('episodes')
          .select('id, title, episode_number, season_id, seasons!inner(project_id, season_number)')
          .eq('id', episodeId)
          .single();
        if (error || !data) return { success: false, error: error?.message || 'Episode not found' };
        episode = data;
      } else {
        if (!episodeNumber) return { success: false, error: 'Missing episode_id or episode_number for delete_episode' };
        const { data, error } = await supabase
          .from('episodes')
          .select('id, title, episode_number, season_id, seasons!inner(project_id, season_number)')
          .eq('project_id', projectId)
          .eq('episode_number', episodeNumber)
          .eq('seasons.season_number', seasonNumber)
          .single();
        if (error || !data) return { success: false, error: error?.message || 'Episode not found' };
        episode = data;
      }

      if ((episode.seasons as any)?.project_id !== projectId) {
        return { success: false, error: 'Episode does not belong to this project' };
      }

      const { error } = await supabase
        .from('episodes')
        .delete()
        .eq('id', episode.id);

      if (error) {
        console.error('Studio: Failed to delete episode:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Deleted episode "${episode.title}" from project ${projectId}`);
      return {
        success: true,
        id: episode.id,
        name: episode.title,
        entityType: 'episode',
        seasonId: episode.season_id,
        seasonNumber: (episode.seasons as any)?.season_number,
        episodeNumber: episode.episode_number,
      };
    }

    if (toolName === 'delete_season') {
      const seasonId = typeof args.season_id === 'string' ? args.season_id.trim() : '';
      const seasonNumber = Number.isFinite(Number(args.season_number)) && Number(args.season_number) > 0
        ? Math.floor(Number(args.season_number))
        : null;

      let season: { id: string; title: string; season_number: number } | null = null;

      if (seasonId) {
        const { data, error } = await supabase
          .from('seasons')
          .select('id, title, season_number')
          .eq('id', seasonId)
          .eq('project_id', projectId)
          .single();
        if (error || !data) return { success: false, error: error?.message || 'Season not found' };
        season = data;
      } else {
        if (!seasonNumber) return { success: false, error: 'Missing season_id or season_number for delete_season' };
        const { data, error } = await supabase
          .from('seasons')
          .select('id, title, season_number')
          .eq('project_id', projectId)
          .eq('season_number', seasonNumber)
          .single();
        if (error || !data) return { success: false, error: error?.message || 'Season not found' };
        season = data;
      }

      const { count, error: countError } = await supabase
        .from('episodes')
        .select('id', { count: 'exact', head: true })
        .eq('season_id', season.id);

      if (countError) return { success: false, error: countError.message };
      if ((count || 0) > 0) {
        return { success: false, error: 'Season has episodes. Delete or move episodes before deleting the season.' };
      }

      const { error } = await supabase
        .from('seasons')
        .delete()
        .eq('id', season.id)
        .eq('project_id', projectId);

      if (error) {
        console.error('Studio: Failed to delete season:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Deleted season "${season.title}" from project ${projectId}`);
      return {
        success: true,
        id: season.id,
        name: season.title,
        entityType: 'season',
        seasonId: season.id,
        seasonNumber: season.season_number,
      };
    }

    if (toolName === 'update_episode') {
      const episodeId = typeof args.episode_id === 'string' ? args.episode_id.trim() : '';
      if (!episodeId) {
        return { success: false, error: 'Missing episode_id for update_episode' };
      }

      const updateData: Record<string, any> = {};
      if (typeof args.title === 'string' && args.title.trim()) updateData.title = args.title.trim();
      if (typeof args.synopsis === 'string') updateData.synopsis = args.synopsis;
      if (['outline', 'writing', 'revision', 'complete', 'locked'].includes(args.status)) updateData.status = args.status;

      if (Object.keys(updateData).length === 0) {
        return { success: false, error: 'No fields to update for update_episode' };
      }

      const { data: ep, error: fetchErr } = await supabase
        .from('episodes')
        .select('id, title, season_id, episode_number, seasons!inner(project_id)')
        .eq('id', episodeId)
        .single();

      if (fetchErr || !ep) {
        return { success: false, error: fetchErr?.message || 'Episode not found' };
      }

      if ((ep.seasons as any)?.project_id !== projectId) {
        return { success: false, error: 'Episode does not belong to this project' };
      }

      const { data, error } = await supabase
        .from('episodes')
        .update(updateData)
        .eq('id', episodeId)
        .select('id, title, synopsis, episode_number, season_id')
        .single();

      if (error) {
        console.error('❌ Studio: Failed to update episode:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`✅ Studio: Updated episode "${data.title}" in project ${projectId}`);
      return {
        success: true,
        id: data.id,
        name: data.title,
        description: data.synopsis || '',
        entityType: 'episode',
        seasonId: data.season_id,
        episodeNumber: data.episode_number,
      };
    }

    if (toolName === 'create_episode') {
      const seasonNumber = Number.isFinite(Number(args.season_number)) && Number(args.season_number) > 0
        ? Math.floor(Number(args.season_number))
        : 1;
      const episodeNumber = Number.isFinite(Number(args.episode_number)) && Number(args.episode_number) > 0
        ? Math.floor(Number(args.episode_number))
        : null;

      if (!episodeNumber) {
        return { success: false, error: 'Missing valid episode_number for create_episode' };
      }

      const { data: project } = await supabase
        .from('projects')
        .select('project_type')
        .eq('id', projectId)
        .single();

      if (!isEpisodic(project?.project_type)) {
        return { success: false, error: 'Episodes can only be created for series projects' };
      }

      let { data: season } = await supabase
        .from('seasons')
        .select('id, title, season_number')
        .eq('project_id', projectId)
        .eq('season_number', seasonNumber)
        .single();

      if (!season) {
        const { data: newSeason, error: createSeasonError } = await supabase
          .from('seasons')
          .insert({
            project_id: projectId,
            season_number: seasonNumber,
            title: `Season ${seasonNumber}`,
            status: 'planning',
          })
          .select('id, title, season_number')
          .single();

        if (createSeasonError || !newSeason) {
          console.error('Studio: Failed to create season for episode:', createSeasonError);
          return { success: false, error: createSeasonError?.message || 'Failed to create season' };
        }
        season = newSeason;
      }

      const episodePayload: Record<string, any> = {
        episode_number: episodeNumber,
        title: args.title?.trim() || `Episode ${episodeNumber}`,
        synopsis: args.synopsis || '',
        status: ['outline', 'writing', 'revision', 'complete', 'locked'].includes(args.status) ? args.status : 'outline',
      };
      if (Number.isFinite(Number(args.runtime)) && Number(args.runtime) > 0) {
        episodePayload.runtime = Math.floor(Number(args.runtime));
      }

      const { data: existingEpisode } = await supabase
        .from('episodes')
        .select('id')
        .eq('season_id', season.id)
        .eq('episode_number', episodeNumber)
        .single();

      const query = existingEpisode
        ? supabase
            .from('episodes')
            .update(episodePayload)
            .eq('id', existingEpisode.id)
            .select('id, title, synopsis, episode_number, season_id')
            .single()
        : supabase
            .from('episodes')
            .insert({ season_id: season.id, ...episodePayload })
            .select('id, title, synopsis, episode_number, season_id')
            .single();

      const { data, error } = await query;

      if (error) {
        console.error('Studio: Failed to create/update episode:', error);
        return { success: false, error: error.message };
      }

      const upsertMode = getEpisodeUpsertMode(existingEpisode);
      if (DEBUG_AI) console.log(`Studio: ${upsertMode === 'update' ? 'Updated' : 'Created'} episode "${data.title}" in project ${projectId}`);
      return {
        success: true,
        id: data.id,
        name: data.title,
        description: data.synopsis || '',
        entityType: 'episode',
        seasonId: data.season_id,
        seasonNumber,
        episodeNumber: data.episode_number,
      };
    }

    if (toolName === 'save_beat') {
      const { data: project } = await supabase
        .from('projects')
        .select('project_type')
        .eq('id', projectId)
        .single();

      const episodeTarget = await resolveEpisodeIdForDevelop(args, projectId, currentEpisodeId);
      if (episodeTarget.error) return { success: false, error: episodeTarget.error };

      if (isEpisodic(project?.project_type) && !episodeTarget.episodeId) {
        return { success: false, error: 'Series beats need an episode target. Ask the user which episode these beats belong to.' };
      }

      // Get current beat count to set order
      let countQuery = supabase
        .from('beats')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId);
      countQuery = episodeTarget.episodeId ? countQuery.eq('episode_id', episodeTarget.episodeId) : countQuery.is('episode_id', null);

      const { count } = await countQuery;

      const order = (count || 0) + 1;

      const { data, error } = await supabase
        .from('beats')
        .insert({
          project_id: projectId,
          title: args.title,
          description: args.description || '',
          act: normalizeBeatAct(args.act),
          beat_type: args.beat_type || 'plot_point',
          episode_id: episodeTarget.episodeId,
          order,
        })
        .select('id, title, description, episode_id')
        .single();

      if (error) {
        console.error('❌ Studio: Failed to save beat:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`✅ Studio: Saved beat "${data.title}" in project ${projectId}`);
      return {
        success: true,
        id: data.id,
        name: data.title,
        description: data.description || '',
        entityType: 'beat',
        episodeId: episodeTarget.episodeId || undefined,
        seasonNumber: episodeTarget.seasonNumber,
        episodeNumber: episodeTarget.episodeNumber,
      };
    }

    if (toolName === 'update_beat') {
      const resolved = await resolveBeatForDevelop(args, projectId, currentEpisodeId);
      if (resolved.error || !resolved.beat) {
        return { success: false, error: resolved.error || 'Beat not found' };
      }

      const updateData: Record<string, any> = {};
      if (typeof args.title === 'string' && args.title.trim()) updateData.title = args.title.trim();
      if (typeof args.description === 'string') updateData.description = args.description;
      if (typeof args.act === 'string') updateData.act = normalizeBeatAct(args.act);
      if (typeof args.beat_type === 'string' && args.beat_type.trim()) updateData.beat_type = args.beat_type.trim();

      if (args.episode_id || args.episode_number || currentEpisodeId) {
        const episodeTarget = await resolveEpisodeIdForDevelop(args, projectId, currentEpisodeId);
        if (episodeTarget.error) return { success: false, error: episodeTarget.error };
        updateData.episode_id = episodeTarget.episodeId;
        resolved.seasonNumber = episodeTarget.seasonNumber;
        resolved.episodeNumber = episodeTarget.episodeNumber;
      }

      if (Object.keys(updateData).length === 0) {
        return { success: false, error: 'No fields to update for update_beat' };
      }

      const { data, error } = await supabase
        .from('beats')
        .update(updateData)
        .eq('id', resolved.beat.id)
        .eq('project_id', projectId)
        .select('id, title, description, episode_id')
        .single();

      if (error) {
        console.error('Studio: Failed to update beat:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Updated beat "${data.title}" in project ${projectId}`);
      return {
        success: true,
        id: data.id,
        name: data.title,
        description: data.description || '',
        entityType: 'beat',
        seasonNumber: resolved.seasonNumber,
        episodeNumber: resolved.episodeNumber,
      };
    }

    if (toolName === 'delete_beat') {
      const resolved = await resolveBeatForDevelop(args, projectId, currentEpisodeId);
      if (resolved.error || !resolved.beat) {
        return { success: false, error: resolved.error || 'Beat not found' };
      }

      const { error } = await supabase
        .from('beats')
        .delete()
        .eq('id', resolved.beat.id)
        .eq('project_id', projectId);

      if (error) {
        console.error('Studio: Failed to delete beat:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Deleted beat "${resolved.beat.title}" from project ${projectId}`);
      return {
        success: true,
        id: resolved.beat.id,
        name: resolved.beat.title,
        description: resolved.beat.description || '',
        entityType: 'beat',
        seasonNumber: resolved.seasonNumber,
        episodeNumber: resolved.episodeNumber,
      };
    }

    if (toolName === 'update_document') {
      const tiptapContent = markdownToTiptap((args.content as string) || '');

      const updateData: Record<string, any> = { content: tiptapContent };
      if (args.title) updateData.title = args.title;

      const { data, error } = await supabase
        .from('project_documents')
        .update(updateData)
        .eq('id', args.document_id)
        .eq('project_id', projectId)
        .select('id, title')
        .single();

      if (error) {
        console.error('❌ Studio: Failed to update document:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`✅ Studio: Updated document "${data.title}"`);
      return { success: true, id: data.id, name: data.title };
    }

    if (toolName === 'create_document') {
      const tiptapContent = markdownToTiptap((args.content as string) || '');

      const docType = args.document_type || 'synopsis';
      const docTitle = args.title || docType.charAt(0).toUpperCase() + docType.slice(1);

      const { data: existingDocs, error: duplicateError } = await supabase
        .from('project_documents')
        .select('id, title, document_type')
        .eq('project_id', projectId);

      if (duplicateError) {
        console.error('Studio: Failed to check duplicate documents:', duplicateError);
        return { success: false, error: duplicateError.message };
      }

      const normalizedTitle = docTitle.trim().toLowerCase();
      const duplicates = (existingDocs || []).filter((doc: any) => {
        const sameTitle = (doc.title || '').trim().toLowerCase() === normalizedTitle;
        const sameType = docType !== 'custom' && doc.document_type === docType;
        return docType === 'custom' ? sameTitle : sameTitle || sameType;
      });

      if (duplicates.length > 1) {
        return { success: false, error: `Multiple documents match "${docTitle}" or type "${docType}". Call get_documents and ask the user which one to update.` };
      }

      if (duplicates.length === 1) {
        const existing = duplicates[0];
        const { data, error } = await supabase
          .from('project_documents')
          .update({
            document_type: docType,
            title: docTitle,
            content: tiptapContent,
          })
          .eq('id', existing.id)
          .eq('project_id', projectId)
          .select('id, title')
          .single();

        if (error) {
          console.error('Studio: Failed to update duplicate document:', error);
          return { success: false, error: error.message };
        }

        if (DEBUG_AI) console.log(`Studio: Updated existing ${docType} document "${data.title}" in project ${projectId}`);
        return { success: true, id: data.id, name: data.title, entityType: 'document', docType };
      }

      const { data, error } = await supabase
        .from('project_documents')
        .insert({
          project_id: projectId,
          document_type: docType,
          title: docTitle,
          content: tiptapContent,
        })
        .select('id, title')
        .single();

      if (error) {
        console.error('❌ Studio: Failed to create document:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`✅ Studio: Created ${docType} document "${data.title}" in project ${projectId}`);
      return { success: true, id: data.id, name: data.title, entityType: 'document', docType };
    }

    if (toolName === 'delete_document') {
      const targetId = typeof args.document_id === 'string' ? args.document_id.trim() : '';
      const targetTitle = typeof args.title === 'string' ? args.title.trim() : '';
      const targetType = typeof args.document_type === 'string' ? args.document_type.trim() : '';

      if (!targetId && !targetTitle && !targetType) {
        return { success: false, error: 'Missing document_id, title, or document_type for delete_document' };
      }

      let existing: { id: string; title: string; document_type?: string | null } | null = null;

      if (targetId) {
        const { data, error } = await supabase
          .from('project_documents')
          .select('id, title, document_type')
          .eq('id', targetId)
          .eq('project_id', projectId)
          .single();

        if (error || !data) {
          return { success: false, error: error?.message || 'Document not found' };
        }
        existing = data;
      } else {
        let query = supabase
          .from('project_documents')
          .select('id, title, document_type')
          .eq('project_id', projectId);

        if (targetTitle) query = query.ilike('title', targetTitle);
        if (targetType) query = query.eq('document_type', targetType);

        const { data, error } = await query;

        if (error) {
          return { success: false, error: error.message };
        }
        if (!data || data.length === 0) {
          return { success: false, error: 'Document not found' };
        }
        if (data.length > 1) {
          return { success: false, error: 'Multiple documents match; call get_documents and ask the user which one to delete' };
        }
        existing = data[0];
      }

      const { error } = await supabase
        .from('project_documents')
        .delete()
        .eq('id', existing.id)
        .eq('project_id', projectId);

      if (error) {
        console.error('Studio: Failed to delete document:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`Studio: Deleted document "${existing.title}" from project ${projectId}`);
      return { success: true, id: existing.id, name: existing.title, entityType: 'document', docType: existing.document_type || 'custom' };
    }

    return { success: false, error: `Unknown tool: ${toolName}` };
  } catch (err: any) {
    console.error(`❌ Studio: Tool execution error (${toolName}):`, err);
    return { success: false, error: err.message };
  }
}

// =============================================================================
// Route
// =============================================================================

router.post(
  '/develop-stream',
  requireAuth,
  extractUserId,
  addPricingService,
  async (req: PricingRequest, res) => {
    const { projectId, message, history = [], openDocumentId, episodeId, approvedDevelopTools = [], resume = false } = req.body;
    const userId = req.userId;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });
    if (!message) return res.status(400).json({ error: 'Missing message' });

    // Verify project ownership
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name, project_type, language, content_language')
      .eq('id', projectId)
      .eq('user_id', userId)
      .eq('deleted', false)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const approvedDevelopToolNames = toApprovedToolSet(approvedDevelopTools);

    if (req.body.conversationId) {
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .select('id, project_id')
        .eq('id', req.body.conversationId)
        .single();

      if (convError || !conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if (conversation.project_id !== projectId) {
        return res.status(403).json({ error: 'Conversation does not belong to this project' });
      }
    }

    const contentLanguage = (project as any).content_language || (project as any).language || 'en';

    // --- SSE Setup ---
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (event: string, data: any) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    let cancelled = false;
    const abortController = new AbortController();
    req.on('close', () => {
      cancelled = true;
      abortController.abort();
    });

    try {
      // Create or reuse conversation
      let activeConversationId = req.body.conversationId as string | null || null;

      if (!activeConversationId) {
        const title = message.length > 50 ? message.substring(0, 50).trim() + '...' : message.trim();
        const { data: newConv } = await supabase
          .from('conversations')
          .insert([{ project_id: projectId, title: title || 'Studio session', phase: 'develop' }])
          .select('id')
          .single();
        if (newConv) activeConversationId = newConv.id;
      }

      // Save user message immediately. When resuming an interrupted turn, the
      // user message is already the last persisted message for this conversation.
      if (activeConversationId && !resume) {
        await supabase.from('conversation_messages').insert([{
          conversation_id: activeConversationId,
          role: 'user',
          content: message,
          token_count: 0,
        }]).then(() => {}, () => {});
      }

      // Build messages
      const openDocContext = openDocumentId
        ? `\n\n[CONTEXT: The user currently has document ID "${openDocumentId}" open in the editor. If they ask to update, change, improve, or rewrite it — call update_document with this ID.]`
        : '';

      let selectedEpisodeContext = '';
      if (episodeId) {
        const { data: selectedEpisode } = await supabase
          .from('episodes')
          .select('title, episode_number, seasons!inner(season_number)')
          .eq('id', episodeId)
          .single();
        const epLabel = selectedEpisode
          ? `S${(selectedEpisode.seasons as any)?.season_number ?? 1}E${selectedEpisode.episode_number} "${selectedEpisode.title}"`
          : `ID "${episodeId}"`;
        selectedEpisodeContext = `\n\n[CONTEXT: The user currently has episode ${epLabel} (ID "${episodeId}") selected. If they ask for beats, structure, synopsis, or story work for "this episode" without naming another one, use this episode_id. When you save or edit beats for a series, ALWAYS name the target episode in your confirmation (e.g. its number and title) so the user knows which episode the beats belong to. If the conversation clearly points to a DIFFERENT episode than the selected one, say which episode you are using before or in the confirmation.]`;
      }

      const messages: any[] = [
        { role: 'system', content: buildDevelopPrompt(contentLanguage, project.project_type || 'film') + openDocContext + selectedEpisodeContext },
        ...history.map((m: any) => ({ role: m.role, content: m.content })),
        { role: 'user', content: message },
      ];

      const routingContext = AIModelRouter.createContext({
        requestType: 'chat',
        inputText: messages.map(m => m.content).join('\n'),
        expectedOutputTokens: 2000,
        hasAttachments: false,
        metadata: { contentScale: 'standard', userPlanId: 'paid' },
      });

      // Agentic tool loop — max 3 rounds
      const MAX_ROUNDS = 3;
      let currentMessages = [...messages];
      let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let answer = '';
      let waitingForApproval = false;

      const studioThinkingSteps: Array<{ key: string; params?: Record<string, string> }> = [];
      const studioEntityCreations: any[] = [];
      const sendStatus = (payload: { key: string; params?: Record<string, string>; tool?: string }) => {
        studioThinkingSteps.push({ key: payload.key, params: payload.params });
        sendEvent('status', payload);
      };

      sendStatus({ key: 'studio.agent.status.analyzing', tool: 'thinking' });

      const confirmedProjectTypeChange = getConfirmedProjectTypeChange(history, message);
      if (confirmedProjectTypeChange) {
        const args = {
          project_type: confirmedProjectTypeChange,
          reason: confirmedProjectTypeChange === 'series'
            ? 'User confirmed they want to create a series structure.'
            : 'User confirmed they want to convert the project to a film.',
        };
        const approvalId = createToolApprovalId('dap');
        pendingDevelopToolApprovals.set(approvalId, {
          userId,
          projectId,
          episodeId,
          toolName: 'change_project_type',
          args,
          createdAt: Date.now(),
        });
        const approvalText = confirmedProjectTypeChange === 'series'
          ? 'Perfecto. Necesito tu autorización para cambiar este proyecto a serie.'
          : 'Perfecto. Necesito tu autorización para cambiar este proyecto a película.';
        answer = approvalText;
        sendEvent('token', { content: approvalText });
        sendEvent('tool_approval_required', {
          id: approvalId,
          toolName: 'change_project_type',
          approvalPath: `/api/ai/studio/develop-tool-approvals/${approvalId}`,
          ...getDevelopToolApprovalSummary('change_project_type', args),
        });

        if (activeConversationId) {
          await supabase.from('conversation_messages').insert([{
            conversation_id: activeConversationId,
            role: 'assistant',
            content: approvalText,
            token_count: 0,
            attachments: {
              studio: {
                thinkingSteps: studioThinkingSteps,
                entityCreations: studioEntityCreations,
              },
            },
          }]).then(() => {}, () => {});
        }

        if (!cancelled) {
          sendEvent('done', { conversationId: activeConversationId });
          res.end();
        }
        return;
      }

      const typeMismatchReply = getProjectTypeMismatchReply(project.project_type || 'film', message);
      if (typeMismatchReply) {
        answer = typeMismatchReply;
        sendEvent('token', { content: typeMismatchReply });

        if (activeConversationId) {
          await supabase.from('conversation_messages').insert([{
            conversation_id: activeConversationId,
            role: 'assistant',
            content: typeMismatchReply,
            token_count: 0,
            attachments: {
              studio: {
                thinkingSteps: studioThinkingSteps,
                entityCreations: studioEntityCreations,
              },
            },
          }]).then(() => {}, () => {});
        }

        if (!cancelled) {
          sendEvent('done', { conversationId: activeConversationId });
          res.end();
        }
        return;
      }

      for (let round = 0; round <= MAX_ROUNDS; round++) {
        if (cancelled) break;

        const isLastRound = round === MAX_ROUNDS;

        const result = await aiRouter.executeStreamingCompletion(
          routingContext,
          {
            messages: currentMessages,
            maxTokens: 2000,
            temperature: 0.8,
            tools: isLastRound ? undefined : DEVELOP_TOOLS,
          },
          {
            onToken: (token: string) => {
              if (!cancelled) {
                answer += token;
                sendEvent('token', { content: token });
              }
            },
            signal: abortController.signal,
          }
        );

        totalUsage.prompt_tokens += result.usage?.prompt_tokens || 0;
        totalUsage.completion_tokens += result.usage?.completion_tokens || 0;
        totalUsage.total_tokens += result.usage?.total_tokens || 0;

        // No tool calls — done
        if (!result.toolCalls || result.toolCalls.length === 0 || result.finishReason === 'stop') {
          break;
        }

        if (DEBUG_AI) {
          console.log(`🔧 Studio develop round ${round + 1}: ${result.toolCalls.length} tool call(s):`,
            result.toolCalls.map((tc: any) => tc.function.name));
        }

        // Add assistant message to loop
        currentMessages.push({
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.toolCalls,
        });

        // Execute tool calls and emit entity_created events
        for (const toolCall of result.toolCalls) {
          if (cancelled) break;

          let args: Record<string, any> = {};
          try {
            args = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            args = {};
          }

          if (requiresToolApproval(DEVELOP_APPROVAL_REQUIRED_TOOLS, toolCall.function.name, approvedDevelopToolNames)) {
            const approvalId = createToolApprovalId('dap');
            pendingDevelopToolApprovals.set(approvalId, {
              userId,
              projectId,
              episodeId,
              toolName: toolCall.function.name,
              args,
              createdAt: Date.now(),
            });
            sendEvent('tool_approval_required', {
              id: approvalId,
              toolName: toolCall.function.name,
              approvalPath: `/api/ai/studio/develop-tool-approvals/${approvalId}`,
              ...getDevelopToolApprovalSummary(toolCall.function.name, args),
            });
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Waiting for user approval to run ${toolCall.function.name}.`,
            });
            waitingForApproval = true;
            // Don't break: keep processing the rest of this turn's tool calls so a
            // batched plan (e.g. "refine to 2 beats" → update, update, delete, delete)
            // surfaces an approval card for EVERY destructive op and still runs the
            // non-destructive ones. Breaking here silently dropped every tool call
            // after the first deletion, so multi-delete/refine only ever applied once.
            continue;
          }

          // Emit a status event with translation key before tool execution
          const toolStatusEvent = (() => {
            const name = args.name || args.title || '';
            switch (toolCall.function.name) {
              case 'create_character': return { key: 'studio.agent.status.creating_character', params: { name } };
              case 'create_location': return { key: 'studio.agent.status.adding_location', params: { name } };
              case 'update_location': return { key: 'studio.agent.status.updating_location', params: { name: args.new_name || name } };
              case 'delete_location': return { key: 'studio.agent.status.deleting_location', params: { name } };
              case 'change_project_type': return { key: 'studio.agent.status.changing_project_type' };
              case 'get_series_structure': return { key: 'studio.agent.status.reading_series' };
              case 'get_beats': return { key: 'studio.agent.status.reading_beats' };
              case 'get_documents': return { key: 'studio.agent.status.reading_documents' };
              case 'get_characters': return { key: 'studio.agent.status.reading_characters' };
              case 'get_locations': return { key: 'studio.agent.status.reading_locations' };
              case 'update_character': return { key: 'studio.agent.status.updating_character', params: { name: args.new_name || name } };
              case 'delete_character': return { key: 'studio.agent.status.deleting_character', params: { name } };
              case 'create_or_update_season': return { key: 'studio.agent.status.updating_season', params: { name } };
              case 'delete_season': return { key: 'studio.agent.status.deleting_season', params: { name } };
              case 'create_episode': return { key: 'studio.agent.status.creating_episode', params: { name } };
              case 'delete_episode': return { key: 'studio.agent.status.deleting_episode', params: { name } };
              case 'update_episode': return { key: 'studio.agent.status.updating_document', params: { name } };
              case 'save_beat': return { key: 'studio.agent.status.saving_beat', params: { name } };
              case 'update_beat': return { key: 'studio.agent.status.updating_beat', params: { name } };
              case 'delete_beat': return { key: 'studio.agent.status.deleting_beat', params: { name } };
              case 'create_document': return { key: 'studio.agent.status.creating_document', params: { type: (args.document_type || 'document').replace(/_/g, ' ') } };
              case 'update_document': return { key: 'studio.agent.status.updating_document' };
              case 'delete_document': return { key: 'studio.agent.status.deleting_document', params: { name } };
              default: return null;
            }
          })();
          if (toolStatusEvent) sendStatus({ ...toolStatusEvent, tool: toolCall.function.name });

          const toolResult = await executeTool(toolCall.function.name, args, projectId, userId, episodeId);

          if (toolResult.success && toolResult.id && toolResult.entityType === 'project') {
            sendEvent('project_updated', {
              id: toolResult.id,
              name: toolResult.name,
              project_type: toolResult.projectType,
              seasonId: toolResult.seasonId,
              episodeId: toolResult.episodeId,
            });
            for (const extraEvent of toolResult.extraEvents || []) {
              studioEntityCreations.push(extraEvent);
              sendEvent('entity_created', extraEvent);
            }
          } else if (toolResult.success && toolResult.id && (toolCall.function.name === 'delete_document' || toolCall.function.name === 'delete_location' || toolCall.function.name === 'delete_character' || toolCall.function.name === 'delete_episode' || toolCall.function.name === 'delete_season' || toolCall.function.name === 'delete_beat')) {
            sendEvent('entity_deleted', {
              type: toolResult.entityType || 'location',
              id: toolResult.id,
              name: toolResult.name || args.name || 'Unknown',
            });
          } else if (toolResult.success && toolResult.id && (toolCall.function.name === 'update_location' || toolCall.function.name === 'update_character')) {
            const entityEvent = {
              type: toolResult.entityType || 'location',
              id: toolResult.id,
              name: toolResult.name || args.new_name || args.name || 'Unknown',
              description: toolResult.description || args.description || '',
            };
            studioEntityCreations.push(entityEvent);
            sendEvent('entity_updated', entityEvent);
          } else if (toolResult.success && toolResult.id) {
            const entityType = toolCall.function.name === 'create_character'
              ? 'character'
                : toolCall.function.name === 'create_location'
                  ? 'location'
                  : (toolCall.function.name === 'create_document' || toolCall.function.name === 'update_document')
                    ? 'document'
                    : toolResult.entityType || 'beat';

            const entityEvent = {
              type: entityType,
              id: toolResult.id,
              name: toolResult.name || args.name || args.title || 'Unknown',
              description: toolResult.description || args.description || '',
              docType: entityType === 'document' ? (toolResult.docType || args.document_type || 'custom') : undefined,
              seasonId: toolResult.seasonId,
              seasonNumber: toolResult.seasonNumber,
              episodeId: toolResult.episodeId,
              episodeNumber: toolResult.episodeNumber,
            };
            studioEntityCreations.push(entityEvent);
            sendEvent('entity_created', entityEvent);
          }

          currentMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.success
              ? toolResult.resultText || `${toolCall.function.name} succeeded. Name: "${toolResult.name}"${toolResult.id ? `. ID: ${toolResult.id}` : ''}${toolResult.description ? `. Summary: ${toolResult.description.slice(0, 120)}` : ''}`
              : `Error in ${toolCall.function.name}: ${toolResult.error}`,
          });
        }
        if (waitingForApproval) break;
      }

      if (activeConversationId && answer) {
        await supabase.from('conversation_messages').insert([{
          conversation_id: activeConversationId,
          role: 'assistant',
          content: answer,
          token_count: totalUsage.completion_tokens,
          attachments: {
            studio: {
              thinkingSteps: studioThinkingSteps,
              entityCreations: studioEntityCreations,
            },
          },
        }]).then(() => {}, () => {});
      }

      if (!cancelled) {
        sendEvent('done', { conversationId: activeConversationId });
        res.end();
      }

    } catch (err: any) {
      if (err.name === 'AbortError') {
        if (!res.writableEnded) res.end();
        return;
      }
      console.error('❌ Studio develop-stream error:', err);
      sendEvent('error', { message: err.message || 'Something went wrong' });
      if (!res.writableEnded) res.end();
    }
  }
);

router.post(
  '/develop-tool-approvals/:approvalId/approve',
  requireAuth,
  extractUserId,
  async (req: PricingRequest, res) => {
    const userId = req.userId;
    const { approvalId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const pending = pendingDevelopToolApprovals.get(approvalId);
    if (!pending || pending.userId !== userId) {
      return res.status(404).json({ error: 'Approval not found or expired' });
    }

    pendingDevelopToolApprovals.take(approvalId);

    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', pending.projectId)
      .eq('user_id', userId)
      .eq('deleted', false)
      .single();

    if (!project) return res.status(404).json({ error: 'Project not found' });

    const toolResult = await executeTool(pending.toolName, pending.args, pending.projectId, userId, pending.episodeId);
    const entityEvents = toolResult.success && toolResult.id
      ? [
        ...(toolResult.entityType === 'project' ? [] : [{
          type: toolResult.entityType || 'entity',
          id: toolResult.id,
          name: toolResult.name || 'Unknown',
          description: toolResult.description || '',
          seasonId: toolResult.seasonId,
          seasonNumber: toolResult.seasonNumber,
          episodeId: toolResult.episodeId,
          episodeNumber: toolResult.episodeNumber,
          docType: toolResult.docType,
        }]),
        ...(toolResult.extraEvents || []),
      ]
      : [];

    return res.json({
      success: toolResult.success,
      error: toolResult.error,
      result: toolResult.resultText || toolResult.name,
      toolName: pending.toolName,
      entityDeleted: pending.toolName.startsWith('delete_'),
      projectUpdated: toolResult.entityType === 'project' ? {
        id: toolResult.id,
        name: toolResult.name,
        project_type: toolResult.projectType,
        seasonId: toolResult.seasonId,
        episodeId: toolResult.episodeId,
      } : undefined,
      entityEvents,
    });
  }
);

router.post(
  '/develop-tool-approvals/:approvalId/deny',
  requireAuth,
  extractUserId,
  async (req: PricingRequest, res) => {
    const userId = req.userId;
    const { approvalId } = req.params;
    pendingDevelopToolApprovals.deny(approvalId, userId);
    return res.json({ success: true });
  }
);

export default router;
