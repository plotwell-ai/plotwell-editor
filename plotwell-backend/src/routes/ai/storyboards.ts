// filepath: src/routes/ai/storyboards.ts
import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
// Image generation is handled by imageModelRouter (OpenRouter primary, Replicate optional).
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { extractUserId, checkAIGenerationLimit, trackAIUsage, addPricingService, checkImageCredits, trackImageUsage, PricingRequest } from "../../middleware/pricingMiddleware";
import { getSignedUrl, BUCKETS, detectBucket } from "../../services/storageService";
import { requireAuth } from "../../middleware/auth";
import { addAIUsageTracker, extractProjectId, trackImageUsageInRoute, trackOpenAIUsageInRoute, AITrackingRequest } from "../../middleware/aiUsageMiddleware";
import {
  preventDuplicateStoryboardGeneration,
  preventDuplicateStoryboardImageGeneration
} from '../../middleware/requestDeduplication';
import { aiTaskEvents } from '../../services/aiTaskEventService';
import { generateSceneId } from '../../services/sceneIdentityService';
import {
  STORYBOARD_SYSTEM,
  buildSceneToStoryboardPrompt,
  buildCharacterPromptDescription,
  buildLocationPromptDescription,
  buildEnhancedSceneDescription,
  buildStoryboardImagePrompt,
} from '../../prompts';
import { defaultVideoFormat } from '../../utils/projectType';

dotenv.config();

// Only log verbose AI details when explicitly enabled (local dev only)
const DEBUG_AI = process.env.DEBUG_AI === 'true';

// Helper function to get user ID from request
function getUserId(req: any): string | null {
  return req.user?.sub || req.user?.id || null;
}

// Helper function to load project language settings
async function loadProjectLanguageSettings(projectId: string, userId: string) {
  try {
    const { data } = await supabase
      .from('projects')
      .select('language, content_language')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    return {
      language: data?.language || 'en',
      content_language: data?.content_language || 'en'
    };
  } catch (error) {
    console.error('Failed to load project language settings:', error);
    return { language: 'en', content_language: 'en' };
  }
}

// Helper function to build language instructions for prompts
function buildLanguageInstructions(language: string, contentLanguage: string, requestType: 'generation' | 'chat' = 'generation') {
  const languageMap = {
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'ja': 'Japanese',
    'zh': 'Chinese',
    'hi': 'Hindi',
    'ar': 'Arabic',
    'ko': 'Korean'
  };

  // For generation requests: Always use project's content_language
  // For chat requests: Use the language of the chat input (language parameter)
  const targetLanguage = requestType === 'generation' ? contentLanguage : language;
  const targetLangName = languageMap[targetLanguage] || 'English';

  // Always provide explicit language instructions, even for English
  return `

CRITICAL LANGUAGE REQUIREMENT:
- Generate ALL output text in ${targetLangName}
- Regardless of the input language or conversation language, ALWAYS generate content in ${targetLangName}
- Character names should be culturally appropriate for ${targetLangName}
- Dialogue and scene descriptions must be in ${targetLangName}
- If the input conversation is in a different language, translate/adapt the concepts to ${targetLangName}
- Maintain cultural context appropriate for ${targetLangName} content
- Use proper grammar and syntax for ${targetLangName}

IMPORTANT: Write the entire response in ${targetLangName}.`;
}

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

// Note: Replicate client is now managed by imageModelRouter service
// Text generation is now handled by AIModelRouter

const supabase = createClient(supabaseUrl, supabaseKey);

type StoryboardAspectRatio = '16:9' | '9:16' | '1:1' | '4:5';

function resolveStoryboardVideoFormat(project?: { video_format?: string | null; project_type?: string | null }): StoryboardAspectRatio {
  const normalized = String(project?.video_format || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace('x', ':')
    .replace('/', ':');

  if (normalized === '16:9' || normalized === '9:16' || normalized === '1:1' || normalized === '4:5') {
    return normalized;
  }

  if (['vertical', 'portrait', 'reel', 'reels', 'short', 'shorts', 'tiktok'].includes(normalized)) {
    return '9:16';
  }

  if (normalized === 'square') {
    return '1:1';
  }

  if (['portrait45', 'instagramportrait'].includes(normalized)) {
    return '4:5';
  }

  return defaultVideoFormat(project?.project_type || 'film');
}

async function signStoryboardImage(imageUrl: string): Promise<string> {
  const bucket = detectBucket(imageUrl);
  if (bucket) return getSignedUrl(bucket, imageUrl);
  if (!imageUrl.startsWith('http')) {
    return getSignedUrl(
      imageUrl.startsWith('ai-generated/') ? BUCKETS.STORYBOARD_IMAGES : BUCKETS.PROJECT_ASSETS,
      imageUrl
    );
  }
  return imageUrl;
}

// Helper: verify user has access to a project (owner or active collaborator)
async function checkProjectAccessForUser(projectId: string, userId: string): Promise<{
  hasAccess: boolean;
  canEdit: boolean;
}> {
  const { data: project } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();

  if (!project) return { hasAccess: false, canEdit: false };
  if (project.user_id === userId) return { hasAccess: true, canEdit: true };

  const { data: collaborator } = await supabase
    .from('project_collaborators')
    .select('role, status')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (!collaborator) return { hasAccess: false, canEdit: false };
  return { hasAccess: true, canEdit: ['owner', 'admin', 'editor'].includes(collaborator.role) };
}

// Combined type for routes that need both pricing and AI tracking
type CombinedRequest = PricingRequest & AITrackingRequest;

// =====================================================
// SCENE-BASED STORYBOARD GENERATION (NEW)
// =====================================================

// POST /scene-to-storyboard - Generate storyboard for a single scene
router.post("/scene-to-storyboard", requireAuth, extractUserId, preventDuplicateStoryboardGeneration, addPricingService, checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, extractProjectId, async (req: CombinedRequest, res) => {
  const {
    project_id,
    episode_id,
    scene_id,
    scene_number,
    scene_heading,
    scene_content,
    panel_count = 6  // Default 6 panels per scene
  } = req.body;

  if (DEBUG_AI) console.log('🎬 SCENE-TO-STORYBOARD:', { project_id, episode_id, scene_id, scene_number, panel_count });

  // Validation
  if (!project_id || !scene_id || scene_number == null || !scene_heading) {
    return res.status(400).json({
      error: "Missing required fields: project_id, scene_id, scene_number, or scene_heading"
    });
  }

  if (!scene_content || scene_content.trim().length === 0) {
    return res.status(400).json({
      error: "Scene content is required for storyboard generation"
    });
  }

  // Load language settings for the project
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Verify project access (write required for storyboard generation)
  const storyAccess = await checkProjectAccessForUser(project_id, userId);
  if (!storyAccess.hasAccess) {
    return res.status(403).json({ error: 'Access denied - not authorized for this project' });
  }
  if (!storyAccess.canEdit) {
    return res.status(403).json({ error: 'Read-only access - viewers cannot generate storyboards', role: 'viewer' });
  }

  const languageSettings = await loadProjectLanguageSettings(project_id, userId);
  const languageInstructions = buildLanguageInstructions(languageSettings.language, languageSettings.content_language, 'generation');

  // Fetch the project's video format so vertical projects get vertical-aware panel breakdowns
  let sceneVideoFormat: StoryboardAspectRatio = '16:9';
  const { data: sceneProjectData } = await supabase
    .from('projects')
    .select('project_type, video_format')
    .eq('id', project_id)
    .single();
  sceneVideoFormat = resolveStoryboardVideoFormat(sceneProjectData);

  try {
    // Build AI prompt focused on single scene
    const prompt = buildSceneToStoryboardPrompt({
      sceneNumber: scene_number,
      sceneHeading: scene_heading,
      sceneContent: scene_content,
      panelCount: panel_count,
      languageInstructions,
      videoFormat: sceneVideoFormat,
    });

    if (DEBUG_AI) console.log(`  🤖 Calling AI router for scene storyboard generation (${panel_count} panels)`);

    // Use AI router for storyboard generation
    const sceneStoryboardContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: prompt,
      expectedOutputTokens: 4096,
      metadata: { forceModel: 'grok' }
    });

    const sceneStoryboardResult = await aiRouter.executeCompletion(sceneStoryboardContext, {
      messages: [
        { role: "system", content: STORYBOARD_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: 4096,
      temperature: 0.7
    });

    const response = sceneStoryboardResult.content || "";
    if (DEBUG_AI) console.log('  📝 Raw AI response length:', response.length);

    // Parse JSON response
    let panels;
    try {
      // Remove markdown code blocks if present
      const cleanedResponse = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      panels = JSON.parse(cleanedResponse);

      if (!Array.isArray(panels)) {
        throw new Error("Response is not an array");
      }
    } catch (parseError) {
      console.error('❌ JSON PARSE ERROR:', parseError);
      console.error('  Response:', response);
      return res.status(500).json({
        error: "Failed to parse AI response",
        details: "The AI returned invalid JSON format"
      });
    }

    if (DEBUG_AI) console.log(`  ✅ Parsed ${panels.length} panels from AI response`);

    // Insert panels into database
    const insertData = panels.map((panel: any, index: number) => ({
      project_id,
      episode_id: episode_id || null,
      scene_id,
      scene_number,
      scene_heading,
      panel_number: index + 1,  // Ensure sequential numbering
      scene_description: panel.scene_description || '',
      shot_type: panel.shot_type || 'medium-shot',
      camera_movement: panel.camera_movement || 'static',
      camera_direction: panel.camera_direction || '',
      duration: String(panel.duration || '5'),
      notes: panel.notes || '',
      lighting: panel.lighting || '',
      mood: panel.mood || '',
      is_ai_generated: true
    }));

    const { data: insertedPanels, error: insertError } = await supabase
      .from('storyboard_panels')
      .insert(insertData)
      .select();

    if (insertError) {
      console.error('❌ DATABASE INSERT ERROR:', insertError);
      return res.status(500).json({
        error: "Failed to save storyboard panels",
        details: insertError.message
      });
    }

    // Track AI usage
    const estimatedPromptTokens = Math.ceil(prompt.length / 4);
    const estimatedCompletionTokens = Math.ceil(response.length / 4);
    const totalTokens = estimatedPromptTokens + estimatedCompletionTokens;

    await trackOpenAIUsageInRoute(req, 'chat_completion', 'gpt-4o-mini', {
      prompt_tokens: estimatedPromptTokens,
      completion_tokens: estimatedCompletionTokens,
      total_tokens: totalTokens
    }, {
      metadata: {
        projectId: project_id,
        context: 'scene_storyboard_generation',
        scene_id,
        scene_number,
        panel_count: panels.length,
        provider: 'openai'
      }
    });

    if (DEBUG_AI) console.log(`✅ STORYBOARD GENERATED: ${insertedPanels?.length || 0} panels for scene ${scene_number}`);

    aiTaskEvents.emit('task', {
      type: 'storyboard:completed',
      projectId: project_id,
      userId,
      payload: { sceneId: scene_id, panelCount: insertedPanels?.length || 0 },
    });

    res.json({
      success: true,
      panels: insertedPanels,
      scene_id,
      scene_number,
      scene_heading,
      panel_count: insertedPanels?.length || 0
    });

  } catch (error) {
    console.error('❌ SCENE-TO-STORYBOARD ERROR:', error);
    aiTaskEvents.emit('task', {
      type: 'storyboard:failed',
      projectId: project_id,
      userId,
      payload: { error: error instanceof Error ? error.message : 'Unknown error' },
    });
    res.status(500).json({
      error: "Failed to generate scene storyboard",
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Interface for character data in image generation request
interface CharacterForGeneration {
  character_id: string;
  include_description: boolean;
  include_appearance: boolean; // Visual appearance details (more important for image gen)
  include_image: boolean; // Whether to use character reference image
  elements: string[]; // Array of element IDs to include
}

// Interface for location data in image generation request
interface LocationForGeneration {
  location_id: string;
  include_description: boolean;
  include_atmosphere: boolean; // Mood/atmosphere details
  include_visual_notes: boolean; // Visual notes and details
  include_image: boolean; // Whether to use location reference image
}

// POST /generate-storyboard-image - Generate image for storyboard panel
// Uses ImageModelRouter with fallback support for multiple models
// Supports character and location linking with element selection
router.post("/generate-storyboard-image", requireAuth, extractUserId, preventDuplicateStoryboardImageGeneration, addPricingService, checkImageCredits, trackImageUsage, addAIUsageTracker, extractProjectId, async (req: AITrackingRequest, res) => {
  const {
    scene_description,
    shot_type,
    camera_movement,
    panel_number,
    preferred_model,
    fidelity,
    visual_style,
    characters, // Array of CharacterForGeneration objects
    location, // LocationForGeneration object
    custom_instructions,
    lighting,       // e.g. "low-key", "golden-hour"
    mood,           // e.g. "tense", "romantic"
    notes,          // key dialogue/detail from the panel
    scene_heading,  // e.g. "INT. OFFICE - NIGHT" — used for INT/EXT + time-of-day context
    panel_id,
    use_previous_shot_reference = true,
  } = req.body;

  if (!scene_description) {
    return res.status(400).json({ error: "Missing scene_description" });
  }

  try {
    const { generateStoryboardImage, sanitizeForImageGeneration } = await import('../../services/imageModelRouter');
    type CharacterReference = { imageUrl: string; name?: string; description?: string };

    // Fetch project's video format (aspect ratio) and visual style (render look).
    const projectId = req.body.project_id || req.projectId;
    let videoFormat: StoryboardAspectRatio = '16:9';
    let projectVisualStyle: string | undefined;
    if (projectId) {
      const { data: projectData } = await supabase
        .from('projects')
        .select('project_type, video_format, visual_style')
        .eq('id', projectId)
        .single();
      videoFormat = resolveStoryboardVideoFormat(projectData);
      projectVisualStyle = projectData?.visual_style || undefined;
    }

    // Effective render look: a per-request override (from the generation modal)
    // wins, otherwise fall back to the project's saved style, then 'cinematic'.
    const effectiveVisualStyle = visual_style || projectVisualStyle || 'cinematic';

    // Build enhanced scene description with character and location details
    const charactersUsed: string[] = [];
    const characterReferences: { imageUrl: string; name?: string; description?: string }[] = [];
    const characterDescriptions: string[] = [];

    if (characters && Array.isArray(characters) && characters.length > 0) {
      for (const charConfig of characters as CharacterForGeneration[]) {
        // Fetch character data including image_url
        const { data: character, error: charError } = await supabase
          .from('characters')
          .select('id, name, description, appearance, image_url')
          .eq('id', charConfig.character_id)
          .single();

        if (charError || !character) continue;

        charactersUsed.push(character.id);

        // Fetch elements if selected
        let elements: { element_type: string; name?: string; description?: string }[] | undefined;
        if (charConfig.elements && charConfig.elements.length > 0) {
          const { data: elementData } = await supabase
            .from('character_elements')
            .select('name, element_type, description, reference_image_url')
            .in('id', charConfig.elements);
          elements = elementData || undefined;
        }

        // Sanitize appearance text before embedding in image prompt
        const sanitizedAppearance = character.appearance ? await sanitizeForImageGeneration(character.appearance) : character.appearance;

        // Build character text description via prompt builder
        characterDescriptions.push(buildCharacterPromptDescription(
          { name: character.name, appearance: sanitizedAppearance, elements },
          { include_appearance: charConfig.include_appearance, include_elements: charConfig.elements?.length > 0 }
        ));

        // Build character reference for image generation
        // Prioritize character's main image over element images
        if (charConfig.include_image && character.image_url) {
          const signedUrl = await getSignedUrl(BUCKETS.CHARACTER_IMAGES, character.image_url);
          characterReferences.push({
            imageUrl: signedUrl,
            name: character.name,
            description: character.appearance || undefined
          });
        } else if (charConfig.elements && charConfig.elements.length > 0) {
          // Fallback: use element reference images if no main character image
          const { data: refElements } = await supabase
            .from('character_elements')
            .select('reference_image_url')
            .in('id', charConfig.elements)
            .not('reference_image_url', 'is', null);

          if (refElements) {
            for (const el of refElements) {
              if (el.reference_image_url) {
                const signedUrl = await getSignedUrl(BUCKETS.CHARACTER_IMAGES, el.reference_image_url);
                characterReferences.push({
                  imageUrl: signedUrl,
                  name: character.name,
                  description: `costume/prop element`
                });
              }
            }
          }
        }
      }

      if (DEBUG_AI) {
        if (characterReferences.length > 0) {
          console.log('🎭 Character references to use:', characterReferences.map(r => `${r.name}: ${r.imageUrl.substring(0, 50)}...`));
        } else if (charactersUsed.length > 0) {
          console.log('🎭 Characters linked but no reference images selected');
        }
      }
    }

    // Process location data for enhanced description and reference
    let locationUsed: string | null = null;
    let locationDescription: string | undefined;
    let locationReference: { imageUrl: string; name?: string; description?: string } | undefined;

    if (location && (location as LocationForGeneration).location_id) {
      const locConfig = location as LocationForGeneration;

      const { data: locationData, error: locError } = await supabase
        .from('locations')
        .select('id, name, description, atmosphere, visual_notes, image_url')
        .eq('id', locConfig.location_id)
        .single();

      if (!locError && locationData) {
        locationUsed = locationData.id;

        // Sanitize location text before embedding in image prompt
        const sanitizedLocDesc = locationData.description ? await sanitizeForImageGeneration(locationData.description) : locationData.description;

        // Build location text description via prompt builder
        const locDesc = buildLocationPromptDescription(
          { description: sanitizedLocDesc, atmosphere: locationData.atmosphere, visual_notes: locationData.visual_notes },
          { include_description: locConfig.include_description, include_atmosphere: locConfig.include_atmosphere, include_visual_notes: locConfig.include_visual_notes }
        );
        if (locDesc) locationDescription = locDesc;

        // Build location reference for image generation
        if (locConfig.include_image && locationData.image_url) {
          const signedUrl = await getSignedUrl(BUCKETS.LOCATION_IMAGES, locationData.image_url);
          locationReference = {
            imageUrl: signedUrl,
            name: locationData.name,
            description: locationData.description || locationData.visual_notes
          };
          if (DEBUG_AI) console.log('📍 Location reference to use:', `${locationData.name}: ${locationData.image_url.substring(0, 50)}...`);
        } else if (locationUsed) {
          if (DEBUG_AI) console.log('📍 Location linked but no reference image selected');
        }
      }
    }

    let continuityReference: CharacterReference | undefined;
    if (use_previous_shot_reference !== false && projectId && panel_id) {
      const { data: currentPanel } = await supabase
        .from('storyboard_panels')
        .select('id, project_id, episode_id, scene_id, panel_number')
        .eq('id', panel_id)
        .eq('project_id', projectId)
        .single();

      if (currentPanel && Number(currentPanel.panel_number) > 1) {
        let previousPanelQuery = supabase
          .from('storyboard_panels')
          .select('id, panel_number, scene_description, shot_type, lighting, mood, notes, image_url')
          .eq('project_id', projectId)
          .eq('scene_id', currentPanel.scene_id)
          .lt('panel_number', currentPanel.panel_number)
          .not('image_url', 'is', null)
          .order('panel_number', { ascending: false })
          .limit(1);

        previousPanelQuery = currentPanel.episode_id
          ? previousPanelQuery.eq('episode_id', currentPanel.episode_id)
          : previousPanelQuery.is('episode_id', null);

        const { data: previousPanels } = await previousPanelQuery;
        const previousPanel = previousPanels?.[0];
        if (previousPanel?.image_url) {
          continuityReference = {
            imageUrl: await signStoryboardImage(previousPanel.image_url),
            name: `Previous shot ${previousPanel.panel_number}`,
            description: [
              previousPanel.scene_description,
              previousPanel.shot_type,
              previousPanel.lighting,
              previousPanel.mood,
              previousPanel.notes,
            ].filter(Boolean).join('. '),
          };
          if (DEBUG_AI) console.log(`🎞️ Previous shot continuity reference: panel ${previousPanel.panel_number}`);
        }
      }
    }

    // Sanitize scene description to avoid image model moderation triggers
    const sanitizedSceneDescription = await sanitizeForImageGeneration(scene_description);
    const sanitizedCustomInstructions = custom_instructions ? await sanitizeForImageGeneration(custom_instructions) : undefined;

    // Assemble final enhanced description via prompt builder
    const enhancedDescription = buildEnhancedSceneDescription({
      sceneDescription: sanitizedSceneDescription,
      characterDescriptions: characterDescriptions.length > 0 ? characterDescriptions : undefined,
      locationDescription,
      customInstructions: sanitizedCustomInstructions,
    });

    const result = await generateStoryboardImage(
      enhancedDescription,
      shot_type,
      camera_movement,
      {
        preferredModel: preferred_model,
        aspectRatio: videoFormat,
        fidelity: fidelity || 'cinematic',
        visualStyle: effectiveVisualStyle,
        // Keep character (identity) and location (set) references separate so each
        // is steered correctly — see generateStoryboardImage / referenceRoles.
        characterReferences: characterReferences.length > 0 ? characterReferences : undefined,
        locationReferences: locationReference ? [locationReference] : undefined,
        continuityReferences: continuityReference ? [continuityReference] : undefined,
        lighting: lighting || undefined,
        mood: mood || undefined,
        notes: notes || undefined,
        cameraDirection: req.body.camera_direction || undefined,
        sceneHeading: scene_heading || undefined,
      }
    );

    // Download and store the image in Supabase storage
    const imageResponse = await fetch(result.imageUrl);
    if (!imageResponse.ok) {
      return res.status(400).json({ error: "Failed to download generated image" });
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const fileName = `ai-generated/${uuidv4()}.png`;

    const { error: uploadError } = await supabase.storage
      .from('storyboard-images')
      .upload(fileName, imageBuffer, {
        contentType: 'image/png',
        upsert: true
      });

    if (uploadError) {
      console.error("Storage upload failed:", uploadError);
      return res.status(500).json({ error: `Storage upload failed: ${uploadError.message}` });
    }

    // Store the path in DB, generate signed URL for immediate response
    const { getSignedUrl: getSignedUrlFn, BUCKETS: B } = await import('../../services/storageService');
    const storagePath = fileName;
    const signedImageUrl = await getSignedUrlFn(B.STORYBOARD_IMAGES, fileName);

    // Track image generation usage
    if (req.userId) {
      await trackImageUsageInRoute(req, 'storyboard_image', result.provider, result.model, {
        imageDimensions: videoFormat,
        imageFormat: 'png',
        imageQuality: 90,
        imageUrl: storagePath,
        promptText: enhancedDescription,
        metadata: {
          sceneDescription: scene_description,
          enhancedDescription: enhancedDescription !== scene_description ? enhancedDescription : undefined,
          shotType: shot_type || 'medium shot',
          cameraMovement: camera_movement || 'static',
          panelNumber: panel_number,
          modelUsed: result.model,
          providerUsed: result.provider,
          generationTimeMs: result.generationTimeMs,
          fidelity: fidelity || 'cinematic',
          visualStyle: effectiveVisualStyle,
          charactersUsed: charactersUsed.length > 0 ? charactersUsed : undefined,
          locationUsed: locationUsed || undefined,
          continuityReferenceUsed: !!continuityReference
        }
      });
    }

    if (req.userId && req.projectId) {
      aiTaskEvents.emit('task', {
        type: 'storyboard-image:completed',
        projectId: req.projectId,
        userId: req.userId,
        payload: { panelNumber: panel_number },
      });
    }

    req.aiCreditsUsageDescription = `Storyboard image generation${panel_number ? ` (panel ${panel_number})` : ''}`;
    return res.json({
      image_url: signedImageUrl,
      model_used: result.model,
      provider_used: result.provider,
      generation_time_ms: result.generationTimeMs,
      fidelity: fidelity || 'cinematic',
      characters_used: charactersUsed,
      location_used: locationUsed,
      continuity_reference_used: !!continuityReference
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Storyboard image generation error:', errorMessage);

    if (req.userId && req.projectId) {
      aiTaskEvents.emit('task', {
        type: 'storyboard-image:failed',
        projectId: req.projectId,
        userId: req.userId,
        payload: { error: errorMessage },
      });
    }

    // Handle specific provider errors (OpenRouter primary, Replicate optional)
    if (errorMessage.includes('Insufficient credit') || errorMessage.includes('402')) {
      return res.status(402).json({
        error: "Insufficient image provider credits",
        details: "The configured image provider rejected the request for insufficient credits or payment.",
        providerError: errorMessage
      });
    }

    if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
      return res.status(401).json({
        error: "Image provider authentication failed",
        details: "Please check the configured OpenRouter or Replicate API key."
      });
    }

    if ((error as any)?.code === 'CONTENT_MODERATED') {
      return res.status(422).json({
        error: "content_moderated",
        message: errorMessage
      });
    }

    return res.status(500).json({
      error: "AI storyboard image generation failed",
      details: errorMessage
    });
  }
});

export default router;
