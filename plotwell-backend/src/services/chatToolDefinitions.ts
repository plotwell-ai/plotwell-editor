// Chat Tool Definitions for AI Tool-Use Mode
// Allows the AI model to autonomously fetch project context instead of manual toggles

import { SupabaseClient } from '@supabase/supabase-js';
import { extractTextFromTipTapJSON } from '../utils/aiHelpers';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

// --- Tool Definitions (OpenAI function-calling format) ---

export const CHAT_CONTEXT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_script',
      description: 'Fetch the production screenplay/script content. Use when the user asks about specific scenes, dialogue, script structure, or needs the script for context.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_characters',
      description: 'Fetch character profiles (name, role, age, description). Use when the user asks about characters, arcs, casting, or character relationships.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_locations',
      description: 'Fetch location details (name, type, description). Use when the user asks about settings, locations, filming locations, or where scenes take place.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_beat_sheet',
      description: 'Fetch the story structure / beat sheet (acts, beats, descriptions). Use when the user asks about story structure, pacing, plot points, or narrative arc.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_document',
      description: 'Fetch a project document (treatment, outline, synopsis, logline, or notes). Use when the user asks about the treatment, concept, story overview, or specific project documents.',
      parameters: {
        type: 'object',
        properties: {
          document_type: {
            type: 'string',
            description: 'The type of document to fetch',
            enum: ['treatment', 'outline', 'synopsis', 'logline', 'notes'],
          },
        },
        required: ['document_type'],
      },
    },
  },
];

// --- Context for tool execution ---

export interface ToolExecutionContext {
  projectId: string;
  episodeId?: string;
  scriptEpisodeId?: string;
  supabase: SupabaseClient;
}

// --- Tool Executor ---

export async function executeToolCall(
  toolName: string,
  args: Record<string, any>,
  context: ToolExecutionContext
): Promise<string> {
  switch (toolName) {
    case 'get_script':
      return await fetchScript(context);
    case 'get_characters':
      return await fetchCharacters(context);
    case 'get_locations':
      return await fetchLocations(context);
    case 'get_beat_sheet':
      return await fetchBeatSheet(context);
    case 'get_document':
      return await fetchDocument(context, args.document_type);
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// --- Individual Fetch Functions ---

async function fetchScript(ctx: ToolExecutionContext): Promise<string> {
  try {
    let scriptId: string | null = null;

    // For TV series: prefer scriptEpisodeId (user-selected), fall back to episodeId (current context)
    const effectiveEpisodeId = ctx.scriptEpisodeId || ctx.episodeId;

    if (effectiveEpisodeId) {
      const { data: episode } = await ctx.supabase
        .from('episodes')
        .select('script_id')
        .eq('id', effectiveEpisodeId)
        .single();

      scriptId = episode?.script_id || null;
      if (DEBUG_AI) console.log('🔧 Tool get_script: Episode script_id:', scriptId);
    } else {
      const { data: project } = await ctx.supabase
        .from('projects')
        .select('prod_script_id')
        .eq('id', ctx.projectId)
        .single();

      scriptId = project?.prod_script_id || null;
      if (DEBUG_AI) console.log('🔧 Tool get_script: Project prod_script_id:', scriptId);
    }

    if (!scriptId) {
      return 'No production script has been set for this project. The user needs to mark a script as the production version first.';
    }

    const { data: script, error: scriptError } = await ctx.supabase
      .from('scripts')
      .select('title, content')
      .eq('id', scriptId)
      .single();

    if (scriptError || !script) {
      return 'Could not fetch the production script.';
    }

    const scriptText = extractTextFromTipTapJSON(script.content);
    if (DEBUG_AI) console.log('🔧 Tool get_script: Extracted text length:', scriptText?.length || 0);

    return `=== SCRIPT (Production Version) ===\nTitle: ${script.title}\n${scriptText || 'Empty script'}`;
  } catch (error) {
    console.error('❌ Tool get_script error:', error);
    return 'Error fetching script.';
  }
}

async function fetchCharacters(ctx: ToolExecutionContext): Promise<string> {
  try {
    const { data: characters } = await ctx.supabase
      .from('characters')
      .select('name, description, character_type, primary_role, importance_level, age')
      .eq('project_id', ctx.projectId);

    if (!characters || characters.length === 0) {
      return 'No characters found in this project.';
    }

    const charactersText = characters.map((char: any) =>
      `- ${char.name}${char.primary_role ? ` (${char.primary_role})` : ''}${char.character_type ? ` [${char.character_type}]` : ''}${char.age ? `, age ${char.age}` : ''}: ${char.description || ''}`
    ).join('\n');

    return `=== CHARACTERS ===\n${charactersText}`;
  } catch (error) {
    console.error('❌ Tool get_characters error:', error);
    return 'Error fetching characters.';
  }
}

async function fetchLocations(ctx: ToolExecutionContext): Promise<string> {
  try {
    const { data: locations } = await ctx.supabase
      .from('locations')
      .select('name, description, location_type')
      .eq('project_id', ctx.projectId);

    if (!locations || locations.length === 0) {
      return 'No locations found in this project.';
    }

    const locationsText = locations.map((loc: any) =>
      `- ${loc.name}${loc.location_type ? ` (${loc.location_type})` : ''}: ${loc.description || ''}`
    ).join('\n');

    return `=== LOCATIONS ===\n${locationsText}`;
  } catch (error) {
    console.error('❌ Tool get_locations error:', error);
    return 'Error fetching locations.';
  }
}

async function fetchBeatSheet(ctx: ToolExecutionContext): Promise<string> {
  try {
    let beatQuery = ctx.supabase
      .from('beats')
      .select('act, beat_type, title, description, "order"')
      .eq('project_id', ctx.projectId);

    // For TV series with episode selected, fetch episode beat sheet
    if (ctx.episodeId) {
      beatQuery = beatQuery.eq('episode_id', ctx.episodeId);
    } else {
      // For films or if no episode selected, fetch project beat sheet (no episode_id)
      beatQuery = beatQuery.is('episode_id', null);
    }

    const { data: beats, error: beatError } = await beatQuery.order('order', { ascending: true });

    if (beatError || !beats || beats.length === 0) {
      return 'No beat sheet found for this project.';
    }

    const beatsText = beats.map((beat: any) =>
      `[${beat.act || 'Act'}${beat.beat_type ? ` - ${beat.beat_type}` : ''}] ${beat.title || 'Untitled'}: ${beat.description || ''}`
    ).join('\n');

    return `=== BEAT SHEET (Story Structure) ===\n${beatsText}`;
  } catch (error) {
    console.error('❌ Tool get_beat_sheet error:', error);
    return 'Error fetching beat sheet.';
  }
}

async function fetchDocument(ctx: ToolExecutionContext, documentType: string): Promise<string> {
  try {
    const { data: documents } = await ctx.supabase
      .from('project_documents')
      .select('title, document_type, content')
      .eq('project_id', ctx.projectId)
      .eq('document_type', documentType);

    if (!documents || documents.length === 0) {
      return `No ${documentType} document found in this project.`;
    }

    // Return the first matching document
    const doc = documents[0];
    let contentText = '';
    if (doc.content) {
      contentText = typeof doc.content === 'string' ? doc.content : extractTextFromTipTapJSON(doc.content);
    }

    return `=== DOCUMENT: ${doc.title || documentType.toUpperCase()} ===\n${contentText || 'Empty document'}`;
  } catch (error) {
    console.error('❌ Tool get_document error:', error);
    return `Error fetching ${documentType} document.`;
  }
}
