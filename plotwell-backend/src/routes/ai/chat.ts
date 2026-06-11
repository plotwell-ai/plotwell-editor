// filepath: src/routes/ai/chat.ts
import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { requireAuth } from "../../middleware/auth";
import { extractUserId, addPricingService, PricingRequest } from "../../middleware/pricingMiddleware";
import { addAIUsageTracker, extractProjectId, trackOpenAIUsageInRoute, AITrackingRequest } from "../../middleware/aiUsageMiddleware";
import { fullRequestClassification, ClassifiedRequest } from "../../middleware/requestClassificationMiddleware";
import { AITokenService } from '../../services/aiTokenService';
import { ContextOptimizer } from '../../services/contextOptimizer';
import { getUserId, loadProjectLanguageSettings, buildLanguageInstructions, isEditorContentEmpty, extractTextFromTipTapJSON } from '../../utils/aiHelpers';
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { AIRoutingLogger } from '../../services/aiRoutingLogger';
import { ScriptParsingService } from '../../services/scriptParsingService';
import { CHAT_CONTEXT_TOOLS, executeToolCall } from '../../services/chatToolDefinitions';
import {
  getBrainstormingPrompts,
  getContextPrompts,
  TOOL_USE_INSTRUCTIONS,
  SYSTEM_MESSAGE_DEFAULT,
  CHAT_LANGUAGE_POLICY,
} from '../../prompts';
import { isEpisodic } from '../../utils/projectType';

dotenv.config();

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const replicateApiToken = process.env.REPLICATE_API_TOKEN;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

if (!replicateApiToken) {
  throw new Error("Missing Replicate API token");
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function verifyProjectWriteAccess(projectId: string, userId: string) {
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id, deleted')
    .eq('id', projectId)
    .single();

  if (projectError || !project || project.deleted) {
    return { ok: false, status: 404, error: 'Project not found' };
  }

  if (project.user_id === userId) {
    return { ok: true };
  }

  const { data: collaborator } = await supabase
    .from('project_collaborators')
    .select('role, status')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single();

  if (!collaborator || collaborator.status !== 'active') {
    return { ok: false, status: 403, error: 'Access denied - not authorized for this project' };
  }

  if (collaborator.role === 'viewer') {
    return { ok: false, status: 403, error: 'Read-only access - viewers cannot chat in this project' };
  }

  return { ok: true };
}

async function verifyConversationBelongsToProject(conversationId: string, projectId: string) {
  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('id, project_id')
    .eq('id', conversationId)
    .single();

  if (error || !conversation) {
    return { ok: false, status: 404, error: 'Conversation not found' };
  }

  if (conversation.project_id !== projectId) {
    return { ok: false, status: 403, error: 'Conversation does not belong to this project' };
  }

  return { ok: true };
}

// Chat-script endpoint
router.post("/chat-script", requireAuth, extractUserId, addPricingService, ...fullRequestClassification('chat'), addAIUsageTracker, extractProjectId, async (req: AITrackingRequest & ClassifiedRequest & PricingRequest, res) => {
  const {
    context,
    projectId,
    projectType,
    content,
    question,
    questionForAI,
    history,
    conversationId,
    attachments,  // Document attachments array
    // Context toggle flags
    includeCharacters,
    includeLocations,
    includeBeatSheet,
    includeScript,
    episodeId,  // For TV series: current episode being edited
    scriptEpisodeId,  // For TV series: specifically selected episode for script context
    useToolMode,  // Tool-use mode: AI autonomously fetches context via function calling
  } = req.body;

  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!projectId) {
    return res.status(400).json({ error: 'Missing projectId' });
  }

  const projectAccess = await verifyProjectWriteAccess(projectId, userId);
  if (!projectAccess.ok) {
    return res.status(projectAccess.status).json({ error: projectAccess.error });
  }

  if (conversationId) {
    const conversationAccess = await verifyConversationBelongsToProject(conversationId, projectId);
    if (!conversationAccess.ok) {
      return res.status(conversationAccess.status).json({ error: conversationAccess.error });
    }
  }

  // Get user's subscription to determine attachment limits and model routing
  const pricingService = req.pricingService;
  if (!pricingService) {
    return res.status(500).json({ error: 'Pricing service not initialized' });
  }

  const subscription = await pricingService.getUserSubscription(userId);
  const planId = subscription?.plan_id || 'free';
  const isFreeUser = planId === 'free';

  // ⚠️ CONTEXT LIMIT: Count context toggles for free users (manual mode only)
  // In tool-use mode, the limit is enforced per-tool-call inside the loop
  if (!useToolMode) {
    let contextCount = 0;
    if (includeCharacters) contextCount++;
    if (includeLocations) contextCount++;
    if (includeBeatSheet) contextCount++;
    if (includeScript) contextCount++;

    if (isFreeUser && contextCount > 2) {
      return res.status(403).json({
        error: 'context_limit_exceeded',
        message: 'Free plan allows maximum 2 context items. Upgrade for unlimited context.',
        maxContext: 2,
        currentContext: contextCount,
        planId: 'free',
        action_required: 'upgrade'
      });
    }
  }

  // Log request details for debugging
  if (DEBUG_AI) {
    console.log('🧠 CHAT REQUEST:', {
      context,
      projectType,
      questionLength: question?.length || 0,
      historyLength: history?.length || 0,
      contextToggles: { includeCharacters, includeLocations, includeBeatSheet, includeScript },
      hasAttachments: !!(attachments?.length),
      episodeId: episodeId || null
    });
  }

  // MODE SELECTION
  let contextPrompt = "";
  let formatInstructions = "";
  let contentLabel = "";
  if (context === "brainstorming") {
    const brainstorming = getBrainstormingPrompts(projectType);
    contextPrompt = brainstorming.role;
    formatInstructions = brainstorming.format;
  } else if (context === "project_concept" && projectType === "film") {
    const ctx = getContextPrompts(context, projectType);
    contextPrompt = ctx.role;
    formatInstructions = ctx.format;
    contentLabel = ctx.contentLabel;
  } else if (context === "script" && projectType === "film") {
    const ctx = getContextPrompts(context, projectType);
    contextPrompt = ctx.role;
    formatInstructions = ctx.format;
    contentLabel = ctx.contentLabel;
  } else {
    const ctx = getContextPrompts(context, projectType);
    contextPrompt = ctx.role;
    formatInstructions = ctx.format;
    contentLabel = ctx.contentLabel;
  }

  // Log selected mode
  if (DEBUG_AI) {
    const modeSelected = context === "brainstorming"
      ? (projectType === "film" ? "brainstorming-film" : projectType === "vertical_series" ? "brainstorming-vertical" : isEpisodic(projectType) ? "brainstorming-series" : "brainstorming-fallback")
      : `${context}-${projectType}`;
    console.log('🎬 CHAT MODE SELECTED:', modeSelected);
  }

  // 🧠 Compose user content - use questionForAI if available (includes attachments), otherwise use question
  const actualQuestion = questionForAI || question;
  let userContent = "";

  // Build attachments section if any documents/scenes are attached
  let attachmentsSection = "";
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    if (DEBUG_AI) {
      console.log('📎 ATTACHMENTS RECEIVED:', JSON.stringify(attachments.map((a: any) => ({
        type: a.type,
        scene_number: a.scene_number,
        title: a.title,
        contentLength: a.content?.length || 0,
        contentPreview: a.content?.substring(0, 100)
      })), null, 2));
    }

    const attachmentParts: string[] = [];

    for (const att of attachments) {
      if (att.type === 'scene') {
        // For scenes, ALWAYS fetch fresh content from backend using scene_number
        // Frontend content is often incomplete or empty
        let sceneContent = '';
        const sceneNumber = att.scene_number;
        const sceneTitle = att.title || `Scene ${sceneNumber}`;

        if (DEBUG_AI) console.log(`📎 Processing scene attachment: scene_number=${sceneNumber}, frontendContentLength=${att.content?.length || 0}`);

        // Always fetch from backend to ensure we have complete scene content
        try {
          const userId = getUserId(req);
          if (DEBUG_AI) console.log(`📎 Fetching scene from backend: projectId=${projectId}, userId=${userId}, sceneNumber=${sceneNumber}`);

          if (userId && projectId && sceneNumber) {
            const scriptData = await ScriptParsingService.parseScriptFromProject(projectId, userId);
            if (DEBUG_AI) console.log(`📎 ScriptParsingService returned: ${scriptData ? `${scriptData.scenes?.length || 0} scenes` : 'null'}`);

            if (scriptData?.scenes) {
              const scene = scriptData.scenes.find((s: any) => s.scene_number === sceneNumber);
              if (DEBUG_AI) console.log(`📎 Found scene ${sceneNumber}: ${scene ? 'YES' : 'NO'}`);

              if (scene) {
                sceneContent = `${scene.heading}\n\n${scene.action_content}`;
                if (scene.characters && scene.characters.length > 0) {
                  sceneContent += `\n\nCharacters in scene: ${scene.characters.join(', ')}`;
                }
                if (DEBUG_AI) console.log(`📎 Built scene content: ${sceneContent.length} chars`);
              }
            }
          }
        } catch (error) {
          console.error('📎 ERROR fetching scene from backend:', error);
        }

        // Fallback to frontend content if backend fetch failed
        if (!sceneContent && att.content) {
          sceneContent = att.content;
          if (DEBUG_AI) console.log(`📎 Using frontend content as fallback: ${sceneContent.length} chars`);
        }

        if (sceneContent && sceneContent.length > 50) {
          attachmentParts.push(`--- ATTACHED SCENE: ${sceneTitle} ---\n${sceneContent}\n--- END ATTACHED SCENE ---`);
          if (DEBUG_AI) console.log(`📎 Added scene to attachmentParts`);
        } else {
          if (DEBUG_AI) console.log(`📎 Scene content too short or empty, NOT adding to attachmentParts`);
        }
      } else {
        // For documents, use the provided content
        const title = att.title || 'Untitled Document';
        const docContent = att.content || '';
        if (docContent) {
          attachmentParts.push(`--- ATTACHED DOCUMENT: ${title} ---\n${docContent}\n--- END ATTACHED DOCUMENT ---`);
        }
      }
    }

    if (attachmentParts.length > 0) {
      attachmentsSection = `\n\n📎 USER HAS ATTACHED THE FOLLOWING CONTENT FOR CONTEXT:\n\n${attachmentParts.join('\n\n')}\n\n⚠️ IMPORTANT: Focus your response on the attached content above. The user is specifically asking about this content.\n\n`;
      if (DEBUG_AI) console.log(`📎 FINAL attachmentsSection length: ${attachmentsSection.length} chars`);
    }
  }

  if (context === "brainstorming") {
    // For brainstorming, include attachments prominently before the question
    userContent = attachmentsSection ? `${attachmentsSection}User question:\n${actualQuestion}` : `User question:\n${actualQuestion}`;
    if (DEBUG_AI) console.log(`📎 FINAL userContent includes attachments: ${attachmentsSection ? 'YES' : 'NO'}, total length: ${userContent.length}`);
  } else {
    // For other contexts (legacy support)
    userContent = `${contentLabel}:\n${JSON.stringify(content, null, 2)}\n\nUser question:\n${actualQuestion}`;
  }

  // Completion call
  try {
    // Calculate dynamic token limits based on project context
    let projectContext;
    try {
      projectContext = await AITokenService.buildProjectContext(
        projectId,
        supabase,
        false,  // don't include script (handled by context toggles)
        false   // don't include concept (handled by attachments)
      );
    } catch (error) {
      // Fallback if project lookup fails
      projectContext = {
        projectType: (projectType as 'film' | 'series') || 'film',
        conceptContent: null,
        scriptContent: content
      };
    }

    // IMPORTANT: Clear characters/locations from projectContext if toggles are off
    // This prevents ContextOptimizer from including them when user didn't request them
    if (!includeCharacters) {
      projectContext.characters = [];
    }
    if (!includeLocations) {
      projectContext.locations = [];
    }

    // Use ContextOptimizer if request classification is available
    let optimizedContext = null;
    if (req.requestClassification) {
      const options = ContextOptimizer.createOptimizationOptions(
        'chat',
        req.requestClassification.estimatedTokens,
        req.requestClassification.complexity
      );

      optimizedContext = ContextOptimizer.optimizeContext(
        projectContext,
        actualQuestion,
        options,
        history
      );

    }

    // Fetch and add context based on toggle flags (skipped in tool-use mode)
    let contextualUserContent = userContent;
    let additionalContext = '';

    // In tool-use mode, skip manual context loading - AI will fetch via tools
    if (useToolMode && context === 'brainstorming') {
      if (DEBUG_AI) console.log('🔧 TOOL MODE: Skipping toggle-based context loading - AI will fetch via function calling');
    }

    // Fetch SCRIPT if toggled (uses production script - prod_script_id)
    // BUT skip if user has attached specific scenes - those take priority
    const hasAttachedScenes = attachments?.some((att: any) => att.type === 'scene');
    const skipToggles = useToolMode && context === 'brainstorming';
    if (!skipToggles && hasAttachedScenes && includeScript) {
      if (DEBUG_AI) console.log('📜 SCRIPT TOGGLE SKIPPED - User has attached specific scenes, those take priority');
    }
    if (!skipToggles && includeScript && projectId && !hasAttachedScenes) {
      if (DEBUG_AI) console.log('📜 SCRIPT TOGGLE ENABLED - Fetching production script for project:', projectId);
      try {
        let scriptId: string | null = null;

        // For TV series: prefer scriptEpisodeId (user-selected), fall back to episodeId (current context)
        const effectiveEpisodeId = scriptEpisodeId || episodeId;

        if (effectiveEpisodeId) {
          // For TV series with episode selected, get the episode's script_id
          const { data: episode } = await supabase
            .from('episodes')
            .select('script_id')
            .eq('id', effectiveEpisodeId)
            .single();

          scriptId = episode?.script_id || null;
          if (DEBUG_AI) console.log('📜 Episode script_id:', scriptId, '(from:', scriptEpisodeId ? 'user selection' : 'current context', ')');
        } else {
          // For films or no episode, get project's prod_script_id
          const { data: project } = await supabase
            .from('projects')
            .select('prod_script_id')
            .eq('id', projectId)
            .single();

          scriptId = project?.prod_script_id || null;
          if (DEBUG_AI) console.log('📜 Project prod_script_id:', scriptId);
        }

        if (scriptId) {
          // Fetch the production script by ID
          const { data: script, error: scriptError } = await supabase
            .from('scripts')
            .select('title, content')
            .eq('id', scriptId)
            .single();

          if (DEBUG_AI) console.log('📜 PRODUCTION SCRIPT RESULT:', {
            found: !!script,
            error: scriptError?.message,
            title: script?.title,
            contentExists: !!script?.content
          });

          if (!scriptError && script) {
            const scriptText = extractTextFromTipTapJSON(script.content);
            if (DEBUG_AI) console.log('📜 EXTRACTED SCRIPT TEXT LENGTH:', scriptText?.length || 0);
            additionalContext += `\n\n=== SCRIPT (Production Version) ===\nTitle: ${script.title}\n${scriptText || 'Empty script'}`;
          }
        } else {
          if (DEBUG_AI) console.log('📜 NO PRODUCTION SCRIPT SET - user needs to mark a script as production');
        }
      } catch (error) {
        console.error('Error fetching production script:', error);
      }
    }

    // Fetch CHARACTERS if toggled
    if (!skipToggles && includeCharacters && projectId) {
      try {
        const { data: characters } = await supabase
          .from('characters')
          .select('name, description, character_type, primary_role, importance_level, age')
          .eq('project_id', projectId);

        if (characters && characters.length > 0) {
          const charactersText = characters.map((char: any) =>
            `- ${char.name}${char.primary_role ? ` (${char.primary_role})` : ''}${char.character_type ? ` [${char.character_type}]` : ''}${char.age ? `, age ${char.age}` : ''}: ${char.description || ''}`
          ).join('\n');
          additionalContext += `\n\n=== CHARACTERS ===\n${charactersText}`;
        }
      } catch (error) {
        console.error('Error fetching characters:', error);
      }
    }

    // Fetch LOCATIONS if toggled
    if (!skipToggles && includeLocations && projectId) {
      try {
        const { data: locations } = await supabase
          .from('locations')
          .select('name, description, location_type')
          .eq('project_id', projectId);

        if (locations && locations.length > 0) {
          const locationsText = locations.map((loc: any) =>
            `- ${loc.name}${loc.location_type ? ` (${loc.location_type})` : ''}: ${loc.description || ''}`
          ).join('\n');
          additionalContext += `\n\n=== LOCATIONS ===\n${locationsText}`;
        }
      } catch (error) {
        console.error('Error fetching locations:', error);
      }
    }

    // Fetch BEAT SHEET if toggled (episode-specific for TV series)
    if (!skipToggles && includeBeatSheet && projectId) {
      try {
        let beatQuery = supabase
          .from('beats')
          .select('act, beat_type, title, description, "order"')
          .eq('project_id', projectId);

        // For TV series with episode selected, fetch episode beat sheet
        if (episodeId) {
          beatQuery = beatQuery.eq('episode_id', episodeId);
        } else {
          // For films or if no episode selected, fetch project beat sheet (no episode_id)
          beatQuery = beatQuery.is('episode_id', null);
        }

        const { data: beats, error: beatError } = await beatQuery.order('order', { ascending: true });

        if (!beatError && beats && beats.length > 0) {
          const beatsText = beats.map((beat: any) =>
            `[${beat.act || 'Act'}${beat.beat_type ? ` - ${beat.beat_type}` : ''}] ${beat.title || 'Untitled'}: ${beat.description || ''}`
          ).join('\n');
          additionalContext += `\n\n=== BEAT SHEET (Story Structure) ===\n${beatsText}`;
        }
      } catch (error) {
        console.error('Error fetching beat sheet:', error);
      }
    }

    // Add all fetched context to user content
    contextualUserContent += additionalContext;

    // Tool-use instructions appended to system prompt when in auto mode
    const toolUseInstructions = (useToolMode && context === 'brainstorming') ? TOOL_USE_INSTRUCTIONS : '';

    // Use optimized context if available, otherwise use traditional approach
    let messages;
    if (optimizedContext) {
      // Use context-optimized prompts (with additional toggle context added)
      // IMPORTANT: Include attachmentsSection (scenes/documents) that was built earlier
      const finalUserPrompt = attachmentsSection + optimizedContext.userPrompt + additionalContext;

      messages = [
        {
          role: "system",
          content: `${optimizedContext.systemPrompt}

          ${CHAT_LANGUAGE_POLICY}

          ${formatInstructions}
          ${toolUseInstructions}
          `
        },
        // Include optimized conversation history if available
        ...(optimizedContext.contextData.conversation || []).map((msg: any) => ({
          role: msg.role,
          content: msg.content,
        })),
        {
          role: "user",
          content: finalUserPrompt,  // NOW INCLUDES TOGGLE CONTEXT
        },
      ];
    } else {
      // Use traditional context construction
      messages = [
        {
          role: "system",
          content: `
            ${SYSTEM_MESSAGE_DEFAULT}

            ${contextPrompt}
            ${formatInstructions}
            ${toolUseInstructions}
          `,
        },
        ...(history || []).map((msg: any) => ({
          role: msg.role,
          content: msg.content,
        })),
        {
          role: "user",
          content: contextualUserContent,
        },
      ];
    }

    let tokenLimits = AITokenService.calculateTokenLimits('chat', projectContext);

    // Brainstorming chat: conversational by default, but flexible for idea generation
    // Scale token limit based on context attached - allows for richer idea lists when needed
    if (context === "brainstorming") {
      const isPaidUser = planId !== 'free';
      const reasoningOverhead = isPaidUser ? 800 : 0; // GPT-5-mini needs extra for reasoning

      if (useToolMode) {
        // Tool-use mode: AI fetches context dynamically, so we use a generous default
        // The model may fetch large context (script, beat sheet), so allow for detailed responses
        tokenLimits = { maxTokens: 1800 + reasoningOverhead, reasoning: 'Tool-use brainstorming - dynamic context' };
      } else {
        const toggleContextCount = [includeCharacters, includeLocations, includeBeatSheet, includeScript].filter(Boolean).length;
        const hasAttachments = attachments && attachments.length > 0;

        // Check if questionForAI contains large attachment content (treatments, documents)
        // ~4 chars per token, so 8000 chars ≈ 2000 tokens of context
        const questionLength = (questionForAI || question || '').length;
        const hasLargeAttachment = questionLength > 8000; // ~2000+ tokens of attachment content
        const hasHugeAttachment = questionLength > 20000; // ~5000+ tokens (full treatment/script)

        if (hasHugeAttachment || includeScript) {
          // Huge context (full script/treatment) - allow detailed analysis + idea generation
          tokenLimits = { maxTokens: 1800 + reasoningOverhead, reasoning: 'Brainstorming with large document/script context' };
        } else if (hasLargeAttachment || includeBeatSheet) {
          // Heavy context (beatsheet or large attachment) - allow detailed idea lists
          tokenLimits = { maxTokens: 1200 + reasoningOverhead, reasoning: 'Brainstorming with heavy context' };
        } else if (toggleContextCount >= 2 || hasAttachments) {
          // Moderate context - allow medium responses with room for idea lists
          tokenLimits = { maxTokens: 900 + reasoningOverhead, reasoning: 'Brainstorming with moderate context' };
        } else {
          // No/minimal context - conversational with room for idea generation when asked
          tokenLimits = { maxTokens: 700 + reasoningOverhead, reasoning: 'Brainstorming chat - flexible mode' };
        }
      }
    }

    // Log token limits
    if (DEBUG_AI) {
      console.log('📊 CHAT TOKEN LIMITS:', {
        maxTokens: tokenLimits.maxTokens,
        reasoning: tokenLimits.reasoning,
        planId
      });
    }

    // Create or use existing conversation
    let activeConversationId = conversationId;

    // If no conversationId provided, create a new conversation
    if (!activeConversationId && projectId) {
      try {
        // Generate a title from the first ~50 chars of the question
        const title = question.length > 50
          ? question.substring(0, 50).trim() + '...'
          : question.trim();

        const { data: newConv, error: convError } = await supabase
          .from("conversations")
          .insert([{
            project_id: projectId,
            title: title || 'New conversation'
          }])
          .select('id')
          .single();

        if (convError) {
          console.error("Failed to create conversation:", convError);
        } else {
          activeConversationId = newConv.id;
          if (DEBUG_AI) {
            console.log('📝 Created new conversation:', activeConversationId);
          }
        }
      } catch (convDbError) {
        console.error("Failed to create conversation:", convDbError);
      }
    }

    // Save user message IMMEDIATELY before API call
    // This ensures the message persists even if refresh happens during AI processing
    if (activeConversationId && projectId) {
      try {
        await supabase
          .from("conversation_messages")
          .insert([{
            conversation_id: activeConversationId,
            role: "user",
            content: question,
            token_count: 0
          }]);
      } catch (dbError) {
        console.error("Failed to save user message:", dbError);
      }
    }

    // Create routing context for intelligent model selection
    const fullPromptText = messages.map(m => m.content).join('\n');
    const routingContext = AIModelRouter.createContext({
      requestType: 'chat',
      inputText: fullPromptText,
      expectedOutputTokens: tokenLimits.maxTokens,
      hasAttachments: !!(content || attachments?.length),
      metadata: {
        contentScale: 'standard',
        userPlanId: planId  // 'free' or paid plan ID for model routing
      }
    });

    // --- Execute AI completion ---
    let answer: string;
    let finalResult: any;
    let toolMetadata: { mode: string; toolCallCount: number; toolsUsed: string[]; rounds: number } | null = null;

    if (useToolMode && context === 'brainstorming') {
      // ====== TOOL-USE MODE ======
      // AI autonomously fetches context via function calling
      const MAX_TOOL_ROUNDS = 3;
      let currentMessages = [...messages];
      let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let toolCallCount = 0;
      const toolsUsed: string[] = [];
      let roundCount = 0;

      if (DEBUG_AI) console.log('🔧 TOOL MODE: Starting tool-use loop (max rounds:', MAX_TOOL_ROUNDS, ')');

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        roundCount = round + 1;
        const isLastRound = round === MAX_TOOL_ROUNDS;

        const result = await aiRouter.executeCompletion(routingContext, {
          messages: currentMessages,
          maxTokens: tokenLimits.maxTokens,
          temperature: 0.7,
          // Only provide tools if we haven't exhausted rounds - force text on last round
          tools: isLastRound ? undefined : CHAT_CONTEXT_TOOLS,
        });

        // Accumulate usage across all rounds
        totalUsage.prompt_tokens += result.usage.prompt_tokens;
        totalUsage.completion_tokens += result.usage.completion_tokens;
        totalUsage.total_tokens += result.usage.total_tokens;

        // If no tool calls or model chose to respond directly, we're done
        if (!result.toolCalls || result.toolCalls.length === 0 || result.finishReason === 'stop') {
          finalResult = { ...result, usage: totalUsage };
          break;
        }

        if (DEBUG_AI) console.log(`🔧 TOOL MODE Round ${round + 1}: Model requested ${result.toolCalls.length} tool(s):`,
          result.toolCalls.map((tc: any) => tc.function.name));

        // Add assistant message with tool_calls to conversation
        currentMessages.push({
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.toolCalls,
        });

        // Execute each tool call and add results
        for (const toolCall of result.toolCalls) {
          toolCallCount++;

          // Free tier limit: max 2 tool calls per request
          if (isFreeUser && toolCallCount > 2) {
            if (DEBUG_AI) console.log('🔧 TOOL MODE: Free tier limit reached (2 tool calls)');
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: 'Context limit reached on free plan. Upgrade for unlimited context.',
            });
            continue;
          }

          try {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const toolResult = await executeToolCall(
              toolCall.function.name,
              args,
              { projectId, episodeId, scriptEpisodeId, supabase }
            );
            toolsUsed.push(toolCall.function.name);

            if (DEBUG_AI) console.log(`🔧 Tool ${toolCall.function.name}: returned ${toolResult.length} chars`);

            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResult,
            });
          } catch (toolError) {
            console.error(`❌ Tool ${toolCall.function.name} execution error:`, toolError);
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error executing ${toolCall.function.name}.`,
            });
          }
        }
      }

      if (!finalResult) {
        finalResult = { content: "Sorry, I couldn't generate a response.", usage: totalUsage, model: 'unknown', provider: 'unknown', routingDecision: {} };
      }

      answer = finalResult.content || "Sorry, I couldn't generate a response.";
      toolMetadata = { mode: 'tool_use', toolCallCount, toolsUsed, rounds: roundCount };

      if (DEBUG_AI) {
        console.log('✅ TOOL MODE COMPLETE:', {
          rounds: roundCount,
          toolCallCount,
          toolsUsed,
          totalTokens: totalUsage.total_tokens,
          answerLength: answer.length,
        });
      }

    } else {
      // ====== TOGGLE MODE (existing flow) ======
      // Use AI Router to automatically select and execute with the best model
      const result = await aiRouter.executeCompletion(routingContext, {
        messages: messages,
        maxTokens: tokenLimits.maxTokens,
        temperature: 0.7
      });

      finalResult = result;
      answer = result.content || "Sorry, I couldn't generate a response.";

      if (DEBUG_AI) {
        console.log('✅ CHAT RESPONSE:', {
          model: result.model,
          provider: result.provider,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          answerLength: answer.length,
          routingReason: result.routingDecision?.reason
        });
      }
    }

    // Send response immediately - don't block on logging/tracking
    // Include conversationId so frontend can track the conversation
    res.json({ answer, conversationId: activeConversationId });

    // Fire-and-forget: Log and track after response is sent
    // These are non-critical operations that shouldn't delay user experience
    // Use setImmediate to ensure res.json() completes first
    setImmediate(async () => {
      try {
        // Log routing decision for analytics
        await AIRoutingLogger.logRoutingDecision({
          userId: req.userId,
          projectId: projectId,
          endpoint: '/api/ai/chat-script',
          context: routingContext,
          decision: finalResult.routingDecision,
          actualUsage: finalResult.usage
        });
      } catch (err) {
        console.error("Failed to log routing decision:", err);
      }

      try {
        // Track token usage
        if (req.userId) {
          await trackOpenAIUsageInRoute(req, 'chat_completion', finalResult.model, {
            prompt_tokens: finalResult.usage.prompt_tokens,
            completion_tokens: finalResult.usage.completion_tokens,
            total_tokens: finalResult.usage.total_tokens
          }, {
            conversationId: activeConversationId,
            metadata: {
              context,
              projectType,
              questionLength: question.length,
              answerLength: answer.length,
              provider: finalResult.provider,
              routingReason: finalResult.routingDecision?.reason,
              ...(toolMetadata || { contextToggles: { includeCharacters, includeLocations, includeBeatSheet, includeScript } })
            }
          });
        }
      } catch (err) {
        console.error("Failed to track usage:", err);
      }

      try {
        // Save assistant response
        if (activeConversationId && projectId) {
          await supabase
            .from("conversation_messages")
            .insert([{
              conversation_id: activeConversationId,
              role: "assistant",
              content: answer,
              token_count: finalResult.usage.completion_tokens,
              model_used: finalResult.model
            }]);
        }
      } catch (err) {
        console.error("Failed to save assistant message:", err);
      }
    });

    return;
  } catch (error) {
    console.error("❌ AI CHAT ERROR:", error);
    console.error("Error details:", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : undefined
    });
    res.status(500).json({ error: "AI error" });
  }
});

// =============================================================================
// SSE STREAMING ENDPOINT
// =============================================================================

// Tool status messages for intermediate feedback
// Tool status keys sent to frontend for i18n translation
function getToolStatusKey(toolName: string): string {
  const keys: Record<string, string> = {
    'get_characters': 'get_characters',
    'get_locations': 'get_locations',
    'get_script': 'get_script',
    'get_beat_sheet': 'get_beat_sheet',
    'get_document': 'get_document',
  };
  return keys[toolName] || 'gathering_context';
}

router.post("/chat-script-stream", requireAuth, extractUserId, addPricingService, ...fullRequestClassification('chat'), addAIUsageTracker, extractProjectId, async (req: AITrackingRequest & ClassifiedRequest & PricingRequest, res) => {
  const {
    context,
    projectId,
    projectType,
    content,
    question,
    questionForAI,
    history,
    conversationId,
    attachments,
    includeCharacters,
    includeLocations,
    includeBeatSheet,
    includeScript,
    episodeId,
    scriptEpisodeId,
    useToolMode,
  } = req.body;

  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!projectId) {
    return res.status(400).json({ error: 'Missing projectId' });
  }

  const projectAccess = await verifyProjectWriteAccess(projectId, userId);
  if (!projectAccess.ok) {
    return res.status(projectAccess.status).json({ error: projectAccess.error });
  }

  if (conversationId) {
    const conversationAccess = await verifyConversationBelongsToProject(conversationId, projectId);
    if (!conversationAccess.ok) {
      return res.status(conversationAccess.status).json({ error: conversationAccess.error });
    }
  }

  const pricingService = req.pricingService;
  if (!pricingService) {
    return res.status(500).json({ error: 'Pricing service not initialized' });
  }

  const subscription = await pricingService.getUserSubscription(userId);
  const planId = subscription?.plan_id || 'free';
  const isFreeUser = planId === 'free';

  // Context limit check for manual mode
  if (!useToolMode) {
    let contextCount = 0;
    if (includeCharacters) contextCount++;
    if (includeLocations) contextCount++;
    if (includeBeatSheet) contextCount++;
    if (includeScript) contextCount++;

    if (isFreeUser && contextCount > 2) {
      return res.status(403).json({
        error: 'context_limit_exceeded',
        message: 'Free plan allows maximum 2 context items. Upgrade for unlimited context.',
        maxContext: 2,
        currentContext: contextCount,
        planId: 'free',
        action_required: 'upgrade'
      });
    }
  }

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

  // Cancellation
  let cancelled = false;
  const abortController = new AbortController();
  req.on('close', () => {
    cancelled = true;
    abortController.abort();
  });

  try {
    // --- Build context (same logic as /chat-script) ---
    const actualQuestion = questionForAI || question;

    // MODE SELECTION
    let contextPrompt = "";
    let formatInstructions = "";
    let contentLabel = "";
    if (context === "brainstorming") {
      const brainstorming = getBrainstormingPrompts(projectType);
      contextPrompt = brainstorming.role;
      formatInstructions = brainstorming.format;
    } else {
      const ctx = getContextPrompts(context, projectType);
      contextPrompt = ctx.role;
      formatInstructions = ctx.format;
      contentLabel = ctx.contentLabel;
    }

    // Build user content with attachments
    let userContent = "";
    let attachmentsSection = "";
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      const attachmentParts: string[] = [];
      for (const att of attachments) {
        if (att.type === 'scene') {
          let sceneContent = '';
          const sceneNumber = att.scene_number;
          const sceneTitle = att.title || `Scene ${sceneNumber}`;
          try {
            if (userId && projectId && sceneNumber) {
              const scriptData = await ScriptParsingService.parseScriptFromProject(projectId, userId);
              if (scriptData?.scenes) {
                const scene = scriptData.scenes.find((s: any) => s.scene_number === sceneNumber);
                if (scene) {
                  sceneContent = `${scene.heading}\n\n${scene.action_content}`;
                  if (scene.characters && scene.characters.length > 0) {
                    sceneContent += `\n\nCharacters in scene: ${scene.characters.join(', ')}`;
                  }
                }
              }
            }
          } catch (error) {
            console.error('📎 ERROR fetching scene from backend:', error);
          }
          if (!sceneContent && att.content) sceneContent = att.content;
          if (sceneContent && sceneContent.length > 50) {
            attachmentParts.push(`--- ATTACHED SCENE: ${sceneTitle} ---\n${sceneContent}\n--- END ATTACHED SCENE ---`);
          }
        } else {
          const title = att.title || 'Untitled Document';
          const docContent = att.content || '';
          if (docContent) {
            attachmentParts.push(`--- ATTACHED DOCUMENT: ${title} ---\n${docContent}\n--- END ATTACHED DOCUMENT ---`);
          }
        }
      }
      if (attachmentParts.length > 0) {
        attachmentsSection = `\n\n📎 USER HAS ATTACHED THE FOLLOWING CONTENT FOR CONTEXT:\n\n${attachmentParts.join('\n\n')}\n\n⚠️ IMPORTANT: Focus your response on the attached content above. The user is specifically asking about this content.\n\n`;
      }
    }

    if (context === "brainstorming") {
      userContent = attachmentsSection ? `${attachmentsSection}User question:\n${actualQuestion}` : `User question:\n${actualQuestion}`;
    } else {
      userContent = `${contentLabel}:\n${JSON.stringify(content, null, 2)}\n\nUser question:\n${actualQuestion}`;
    }

    // Build project context
    let projectContext;
    try {
      projectContext = await AITokenService.buildProjectContext(projectId, supabase, false, false);
    } catch {
      projectContext = { projectType: (projectType as 'film' | 'series') || 'film', conceptContent: null, scriptContent: content };
    }
    if (!includeCharacters) projectContext.characters = [];
    if (!includeLocations) projectContext.locations = [];

    // Context optimizer
    let optimizedContext = null;
    if (req.requestClassification) {
      const options = ContextOptimizer.createOptimizationOptions('chat', req.requestClassification.estimatedTokens, req.requestClassification.complexity);
      optimizedContext = ContextOptimizer.optimizeContext(projectContext, actualQuestion, options, history);
    }

    // Fetch toggle-based context (manual mode only)
    let contextualUserContent = userContent;
    let additionalContext = '';
    const hasAttachedScenes = attachments?.some((att: any) => att.type === 'scene');
    const skipToggles = useToolMode && context === 'brainstorming';

    if (!skipToggles && includeScript && projectId && !hasAttachedScenes) {
      try {
        let scriptId: string | null = null;
        const effectiveEpisodeId = scriptEpisodeId || episodeId;
        if (effectiveEpisodeId) {
          const { data: episode } = await supabase.from('episodes').select('script_id').eq('id', effectiveEpisodeId).single();
          scriptId = episode?.script_id || null;
        } else {
          const { data: project } = await supabase.from('projects').select('prod_script_id').eq('id', projectId).single();
          scriptId = project?.prod_script_id || null;
        }
        if (scriptId) {
          const { data: script, error: scriptError } = await supabase.from('scripts').select('title, content').eq('id', scriptId).single();
          if (!scriptError && script) {
            const scriptText = extractTextFromTipTapJSON(script.content);
            additionalContext += `\n\n=== SCRIPT (Production Version) ===\nTitle: ${script.title}\n${scriptText || 'Empty script'}`;
          }
        }
      } catch (error) { console.error('Error fetching production script:', error); }
    }

    if (!skipToggles && includeCharacters && projectId) {
      try {
        const { data: characters } = await supabase.from('characters').select('name, description, character_type, primary_role, importance_level, age').eq('project_id', projectId);
        if (characters && characters.length > 0) {
          const charactersText = characters.map((char: any) => `- ${char.name}${char.primary_role ? ` (${char.primary_role})` : ''}${char.character_type ? ` [${char.character_type}]` : ''}${char.age ? `, age ${char.age}` : ''}: ${char.description || ''}`).join('\n');
          additionalContext += `\n\n=== CHARACTERS ===\n${charactersText}`;
        }
      } catch (error) { console.error('Error fetching characters:', error); }
    }

    if (!skipToggles && includeLocations && projectId) {
      try {
        const { data: locations } = await supabase.from('locations').select('name, description, location_type').eq('project_id', projectId);
        if (locations && locations.length > 0) {
          const locationsText = locations.map((loc: any) => `- ${loc.name}${loc.location_type ? ` (${loc.location_type})` : ''}: ${loc.description || ''}`).join('\n');
          additionalContext += `\n\n=== LOCATIONS ===\n${locationsText}`;
        }
      } catch (error) { console.error('Error fetching locations:', error); }
    }

    if (!skipToggles && includeBeatSheet && projectId) {
      try {
        let beatQuery = supabase.from('beats').select('act, beat_type, title, description, "order"').eq('project_id', projectId);
        if (episodeId) { beatQuery = beatQuery.eq('episode_id', episodeId); } else { beatQuery = beatQuery.is('episode_id', null); }
        const { data: beats, error: beatError } = await beatQuery.order('order', { ascending: true });
        if (!beatError && beats && beats.length > 0) {
          const beatsText = beats.map((beat: any) => `[${beat.act || 'Act'}${beat.beat_type ? ` - ${beat.beat_type}` : ''}] ${beat.title || 'Untitled'}: ${beat.description || ''}`).join('\n');
          additionalContext += `\n\n=== BEAT SHEET (Story Structure) ===\n${beatsText}`;
        }
      } catch (error) { console.error('Error fetching beat sheet:', error); }
    }

    contextualUserContent += additionalContext;

    const toolUseInstructions = (useToolMode && context === 'brainstorming') ? TOOL_USE_INSTRUCTIONS : '';

    // Build messages array
    let messages;
    if (optimizedContext) {
      const finalUserPrompt = attachmentsSection + optimizedContext.userPrompt + additionalContext;
      messages = [
        { role: "system", content: `${optimizedContext.systemPrompt}\n\n${CHAT_LANGUAGE_POLICY}\n\n${formatInstructions}\n${toolUseInstructions}` },
        ...(optimizedContext.contextData.conversation || []).map((msg: any) => ({ role: msg.role, content: msg.content })),
        { role: "user", content: finalUserPrompt },
      ];
    } else {
      messages = [
        { role: "system", content: `${SYSTEM_MESSAGE_DEFAULT}\n\n${contextPrompt}\n${formatInstructions}\n${toolUseInstructions}` },
        ...(history || []).map((msg: any) => ({ role: msg.role, content: msg.content })),
        { role: "user", content: contextualUserContent },
      ];
    }

    // Token limits
    let tokenLimits = AITokenService.calculateTokenLimits('chat', projectContext);
    if (context === "brainstorming") {
      const isPaidUser = planId !== 'free';
      const reasoningOverhead = isPaidUser ? 800 : 0;
      if (useToolMode) {
        tokenLimits = { maxTokens: 1800 + reasoningOverhead, reasoning: 'Tool-use brainstorming streaming' };
      } else {
        const toggleContextCount = [includeCharacters, includeLocations, includeBeatSheet, includeScript].filter(Boolean).length;
        const hasAttachments = attachments && attachments.length > 0;
        const questionLength = (questionForAI || question || '').length;
        const hasLargeAttachment = questionLength > 8000;
        const hasHugeAttachment = questionLength > 20000;
        if (hasHugeAttachment || includeScript) {
          tokenLimits = { maxTokens: 1800 + reasoningOverhead, reasoning: 'Brainstorming streaming with large context' };
        } else if (hasLargeAttachment || includeBeatSheet) {
          tokenLimits = { maxTokens: 1200 + reasoningOverhead, reasoning: 'Brainstorming streaming with heavy context' };
        } else if (toggleContextCount >= 2 || hasAttachments) {
          tokenLimits = { maxTokens: 900 + reasoningOverhead, reasoning: 'Brainstorming streaming with moderate context' };
        } else {
          tokenLimits = { maxTokens: 700 + reasoningOverhead, reasoning: 'Brainstorming streaming chat' };
        }
      }
    }

    // Create or use existing conversation
    let activeConversationId = conversationId;
    if (!activeConversationId && projectId) {
      try {
        const title = question.length > 50 ? question.substring(0, 50).trim() + '...' : question.trim();
        const { data: newConv, error: convError } = await supabase.from("conversations").insert([{ project_id: projectId, title: title || 'New conversation' }]).select('id').single();
        if (!convError) activeConversationId = newConv.id;
      } catch (convDbError) { console.error("Failed to create conversation:", convDbError); }
    }

    // Save user message
    if (activeConversationId && projectId) {
      try {
        await supabase.from("conversation_messages").insert([{ conversation_id: activeConversationId, role: "user", content: question, token_count: 0 }]);
      } catch (dbError) { console.error("Failed to save user message:", dbError); }
    }

    // Routing context
    const fullPromptText = messages.map(m => m.content).join('\n');
    const routingContext = AIModelRouter.createContext({
      requestType: 'chat',
      inputText: fullPromptText,
      expectedOutputTokens: tokenLimits.maxTokens,
      hasAttachments: !!(content || attachments?.length),
      metadata: { contentScale: 'standard', userPlanId: planId }
    });

    // --- Execute AI with streaming ---
    let answer = '';
    let finalResult: any;
    let toolMetadata: { mode: string; toolCallCount: number; toolsUsed: string[]; rounds: number } | null = null;

    if (useToolMode && context === 'brainstorming') {
      // ====== TOOL-USE MODE WITH STREAMING ======
      const MAX_TOOL_ROUNDS = 3;
      let currentMessages = [...messages];
      let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let toolCallCount = 0;
      const toolsUsed: string[] = [];
      let roundCount = 0;

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (cancelled) break;
        roundCount = round + 1;
        const isLastRound = round === MAX_TOOL_ROUNDS;

        const result = await aiRouter.executeStreamingCompletion(routingContext, {
          messages: currentMessages,
          maxTokens: tokenLimits.maxTokens,
          temperature: 0.7,
          tools: isLastRound ? undefined : CHAT_CONTEXT_TOOLS,
        }, {
          onToken: (token) => {
            if (!cancelled) {
              answer += token;
              sendEvent('token', { content: token });
            }
          },
          signal: abortController.signal,
        });

        totalUsage.prompt_tokens += result.usage.prompt_tokens;
        totalUsage.completion_tokens += result.usage.completion_tokens;
        totalUsage.total_tokens += result.usage.total_tokens;

        if (!result.toolCalls || result.toolCalls.length === 0 || result.finishReason === 'stop') {
          finalResult = { ...result, usage: totalUsage };
          break;
        }

        // Tool calls: send status events and execute
        currentMessages.push({
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.toolCalls,
        });

        for (const toolCall of result.toolCalls) {
          if (cancelled) break;
          toolCallCount++;

          if (isFreeUser && toolCallCount > 2) {
            currentMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Context limit reached on free plan. Upgrade for unlimited context.' });
            continue;
          }

          // Send status event
          sendEvent('status', {
            type: 'tool_call',
            tool: toolCall.function.name,
            statusKey: getToolStatusKey(toolCall.function.name),
          });

          try {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            const toolResult = await executeToolCall(toolCall.function.name, args, { projectId, episodeId, scriptEpisodeId, supabase });
            toolsUsed.push(toolCall.function.name);
            currentMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
          } catch (toolError) {
            console.error(`❌ Tool ${toolCall.function.name} execution error:`, toolError);
            currentMessages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error executing ${toolCall.function.name}.` });
          }
        }
      }

      if (!finalResult) {
        finalResult = { content: answer || "Sorry, I couldn't generate a response.", usage: totalUsage, model: 'unknown', provider: 'unknown', routingDecision: {} };
      }

      if (!answer) answer = finalResult.content || '';
      toolMetadata = { mode: 'tool_use', toolCallCount, toolsUsed, rounds: roundCount };

    } else {
      // ====== TOGGLE MODE WITH STREAMING ======
      const result = await aiRouter.executeStreamingCompletion(routingContext, {
        messages: messages,
        maxTokens: tokenLimits.maxTokens,
        temperature: 0.7
      }, {
        onToken: (token) => {
          if (!cancelled) {
            answer += token;
            sendEvent('token', { content: token });
          }
        },
        signal: abortController.signal,
      });

      finalResult = result;
      if (!answer) answer = result.content || '';
    }

    // Send done event
    sendEvent('done', { conversationId: activeConversationId });
    res.end();

    // Fire-and-forget logging
    setImmediate(async () => {
      try {
        await AIRoutingLogger.logRoutingDecision({
          userId: req.userId, projectId, endpoint: '/api/ai/chat-script-stream',
          context: routingContext, decision: finalResult.routingDecision, actualUsage: finalResult.usage
        });
      } catch (err) { console.error("Failed to log routing decision:", err); }

      try {
        if (req.userId) {
          await trackOpenAIUsageInRoute(req, 'chat_completion', finalResult.model, {
            prompt_tokens: finalResult.usage.prompt_tokens,
            completion_tokens: finalResult.usage.completion_tokens,
            total_tokens: finalResult.usage.total_tokens
          }, {
            conversationId: activeConversationId,
            metadata: {
              context, projectType, questionLength: question.length, answerLength: answer.length,
              provider: finalResult.provider, routingReason: finalResult.routingDecision?.reason,
              streaming: true,
              ...(toolMetadata || { contextToggles: { includeCharacters, includeLocations, includeBeatSheet, includeScript } })
            }
          });
        }
      } catch (err) { console.error("Failed to track usage:", err); }

      try {
        if (activeConversationId && projectId && answer) {
          await supabase.from("conversation_messages").insert([{
            conversation_id: activeConversationId, role: "assistant", content: answer,
            token_count: finalResult.usage.completion_tokens, model_used: finalResult.model
          }]);
        }
      } catch (err) { console.error("Failed to save assistant message:", err); }
    });

  } catch (error) {
    console.error("❌ AI CHAT STREAM ERROR:", error);
    sendEvent('error', { message: error instanceof Error ? error.message : 'AI error' });
    if (!res.writableEnded) res.end();
  }
});

export default router;
