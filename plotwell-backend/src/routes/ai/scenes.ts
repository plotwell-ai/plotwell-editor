import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { extractUserId, checkAIGenerationLimit, trackAIUsage, addPricingService, PricingRequest } from "../../middleware/pricingMiddleware";
import { requireAuth } from "../../middleware/auth";
import { fullRequestClassification, ClassifiedRequest } from "../../middleware/requestClassificationMiddleware";
import { createReplicateCompletion } from '../../utils/replicateHelper';
import { OpenAI } from "openai";
import { addAIUsageTracker, trackOpenAIUsageInRoute, AITrackingRequest } from "../../middleware/aiUsageMiddleware";
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { extractTipTapJsonFromAIResponse, validateTipTapStructure } from '../../utils/aiHelpers';
import { aiTaskEvents } from '../../services/aiTaskEventService';
import { ensureProsemirrorFormat } from '../../utils/formatDetection';
import {
  buildSceneGeneratorPrompt,
  sceneFormatGuidance,
  buildSceneRefinerPrompt,
  buildSceneTransformerPrompt,
  buildParagraphTransformerPrompt,
  SCENE_GENERATOR_SYSTEM,
  SCENE_REFINER_SYSTEM,
  SCENE_TRANSFORMER_SYSTEM,
  PARAGRAPH_TRANSFORMER_SYSTEM,
  MODIFICATION_INSTRUCTIONS,
  PARAGRAPH_GUIDELINES,
} from '../../prompts';

dotenv.config();

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Helper function to get user ID from request
function getUserId(req: any): string | null {
  return req.user?.sub || req.user?.id || null;
}

// Helper: verify user has access to a project (owner or active collaborator)
async function checkProjectAccessForUser(projectId: string, userId: string): Promise<{
  hasAccess: boolean;
  isOwner: boolean;
  role: string | null;
  canEdit: boolean;
}> {
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();

  if (projectError || !project) {
    return { hasAccess: false, isOwner: false, role: null, canEdit: false };
  }

  if (project.user_id === userId) {
    return { hasAccess: true, isOwner: true, role: 'owner', canEdit: true };
  }

  const { data: collaborator, error: collabError } = await supabase
    .from('project_collaborators')
    .select('role, status')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (collabError || !collaborator) {
    return { hasAccess: false, isOwner: false, role: null, canEdit: false };
  }

  const canEdit = ['owner', 'admin', 'editor'].includes(collaborator.role);
  return { hasAccess: true, isOwner: false, role: collaborator.role, canEdit };
}

async function checkConversationBelongsToProject(conversationId: string, projectId: string): Promise<boolean> {
  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('id, project_id')
    .eq('id', conversationId)
    .single();

  return !error && !!conversation && conversation.project_id === projectId;
}

// Helper function to load project language settings
async function loadProjectLanguageSettings(projectId: string, userId: string) {
  try {
    // First get project settings
    const { data: projectData } = await supabase
      .from('projects')
      .select('language, content_language')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    // Also get user's UI language as fallback
    const { data: userData } = await supabase
      .from('users')
      .select('ui_language')
      .eq('id', userId)
      .single();

    const userLanguage = userData?.ui_language || 'en';

    return {
      language: projectData?.language || userLanguage,
      // Use project content_language, then project language, then user UI language
      content_language: projectData?.content_language || projectData?.language || userLanguage
    };
  } catch (error) {
    console.error('Failed to load project language settings:', error);
    return { language: 'en', content_language: 'en' };
  }
}

// Scene Generation Endpoint - Generate individual scenes
router.post("/generate-scene", requireAuth, extractUserId, addPricingService, ...fullRequestClassification('script-generation'), checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, async (req: PricingRequest & ClassifiedRequest & AITrackingRequest, res: any) => {
  const {
    project_id,
    script_id,
    episode_id, // For TV series - link scene to specific episode
    scene_description,
    scene_context,
    characters,
    style_preferences,
    scene_number,
    // New context data for enhanced generation
    documents,
    locations,
    conversation_context,
    // Optional previous scene for continuity
    previous_scene,
    // Conversation ID for message saving
    conversation_id
  } = req.body;

  if (!project_id || !scene_description) {
    return res.status(400).json({
      error: "Missing required fields: project_id and scene_description are required"
    });
  }

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    // Verify project access (write required for generation)
    const access = await checkProjectAccessForUser(project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot generate scenes', role: 'viewer' });
    }

    if (conversation_id) {
      const conversationMatchesProject = await checkConversationBelongsToProject(conversation_id, project_id);
      if (!conversationMatchesProject) {
        return res.status(403).json({ error: "Conversation does not belong to this project" });
      }
    }

    // Load project language settings
    const languageSettings = await loadProjectLanguageSettings(project_id, userId);

    // Load project context data from database
    const [charactersResult, documentsResult, locationsResult, scriptResult] = await Promise.all([
      // Load characters
      supabase
        .from('characters')
        .select('name, description, character_type')
        .eq('project_id', project_id),

      // Load documents
      supabase
        .from('project_documents')
        .select('title, content, document_type')
        .eq('project_id', project_id),

      // Load locations
      supabase
        .from('locations')
        .select('name, description')
        .eq('project_id', project_id),

      // Load script content for context
      script_id
        ? supabase
            .from('scripts')
            .select('title, content, scenes')
            .eq('id', script_id)
            .single()
        : Promise.resolve({ data: null, error: null })
    ]);

    // Extract loaded data and check for errors
    const loadedCharacters = charactersResult.data || [];
    const loadedDocuments = documentsResult.data || [];
    const loadedLocations = locationsResult.data || [];
    const loadedScript = scriptResult.data;

    // Log any query errors
    if (charactersResult.error) {
      console.error("🎬 ERROR: Failed to load characters:", charactersResult.error);
    }
    if (documentsResult.error) {
      console.error("🎬 ERROR: Failed to load documents:", documentsResult.error);
    }
    if (locationsResult.error) {
      console.error("🎬 ERROR: Failed to load locations:", locationsResult.error);
    }
    if (scriptResult.error && script_id) {
      console.error("🎬 ERROR: Failed to load script:", scriptResult.error);
    }

    // Build character context from loaded data
    let characterContext = '';
    if (loadedCharacters.length > 0) {
      const simpleCharacters = loadedCharacters.map((char: any) => ({
        name: char.name,
        description: char.description,
        role: char.character_type
      }));
      characterContext = `\nProject Characters (available for this scene):\n${JSON.stringify(simpleCharacters, null, 2)}`;
    }

    // Prepare scene context if provided
    let contextText = scene_context ? `\nScene Context: ${scene_context}` : '';

    // Build documents context from loaded data
    let documentsContext = '';
    if (loadedDocuments.length > 0) {
      const documentsSummary = loadedDocuments
        .map((doc: any) => {
          // Extract text from ProseMirror JSON content
          let contentText = 'No content';
          if (doc.content) {
            if (typeof doc.content === 'string') {
              contentText = doc.content;
            } else if (doc.content.content && Array.isArray(doc.content.content)) {
              // Extract text from ProseMirror JSON structure
              contentText = doc.content.content
                .map((node: any) => {
                  if (node.content && Array.isArray(node.content)) {
                    return node.content.map((textNode: any) => textNode.text || '').join(' ');
                  }
                  return '';
                })
                .join(' ')
                .trim();
            }
          }

          const preview = contentText.substring(0, 200);
          return `- ${doc.title} (${doc.document_type}): ${preview}${preview.length >= 200 ? '...' : ''}`;
        })
        .join('\n');
      documentsContext = `\nProject Documents (for story context):\n${documentsSummary}`;
    }

    // Build locations context from loaded data
    let locationsContext = '';
    if (loadedLocations.length > 0) {
      const locationsSummary = loadedLocations
        .map((loc: any) => `- ${loc.name}: ${loc.description || 'No description'}`)
        .join('\n');
      locationsContext = `\nProject Locations (available for scenes):\n${locationsSummary}`;
    }

    // Build script context from loaded script
    let scriptContext = '';
    if (loadedScript?.content) {
      // Ensure ProseMirror format before processing
      const scriptDoc = ensureProsemirrorFormat(loadedScript.content);
      // Extract text from ProseMirror JSON content for script context
      let scriptText = '';
      if (typeof loadedScript.content === 'string') {
        scriptText = loadedScript.content;
      } else if (scriptDoc.content && Array.isArray(scriptDoc.content)) {
        // Extract text from ProseMirror JSON structure with scene headings marked
        scriptText = scriptDoc.content
          .map((node: any) => {
            const nodeType = node.type || '';
            const text = node.content?.map((textNode: any) => textNode.text || '').join(' ') || '';

            // Mark scene headings for easier identification
            if (nodeType === 'sceneHeading') {
              return `\n[SCENE] ${text}`;
            }
            return text;
          })
          .filter((text: string) => text.trim())
          .join('\n')
          .trim();
      }

      // Limit script context to avoid token overflow (approximately 8000 characters)
      const maxScriptLength = 8000;
      if (scriptText.length > maxScriptLength) {
        scriptText = scriptText.substring(0, maxScriptLength) + '\n... [Script truncated for context]';
      }

      if (scriptText) {
        const scriptTitle = loadedScript.title || 'Untitled Script';
        scriptContext = `\n\nEXISTING SCRIPT CONTENT ("${scriptTitle}"):\nUse this as reference for tone, style, character voices, and story continuity:\n${scriptText}`;
      }
    }

    // Add conversation context if provided
    let conversationContextText = '';
    if (conversation_context) {
      conversationContextText = `\nBrainstorming Context: ${conversation_context}`;
    }

    // Add previous scene for continuity if provided
    let previousSceneContext = '';
    if (previous_scene) {
      // Extract text from previous scene's ProseMirror JSON content
      let previousSceneText = '';
      if (typeof previous_scene === 'string') {
        previousSceneText = previous_scene;
      } else if (previous_scene.content && Array.isArray(previous_scene.content)) {
        // Extract text from ProseMirror JSON structure
        previousSceneText = previous_scene.content
          .map((node: any) => {
            if (node.content && Array.isArray(node.content)) {
              return node.content.map((textNode: any) => textNode.text || '').join(' ');
            }
            return '';
          })
          .join('\n')
          .trim();
      }

      if (previousSceneText) {
        previousSceneContext = `\n\nPREVIOUS SCENE (for continuity):\n${previousSceneText}\n\nIMPORTANT: Use the previous scene to maintain narrative continuity. Continue the story naturally from where it left off, maintaining character states, locations, and plot momentum.`;
      }
    }

    // Fetch project type so vertical projects get short-form scene guidance
    const { data: sceneProject } = await supabase
      .from('projects')
      .select('project_type')
      .eq('id', project_id)
      .single();
    const formatGuidance = sceneFormatGuidance(sceneProject?.project_type);

    // Build the AI prompt for scene generation
    const prompt = buildSceneGeneratorPrompt({
      sceneDescription: scene_description,
      language: languageSettings.content_language,
      contextText,
      characterContext,
      documentsContext,
      locationsContext,
      scriptContext,
      conversationContextText,
      previousSceneContext,
      stylePreferences: style_preferences,
      formatGuidance,
    });

    // Save user message IMMEDIATELY before AI call
    // This ensures the message persists even if refresh happens during AI processing
    if (conversation_id && project_id) {
      try {
        const userMessage = `Generate scene: ${scene_description}`;
        await supabase
          .from("conversation_messages")
          .insert([{
            conversation_id: conversation_id,
            role: "user",
            content: userMessage,
            token_count: 0
          }]);
      } catch (dbError) {
        // Don't fail the request if user message saving fails
        console.error("Failed to save user message:", dbError);
      }
    }

    const sceneContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: prompt,
      expectedOutputTokens: 16384,
      metadata: { forceModel: 'grok' }
    });

    const sceneResult = await aiRouter.executeCompletion(sceneContext, {
      messages: [
        { role: "system", content: SCENE_GENERATOR_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: 32768,
    });

    const sceneContent = sceneResult.content;
    if (!sceneContent) {
      throw new Error("No content returned from AI");
    }

    // Clean and parse the response using robust extractor with balanced brace counting
    if (DEBUG_AI) console.log('🔍 Raw AI response (first 500 chars):', sceneContent.substring(0, 500));

    const extractionResult = extractTipTapJsonFromAIResponse(sceneContent);

    if (!extractionResult.success || !extractionResult.json) {
      // Log detailed error info for debugging
      console.error('❌ Scene JSON Extraction Failed:', {
        error: extractionResult.error,
        debugInfo: extractionResult.debugInfo,
        extractedContent: extractionResult.extractedContent?.substring(0, 500)
      });
      throw new Error(`Failed to parse generated scene JSON: ${extractionResult.error}`);
    }

    if (extractionResult.debugInfo) {
      const logData: any = {
        originalLength: extractionResult.debugInfo.originalLength,
        extractedLength: extractionResult.debugInfo.extractedLength,
        hadMarkdownWrapper: extractionResult.debugInfo.hadMarkdownWrapper,
        hadTextBeforeJson: extractionResult.debugInfo.hadTextBeforeJson,
        hadTextAfterJson: extractionResult.debugInfo.hadTextAfterJson
      };

      if (extractionResult.debugInfo.wasRepaired) {
        logData.wasRepaired = true;
        logData.repairs = extractionResult.debugInfo.repairs;
        if (DEBUG_AI) console.log('✅ JSON Extraction Success (REPAIRED):', logData);
      } else if (DEBUG_AI) {
        console.log('✅ JSON Extraction Success:', logData);
      }
    }

    const sceneJson = extractionResult.json;

    // Validate content quality - especially important if repair was needed
    const paragraphCount = sceneJson.content?.length || 0;
    const hasSceneHeading = sceneJson.content?.some((item: any) => item.type === 'sceneHeading');

    if (DEBUG_AI && extractionResult.debugInfo?.wasRepaired) {
      if (paragraphCount < 3) {
        if (DEBUG_AI) console.log('⚠️ Repaired scene has few paragraphs:', paragraphCount);
      }
      if (!hasSceneHeading) {
        if (DEBUG_AI) console.log('⚠️ Repaired scene is missing scene heading');
      }
    }

    // Extract scene heading for metadata
    const sceneHeading = sceneJson.content?.find((item: any) =>
      item.type === 'sceneHeading'
    )?.content?.[0]?.text || 'Generated Scene';

    // Find the next available scene number to avoid duplicates
    let finalSceneNumber = scene_number || 1;
    if (script_id) {
      const { data: existingScenes } = await supabase
        .from('ai_generated_scenes')
        .select('scene_number')
        .eq('project_id', project_id)
        .eq('script_id', script_id)
        .order('scene_number', { ascending: false })
        .limit(1);

      if (existingScenes && existingScenes.length > 0) {
        finalSceneNumber = existingScenes[0].scene_number + 1;
      }
    }

    // Store the generated scene in the database
    const sceneData: any = {
      project_id,
      script_id: script_id || null,
      scene_number: finalSceneNumber,
      heading: sceneHeading,
      content: sceneJson,
      characters: characters?.map((c: any) => c.name) || [],
      status: 'draft',
      is_ai_generated: true,
      user_id: userId,
      generation_metadata: {
        model: 'deepseek/deepseek-v4-flash',
        scene_description,
        scene_context,
        style_preferences,
        used_previous_scene: !!previous_scene,
        used_script_context: !!loadedScript?.content,
        prompt_length: prompt.length,
        response_tokens: sceneResult.usage?.completion_tokens,
        generated_at: new Date().toISOString()
      }
    };

    // Add episode_id if provided (for TV series)
    if (episode_id) {
      sceneData.episode_id = episode_id;
    }

    const { data: savedScene, error: saveError } = await supabase
      .from('ai_generated_scenes')
      .insert(sceneData)
      .select()
      .single();

    if (saveError) {
      console.error("❌ Error saving scene:", saveError);
      throw new Error("Failed to save generated scene");
    }

    // Save assistant response message after successful scene generation
    if (conversation_id && project_id) {
      try {
        const assistantMessage = `✓ Scene generated successfully! The scene "${sceneHeading}" has been created and is ready to be inserted into your screenplay.`;
        await supabase
          .from("conversation_messages")
          .insert([{
            conversation_id: conversation_id,
            role: "assistant",
            content: assistantMessage,
            token_count: sceneResult.usage?.completion_tokens || 0,
            model_used: sceneResult.model
          }]);
      } catch (dbError) {
        // Don't fail the request if assistant message saving fails
        console.error("Failed to save assistant message:", dbError);
      }
    }

    // Track AI usage
    if (sceneResult.usage && userId) {
      await trackOpenAIUsageInRoute(req, 'script_generation', sceneResult.model, {
        prompt_tokens: sceneResult.usage.prompt_tokens,
        completion_tokens: sceneResult.usage.completion_tokens,
        total_tokens: sceneResult.usage.total_tokens
      }, {
        metadata: {
          projectId: project_id,
          conversationId: conversation_id,
          sceneHeading: sceneHeading,
          provider: sceneResult.provider
        }
      });
    }

    aiTaskEvents.emit('task', {
      type: 'scene:completed',
      projectId: project_id,
      userId,
      payload: { sceneId: savedScene?.id },
    });

    res.json({
      success: true,
      scene: savedScene,
      usage: sceneResult.usage
    });

  } catch (error: any) {
    console.error("❌ Scene generation error:", error);
    const failUserId = getUserId(req);
    if (failUserId) {
      aiTaskEvents.emit('task', {
        type: 'scene:failed',
        projectId: project_id,
        userId: failUserId,
        payload: { error: error.message },
      });
    }
    res.status(500).json({
      error: "Failed to generate scene",
      details: error.message
    });
  }
});

// Scene Discussion Endpoint - Refine and modify existing scenes
router.post("/discuss-scene", requireAuth, extractUserId, addPricingService, ...fullRequestClassification('chat'), checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, async (req: PricingRequest & ClassifiedRequest & AITrackingRequest, res: any) => {
  const {
    scene_id,
    feedback,
    modification_type, // 'refine', 'expand', 'shorten', 'restyle', 'custom'
    specific_instructions,
    project_id
  } = req.body;

  if (!scene_id || !feedback) {
    return res.status(400).json({
      error: "Missing required fields: scene_id and feedback are required"
    });
  }

  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    // Fetch the existing scene
    const { data: existingScene, error: fetchError } = await supabase
      .from('ai_generated_scenes')
      .select('*')
      .eq('id', scene_id)
      .single();

    if (fetchError || !existingScene) {
      return res.status(404).json({ error: "Scene not found" });
    }

    // Build the AI prompt for scene refinement
    const prompt = buildSceneRefinerPrompt({
      existingSceneContent: existingScene.content,
      sceneHeading: existingScene.heading,
      feedback,
      modificationType: modification_type,
      specificInstructions: specific_instructions,
    });

    const refineContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: prompt,
      expectedOutputTokens: 16384,
      metadata: { forceModel: 'grok' }
    });

    const refineResult = await aiRouter.executeCompletion(refineContext, {
      messages: [
        { role: "system", content: SCENE_REFINER_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: 16384,
    });

    const refinedContent = refineResult.content;
    if (!refinedContent) {
      throw new Error("No content returned from AI");
    }

    // Clean and parse the response using robust extractor
    const refineExtractionResult = extractTipTapJsonFromAIResponse(refinedContent);

    if (!refineExtractionResult.success || !refineExtractionResult.json) {
      console.error('❌ Refine JSON Extraction Failed:', {
        error: refineExtractionResult.error,
        debugInfo: refineExtractionResult.debugInfo
      });
      throw new Error(`Failed to parse refined scene JSON: ${refineExtractionResult.error}`);
    }

    const refinedJson = refineExtractionResult.json;

    // Extract the new scene heading
    const newSceneHeading = refinedJson.content?.find((item: any) =>
      item.type === 'sceneHeading'
    )?.content?.[0]?.text || existingScene.heading;

    // Update the scene with refined content
    const { data: updatedScene, error: updateError } = await supabase
      .from('ai_generated_scenes')
      .update({
        content: refinedJson,
        heading: newSceneHeading,
        generation_metadata: {
          ...existingScene.generation_metadata,
          last_modified: new Date().toISOString(),
          modification_type,
          feedback,
          specific_instructions,
          refinement_tokens: refineResult.usage?.completion_tokens
        }
      })
      .eq('id', scene_id)
      .select()
      .single();

    if (updateError) {
      console.error("❌ Error updating scene:", updateError);
      throw new Error("Failed to update scene");
    }

    // Track AI usage
    if (refineResult.usage && userId) {
      await trackOpenAIUsageInRoute(req, 'chat_completion', refineResult.model, {
        prompt_tokens: refineResult.usage.prompt_tokens,
        completion_tokens: refineResult.usage.completion_tokens,
        total_tokens: refineResult.usage.total_tokens
      }, {
        metadata: {
          projectId: project_id,
          sceneId: scene_id,
          modificationType: modification_type,
          provider: refineResult.provider
        }
      });
    }

    aiTaskEvents.emit('task', {
      type: 'scene:completed',
      projectId: project_id,
      userId,
      payload: { sceneId: updatedScene?.id, operation: 'discuss' },
    });

    res.json({
      success: true,
      scene: updatedScene,
      usage: refineResult.usage
    });

  } catch (error: any) {
    console.error("❌ Scene refinement error:", error);
    const failUserId = getUserId(req);
    if (failUserId) {
      aiTaskEvents.emit('task', {
        type: 'scene:failed',
        projectId: project_id,
        userId: failUserId,
        payload: { error: error.message, operation: 'discuss' },
      });
    }
    res.status(500).json({
      error: "Failed to refine scene",
      details: error.message
    });
  }
});

// Scene Management Endpoints
router.get("/scenes/:project_id", requireAuth, async (req: any, res: any) => {
  try {
    const { project_id } = req.params;
    const { scriptId, episode_id } = req.query; // Optional scriptId or episode_id query parameters
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    // Verify project access (owner or collaborator)
    const access = await checkProjectAccessForUser(project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }

    // If episode_id is provided, get the script_id from the episode
    let resolvedScriptId = scriptId;
    if (episode_id && !scriptId) {
      const { data: episode } = await supabase
        .from('episodes')
        .select('script_id')
        .eq('id', episode_id)
        .eq('project_id', project_id)
        .single();

      if (episode?.script_id) {
        resolvedScriptId = episode.script_id;
      }
    }

    // Build query with optional scriptId filter
    let query = supabase
      .from('ai_generated_scenes')
      .select('*')
      .eq('project_id', project_id);

    // If scriptId is provided or resolved from episode, filter by it
    if (resolvedScriptId) {
      query = query.eq('script_id', resolvedScriptId);
    } else {
      if (DEBUG_AI) console.log(`📝 Loading all scenes for project ${project_id}`);
    }

    query = query.order('created_at', { ascending: false });

    const { data: scenes, error } = await query;

    if (error) {
      throw error;
    }

    res.json({ success: true, scenes });
  } catch (error: any) {
    console.error("❌ Error fetching scenes:", error);
    res.status(500).json({ error: "Failed to fetch scenes" });
  }
});

router.get("/scene/:scene_id", requireAuth, async (req: any, res: any) => {
  try {
    const { scene_id } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    const { data: scene, error } = await supabase
      .from('ai_generated_scenes')
      .select('*')
      .eq('id', scene_id)
      .single();

    if (error) {
      throw error;
    }

    // Verify user has access to this scene's project
    if (scene?.project_id) {
      const access = await checkProjectAccessForUser(scene.project_id, userId);
      if (!access.hasAccess) {
        return res.status(403).json({ error: 'Access denied - not authorized for this project' });
      }
    }

    res.json({ success: true, scene });
  } catch (error: any) {
    console.error("❌ Error fetching scene:", error);
    res.status(500).json({ error: "Failed to fetch scene" });
  }
});

router.delete("/scene/:scene_id", requireAuth, async (req: any, res: any) => {
  try {
    const { scene_id } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    // First check if scene exists and belongs to user
    const { data: existingScene, error: fetchError } = await supabase
      .from('ai_generated_scenes')
      .select('id, status, user_id, project_id')
      .eq('id', scene_id)
      .eq('user_id', userId)
      .single();

    if (fetchError && fetchError.code === 'PGRST116') {
      return res.status(404).json({ error: "Scene not found or access denied" });
    }

    if (fetchError) {
      console.error("❌ DELETE: Error checking scene existence:", fetchError);
      throw fetchError;
    }

    // Add user_id check for security
    const { data: deletedData, error } = await supabase
      .from('ai_generated_scenes')
      .delete()
      .eq('id', scene_id)
      .eq('user_id', userId)
      .select();

    if (error) {
      console.error("❌ DELETE: Database error:", error);
      return res.status(500).json({
        error: "Database error",
        details: error.message,
        code: error.code
      });
    }

    if (!deletedData || deletedData.length === 0) {
      return res.status(403).json({ error: "Scene could not be deleted - permission denied" });
    }

    res.json({ success: true, deleted: deletedData });
  } catch (error: any) {
    console.error("❌ Error deleting scene:", error);
    res.status(500).json({ error: "Failed to delete scene" });
  }
});

// Scene Insertion Endpoints
router.post("/insert-scene", requireAuth, async (req: any, res: any) => {
  try {
    const {
      script_id,
      scene_id,
      insert_position,
      target_node_index,
      project_id
    } = req.body;

    if (DEBUG_AI) console.log('🎬 INSERT SCENE REQUEST:', {
      script_id,
      scene_id,
      insert_position,
      target_node_index,
      project_id
    });

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    if (!script_id || !scene_id || !insert_position || !project_id) {
      return res.status(400).json({
        error: "Missing required fields: script_id, scene_id, insert_position, project_id"
      });
    }

    // Verify project access (write required)
    const access = await checkProjectAccessForUser(project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }
    if (!access.canEdit) {
      return res.status(403).json({ error: 'Read-only access - viewers cannot insert scenes', role: 'viewer' });
    }

    const { SceneInsertionService } = await import('../../services/sceneInsertionService');

    const result = await SceneInsertionService.insertScene({
      scriptId: script_id,
      sceneId: scene_id,
      insertPosition: insert_position,
      targetNodeIndex: target_node_index,
      userId,
      projectId: project_id
    });

    if (DEBUG_AI) console.log('🎬 INSERT SCENE RESULT:', { success: result.success, error: result.error });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error: any) {
    console.error("❌ Error inserting scene:", error);
    res.status(500).json({ error: "Failed to insert scene" });
  }
});

router.post("/preview-scene-insertion", requireAuth, async (req: any, res: any) => {
  try {
    const {
      script_id,
      scene_id,
      insert_position,
      target_node_index,
      project_id
    } = req.body;

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    if (!script_id || !scene_id || !insert_position || !project_id) {
      return res.status(400).json({
        error: "Missing required fields: script_id, scene_id, insert_position, project_id"
      });
    }

    // Verify project access (read is enough for preview)
    const access = await checkProjectAccessForUser(project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }

    const { SceneInsertionService } = await import('../../services/sceneInsertionService');

    const result = await SceneInsertionService.previewInsertion({
      scriptId: script_id,
      sceneId: scene_id,
      insertPosition: insert_position,
      targetNodeIndex: target_node_index,
      userId,
      projectId: project_id
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error: any) {
    console.error("❌ Error previewing scene insertion:", error);
    res.status(500).json({ error: "Failed to preview scene insertion" });
  }
});

router.get("/insertion-points/:script_id/:project_id", requireAuth, async (req: any, res: any) => {
  try {
    const { script_id, project_id } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    // Verify project access
    const access = await checkProjectAccessForUser(project_id, userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }

    const { SceneInsertionService } = await import('../../services/sceneInsertionService');

    const result = await SceneInsertionService.getInsertionPoints(script_id, project_id);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (error: any) {
    console.error("❌ Error getting insertion points:", error);
    res.status(500).json({ error: "Failed to get insertion points" });
  }
});

// Helper: Run the actual AI transform and update the pending transform row
async function executeTransformInBackground(
  pendingId: string,
  userId: string,
  project_id: string,
  script_id: string | null,
  scene_content: any,
  scene_position: any,
  operation: string,
  tone: string | undefined,
  instructions: string | undefined,
  req: any
) {
  try {
    // Load project language settings
    const languageSettings = await loadProjectLanguageSettings(project_id, userId);
    const contentLanguage = languageSettings.content_language || 'en';

    // Load full project context
    const [charactersResult, documentsResult, locationsResult, scriptResult] = await Promise.all([
      supabase
        .from('characters')
        .select('name, description, character_type')
        .eq('project_id', project_id),
      supabase
        .from('project_documents')
        .select('title, content, document_type')
        .eq('project_id', project_id),
      supabase
        .from('locations')
        .select('name, description')
        .eq('project_id', project_id),
      script_id
        ? supabase
            .from('scripts')
            .select('title, content, scenes')
            .eq('id', script_id)
            .single()
        : Promise.resolve({ data: null, error: null })
    ]);

    const loadedCharacters = charactersResult.data || [];
    const loadedDocuments = documentsResult.data || [];
    const loadedLocations = locationsResult.data || [];
    const loadedScript = scriptResult.data;

    // Build character context
    let characterContext = '';
    if (loadedCharacters.length > 0) {
      const simpleCharacters = loadedCharacters.map((char: any) => ({
        name: char.name,
        description: char.description,
        role: char.character_type
      }));
      characterContext = `\nProject Characters:\n${JSON.stringify(simpleCharacters, null, 2)}`;
    }

    // Build documents context
    let documentsContext = '';
    if (loadedDocuments.length > 0) {
      const documentsSummary = loadedDocuments
        .map((doc: any) => {
          let contentText = 'No content';
          if (doc.content) {
            if (typeof doc.content === 'string') {
              contentText = doc.content;
            } else if (doc.content.content && Array.isArray(doc.content.content)) {
              contentText = doc.content.content
                .map((node: any) => {
                  if (node.content && Array.isArray(node.content)) {
                    return node.content.map((textNode: any) => textNode.text || '').join(' ');
                  }
                  return '';
                })
                .join(' ')
                .trim();
            }
          }
          const preview = contentText.substring(0, 200);
          return `- ${doc.title} (${doc.document_type}): ${preview}${preview.length >= 200 ? '...' : ''}`;
        })
        .join('\n');
      documentsContext = `\nProject Documents:\n${documentsSummary}`;
    }

    // Build locations context
    let locationsContext = '';
    if (loadedLocations.length > 0) {
      const locationsSummary = loadedLocations
        .map((loc: any) => `- ${loc.name}: ${loc.description || 'No description'}`)
        .join('\n');
      locationsContext = `\nProject Locations:\n${locationsSummary}`;
    }

    // Build script context
    let scriptContext = '';
    if (loadedScript?.content) {
      // Ensure ProseMirror format before processing
      const scriptDoc = ensureProsemirrorFormat(loadedScript.content);
      let scriptText = '';
      if (typeof loadedScript.content === 'string') {
        scriptText = loadedScript.content;
      } else if (scriptDoc.content && Array.isArray(scriptDoc.content)) {
        scriptText = scriptDoc.content
          .map((node: any) => {
            const nodeType = node.type || '';
            const text = node.content?.map((textNode: any) => textNode.text || '').join(' ') || '';
            if (nodeType === 'sceneHeading') {
              return `\n[SCENE] ${text}`;
            }
            return text;
          })
          .filter((text: string) => text.trim())
          .join('\n')
          .trim();
      }

      const maxScriptLength = 8000;
      if (scriptText.length > maxScriptLength) {
        scriptText = scriptText.substring(0, maxScriptLength) + '\n... [Script truncated for context]';
      }

      if (scriptText) {
        const scriptTitle = loadedScript.title || 'Untitled Script';
        scriptContext = `\n\nFULL SCRIPT ("${scriptTitle}"):\nUse this for tone, style, character voices, and story continuity:\n${scriptText}`;
      }
    }

    // Build scene position context
    let positionContext = '';
    if (scene_position) {
      positionContext = `\n\nSCENE POSITION IN SCRIPT:`;
      positionContext += `\nThis is scene ${scene_position.scene_number} of ${scene_position.total_scenes} total scenes.`;
      if (scene_position.previous_scene_heading) {
        positionContext += `\nPrevious scene: ${scene_position.previous_scene_heading}`;
      }
      if (scene_position.next_scene_heading) {
        positionContext += `\nNext scene: ${scene_position.next_scene_heading}`;
      }
    }

    // Build the AI prompt for scene transformation
    const prompt = buildSceneTransformerPrompt({
      operation,
      tone,
      instructions,
      sceneContent: scene_content,
      positionContext,
      characterContext,
      documentsContext,
      locationsContext,
      scriptContext,
      contentLanguage,
    });

    if (DEBUG_AI) {
      console.log(`🔄 TRANSFORM SCENE BACKGROUND:`, {
        pendingId,
        operation,
        tone,
        sceneNodes: scene_content?.length || 0,
        contentLanguage
      });
    }

    // Create AI context
    const aiContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: prompt,
      expectedOutputTokens: 16384,
      metadata: { forceModel: 'grok' }
    });

    const result = await aiRouter.executeCompletion(aiContext, {
      messages: [
        { role: "system", content: SCENE_TRANSFORMER_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: 32768,
    });

    if (!result.content) {
      throw new Error("No content returned from AI");
    }

    // Parse ProseMirror JSON from response
    const extractionResult = extractTipTapJsonFromAIResponse(result.content);

    if (!extractionResult.success || !extractionResult.json) {
      console.error("❌ Failed to extract ProseMirror JSON from transform-scene response");
      throw new Error("Failed to parse AI response into valid screenplay format");
    }

    const transformedContent = extractionResult.json;

    // Track AI usage
    if (result.usage && userId) {
      await trackOpenAIUsageInRoute(req, 'chat_completion', result.model, {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        total_tokens: result.usage.total_tokens
      }, {
        metadata: {
          projectId: project_id,
          operation,
          tone: tone || undefined,
          provider: result.provider
        }
      });
    }

    // Update pending transform with result
    await supabase
      .from('ai_pending_transforms')
      .update({
        transformed_content: transformedContent,
        status: 'completed',
      })
      .eq('id', pendingId);

    // Push SSE notification to connected clients
    aiTaskEvents.emit('task', {
      type: 'transform:completed',
      projectId: project_id,
      userId,
      payload: { id: pendingId, operation },
    });

    if (DEBUG_AI) {
      console.log(`✅ TRANSFORM SCENE BACKGROUND SUCCESS:`, {
        pendingId,
        operation,
        outputNodes: transformedContent.content?.length || 0
      });
    }

  } catch (error: any) {
    console.error("❌ Transform scene background error:", error);
    await supabase
      .from('ai_pending_transforms')
      .update({
        status: 'failed',
        error_message: error.message,
      })
      .eq('id', pendingId);

    // Push SSE failure notification
    aiTaskEvents.emit('task', {
      type: 'transform:failed',
      projectId: project_id,
      userId,
      payload: { id: pendingId, operation, error: error.message },
    });
  }
}

// Transform Scene Endpoint - Async: creates a pending transform and processes in background
router.post("/transform-scene", requireAuth, extractUserId, addPricingService, ...fullRequestClassification('script-generation'), checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, async (req: PricingRequest & ClassifiedRequest & AITrackingRequest, res: any) => {
  try {
    const {
      project_id,
      script_id,
      episode_id,
      scene_heading: scene_heading_body,
      scene_content,
      scene_position,
      operation,
      tone,
      instructions,
      scene_pos,
      scene_end_pos,
    } = req.body;

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    if (!project_id || !scene_content || !operation) {
      return res.status(400).json({
        error: "Missing required fields: project_id, scene_content, operation"
      });
    }

    const validOperations = ['rephrase', 'expand', 'shorten', 'change-tone', 'custom'];
    if (!validOperations.includes(operation)) {
      return res.status(400).json({
        error: `Invalid operation. Must be one of: ${validOperations.join(', ')}`
      });
    }

    if (operation === 'change-tone' && !tone) {
      return res.status(400).json({ error: "Missing required field 'tone' for change-tone operation" });
    }

    if (operation === 'custom' && !instructions) {
      return res.status(400).json({ error: "Missing required field 'instructions' for custom operation" });
    }

    // Use the heading sent explicitly by the client; fall back to extracting it from content nodes
    const sceneHeading = scene_heading_body
      || scene_content?.find((n: any) =>
          n.type === 'sceneHeading' || n.attrs?.class === 'scene-heading'
        )?.content?.[0]?.text
      || `Scene ${scene_position?.scene_number || '?'}`;

    // Create pending transform row
    const { data: pending, error: insertError } = await supabase
      .from('ai_pending_transforms')
      .insert([{
        user_id: userId,
        project_id,
        script_id: script_id || null,
        episode_id: episode_id || null,
        operation,
        tone: tone || null,
        instructions: instructions || null,
        scene_heading: sceneHeading,
        scene_number: scene_position?.scene_number || null,
        original_content: scene_content,
        scene_pos: scene_pos ?? 0,
        scene_end_pos: scene_end_pos ?? 0,
        status: 'processing',
      }])
      .select()
      .single();

    if (insertError || !pending) {
      console.error("❌ Failed to create pending transform:", insertError);
      return res.status(500).json({ error: "Failed to create pending transform" });
    }

    // Fire and forget: run AI in background
    executeTransformInBackground(
      pending.id,
      userId,
      project_id,
      script_id || null,
      scene_content,
      scene_position,
      operation,
      tone,
      instructions,
      req
    );

    // Return immediately with the pending transform ID
    res.json({
      success: true,
      pending_transform_id: pending.id,
      status: 'processing',
    });

  } catch (error: any) {
    console.error("❌ Transform scene error:", error);
    res.status(500).json({
      error: "Failed to transform scene",
      details: error.message
    });
  }
});

// Get pending transforms for a project
router.get("/pending-transforms", requireAuth, extractUserId, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    const { project_id } = req.query;
    if (!project_id) {
      return res.status(400).json({ error: "Missing project_id" });
    }

    const { data, error } = await supabase
      .from('ai_pending_transforms')
      .select('id, operation, tone, instructions, scene_heading, scene_number, original_content, transformed_content, scene_pos, scene_end_pos, status, error_message, created_at')
      .eq('user_id', userId)
      .eq('project_id', project_id)
      .in('status', ['processing', 'completed'])
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      console.error("❌ Failed to fetch pending transforms:", error);
      return res.status(500).json({ error: "Failed to fetch pending transforms" });
    }

    res.json({ pending_transforms: data || [] });
  } catch (error: any) {
    console.error("❌ Pending transforms error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get a single pending transform by ID
router.get("/pending-transforms/:id", requireAuth, extractUserId, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    const { id } = req.params;

    const { data, error } = await supabase
      .from('ai_pending_transforms')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Pending transform not found" });
    }

    res.json(data);
  } catch (error: any) {
    console.error("❌ Pending transform fetch error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Accept or reject a pending transform
router.patch("/pending-transforms/:id", requireAuth, extractUserId, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    const { id } = req.params;
    const { action } = req.body; // 'accept' | 'reject'

    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: "Action must be 'accept' or 'reject'" });
    }

    const newStatus = action === 'accept' ? 'accepted' : 'rejected';

    const { data, error } = await supabase
      .from('ai_pending_transforms')
      .update({ status: newStatus })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', 'completed')
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Pending transform not found or not in completed state" });
    }

    res.json({ success: true, status: newStatus });
  } catch (error: any) {
    console.error("❌ Pending transform update error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Transform Text Endpoint - Expand or Rewrite selected text
router.post("/transform-text", requireAuth, extractUserId, addPricingService, ...fullRequestClassification('chat'), checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, async (req: PricingRequest & ClassifiedRequest & AITrackingRequest, res: any) => {
  try {
    const {
      project_id,
      text,
      operation,  // 'expand' | 'rewrite'
      paragraph_type,  // 'action', 'dialogue', 'sceneHeading', etc.
      context  // { before?: string, after?: string }
    } = req.body;

    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "User ID not found" });
    }

    if (!project_id || !text || !operation) {
      return res.status(400).json({
        error: "Missing required fields: project_id, text, operation"
      });
    }

    if (!['expand', 'rewrite'].includes(operation)) {
      return res.status(400).json({
        error: "Invalid operation. Must be 'expand' or 'rewrite'"
      });
    }

    // Load project language settings
    const languageSettings = await loadProjectLanguageSettings(project_id, userId);
    const contentLanguage = languageSettings.content_language || 'en';

    // Build the AI prompt for paragraph transformation
    const prompt = buildParagraphTransformerPrompt({
      operation: operation as 'expand' | 'rewrite',
      text,
      paragraphType: paragraph_type,
      contextBefore: context?.before,
      contextAfter: context?.after,
      contentLanguage,
    });

    if (DEBUG_AI) {
      console.log(`🔄 TRANSFORM TEXT REQUEST:`, {
        operation,
        paragraph_type,
        textLength: text.length,
        contentLanguage
      });
    }

    // Create AI context
    const aiContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: prompt,
      expectedOutputTokens: Math.min(text.length * 3, 4096), // Estimate: up to 3x expansion
      metadata: { forceModel: 'grok' }
    });

    const result = await aiRouter.executeCompletion(aiContext, {
      messages: [
        { role: "system", content: PARAGRAPH_TRANSFORMER_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: Math.min(text.length * 3, 4096),
    });

    let transformedText = result.content;
    if (!transformedText) {
      throw new Error("No content returned from AI");
    }

    // Clean up the response - remove any quotes or markdown
    transformedText = transformedText.trim();
    if (transformedText.startsWith('"') && transformedText.endsWith('"')) {
      transformedText = transformedText.slice(1, -1);
    }
    if (transformedText.startsWith('```') && transformedText.endsWith('```')) {
      transformedText = transformedText.replace(/```[^\n]*\n?/g, '').trim();
    }

    // Track AI usage
    if (result.usage && userId) {
      await trackOpenAIUsageInRoute(req, 'chat_completion', result.model, {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: result.usage.completion_tokens,
        total_tokens: result.usage.total_tokens
      }, {
        metadata: {
          projectId: project_id,
          operation,
          paragraph_type,
          provider: result.provider
        }
      });
    }

    if (DEBUG_AI) {
      console.log(`✅ TRANSFORM TEXT SUCCESS:`, {
        operation,
        originalLength: text.length,
        transformedLength: transformedText.length
      });
    }

    res.json({
      success: true,
      transformed_text: transformedText,
      usage: result.usage
    });

  } catch (error: any) {
    console.error("❌ Transform text error:", error);
    res.status(500).json({
      error: "Failed to transform text",
      details: error.message
    });
  }
});

export default router;
