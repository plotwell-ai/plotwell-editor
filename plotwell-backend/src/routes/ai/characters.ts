import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
// Replicate is now handled by imageModelRouter service
import { OpenAI } from "openai";
import { extractUserId, checkAIGenerationLimit, trackAIUsage, addPricingService, checkImageCredits, trackImageUsage, PricingRequest } from "../../middleware/pricingMiddleware";
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { requireAuth } from "../../middleware/auth";
import { addAIUsageTracker, extractProjectId, trackImageUsageInRoute, trackOpenAIUsageInRoute, AITrackingRequest } from "../../middleware/aiUsageMiddleware";
import {
  preventDuplicateCharacterGeneration,
  preventDuplicateCharacterImageGeneration
} from '../../middleware/requestDeduplication';
import { extractTextFromTipTapJSON } from '../../utils/aiHelpers';
import { aiTaskEvents } from '../../services/aiTaskEventService';
import {
  buildDocumentsToCharactersPrompt,
  buildScriptToCharactersPrompt,
  buildCharacterImagePrompt,
  buildCharacterViewPrompt,
  CHARACTER_VIEW_ANGLES,
  DOCUMENTS_TO_CHARACTERS_SYSTEM,
  SCRIPT_TO_CHARACTERS_SYSTEM,
} from '../../prompts';
import { resolveEffectiveVisualStyle } from '../../services/projectStyleService';
import { getEffectiveCost } from '../../config/pricingPlans';
import {
  canonicalizeCharacterName,
  dedupeCharacterCandidates,
  getCharacterIdentityKey,
} from '../../utils/characterIdentity';
import {
  buildCharacterVisualProfilePrompt,
  sanitizeCharacterVisualProfile,
} from '../../utils/visualProfiles';

// Combined type for routes that need both pricing and AI tracking
type CombinedRequest = PricingRequest & AITrackingRequest;

dotenv.config();

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Note: Replicate client is now managed by imageModelRouter service

// Helper function to get user ID from request
function getUserId(req: any): string | null {
  return req.user?.sub || req.user?.id || null;
}

/**
 * Sanitize character_type to valid database values
 * Valid: "main", "minor", "ensemble", "background"
 * Maps "supporting" -> "minor" (common AI mistake)
 */
function sanitizeCharacterType(type: string | undefined): string {
  const validTypes = ['main', 'minor', 'ensemble', 'background'];
  const normalized = (type || 'minor').toLowerCase();

  // Map common AI mistakes
  if (normalized === 'supporting' || normalized === 'secondary') {
    return 'minor';
  }
  if (normalized === 'lead' || normalized === 'protagonist' || normalized === 'primary') {
    return 'main';
  }
  if (normalized === 'extra' || normalized === 'bit' || normalized === 'walk-on') {
    return 'background';
  }

  return validTypes.includes(normalized) ? normalized : 'minor';
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

// Helper function to get human-readable label for element type
function getElementTypeLabel(elementType: string): string {
  const labels: Record<string, string> = {
    'costume': 'Costume',
    'prop': 'Prop',
    'accessory': 'Accessory',
    'makeup': 'Makeup/FX',
    'hairstyle': 'Hairstyle',
    'other': 'Element'
  };
  return labels[elementType] || 'Element';
}

// extractTextFromTipTapJSON imported from aiHelpers

// Interface for element data in image generation
interface ElementForGeneration {
  id: string;
  name: string;
  element_type: string;
  description?: string;
  include_description?: boolean;
}

// POST /generate-character-image - Generate AI character reference image
// Uses ImageModelRouter with fallback support for multiple models:
// - seedream-4 (primary)
// - flux-1.1-pro (fallback)
// - imagen-4-fast (fallback)
// Now supports elements (costumes, props, accessories) that influence the generated image
router.post("/generate-character-image", requireAuth, extractUserId, preventDuplicateCharacterImageGeneration, addPricingService, checkImageCredits, trackImageUsage, addAIUsageTracker, extractProjectId, async (req: CombinedRequest, res) => {
  if (DEBUG_AI) console.log("🎭 Character image generation started");
  const {
    character_id,
    character_name,
    appearance,              // Structured physical/visual description (preferred for images)
    visual_profile,          // Stable structured visual identity
    description,             // Personality/role/story (non-visual)
    reference_image_url,     // Legacy: URL-based reference (deprecated)
    reference_image_base64,  // New: base64 data URI reference (preferred)
    image_style,             // Optional per-request style override; usually unset (project-wide)
    similarity,
    preferred_model,
    elements,           // Array of elements to include in generation
    image_description,  // Optional context for this specific image
    save_to_gallery,    // Whether to save to character_images table
    custom_instructions // User-provided visual details to add to prompt
  } = req.body;

  if (!character_name) {
    return res.status(400).json({ error: "Missing character_name" });
  }

  // The image should be driven by the PHYSICAL appearance, not personality/role —
  // feeding role text ("criminal mastermind") makes the model invent wardrobe/armor.
  // Prefer the structured appearance; fall back to the legacy blended description.
  const hasStructuredAppearance = typeof appearance === 'string' && appearance.trim().length > 0;
  let characterDescription = hasStructuredAppearance ? appearance : (description || "");

  try {
    // Import the image model router
    const { getImageRouter, sanitizeForImageGeneration } = await import('../../services/imageModelRouter');
    type ImageModelId = 'seedream-4' | 'flux-1.1-pro' | 'flux-2-dev' | 'imagen-4-fast';

    // Sanitize user inputs before building the prompt to avoid moderation issues
    // This only cleans the description text — the technical prompt instructions stay untouched
    if (characterDescription) {
      characterDescription = await sanitizeForImageGeneration(characterDescription);
    }

    // Build element descriptions if provided
    let elementPromptSection = "";
    const elementsUsed: string[] = [];

    if (elements && Array.isArray(elements) && elements.length > 0 && character_id) {
      const elementDescriptions: string[] = [];

      // Elements can be passed as either full objects or just {id, include_description}
      // If we only have IDs, we need to fetch the full element data
      const firstElement = elements[0];
      const needsDataFetch = !firstElement.name && !firstElement.element_type;

      let fullElements: ElementForGeneration[] = elements;

      if (needsDataFetch) {
        // Fetch full element data from database
        const characterElementsService = await import('../../services/characterElementsService');
        const { data: fetchedElements } = await characterElementsService.getCharacterElements(character_id);

        if (fetchedElements && fetchedElements.length > 0) {
          // Map the fetched elements to include the include_description flag
          const elementIdToFlags = new Map(elements.map((e: any) => [e.id, e.include_description]));
          fullElements = fetchedElements
            .filter((el: any) => elementIdToFlags.has(el.id))
            .map((el: any) => ({
              ...el,
              include_description: elementIdToFlags.get(el.id) !== false
            }));
        }
      }

      for (const element of fullElements) {
        if (element.include_description !== false && element.description) {
          const typeLabel = getElementTypeLabel(element.element_type);
          elementDescriptions.push(`${typeLabel}: ${element.description}`);
          elementsUsed.push(element.id);
        } else if (element.name) {
          // Include element by name even without description
          elementDescriptions.push(element.name);
          elementsUsed.push(element.id);
        }
      }

      if (elementDescriptions.length > 0) {
        elementPromptSection = ` Visual elements: ${elementDescriptions.join('. ')}.`;
      }
    }

    // Build comprehensive prompt for character portrait
    // Character physical description gets highest priority in the prompt (placed first, before story context)
    // Age is explicitly extracted and reinforced to prevent models from aging up characters
    let prompt: string;
    const sanitizedImageDesc = image_description ? await sanitizeForImageGeneration(image_description) : '';
    const imageContext = sanitizedImageDesc ? ` Scene context: ${sanitizedImageDesc}.` : '';

    // Extract age from description to anchor it explicitly in the prompt
    // Matches patterns like "25-year-old", "25 year old", "age 25", "aged 25", "25 years old", "25 años"
    const visualIdentityPart = buildCharacterVisualProfilePrompt(visual_profile);
    const ageSource = `${visualIdentityPart} ${characterDescription}`;
    const ageMatch = ageSource.match(/(\d{1,2})[\s-]?(?:year[\s-]?old|years[\s-]?old|años|age(?:d)?[\s:]+)/i)
      || ageSource.match(/(?:age(?:d)?|edad)[\s:]+(\d{1,2})/i);
    const extractedAge = ageMatch ? parseInt(ageMatch[1] || ageMatch[0].match(/\d+/)?.[0] || '', 10) : null;

    // Build age anchor — placed at the very start of the prompt for maximum weight
    let ageAnchor = '';
    if (extractedAge && extractedAge > 0 && extractedAge < 100) {
      // Map age to a skin/face descriptor so the model doesn't just read "25" and ignore it
      let skinDescriptor = '';
      if (extractedAge <= 18) skinDescriptor = 'teenager with smooth youthful skin, baby-faced';
      else if (extractedAge <= 25) skinDescriptor = 'young adult with smooth youthful skin, no wrinkles, no forehead lines';
      else if (extractedAge <= 35) skinDescriptor = 'young adult with smooth skin, minimal signs of aging';
      else if (extractedAge <= 45) skinDescriptor = 'adult with early signs of aging, subtle expression lines';
      else if (extractedAge <= 55) skinDescriptor = 'middle-aged with visible expression lines';
      else skinDescriptor = 'older adult with natural aging, visible wrinkles';

      ageAnchor = `Exactly ${extractedAge} years old, ${skinDescriptor}. `;
    }

    // Character physical description is the PRIMARY visual source — place it prominently.
    // When falling back to the legacy blended description (no structured appearance),
    // tell the model to read ONLY physical traits from it and ignore personality/role,
    // so a "scheming planner" cat doesn't get dressed in a cloak.
    const descriptionPart = characterDescription
      ? (hasStructuredAppearance
          ? ` Character appearance (HIGHEST PRIORITY): ${characterDescription}.`
          : ` Character notes — extract ONLY physical/visual traits from this and IGNORE any personality, role, or story: ${characterDescription}.`)
      : '';

    // Render look comes from the project (source of truth); image_style is an optional override.
    const effectiveVisualStyle = await resolveEffectiveVisualStyle(supabase, req.body.project_id || req.projectId, image_style);

    // Support both base64 (preferred) and URL-based references
    const referenceImage = reference_image_base64 || reference_image_url;

    const similarityPercent = similarity !== undefined ? Math.round(parseFloat(similarity) * 100) : 70;
    prompt = buildCharacterImagePrompt({
      characterName: character_name,
      visualIdentityPart,
      descriptionPart,
      elementPromptSection,
      imageStyle: effectiveVisualStyle,
      imageContext,
      ageAnchor,
      hasReference: !!referenceImage,
      similarityPercent,
    });

    // Append user custom instructions to the prompt if provided
    if (custom_instructions && typeof custom_instructions === 'string' && custom_instructions.trim()) {
      const sanitizedCustom = await sanitizeForImageGeneration(custom_instructions.trim());
      if (sanitizedCustom) {
        prompt += ` Additional details: ${sanitizedCustom}.`;
      }
    }

    if (DEBUG_AI) console.log("🎨 Generating character image with model router...");

    const router = getImageRouter({
      preferredModel: (preferred_model as ImageModelId) || 'flux.2-klein-4b',
      preferredProvider: 'openrouter',
      fallbackEnabled: true
    });

    const result = await router.generate({
      prompt,
      aspectRatio: '1:1',
      outputFormat: 'png',
      ...(referenceImage && {
        referenceImages: [referenceImage],
        referenceStrength: similarity !== undefined ? parseFloat(similarity) : 0.7
      })
    });

    if (DEBUG_AI) console.log(`✅ Image generated with ${result.model} in ${result.generationTimeMs}ms`);

    // Download and store the image
    const imageResponse = await fetch(result.imageUrl);
    if (!imageResponse.ok) {
      return res.status(400).json({ error: "Failed to download generated image" });
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const fileName = `characters/ai-generated/${uuidv4()}.png`;

    const { error: uploadError } = await supabase.storage
      .from('character-images')
      .upload(fileName, imageBuffer, {
        contentType: 'image/png',
        upsert: true
      });

    if (uploadError) {
      return res.status(500).json({ error: `Storage upload failed: ${uploadError.message}` });
    }

    // Store the path in DB, generate signed URL for immediate response
    const { getSignedUrl: getSignedUrlFn, BUCKETS: B } = await import('../../services/storageService');
    const storagePath = fileName; // Path stored in DB
    const signedImageUrl = await getSignedUrlFn(B.CHARACTER_IMAGES, fileName); // URL for response

    // Track image generation usage
    if (req.userId) {
      await trackImageUsageInRoute(req, 'character_image', 'replicate', result.model, {
        imageDimensions: '1:1',
        imageFormat: 'png',
        imageQuality: 90,
        imageUrl: storagePath,
        promptText: prompt,
        metadata: {
          characterName: character_name,
          hasReferenceImage: !!referenceImage,
          imageStyle: image_style || 'photorealistic',
          modelUsed: result.model,
          generationTimeMs: result.generationTimeMs,
          elementsUsed: elementsUsed
        }
      });
    }

    // Note: AI credits are consumed by the trackAICreditsUsage middleware when response is sent

    // Always save to character_images table for multi-image gallery when character_id is provided
    let savedImageRecord = null;
    if (character_id) {
      try {
        const characterImagesService = await import('../../services/characterImagesService');

        // Migrate legacy image_url to gallery if gallery is empty but character has an image
        const galleryCount = await characterImagesService.getImageCount(character_id);
        if (galleryCount === 0) {
          const { data: char } = await supabase
            .from('characters')
            .select('image_url')
            .eq('id', character_id)
            .single();

          if (char?.image_url) {
            await characterImagesService.createCharacterImage({
              character_id,
              image_url: char.image_url,
              image_type: 'portrait',
              is_primary: true,
              is_ai_generated: false,
            });
            if (DEBUG_AI) console.log('📸 Migrated legacy character image_url to gallery');
          }
        }

        const { data: imageRecord, error: saveError } = await characterImagesService.createCharacterImage({
          character_id,
          image_url: storagePath,
          description: image_description,
          image_type: 'portrait',
          is_primary: true,
          is_ai_generated: true,
          generation_metadata: {
            model: result.model,
            prompt: prompt,
            elements_used: elementsUsed,
            image_style: image_style || 'photorealistic',
            generation_time_ms: result.generationTimeMs
          }
        });

        if (saveError) {
          console.warn('⚠️ Failed to save image to gallery:', saveError);
        } else {
          savedImageRecord = imageRecord;
          if (DEBUG_AI) console.log('✅ Image saved to character gallery:', imageRecord?.id);
        }

        // Update legacy image_url to match the new primary
        await supabase
          .from('characters')
          .update({ image_url: storagePath })
          .eq('id', character_id);
      } catch (saveErr) {
        console.warn('⚠️ Error saving image to gallery:', saveErr);
      }
    }

    if (req.userId && req.projectId) {
      aiTaskEvents.emit('task', {
        type: 'character-image:completed',
        projectId: req.projectId,
        userId: req.userId,
        payload: { characterId: character_id },
      });
    }

    req.aiCreditsUsageDescription = 'Character image generation';
    return res.json({
      image_url: signedImageUrl,
      model_used: result.model,
      generation_time_ms: result.generationTimeMs,
      elements_used: elementsUsed,
      saved_to_gallery: !!savedImageRecord,
      image_record: savedImageRecord
    });

  } catch (error: unknown) {
    console.error('AI character image generation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (req.userId && req.projectId) {
      aiTaskEvents.emit('task', {
        type: 'character-image:failed',
        projectId: req.projectId,
        userId: req.userId,
        payload: { error: errorMessage },
      });
    }

    if (errorMessage.includes('Insufficient credit') || errorMessage.includes('402')) {
      return res.status(402).json({
        error: "Insufficient Replicate credits",
        details: "Please add credits to your Replicate account at https://replicate.com/account/billing#billing and wait a few minutes for processing.",
        replicateError: errorMessage
      });
    }

    if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
      return res.status(401).json({
        error: "Replicate API authentication failed",
        details: "Please check your Replicate API key configuration."
      });
    }

    if ((error as any)?.code === 'CONTENT_MODERATED') {
      return res.status(422).json({
        error: "content_moderated",
        message: errorMessage
      });
    }

    return res.status(500).json({
      error: "AI character image generation failed",
      details: errorMessage
    });
  }
});

// POST /generate-character-views — generate identity-locked turnaround angles
// (front / three-quarter / profile / …) from a character's PRIMARY image.
//
// These extra angles give downstream storyboard + image-to-video a richer
// reference set, which keeps the face consistent across shots. Deliberately runs
// on the cheap fallback image model (flux.2-klein-4b, no escalation) at 100%
// reference strength so identity is preserved without the cost of the pro model.
//
// Billing: one image's worth of credits per generated view. The credit-check
// middleware validates the requested count up front (body.ai_credits_required);
// we set req.aiCreditsRequired to the count actually produced before responding,
// so failed views are never charged.
const CHARACTER_VIEW_MODEL = 'flux.2-klein-4b';
router.post("/generate-character-views", requireAuth, extractUserId, addPricingService, checkImageCredits, trackImageUsage, addAIUsageTracker, extractProjectId, async (req: CombinedRequest, res) => {
  const { character_id, angles, image_style } = req.body;

  if (!character_id) {
    return res.status(400).json({ error: "Missing character_id" });
  }

  try {
    // Load the character and its primary reference image.
    const { data: character, error: charError } = await supabase
      .from('characters')
      .select('id, name, appearance, description, image_url, project_id')
      .eq('id', character_id)
      .single();

    if (charError || !character) {
      return res.status(404).json({ error: "Character not found" });
    }
    if (!character.image_url) {
      return res.status(400).json({ error: "Generate a primary character image first — views are derived from it." });
    }

    const { getImageRouter, sanitizeForImageGeneration } = await import('../../services/imageModelRouter');
    const { getSignedUrl, BUCKETS } = await import('../../services/storageService');
    const characterImagesService = await import('../../services/characterImagesService');

    // Resolve the primary image to a fetchable URL for the model to condition on.
    const referenceImage = await getSignedUrl(BUCKETS.CHARACTER_IMAGES, character.image_url);

    // Validate requested angles; default to the two most useful extra views.
    // Cap so primary + views fit the 3-image gallery (primary + 2 views).
    const requested: string[] = Array.isArray(angles) && angles.length > 0
      ? angles.filter((a: string) => (CHARACTER_VIEW_ANGLES as readonly string[]).includes(a))
      : ['three-quarter', 'profile'];
    const galleryCount = await characterImagesService.getImageCount(character_id);
    const remainingSlots = Math.max(0, 3 - galleryCount);
    const targetAngles = [...new Set(requested)].slice(0, Math.max(1, remainingSlots || 2));

    // Prefer the structured physical appearance over the blended description.
    const visualSource = (typeof character.appearance === 'string' && character.appearance.trim())
      ? character.appearance
      : (character.description || '');
    const sanitizedDescription = visualSource ? await sanitizeForImageGeneration(visualSource) : '';
    const descriptionPart = sanitizedDescription ? ` Character appearance (HIGHEST PRIORITY): ${sanitizedDescription}.` : '';

    // Render look from the project (source of truth); image_style is an optional override.
    const effectiveVisualStyle = await resolveEffectiveVisualStyle(supabase, character.project_id || req.projectId, image_style);

    // Cheap fallback model only — no escalation to the pro model.
    const imageRouter = getImageRouter({
      preferredModel: CHARACTER_VIEW_MODEL,
      preferredProvider: 'openrouter',
      fallbackEnabled: false,
    });

    const generated: Array<{ angle: string; image_url: string; image_record: unknown }> = [];
    const failures: Array<{ angle: string; error: string }> = [];

    for (const angle of targetAngles) {
      try {
        const prompt = buildCharacterViewPrompt({
          characterName: character.name,
          angle,
          descriptionPart,
          imageStyle: effectiveVisualStyle,
        });

        const result = await imageRouter.generate({
          prompt,
          aspectRatio: '1:1',
          outputFormat: 'png',
          referenceImages: [referenceImage],
          referenceRoles: ['character'],
          referenceStrength: 1.0, // 100% — lock identity to the primary image
        });

        const imageResponse = await fetch(result.imageUrl);
        if (!imageResponse.ok) throw new Error('Failed to download generated view');
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        const fileName = `characters/views/${uuidv4()}.png`;
        const { error: uploadError } = await supabase.storage
          .from('character-images')
          .upload(fileName, imageBuffer, { contentType: 'image/png', upsert: true });
        if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

        const { data: imageRecord } = await characterImagesService.createCharacterImage({
          character_id,
          image_url: fileName,
          description: `${angle} view`,
          image_type: 'reference',
          is_primary: false,
          is_ai_generated: true,
          generation_metadata: {
            model: result.model,
            angle,
            prompt,
            reference_strength: 1.0,
            generation_time_ms: result.generationTimeMs,
          },
        });

        const signedUrl = await getSignedUrl(BUCKETS.CHARACTER_IMAGES, fileName);
        generated.push({ angle, image_url: signedUrl, image_record: imageRecord });

        if (req.userId) {
          await trackImageUsageInRoute(req, 'character_image', result.provider, result.model, {
            imageDimensions: '1:1',
            imageFormat: 'png',
            imageQuality: 90,
            imageUrl: fileName,
            promptText: prompt,
            metadata: { characterName: character.name, angle, viewGeneration: true, modelUsed: result.model },
          });
        }
      } catch (viewErr) {
        const msg = viewErr instanceof Error ? viewErr.message : 'View generation failed';
        console.error(`❌ Character view (${angle}) failed:`, msg);
        failures.push({ angle, error: msg });
      }
    }

    // Charge only for views that actually succeeded (consumed by trackImageUsage on response).
    req.aiCreditsRequired = generated.length * getEffectiveCost('image');
    req.aiCreditsUsageDescription = `Character reference views (${generated.length})`;

    if (generated.length === 0) {
      return res.status(502).json({ error: "Failed to generate character views", details: failures });
    }

    if (req.userId && req.projectId) {
      aiTaskEvents.emit('task', {
        type: 'character-image:completed',
        projectId: req.projectId,
        userId: req.userId,
        payload: { characterId: character_id, views: generated.length },
      });
    }

    return res.json({
      character_id,
      model_used: CHARACTER_VIEW_MODEL,
      generated: generated.length,
      views: generated,
      failed: failures,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Character views generation error:', errorMessage);
    if ((error as any)?.code === 'CONTENT_MODERATED') {
      return res.status(422).json({ error: "content_moderated", message: errorMessage });
    }
    return res.status(500).json({ error: "Failed to generate character views", details: errorMessage });
  }
});

// POST /brainstorming-to-characters - Extract characters from brainstorming conversation
// Generate characters from project documents (formerly "brainstorming-to-characters")
router.post("/documents-to-characters", requireAuth, extractUserId, preventDuplicateCharacterGeneration, addPricingService, checkAIGenerationLimit, trackAIUsage, async (req, res) => {
  const { conversation, projectId, projectType, history, episode_id, existing_characters } = req.body;

  if (!conversation || !projectId) {
    return res.status(400).json({ error: "Missing conversation or projectId" });
  }

  // Load language settings for the project
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const languageSettings = await loadProjectLanguageSettings(projectId, userId);
  const languageInstructions = buildLanguageInstructions(languageSettings.language, languageSettings.content_language, 'generation');

  // Format the full conversation history for better context
  const fullConversation = history && history.length > 0
    ? history.map((msg: any) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n\n')
    : conversation;

  // Try to get additional project context (script, concept)
  let scriptText = "";
  let conceptText = "";

  try {
    // Get script if available (episode-aware)
    let scriptId;

    if (episode_id) {
      // TV series - get episode's script
      const { data: episode } = await supabase
        .from("episodes")
        .select("script_id")
        .eq("id", episode_id)
        .eq("project_id", projectId)
        .single();

      if (episode?.script_id) {
        scriptId = episode.script_id;
      }
    } else {
      // Film - get project's production script
      const { data: project } = await supabase
        .from("projects")
        .select("prod_script_id")
        .eq("id", projectId)
        .single();

      if (project?.prod_script_id) {
        scriptId = project.prod_script_id;
      }
    }

    if (scriptId) {
      const { data: script } = await supabase
        .from("scripts")
        .select("content")
        .eq("id", scriptId)
        .single();

      if (script?.content) {
        scriptText = extractTextFromTipTapJSON(script.content);
      }
    }

    // Get documents instead of project concepts
    const { data: documents } = await supabase
      .from("project_documents")
      .select("title, document_type, content")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });

    if (documents && documents.length > 0) {
      conceptText = documents.map((doc: any) =>
        `${doc.title || 'Untitled Document'} (${doc.document_type}):\n${extractTextFromTipTapJSON(doc.content) || ''}`
      ).join('\n\n');
    }
  } catch (error) {
    // Continue without additional context if there's an error
    if (DEBUG_AI) console.log("Could not fetch additional project context:", error);
  }

  // Format existing characters for AI prompt to prevent duplicates
  const existingCharactersList = existing_characters && existing_characters.length > 0
    ? existing_characters.map((c: any) => `- ${c.name}${c.description ? `: ${c.description.substring(0, 100)}` : ''}`).join('\n')
    : null;

  const prompt = buildDocumentsToCharactersPrompt({
      projectType,
      scriptText,
      conceptText,
      fullConversation,
      existingCharactersList,
      languageInstructions,
    });

  try {

    const charContext = AIModelRouter.createContext({
      requestType: 'extraction',
      inputText: prompt,
      expectedOutputTokens: 16384,
      metadata: { forceModel: 'grok' }
    });

    const charResult = await aiRouter.executeCompletion(charContext, {
      messages: [
        { role: "system", content: DOCUMENTS_TO_CHARACTERS_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: 16384,
    });

    let charactersContent = charResult.content?.trim() || "";

    // Clean up any markdown formatting
    if (charactersContent.startsWith("```json")) {
      charactersContent = charactersContent.replace(/```json|```/g, "").trim();
    } else if (charactersContent.startsWith("```")) {
      charactersContent = charactersContent.replace(/```/g, "").trim();
    }

    // Try to parse the JSON
    let charactersArray;
    try {
      charactersArray = JSON.parse(charactersContent);

      if (!Array.isArray(charactersArray)) {
        throw new Error("Not an array");
      }


      // Check if we got an empty array
      if (charactersArray.length === 0) {
        return res.json({
          characters: [],
          message: "No characters were found in the brainstorming conversation."
        });
      }

    } catch (parseError) {
      console.error('Invalid AI character extraction response:', parseError);
      return res.status(502).json({
        error: "AI returned invalid character data",
        details: "No characters were created. Please retry the extraction.",
      });
    }

    // Get existing characters to avoid duplicates (normalize names to handle V.O., O.S., CONT'D variations)
    const { data: existingCharacters } = await supabase
      .from('characters')
      .select('name')
      .eq('project_id', projectId);

    const existingKeys = new Set(
      (existingCharacters || []).map(c => getCharacterIdentityKey(c.name)).filter(Boolean)
    );

    if (DEBUG_AI) console.log('🔍 Existing characters in project:', existingKeys.size);

    const dedupedCharacters = dedupeCharacterCandidates(charactersArray);
    const charactersToInsert = dedupedCharacters
      .map((character: any) => ({
        project_id: projectId,
        name: canonicalizeCharacterName(character.name),
        appearance: character.appearance || null, // Concrete physical/visual description for image gen
        visual_profile: sanitizeCharacterVisualProfile(character.visual_profile),
        description: character.description || "Character from comprehensive project analysis",
        character_type: sanitizeCharacterType(character.character_type), // Sanitize to valid DB values
        primary_role: character.primary_role || 'character',
        importance_level: character.importance_level || 3,
        status: character.status || 'active',
        story_arc: character.story_arc || null,
        motivations: character.motivations || null,
        fears: character.fears || null,
        goals: character.goals || null,
        is_ai_generated: true,
        scope: episode_id ? 'episode' : 'project',
        episode_id: episode_id || null
      }))
      .filter(character => !existingKeys.has(getCharacterIdentityKey(character.name)));

    if (DEBUG_AI) console.log('💾 Characters after duplicate filter:', charactersToInsert.length);
    if (DEBUG_AI && charactersToInsert.length > 0) {
      if (DEBUG_AI) console.log('💾 Sample character data:', JSON.stringify(charactersToInsert[0], null, 2));
    }

    if (charactersToInsert.length === 0) {
      if (DEBUG_AI) console.log('ℹ️ All characters already exist in project');
      return res.json({
        characters: [],
        message: 'All extracted characters already exist in the project'
      });
    }

    const { data, error } = await supabase
      .from("characters")
      .insert(charactersToInsert)
      .select();

    if (error) {
      console.error("Failed to save characters:", error);
      return res.status(500).json({ error: "Database error", details: error.message });
    }

    // If episode_id provided, populate episode_characters mapping table
    if (episode_id && data && data.length > 0) {
      const episodeCharacterMappings = data.map((character: any) => ({
        episode_id: episode_id,
        character_id: character.id,
        role_type: character.character_type === 'main' ? 'regular' : 'guest'
      }));

      const { error: mappingError } = await supabase
        .from("episode_characters")
        .insert(episodeCharacterMappings);

      if (mappingError) {
        console.warn("Failed to populate episode_characters mapping:", mappingError);
        // Don't fail the request, just log the warning
      }
    }

    aiTaskEvents.emit('task', {
      type: 'character:extracted',
      projectId: projectId,
      userId,
      payload: { count: data?.length || 0 },
    });

    res.json({
      characters: dedupedCharacters,
      saved: data,
      message: `Created ${data?.length || 0} characters successfully from ${episode_id ? 'episode' : 'project'} context`
    });
  } catch (error) {
    console.error('Generation error:', error);
    aiTaskEvents.emit('task', {
      type: 'character:failed',
      projectId: projectId,
      userId,
      payload: { error: error instanceof Error ? error.message : 'Unknown error' },
    });
    res.status(500).json({ error: "AI error", details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /script-to-characters - Extract characters from production script
router.post("/script-to-characters", requireAuth, extractUserId, preventDuplicateCharacterGeneration, addPricingService, checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, async (req: CombinedRequest, res) => {
  const { project_id, projectType, episode_id, existing_characters } = req.body;

  if (!project_id) {
    return res.status(400).json({ error: "Missing project_id" });
  }

  // Load language settings for the project
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const languageSettings = await loadProjectLanguageSettings(project_id, userId);
  const languageInstructions = buildLanguageInstructions(languageSettings.language, languageSettings.content_language, 'generation');

  try {
    // Get the script to analyze
    // For TV series episodes: use episode's script_id
    // For films: use project's prod_script_id
    let scriptId;

    if (episode_id) {
      // TV series - get episode's script
      const { data: episode } = await supabase
        .from("episodes")
        .select("script_id")
        .eq("id", episode_id)
        .eq("project_id", project_id)
        .single();

      if (!episode?.script_id) {
        return res.status(400).json({ error: "No script found for this episode" });
      }
      scriptId = episode.script_id;
    } else {
      // Film - get project's production script
      const { data: project } = await supabase
        .from("projects")
        .select("prod_script_id")
        .eq("id", project_id)
        .single();

      if (!project?.prod_script_id) {
        return res.status(400).json({ error: "No production script found" });
      }
      scriptId = project.prod_script_id;
    }

    const { data: script } = await supabase
      .from("scripts")
      .select("content")
      .eq("id", scriptId)
      .single();

    if (!script?.content) {
      return res.status(400).json({ error: "Script content not found" });
    }

    // Convert TipTap JSON to readable text
    const scriptText = extractTextFromTipTapJSON(script.content);

    // Format existing characters for AI prompt to prevent duplicates
    const existingCharactersList = existing_characters && existing_characters.length > 0
      ? existing_characters.map((c: any) => `- ${c.name}${c.description ? `: ${c.description.substring(0, 100)}` : ''}`).join('\n')
      : null;

    const prompt = buildScriptToCharactersPrompt({
      projectType,
      scriptText,
      existingCharactersList,
      languageInstructions,
    });

    const scriptCharContext = AIModelRouter.createContext({
      requestType: 'extraction',
      inputText: prompt,
      expectedOutputTokens: 16384,
      metadata: { forceModel: 'grok' }
    });

    const scriptCharResult = await aiRouter.executeCompletion(scriptCharContext, {
      messages: [
        { role: "system", content: SCRIPT_TO_CHARACTERS_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: 16384,
    });

    let charactersContent = scriptCharResult.content?.trim() || "";

    // Clean up any markdown formatting
    if (charactersContent.startsWith("```json")) {
      charactersContent = charactersContent.replace(/```json|```/g, "").trim();
    } else if (charactersContent.startsWith("```")) {
      charactersContent = charactersContent.replace(/```/g, "").trim();
    }

    // Try to parse the JSON
    let charactersArray;
    try {
      charactersArray = JSON.parse(charactersContent);

      if (!Array.isArray(charactersArray)) {
        throw new Error("Not an array");
      }
    } catch (parseError) {
      console.error("Invalid AI script character response:", parseError);
      return res.status(502).json({
        error: "AI returned invalid character data",
        details: "No characters were created. Please retry the extraction.",
      });
    }

    // Get existing characters to avoid duplicates (normalize names to handle V.O., O.S., CONT'D variations)
    const { data: existingCharacters } = await supabase
      .from('characters')
      .select('name')
      .eq('project_id', project_id);

    const existingKeys = new Set(
      (existingCharacters || []).map(c => getCharacterIdentityKey(c.name)).filter(Boolean)
    );

    if (DEBUG_AI) console.log('🔍 Existing characters in project:', existingKeys.size);

    const dedupedCharacters = dedupeCharacterCandidates(charactersArray);
    const charactersToInsert = dedupedCharacters
      .map((character: any) => ({
        project_id: project_id,
        name: canonicalizeCharacterName(character.name),
        appearance: character.appearance || null, // Concrete physical/visual description for image gen
        visual_profile: sanitizeCharacterVisualProfile(character.visual_profile),
        description: character.description || "Character from script analysis",
        character_type: sanitizeCharacterType(character.character_type), // Sanitize to valid DB values
        primary_role: character.primary_role || 'character',
        importance_level: character.importance_level || 3,
        status: character.status || 'active',
        story_arc: character.story_arc || null,
        motivations: character.motivations || null,
        fears: character.fears || null,
        goals: character.goals || null,
        is_ai_generated: true,
        scope: episode_id ? 'episode' : 'project',
        episode_id: episode_id || null
      }))
      .filter(character => !existingKeys.has(getCharacterIdentityKey(character.name)));

    if (DEBUG_AI) console.log('💾 Characters after duplicate filter:', charactersToInsert.length);

    if (charactersToInsert.length === 0) {
      if (DEBUG_AI) console.log('ℹ️ All characters already exist in project');
      return res.json({
        characters: [],
        message: 'All extracted characters already exist in the project'
      });
    }

    const { data, error } = await supabase
      .from("characters")
      .insert(charactersToInsert)
      .select();

    if (error) {
      console.error("Failed to save script characters:", error);
      return res.status(500).json({ error: "Database error", details: error.message });
    }

    // If episode_id provided, populate episode_characters mapping table
    if (episode_id && data && data.length > 0) {
      const episodeCharacterMappings = data.map((character: any) => ({
        episode_id: episode_id,
        character_id: character.id,
        role_type: character.character_type === 'main' ? 'regular' : 'guest'
      }));

      const { error: mappingError } = await supabase
        .from("episode_characters")
        .insert(episodeCharacterMappings);

      if (mappingError) {
        console.warn("Failed to populate episode_characters mapping:", mappingError);
        // Don't fail the request, just log the warning
      }
    }

    // Track AI usage
    if (scriptCharResult.usage && userId) {
      await trackOpenAIUsageInRoute(req, 'character_generation', scriptCharResult.model, {
        prompt_tokens: scriptCharResult.usage.prompt_tokens,
        completion_tokens: scriptCharResult.usage.completion_tokens,
        total_tokens: scriptCharResult.usage.total_tokens
      }, {
        metadata: {
          projectId: project_id,
          episodeId: episode_id,
          charactersExtracted: data?.length || 0,
          provider: scriptCharResult.provider
        }
      });
    }

    aiTaskEvents.emit('task', {
      type: 'character:extracted',
      projectId: project_id,
      userId,
      payload: { count: data?.length || 0, source: 'script' },
    });

    res.json({
      characters: dedupedCharacters,
      saved: data,
      message: `Extracted and created ${data?.length || 0} characters from ${episode_id ? 'episode' : 'project'} script`
    });
  } catch (error) {
    console.error('Script to characters error:', error);
    aiTaskEvents.emit('task', {
      type: 'character:failed',
      projectId: project_id,
      userId,
      payload: { error: error instanceof Error ? error.message : 'Unknown error', source: 'script' },
    });
    res.status(500).json({ error: "AI analysis failed", details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
