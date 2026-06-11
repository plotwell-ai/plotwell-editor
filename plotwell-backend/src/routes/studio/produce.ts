/**
 * Studio v2 - Produce Phase Stream
 *
 * Agentic production planning endpoint. The AI can read the script breakdown
 * and create/update production assets (props, wardrobe, vehicles, VFX, etc.)
 * and budget lines directly in the DB.
 *
 * Tools: get_script_outline, get_breakdown_summary, add_asset,
 *        link_asset_to_scene, update_budget_line
 */

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '../../middleware/auth';
import { extractUserId, addPricingService, PricingRequest } from '../../middleware/pricingMiddleware';
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { extractTextFromTipTapJSON } from '../../utils/aiHelpers';
import { isEpisodic } from '../../utils/projectType';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// =============================================================================
// Tool definitions
// =============================================================================

const PRODUCE_TOOLS: { type: 'function'; function: { name: string; description: string; parameters: Record<string, any> } }[] = [
  {
    type: 'function',
    function: {
      name: 'get_script_outline',
      description: 'Get a numbered list of all scene headings in the script, with INT/EXT and location. Use to understand what scenes need production planning.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_breakdown_summary',
      description: 'Get a summary of existing production assets in this project grouped by department (props, wardrobe, vehicles, etc.).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_budget_summary',
      description: 'Get the current budget breakdown by department.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_asset',
      description: 'Add a production asset to the project (prop, wardrobe piece, vehicle, VFX element, etc.). Creates it in the asset registry.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Asset name, e.g. "Detective badge", "1970s Ford Mustang"' },
          department: {
            type: 'string',
            enum: ['props', 'wardrobe', 'vehicles', 'vfx', 'stunts', 'makeup', 'sound', 'special_effects', 'animals', 'other'],
            description: 'Production department this asset belongs to',
          },
          description: { type: 'string', description: 'Brief description of the asset' },
          quantity: { type: 'integer', description: 'Number of units needed (default 1)' },
          notes: { type: 'string', description: 'Any notes about sourcing, handling, etc.' },
        },
        required: ['name', 'department'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_budget_line',
      description: 'Create or update a budget line item for a department. Amount is in whole currency units (not cents).',
      parameters: {
        type: 'object',
        properties: {
          department: { type: 'string', description: 'Department name, e.g. "Camera", "Art Department", "Cast"' },
          category: { type: 'string', description: 'Budget category, e.g. "Equipment Rental", "Daily Rates", "Materials"' },
          description: { type: 'string', description: 'Line item description' },
          estimated_amount: { type: 'number', description: 'Estimated amount in currency units (e.g. 1500 for $1,500)' },
          notes: { type: 'string', description: 'Any notes about this budget item' },
        },
        required: ['department', 'category', 'description', 'estimated_amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_production_notes',
      description: 'Add or update production notes for a specific scene (complexity, special requirements, crew notes).',
      parameters: {
        type: 'object',
        properties: {
          scene_number: { type: 'integer', description: 'The 1-based scene number' },
          notes: { type: 'string', description: 'Production notes for this scene' },
          complexity: {
            type: 'string',
            enum: ['simple', 'medium', 'complex'],
            description: 'Scene complexity for scheduling',
          },
          estimated_shoot_days: {
            type: 'number',
            description: 'Estimated days to shoot this scene (can be fractional, e.g. 0.5)',
          },
        },
        required: ['scene_number', 'notes'],
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

function buildProducePrompt(contentLanguage: string): string {
  const langName = LANGUAGE_NAMES[contentLanguage] || 'English';
  return `You are a production planning agent for a film/TV project. You READ the script and BUILD the production breakdown — not just chat about it.

## YOUR JOB
- Analyze the script to identify what's needed for production
- Create production assets (props, wardrobe, vehicles, VFX, etc.)
- Build budget estimates based on script requirements
- Add production notes and complexity estimates to scenes

## TOOL USAGE
- Start with get_script_outline to understand the project scope
- Use get_breakdown_summary to see what's already been catalogued
- add_asset: create an asset in the production registry — be specific and practical
- update_budget_line: create budget estimates by department
- update_production_notes: add scene-level production information

## APPROACH
When the user asks to "break down" or "analyze" the script:
1. Call get_script_outline
2. Systematically add assets per department (props → wardrobe → vehicles → VFX)
3. Add budget estimates for the main departments
4. Give a summary of what was created

## SCREENPLAY LANGUAGE
Asset names and production notes should reference the script content in ${langName}.
Your conversational replies to the user can match the language they write in.

## RESPONSE STYLE
- Be specific and practical — name real assets, realistic budget numbers
- After creating items: summarize by department ("Added 8 props, 3 wardrobe pieces, 2 vehicles")`;
}

// =============================================================================
// Script helpers (same as write.ts)
// =============================================================================

async function getScriptForProject(projectId: string, episodeId?: string) {
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

  const content = script.content || { type: 'doc', content: [] };
  return { scriptId, content, nodes: content.content || [] };
}

// =============================================================================
// Tool executor
// =============================================================================

async function executeProduceTool(
  toolName: string,
  args: Record<string, any>,
  projectId: string,
  userId: string,
  episodeId?: string
): Promise<{ success: boolean; result?: string; eventType?: string; eventData?: any; error?: string }> {
  try {
    if (toolName === 'get_script_outline') {
      const info = await getScriptForProject(projectId, episodeId);
      if (!info) return { success: true, result: 'No production script set. Ask the user to set a production script.' };

      const nodes: any[] = info.nodes;
      let count = 0;
      const lines: string[] = [];

      for (const node of nodes) {
        if (node.type === 'sceneHeading') {
          count++;
          const text = node.content?.map((c: any) => c.text || '').join('') || '';
          lines.push(`${count}. ${text}`);
        }
      }

      if (lines.length === 0) return { success: true, result: 'Script is empty.' };
      return { success: true, result: `${lines.length} scenes:\n${lines.join('\n')}` };
    }

    if (toolName === 'get_breakdown_summary') {
      const { data: assets } = await supabase
        .from('production_assets')
        .select('name, department, description, quantity, status')
        .eq('project_id', projectId)
        .order('department');

      if (!assets || assets.length === 0) {
        return { success: true, result: 'No production assets yet.' };
      }

      const byDept = assets.reduce((acc: Record<string, any[]>, a) => {
        if (!acc[a.department]) acc[a.department] = [];
        acc[a.department].push(a);
        return acc;
      }, {});

      const lines = Object.entries(byDept).map(([dept, items]) =>
        `${dept.toUpperCase()} (${items.length}):\n${items.map(i => `  - ${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}${i.description ? `: ${i.description}` : ''}`).join('\n')}`
      );

      return { success: true, result: lines.join('\n\n') };
    }

    if (toolName === 'get_budget_summary') {
      const { data: lines } = await supabase
        .from('production_budgets')
        .select('department, category, description, estimated_amount')
        .eq('project_id', projectId)
        .order('department');

      if (!lines || lines.length === 0) {
        return { success: true, result: 'No budget lines yet.' };
      }

      const byDept = lines.reduce((acc: Record<string, any[]>, l) => {
        if (!acc[l.department]) acc[l.department] = [];
        acc[l.department].push(l);
        return acc;
      }, {});

      const deptTotals = Object.entries(byDept).map(([dept, items]) => {
        const total = items.reduce((sum, i) => sum + (i.estimated_amount || 0), 0);
        return `${dept}: ${items.map(i => `${i.category} — ${i.description} ($${(i.estimated_amount / 100).toLocaleString()})`).join(', ')} | Subtotal: $${(total / 100).toLocaleString()}`;
      });

      const grandTotal = lines.reduce((sum, l) => sum + (l.estimated_amount || 0), 0);
      return { success: true, result: `Budget Summary:\n${deptTotals.join('\n')}\n\nGrand Total: $${(grandTotal / 100).toLocaleString()}` };
    }

    if (toolName === 'add_asset') {
      const { data: asset, error } = await supabase
        .from('production_assets')
        .insert({
          project_id: projectId,
          name: args.name,
          department: args.department,
          description: args.description || '',
          quantity: args.quantity || 1,
          notes: args.notes || '',
          status: 'needed',
        })
        .select('id, name, department')
        .single();

      if (error) {
        console.error('❌ Studio produce: add_asset error:', error);
        return { success: false, error: error.message };
      }

      if (DEBUG_AI) console.log(`✅ Studio produce: added asset "${asset.name}" (${asset.department})`);
      return {
        success: true,
        result: `Asset "${asset.name}" added to ${asset.department}.`,
        eventType: 'breakdown_updated',
        eventData: { assetId: asset.id, name: asset.name, department: asset.department },
      };
    }

    if (toolName === 'update_budget_line') {
      // Convert currency units to cents
      const amountCents = Math.round((args.estimated_amount || 0) * 100);

      // Upsert: match on project + department + category + description
      const { data: existing } = await supabase
        .from('production_budgets')
        .select('id')
        .eq('project_id', projectId)
        .eq('department', args.department)
        .eq('category', args.category)
        .eq('description', args.description)
        .single();

      let lineId: string;

      if (existing) {
        await supabase
          .from('production_budgets')
          .update({ estimated_amount: amountCents, notes: args.notes || '' })
          .eq('id', existing.id);
        lineId = existing.id;
      } else {
        const { data: newLine, error } = await supabase
          .from('production_budgets')
          .insert({
            project_id: projectId,
            user_id: userId,
            department: args.department,
            category: args.category,
            description: args.description,
            estimated_amount: amountCents,
            notes: args.notes || '',
          })
          .select('id')
          .single();

        if (error) {
          console.error('❌ Studio produce: update_budget_line error:', error);
          return { success: false, error: error.message };
        }
        lineId = newLine.id;
      }

      if (DEBUG_AI) console.log(`✅ Studio produce: budget line ${args.department}/${args.category} = $${args.estimated_amount}`);
      return {
        success: true,
        result: `Budget line: ${args.department} / ${args.category} — ${args.description}: $${args.estimated_amount.toLocaleString()}`,
        eventType: 'budget_updated',
        eventData: { lineId, department: args.department, category: args.category, amount: amountCents },
      };
    }

    if (toolName === 'update_production_notes') {
      const info = await getScriptForProject(projectId, episodeId);
      if (!info) return { success: false, error: 'No production script found.' };

      // Find the scene number → scene_id
      let sceneCount = 0;
      let sceneId: string | null = null;

      for (const node of info.nodes) {
        if (node.type === 'sceneHeading') {
          sceneCount++;
          if (sceneCount === args.scene_number) {
            // Generate the same scene_id hash used elsewhere (use scene number as fallback)
            sceneId = `scene_${args.scene_number}`;
            break;
          }
        }
      }

      if (!sceneId) return { success: false, error: `Scene ${args.scene_number} not found.` };

      // Upsert production_scene_data
      const { data: existing } = await supabase
        .from('production_scene_data')
        .select('id')
        .eq('project_id', projectId)
        .eq('scene_number', args.scene_number)
        .eq('script_id', info.scriptId)
        .single();

      if (existing) {
        await supabase
          .from('production_scene_data')
          .update({
            production_notes: args.notes,
            ...(args.complexity ? { complexity: args.complexity } : {}),
            ...(args.estimated_shoot_days ? { estimated_shoot_days: args.estimated_shoot_days } : {}),
          })
          .eq('id', existing.id);
      } else {
        await supabase.from('production_scene_data').insert({
          project_id: projectId,
          user_id: userId,
          script_id: info.scriptId,
          scene_number: args.scene_number,
          scene_id: sceneId,
          ...(episodeId ? { episode_id: episodeId } : {}),
          production_notes: args.notes,
          complexity: args.complexity || 'medium',
          estimated_shoot_days: args.estimated_shoot_days || 1,
        });
      }

      if (DEBUG_AI) console.log(`✅ Studio produce: production notes updated for scene ${args.scene_number}`);
      return {
        success: true,
        result: `Scene ${args.scene_number} production notes updated.`,
        eventType: 'breakdown_updated',
        eventData: { sceneNumber: args.scene_number },
      };
    }

    return { success: false, error: `Unknown tool: ${toolName}` };
  } catch (err: any) {
    console.error(`❌ Studio produce tool error (${toolName}):`, err);
    return { success: false, error: err.message };
  }
}

// =============================================================================
// Route
// =============================================================================

router.post(
  '/plan-stream',
  requireAuth,
  extractUserId,
  addPricingService,
  async (req: PricingRequest, res) => {
    const { projectId, message, history = [], conversationId, episodeId, resume = false } = req.body;
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
      let activeConvId = conversationId as string | null || null;

      if (!activeConvId) {
        const title = message.length > 50 ? message.substring(0, 50).trim() + '...' : message.trim();
        const { data: conv } = await supabase
          .from('conversations')
          .insert([{ project_id: projectId, title, phase: 'plan' }])
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
        { role: 'system', content: buildProducePrompt(contentLanguage) },
        ...history.map((m: any) => ({ role: m.role, content: m.content })),
        { role: 'user', content: message },
      ];

      const routingCtx = AIModelRouter.createContext({
        requestType: 'chat',
        inputText: messages.map(m => m.content).join('\n'),
        expectedOutputTokens: 1000,
        hasAttachments: false,
        metadata: { contentScale: 'standard', userPlanId: 'paid' },
      });

      const MAX_ROUNDS = 6;
      let current = [...messages];
      let answer = '';
      const studioThinkingSteps: Array<{ key: string; params?: Record<string, string> }> = [];
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
            maxTokens: 1000,
            temperature: 0.6,
            tools: isLast ? undefined : PRODUCE_TOOLS,
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
          console.log(`🔧 Studio produce round ${round + 1}: ${result.toolCalls.map((t: any) => t.function.name).join(', ')}`);
        }

        current.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls });

        for (const toolCall of result.toolCalls) {
          if (cancelled) break;

          let args: Record<string, any> = {};
          try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { args = {}; }
          sendStatus({
            key: 'studio.agent.status.using_tool',
            params: { tool: toolCall.function.name },
            tool: toolCall.function.name,
          });

          const toolResult = await executeProduceTool(toolCall.function.name, args, projectId, userId, episodeId);

          if (toolResult.eventType) {
            send(toolResult.eventType, toolResult.eventData);
          }

          current.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.success
              ? (toolResult.result || 'Done.')
              : `Error: ${toolResult.error}`,
          });
        }
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
      console.error('❌ Studio produce-stream error:', err);
      send('error', { message: err.message || 'Something went wrong' });
      if (!res.writableEnded) res.end();
    }
  }
);

export default router;
