import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { v4 as uuidv4 } from 'uuid';
// Image generation is handled by imageModelRouter (OpenRouter primary, Replicate optional).
import { OpenAI } from "openai";
import { extractUserId, checkAIGenerationLimit, trackAIUsage, addPricingService, checkImageCredits, trackImageUsage, PricingRequest } from "../../middleware/pricingMiddleware";
import { aiRouter, AIModelRouter } from '../../services/aiModelRouter';
import { requireAuth } from "../../middleware/auth";
import { preventDuplicateLocationGeneration, preventDuplicateLocationImageGeneration } from '../../middleware/requestDeduplication';
import { addAIUsageTracker, extractProjectId, trackImageUsageInRoute, trackOpenAIUsageInRoute, AITrackingRequest } from "../../middleware/aiUsageMiddleware";
import { aiTaskEvents } from '../../services/aiTaskEventService';
import {
  getUserId,
  loadProjectLanguageSettings,
  buildLanguageInstructions,
  extractTextFromTipTapJSON
} from '../../utils/aiHelpers';
import {
  DOCUMENTS_TO_LOCATIONS_SYSTEM,
  SCRIPT_TO_LOCATIONS_SYSTEM,
  buildDocumentsToLocationsPrompt,
  buildScriptToLocationsPrompt,
  buildLocationImagePrompt,
} from '../../prompts';
import { resolveEffectiveVisualStyle } from '../../services/projectStyleService';
import {
  canonicalizeLocationName,
  dedupeLocationCandidates,
  getLocationIdentityKey,
} from '../../utils/locationIdentity';
import {
  buildLocationVisualProfilePrompt,
  sanitizeLocationVisualProfile,
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

// Note: provider clients are managed by imageModelRouter service.

// Brainstorming to locations - comprehensive extraction including script content
// Generate locations from project documents (formerly "brainstorming-to-locations")
router.post("/documents-to-locations", requireAuth, extractUserId, preventDuplicateLocationGeneration, addPricingService, checkAIGenerationLimit, trackAIUsage, async (req, res) => {
  const { conversation, projectId, projectType, history, episode_id, existing_locations } = req.body;

  if (!conversation || !projectId) {
    return res.status(400).json({ error: "Missing conversation or projectId" });
  }

  // Load language settings for the project
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Verify project access (write required for location generation)
  const access = await checkProjectAccessForUser(projectId, userId);
  if (!access.hasAccess) {
    return res.status(403).json({ error: 'Access denied - not authorized for this project' });
  }
  if (!access.canEdit) {
    return res.status(403).json({ error: 'Read-only access - viewers cannot generate locations', role: 'viewer' });
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

  // Format existing locations for AI prompt to prevent duplicates
  const existingLocationsList = existing_locations && existing_locations.length > 0
    ? existing_locations.map((l: any) => `- ${l.name}${l.description ? `: ${l.description.substring(0, 100)}` : ''}`).join('\n')
    : null;

  const prompt = buildDocumentsToLocationsPrompt({
    projectType: projectType || 'film',
    scriptText,
    conceptText,
    fullConversation,
    existingLocationsList,
    languageInstructions,
  });

  try {
    if (DEBUG_AI) console.log("Location extraction input (first 500 chars):", fullConversation.substring(0, 500));

    const locContext = AIModelRouter.createContext({
      requestType: 'extraction',
      inputText: prompt,
      expectedOutputTokens: 16384,
      metadata: { forceModel: 'grok' }
    });

    const locResult = await aiRouter.executeCompletion(locContext, {
      messages: [
        { role: "system", content: DOCUMENTS_TO_LOCATIONS_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: 16384,
    });

    let locationsContent = locResult.content?.trim() || "";

    // Clean up any markdown formatting
    if (locationsContent.startsWith("```json")) {
      locationsContent = locationsContent.replace(/```json|```/g, "").trim();
    } else if (locationsContent.startsWith("```")) {
      locationsContent = locationsContent.replace(/```/g, "").trim();
    }

    // Try to parse the JSON
    let locationsArray;
    try {
      locationsArray = JSON.parse(locationsContent);

      if (!Array.isArray(locationsArray)) {
        throw new Error("Not an array");
      }
    } catch (parseError) {
      console.error("Invalid AI location extraction response:", parseError);
      return res.status(502).json({
        error: "AI returned invalid location data",
        details: "No locations were created. Please retry the extraction.",
      });
    }

    // Get existing locations to avoid duplicates
    const { data: existingLocations } = await supabase
      .from('locations')
      .select('name')
      .eq('project_id', projectId);

    const existingLocationKeys = new Set(
      (existingLocations || []).map(l => getLocationIdentityKey(l.name)).filter(Boolean)
    );

    if (DEBUG_AI) console.log('🔍 Existing locations in project:', existingLocationKeys.size);

    // Deduplicate the AI response itself before comparing it with saved locations.
    const dedupedLocations = dedupeLocationCandidates(locationsArray);
    const locationsToInsert = dedupedLocations
      .map((location: any) => ({
        project_id: projectId,
        name: canonicalizeLocationName(location.name) || "UNNAMED LOCATION",
        description: location.description || "Location from comprehensive project analysis",
        location_type: location.location_type || 'interior',
        story_importance: location.story_importance || 'supporting',
        atmosphere: location.atmosphere || null,
        visual_notes: location.visual_notes || null,
        visual_profile: sanitizeLocationVisualProfile(location.visual_profile),
        is_ai_generated: true,
        scope: episode_id ? 'episode' : 'project',
        episode_id: episode_id || null
      }))
      .filter(location => !existingLocationKeys.has(getLocationIdentityKey(location.name)));

    if (DEBUG_AI) console.log('💾 Locations after duplicate filter:', locationsToInsert.length);

    if (locationsToInsert.length === 0) {
      if (DEBUG_AI) console.log('ℹ️ All locations already exist in project');
      return res.json({
        locations: [],
        message: 'All extracted locations already exist in the project'
      });
    }

    const { data, error } = await supabase
      .from("locations")
      .insert(locationsToInsert)
      .select();

    if (error) {
      console.error("Failed to save locations:", error);
      return res.status(500).json({ error: "Database error", details: error.message });
    }

    // If episode_id provided, populate episode_locations mapping table
    if (episode_id && data && data.length > 0) {
      const episodeLocationMappings = data.map((location: any) => ({
        episode_id: episode_id,
        location_id: location.id,
        scene_count: null // Will be calculated later based on actual scenes
      }));

      const { error: mappingError } = await supabase
        .from("episode_locations")
        .insert(episodeLocationMappings);

      if (mappingError) {
        console.warn("Failed to populate episode_locations mapping:", mappingError);
        // Don't fail the request, just log the warning
      }
    }

    aiTaskEvents.emit('task', {
      type: 'location:extracted',
      projectId: projectId,
      userId,
      payload: { count: data?.length || 0 },
    });

    res.json({
      locations: dedupedLocations,
      saved: data,
      message: `Created ${data?.length || 0} locations successfully from ${episode_id ? 'episode' : 'project'} context`
    });
  } catch (error) {
    console.error('Generation error:', error);
    aiTaskEvents.emit('task', {
      type: 'location:failed',
      projectId: projectId,
      userId,
      payload: { error: error instanceof Error ? error.message : 'Unknown error' },
    });
    res.status(500).json({ error: "AI error", details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Script to locations - enhanced location extraction from scripts
router.post("/script-to-locations", requireAuth, extractUserId, preventDuplicateLocationGeneration, addPricingService, checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, async (req: CombinedRequest, res) => {
  const { project_id, projectType, episode_id, existing_locations } = req.body;

  if (!project_id) {
    return res.status(400).json({ error: "Missing project_id" });
  }

  // Load language settings for the project
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Verify project access (write required for location generation)
  const scriptLocAccess = await checkProjectAccessForUser(project_id, userId);
  if (!scriptLocAccess.hasAccess) {
    return res.status(403).json({ error: 'Access denied - not authorized for this project' });
  }
  if (!scriptLocAccess.canEdit) {
    return res.status(403).json({ error: 'Read-only access - viewers cannot generate locations', role: 'viewer' });
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

    // Format existing locations for AI prompt to prevent duplicates
    const existingLocationsList = existing_locations && existing_locations.length > 0
      ? existing_locations.map((l: any) => `- ${l.name}${l.description ? `: ${l.description.substring(0, 100)}` : ''}`).join('\n')
      : null;

    const prompt = buildScriptToLocationsPrompt({
      projectType: projectType || 'film',
      scriptText,
      existingLocationsList,
      languageInstructions,
    });

    const scriptLocContext = AIModelRouter.createContext({
      requestType: 'extraction',
      inputText: prompt,
      expectedOutputTokens: 16384,
      metadata: { forceModel: 'grok' }
    });

    const scriptLocResult = await aiRouter.executeCompletion(scriptLocContext, {
      messages: [
        { role: "system", content: SCRIPT_TO_LOCATIONS_SYSTEM },
        { role: "user", content: prompt },
      ],
      maxTokens: 16384,
    });

    let locationsContent = scriptLocResult.content?.trim() || "";

    // Clean up any markdown formatting
    if (locationsContent.startsWith("```json")) {
      locationsContent = locationsContent.replace(/```json|```/g, "").trim();
    } else if (locationsContent.startsWith("```")) {
      locationsContent = locationsContent.replace(/```/g, "").trim();
    }

    // Try to parse the JSON
    let locationsArray;
    try {
      locationsArray = JSON.parse(locationsContent);

      if (!Array.isArray(locationsArray)) {
        throw new Error("Not an array");
      }
    } catch (parseError) {
      console.error("Invalid AI script location response:", parseError);
      return res.status(502).json({
        error: "AI returned invalid location data",
        details: "No locations were created. Please retry the extraction.",
      });
    }

    // Get existing locations to avoid duplicates
    const { data: existingLocations } = await supabase
      .from('locations')
      .select('name')
      .eq('project_id', project_id);

    const existingLocationKeys = new Set(
      (existingLocations || []).map(l => getLocationIdentityKey(l.name)).filter(Boolean)
    );

    if (DEBUG_AI) console.log('🔍 Existing locations in project:', existingLocationKeys.size);

    // Valid values for database constraints
    const validLocationTypes = ['interior', 'exterior', 'both', 'studio', 'virtual'];
    const validStoryImportance = ['critical', 'major', 'supporting', 'minor'];

    // Filter out duplicates and prepare locations for insertion
    const dedupedLocations = dedupeLocationCandidates(locationsArray);
    const locationsToInsert = dedupedLocations
      .map((location: any) => {
        // Normalize location_type
        let locationType = 'interior';
        if (location.location_type) {
          const lt = String(location.location_type).toLowerCase();
          if (validLocationTypes.includes(lt)) {
            locationType = lt;
          } else if (lt.includes('both') || lt.includes('mixed') || (lt.includes('ext') && lt.includes('int'))) {
            locationType = 'both';
          } else if (lt.includes('ext')) {
            locationType = 'exterior';
          } else if (lt.includes('int')) {
            locationType = 'interior';
          } else if (lt.includes('studio')) {
            locationType = 'studio';
          } else if (lt.includes('virtual') || lt.includes('cgi')) {
            locationType = 'virtual';
          }
        }

        // Normalize story_importance (remove accents first)
        let storyImportance = 'supporting';
        if (location.story_importance) {
          const si = String(location.story_importance).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (validStoryImportance.includes(si)) {
            storyImportance = si;
          } else if (si.includes('critic') || si.includes('primary') || si.includes('main') || si.includes('principal')) {
            storyImportance = 'critical';
          } else if (si.includes('major') || si.includes('second') || si.includes('signif') || si.includes('mayor')) {
            storyImportance = 'major';
          } else if (si.includes('minor') || si.includes('back') || si.includes('minim') || si.includes('menor') || si.includes('fondo')) {
            storyImportance = 'minor';
          }
        }

        return {
          project_id: project_id,
          name: canonicalizeLocationName(location.name) || "UNNAMED LOCATION",
          description: location.description || "Location from script analysis",
          location_type: locationType,
          story_importance: storyImportance,
          atmosphere: location.atmosphere || null,
          visual_notes: location.visual_notes || null,
          visual_profile: sanitizeLocationVisualProfile(location.visual_profile),
          is_ai_generated: true,
          scope: episode_id ? 'episode' : 'project',
          episode_id: episode_id || null
        };
      })
      .filter(location => !existingLocationKeys.has(getLocationIdentityKey(location.name)));

    if (DEBUG_AI) console.log('💾 Locations after duplicate filter:', locationsToInsert.length);

    if (locationsToInsert.length === 0) {
      if (DEBUG_AI) console.log('ℹ️ All locations already exist in project');
      return res.json({
        locations: [],
        message: 'All extracted locations already exist in the project'
      });
    }

    const { data, error } = await supabase
      .from("locations")
      .insert(locationsToInsert)
      .select();

    if (error) {
      console.error("Failed to save script locations:", error);
      return res.status(500).json({ error: "Database error", details: error.message });
    }

    // If episode_id provided, populate episode_locations mapping table
    if (episode_id && data && data.length > 0) {
      const episodeLocationMappings = data.map((location: any) => ({
        episode_id: episode_id,
        location_id: location.id,
        scene_count: null // Will be calculated later based on actual scenes
      }));

      const { error: mappingError } = await supabase
        .from("episode_locations")
        .insert(episodeLocationMappings);

      if (mappingError) {
        console.warn("Failed to populate episode_locations mapping:", mappingError);
        // Don't fail the request, just log the warning
      }
    }

    // Track xAI usage
    if (scriptLocResult.usage && userId) {
      await trackOpenAIUsageInRoute(req, 'location_generation', scriptLocResult.model, {
        prompt_tokens: scriptLocResult.usage.prompt_tokens || 0,
        completion_tokens: scriptLocResult.usage.completion_tokens || 0,
        total_tokens: scriptLocResult.usage.total_tokens || 0
      }, {
        metadata: {
          projectId: project_id,
          episodeId: episode_id,
          locationsExtracted: data?.length || 0
        }
      });
    }

    aiTaskEvents.emit('task', {
      type: 'location:extracted',
      projectId: project_id,
      userId,
      payload: { count: data?.length || 0, source: 'script' },
    });

    res.json({
      locations: dedupedLocations,
      saved: data,
      message: `Extracted and created ${data?.length || 0} locations from ${episode_id ? 'episode' : 'project'} script`
    });
  } catch (error) {
    console.error('Script to locations error:', error);
    aiTaskEvents.emit('task', {
      type: 'location:failed',
      projectId: project_id,
      userId,
      payload: { error: error instanceof Error ? error.message : 'Unknown error', source: 'script' },
    });
    res.status(500).json({ error: "AI analysis failed", details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /generate-location-image - Generate AI location reference image
// Uses ImageModelRouter with OpenRouter primary and optional Replicate models.
router.post("/generate-location-image", requireAuth, extractUserId, preventDuplicateLocationImageGeneration, addPricingService, checkAIGenerationLimit, checkImageCredits, trackImageUsage, addAIUsageTracker, extractProjectId, async (req: CombinedRequest, res) => {
  if (DEBUG_AI) console.log("🏠 Location image generation started");
  const { location_id, location_name, description, visual_notes, visual_profile, atmosphere, location_type, reference_image_url, reference_image_base64, image_style, similarity, preferred_model, include_people, custom_instructions } = req.body;

  // Support both base64 (preferred) and URL-based references
  const referenceImage = reference_image_base64 || reference_image_url;

  if (!location_name) {
    return res.status(400).json({ error: "Missing location_name" });
  }

  try {
    // Import the image model router
    const { getImageRouter, sanitizeForImageGeneration } = await import('../../services/imageModelRouter');
    type ImageModelId = import('../../services/imageModelRouter').ImageModelId;

    // Stable location identity leads the prompt. Mood is deliberately last.
    const visualIdentity = buildLocationVisualProfilePrompt(visual_profile);
    const sanitizedVisualNotes = visual_notes
      ? await sanitizeForImageGeneration(visual_notes)
      : '';
    const atmosphereHint = atmosphere ? atmosphere.split(/[,.]/).filter(Boolean)[0]?.trim() : '';

    // Render look from the project (source of truth); image_style is an optional override.
    const effectiveVisualStyle = await resolveEffectiveVisualStyle(supabase, req.body.project_id || req.projectId, image_style);

    let prompt: string = buildLocationImagePrompt({
      locationName: location_name,
      locationType: location_type,
      visualIdentity,
      visualNotes: sanitizedVisualNotes
        ? `Additional visible environment details: ${sanitizedVisualNotes}.`
        : '',
      atmosphere: atmosphereHint,
      imageStyle: effectiveVisualStyle,
      includePeople: !!include_people,
      hasReference: !!referenceImage,
      similarityPercent: referenceImage && similarity !== undefined ? Math.round(parseFloat(similarity) * 100) : undefined,
    });

    // Append user custom instructions to the prompt if provided
    if (custom_instructions && typeof custom_instructions === 'string' && custom_instructions.trim()) {
      prompt += ` Additional details: ${custom_instructions.trim()}.`;
    }

    // Sanitize the FULL prompt to catch location names, context, and instructions that might trigger moderation
    prompt = await sanitizeForImageGeneration(prompt);

    if (DEBUG_AI) console.log("🎨 Generating location image with model router...");

    // Use the image model router - OpenRouter FLUX 2 Pro by default, with router-managed fallback.
    const router = getImageRouter({
      preferredModel: (preferred_model as ImageModelId) || 'flux.2-pro',
      preferredProvider: 'openrouter',
      fallbackEnabled: true
    });

    const result = await router.generate({
      prompt,
      aspectRatio: '16:9',
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
    const fileName = `locations/ai-generated/${uuidv4()}.png`;

    const { error: uploadError } = await supabase.storage
      .from('location-images')
      .upload(fileName, imageBuffer, {
        contentType: 'image/png',
        upsert: true
      });

    if (uploadError) {
      return res.status(500).json({ error: `Storage upload failed: ${uploadError.message}` });
    }

    // Store the path in DB, generate signed URL for immediate response
    const { getSignedUrl: getSignedUrlFn, BUCKETS: B } = await import('../../services/storageService');
    const storagePath = fileName;
    const signedImageUrl = await getSignedUrlFn(B.LOCATION_IMAGES, fileName);

    // Save to location_images gallery table (like characters do)
    if (location_id) {
      // `image_type` describes the image (exterior/interior/aerial/detail/reference),
      // not the location's type. location_type values like "both" violate the column's
      // CHECK constraint, so only honor it when it's a valid image_type — else default.
      const VALID_IMAGE_TYPES = ['exterior', 'interior', 'aerial', 'detail', 'reference'] as const;
      const imageType = VALID_IMAGE_TYPES.includes(location_type)
        ? (location_type as typeof VALID_IMAGE_TYPES[number])
        : 'exterior';
      try {
        const locationImagesService = await import('../../services/locationImagesService');

        // Migrate legacy image_url to gallery if gallery is empty but location has an image
        const galleryCount = await locationImagesService.getImageCount(location_id);
        if (galleryCount === 0) {
          const { data: loc } = await supabase
            .from('locations')
            .select('image_url')
            .eq('id', location_id)
            .single();

          if (loc?.image_url) {
            await locationImagesService.createLocationImage({
              location_id,
              image_url: loc.image_url,
              image_type: imageType,
              is_primary: true,
              is_ai_generated: false,
            });
            if (DEBUG_AI) console.log('📸 Migrated legacy image_url to gallery');
          }
        }

        const { data: imageRecord, error: saveError } = await locationImagesService.createLocationImage({
          location_id,
          image_url: storagePath,
          description: prompt,
          image_type: imageType,
          is_primary: true,
          is_ai_generated: true,
          generation_metadata: {
            model: result.model,
            provider: result.provider,
            prompt: prompt,
            image_style: image_style || 'photorealistic',
            has_reference_image: !!referenceImage,
            generation_time_ms: result.generationTimeMs
          }
        });

        if (saveError) {
          console.error('❌ Failed to save to location_images:', saveError.message);
        }

        // Update legacy image_url on the location record to match the new primary
        const { error: updateError } = await supabase
          .from('locations')
          .update({ image_url: storagePath })
          .eq('id', location_id);

        if (updateError) {
          console.error('❌ Failed to update location image_url:', updateError.message);
        }
      } catch (err) {
        console.error('❌ Failed to save location image to gallery:', err);
      }
    }

    // Track image generation usage
    if (req.userId) {
      await trackImageUsageInRoute(req, 'location_image', result.provider, result.model, {
        imageDimensions: '16:9',
        imageFormat: 'png',
        imageQuality: 90,
        imageUrl: storagePath,
        promptText: prompt,
        metadata: {
          locationName: location_name,
          locationType: location_type,
          hasReferenceImage: !!referenceImage,
          imageStyle: image_style || 'photorealistic',
          modelUsed: result.model,
          providerUsed: result.provider,
          generationTimeMs: result.generationTimeMs
        }
      });
    }

    // Note: AI credits are consumed by the trackAICreditsUsage middleware when response is sent

    if (req.userId && req.projectId) {
      aiTaskEvents.emit('task', {
        type: 'location-image:completed',
        projectId: req.projectId,
        userId: req.userId,
        payload: { locationId: location_id },
      });
    }

    req.aiCreditsUsageDescription = 'Location image generation';
    return res.json({
      image_url: signedImageUrl,
      model_used: result.model,
      provider_used: result.provider,
      generation_time_ms: result.generationTimeMs
    });

  } catch (error: unknown) {
    console.error('AI location image generation error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (req.userId && req.projectId) {
      aiTaskEvents.emit('task', {
        type: 'location-image:failed',
        projectId: req.projectId,
        userId: req.userId,
        payload: { error: errorMessage },
      });
    }

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
      error: "AI location image generation failed",
      details: errorMessage
    });
  }
});

export default router;
