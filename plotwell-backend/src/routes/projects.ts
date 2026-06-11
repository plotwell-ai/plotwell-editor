import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { extractUserId, checkProjectLimit, addPricingService, PricingRequest } from "../middleware/pricingMiddleware";
import { requireAuth, checkProjectAccess } from "../middleware/auth";
import { buildProjectGraph } from "../services/projectGraphService";
import { isEpisodic, defaultVideoFormat } from "../utils/projectType";
import { resolveVisualStyleId } from "../prompts";
// Note: AddonBillingService has been removed - replaced with unified billing system

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
// Note: addonBillingService has been removed

// Get all projects for a user (owned + collaborator)
router.get("/", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const userId = req.userId; // Extracted from JWT token
  const showTrashed = req.query.trashed === "true";

  try {
    // Get projects where user is the owner
    const { data: ownedProjects, error: ownedError } = await supabase
      .from("projects")
      .select("*")
      .eq("user_id", userId)
      .eq("deleted", showTrashed);
    
    if (ownedError) {
      console.error('❌ OWNED PROJECTS ERROR:', ownedError);
      return res.status(500).json({ error: ownedError.message });
    }

    // Get projects where user is a collaborator
    const { data: collaboratorProjects, error: collaboratorError } = await supabase
      .from("project_collaborators")
      .select(`
        role,
        status,
        joined_at,
        projects (
          id,
          name,
          description,
          project_type,
          status,
          content_language,
          user_id,
          created_at,
          updated_at,
          deleted
        )
      `)
      .eq("user_id", userId)
      .eq("status", "active")
      .eq("projects.deleted", showTrashed);

    if (collaboratorError) {
      console.error('❌ COLLABORATOR PROJECTS ERROR:', collaboratorError);
      return res.status(500).json({ error: collaboratorError.message });
    }

    // Flatten collaborator projects and add metadata
    const flattenedCollaboratorProjects = (collaboratorProjects || [])
      .filter(cp => cp.projects) // Only include records with valid project data
      .map(cp => ({
        ...cp.projects,
        user_role: cp.role,
        collaboration_status: cp.status,
        collaboration_joined_at: cp.joined_at,
        is_collaborator: true
      }));

    // Add metadata to owned projects
    const enrichedOwnedProjects = (ownedProjects || []).map(p => ({
      ...p,
      user_role: 'owner',
      is_collaborator: false
    }));

    // Combine both arrays and remove duplicates (shouldn't happen but just in case)
    const allProjects = [...enrichedOwnedProjects, ...flattenedCollaboratorProjects];
    const uniqueProjects = allProjects.filter((project, index, self) =>
      index === self.findIndex(p => p.id === project.id)
    );

    res.json(uniqueProjects);
  } catch (error) {
    console.error('❌ PROJECT LIST EXCEPTION:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post("/", requireAuth, extractUserId, addPricingService, checkProjectLimit, async (req: PricingRequest, res) => {
  const { name, description, project_type = 'film', status = 'active', content_language = 'en', video_format, visual_style, settings, title, author, based_on, contact_info, copyright_notice, registration_number, initial_content } = req.body;
  const user_id = req.userId; // Extracted from JWT token

  // Vertical formats default to 9:16; everything else to 16:9 (overridable by client).
  const resolvedVideoFormat = video_format || defaultVideoFormat(project_type);
  // AI render look. Normalize to a known palette id; defaults to 'cinematic'.
  const resolvedVisualStyle = resolveVisualStyleId(visual_style);

  const insertData = {
    name,
    description,
    user_id,
    project_type,
    status,
    content_language,
    video_format: resolvedVideoFormat,
    visual_style: resolvedVisualStyle,
    settings: settings || {},
    title,
    author,
    based_on,
    contact_info,
    copyright_notice,
    registration_number
  };

  const { data, error } = await supabase
    .from("projects")
    .insert([insertData])
    .select()
    .single();

  if (error) {
    console.error('❌ PROJECT INSERT ERROR:', {
      error: error,
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code
    });
    return res.status(500).json({ error: error.message });
  }

  // Auto-create first conversation for immediate chat interface
  try {
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .insert([{
        project_id: data.id,
        title: "Welcome to Brainstorming"
      }])
      .select()
      .single();

    if (convError) {
      console.error('⚠️ Failed to create initial conversation:', convError);
      // Don't fail project creation if conversation creation fails
    }
  } catch (convError) {
    console.error('⚠️ Exception creating initial conversation:', convError);
    // Don't fail project creation
  }

  // Check if this project creation requires addon billing
  try {
    const pricingService = req.pricingService!;
    const userSubscription = await pricingService.getUserSubscription(user_id);
    const currentProjectCount = userSubscription.projects_count || 0;
    const { getPlanById } = await import('../config/pricingPlans');
    const plan = getPlanById(userSubscription.plan_id);

    if (plan) {
      // Get effective limits including addons
      const effectiveLimits = pricingService.getEffectiveLimits(
        plan,
        userSubscription.additional_projects || 0,
        userSubscription.additional_collaborators || 0
      );

      // Check if user exceeds EFFECTIVE limits (including addons)
      if (effectiveLimits.projects !== -1 && currentProjectCount > effectiveLimits.projects) {
        return res.status(402).json({
          error: 'Project limit exceeded',
          message: 'You need to purchase additional project slots to create more projects',
          limit_info: {
            current_projects: currentProjectCount,
            plan_limit: plan.limits.projects,
            additional_projects: userSubscription.additional_projects || 0,
            effective_limit: effectiveLimits.projects,
            addon_required: true,
            addon_price: 3 // USD per additional project
          },
          action: {
            type: 'addon_purchase_required',
            addon_type: 'additional_projects',
            redirect_to: '/profile?purchase=projects'
          }
        });
      }
    }
  } catch (billingError) {
    console.error('❌ Error processing addon billing:', billingError);
    // Don't fail the project creation if billing fails
  }

  // Auto-create initial script (and season/episode for TV series)
  let initialScriptId: string | null = null;
  let initialEpisodeId: string | null = null;
  let initialSeasonId: string | null = null;

  try {
    // Default empty screenplay document
    const defaultContent = {
      type: "doc",
      content: [{
        type: "action"
      }]
    };
    const initialContent = (initial_content && initial_content.type === 'doc') ? initial_content : defaultContent;

    if (isEpisodic(project_type)) {
      // For episodic projects (TV series / vertical series): Create Season 1 → Episode 1 → Script
      if (DEBUG_AI) console.log('🎬 Creating initial episodic structure...');

      // 1. Create Season 1
      const { data: season, error: seasonError } = await supabase
        .from("seasons")
        .insert([{
          project_id: data.id,
          season_number: 1,
          title: "Season 1"
        }])
        .select()
        .single();

      if (seasonError) {
        console.error('⚠️ Failed to create initial season:', seasonError);
      } else {
        initialSeasonId = season.id;
        if (DEBUG_AI) console.log('✅ Created Season 1:', season.id);

        // 2. Create Episode 1
        const { data: episode, error: episodeError } = await supabase
          .from("episodes")
          .insert([{
            season_id: season.id,
            project_id: data.id,
            episode_number: 1,
            title: "Episode 1"
          }])
          .select()
          .single();

        if (episodeError) {
          console.error('⚠️ Failed to create initial episode:', episodeError);
        } else {
          initialEpisodeId = episode.id;
          if (DEBUG_AI) console.log('✅ Created Episode 1:', episode.id);

          // 3. Create script linked to episode
          const { data: script, error: scriptError } = await supabase
            .from("scripts")
            .insert([{
              project_id: data.id,
              episode_id: episode.id,
              title: "Untitled Script",
              content: initialContent,
              is_ai_generated: false
            }])
            .select()
            .single();

          if (scriptError) {
            console.error('⚠️ Failed to create initial script:', scriptError);
          } else {
            initialScriptId = script.id;
            if (DEBUG_AI) console.log('✅ Created initial script for Episode 1:', script.id);

            // 4. Link script to episode
            await supabase
              .from("episodes")
              .update({ script_id: script.id })
              .eq("id", episode.id);
          }
        }
      }
    } else {
      // For film/short/other: Create a single script
      if (DEBUG_AI) console.log('🎬 Creating initial script for project...');

      const { data: script, error: scriptError } = await supabase
        .from("scripts")
        .insert([{
          project_id: data.id,
          title: "Untitled Script",
          content: initialContent,
          is_ai_generated: false
        }])
        .select()
        .single();

      if (scriptError) {
        console.error('⚠️ Failed to create initial script:', scriptError);
      } else {
        initialScriptId = script.id;
        if (DEBUG_AI) console.log('✅ Created initial script:', script.id);

        // Set as production script
        await supabase
          .from("projects")
          .update({ prod_script_id: script.id })
          .eq("id", data.id);
      }
    }
  } catch (scriptError) {
    console.error('⚠️ Exception creating initial script/structure:', scriptError);
    // Don't fail project creation if script creation fails
  }

  // Return project with initial script/episode info for navigation
  res.json({
    ...data,
    initial_script_id: initialScriptId,
    initial_episode_id: initialEpisodeId,
    initial_season_id: initialSeasonId
  });
});

// Get a single project by ID (with collaboration access check)
router.get("/:id", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId; // Extracted from JWT token

  try {
    // First check if user has access to this project (owner or collaborator)
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .single();

    if (projectError || !project) {
      if (DEBUG_AI) console.log('❌ Project not found:', projectError?.message);
      return res.status(404).json({ error: "Project not found" });
    }
    
    // Check if user is the owner
    if (project.user_id === userId) {
      return res.json({
        ...project,
        user_role: 'owner',
        is_collaborator: false
      });
    }
    
    // Check if user is a collaborator
    const { data: collaborator, error: collaboratorError } = await supabase
      .from("project_collaborators")
      .select("role, status")
      .eq("project_id", id)
      .eq("user_id", userId)
      .eq("status", "active")
      .single();
    
    if (collaboratorError || !collaborator) {
      if (DEBUG_AI) console.log('❌ Access denied - not owner or collaborator:', collaboratorError?.message);
      return res.status(403).json({ error: "Access denied" });
    }

    // User is a collaborator, return project data with role info
    res.json({
      ...project,
      user_role: collaborator.role,
      is_collaborator: true,
      collaboration_status: collaborator.status
    });
  } catch (error) {
    console.error('❌ GET PROJECT ERROR:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Relationship graph (mind-map) for a project: a read-only projection over
// characters, locations, scenes, beats, cast and assets plus their derived
// relationships. Backs the editable project map UI.
router.get("/:project_id/graph", requireAuth, checkProjectAccess, async (req: Request, res: Response) => {
  const { project_id } = req.params;
  const episodeId = (req.query.episode_id as string) || null;

  try {
    const graph = await buildProjectGraph(project_id, episodeId);
    res.json(graph);
  } catch (error) {
    console.error('❌ GET PROJECT GRAPH ERROR:', error);
    res.status(500).json({ error: "Failed to build project graph" });
  }
});

// Mark project onboarding as completed (owner only)
router.post("/:id/onboarding-complete", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId;

  try {
    // Update only if user is the owner and onboarding not already completed
    const { data, error } = await supabase
      .from("projects")
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId) // Only owner can mark onboarding complete
      .is("onboarding_completed_at", null) // Only update if not already completed
      .select("id, onboarding_completed_at")
      .single();

    if (error) {
      // If no rows updated, it might already be completed or user is not owner
      if (error.code === 'PGRST116') {
        // Check if it's because already completed or because not owner
        const { data: project } = await supabase
          .from("projects")
          .select("user_id, onboarding_completed_at")
          .eq("id", id)
          .single();

        if (project && project.user_id !== userId) {
          return res.status(403).json({ error: "Only project owner can complete onboarding" });
        }

        if (project && project.onboarding_completed_at) {
          return res.json({ id, onboarding_completed_at: project.onboarding_completed_at, already_completed: true });
        }
      }
      console.error('❌ ONBOARDING COMPLETE ERROR:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ id: data.id, onboarding_completed_at: data.onboarding_completed_at });
  } catch (error) {
    console.error('❌ ONBOARDING COMPLETE EXCEPTION:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Restore a project with $5 payment validation
router.post("/:id/restore", requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId!;
  const pricingService = req.pricingService!;

  try {
    // Get project and verify it's deleted and user owns it
    const { data: project, error: fetchError } = await supabase
      .from("projects")
      .select("deleted, title")
      .eq("id", id)
      .eq("user_id", userId)
      .single();
    
    if (fetchError) return res.status(500).json({ error: fetchError.message });
    
    if (!project) {
      return res.status(404).json({ error: "Project not found or access denied" });
    }
    
    if (!project.deleted) {
      return res.status(400).json({ 
        error: "Project is not deleted",
        current_status: "active"
      });
    }
    
    // Check if user can afford the restore fee and if it would exceed limits
    const RESTORE_FEE_DOLLARS = 5;
    const subscription = await pricingService.getUserSubscription(userId);
    const currentActiveCount = subscription.projects_count || 0;
    const plan = pricingService.getPlan(subscription.plan_id);
    
    if (!plan) {
      return res.status(400).json({ error: "Invalid subscription plan" });
    }
    
    const effectiveLimits = pricingService.getEffectiveLimits(
      plan,
      subscription.additional_projects || 0,
      subscription.additional_collaborators || 0
    );

    // Trashed projects already count toward the limit, so restore is only blocked
    // if user is already at/over their limit (shouldn't happen but check anyway)
    if (effectiveLimits.projects !== -1 && currentActiveCount > effectiveLimits.projects) {
      if (DEBUG_AI) console.log(`❌ RESTORE BLOCKED: Already at/over limit. Current: ${currentActiveCount}, Limit: ${effectiveLimits.projects}`);

      return res.status(403).json({
        error: 'limit_exceeded',
        error_type: 'restore_blocked',
        limit_info: {
          current_projects: currentActiveCount,
          effective_limit: effectiveLimits.projects,
          plan_limit: plan.limits.projects,
          additional_projects: subscription.additional_projects || 0
        },
        redirect_to: '/profile/plans'
      });
    }

    // Process the restore with payment
    const isDevelopment = process.env.NODE_ENV !== 'production';

    // Record the restore transaction
    const { error: transactionError } = await supabase
      .from('unarchive_transactions')
      .insert({
        user_id: userId,
        project_id: id,
        transaction_type: 'restore',
        amount_cents: RESTORE_FEE_DOLLARS * 100, // $5.00 = 500 cents
        currency: 'USD',
        status: 'completed',
        payment_method: isDevelopment ? 'dev_simulation' : 'stripe',
        project_title: project.title,
        created_at: new Date().toISOString()
      });

    if (transactionError) {
      console.error('❌ RESTORE TRANSACTION ERROR:', transactionError);
    }
    
    // Restore the project
    const { error: updateError } = await supabase
      .from("projects")
      .update({ 
        deleted: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("user_id", userId);
    
    if (updateError) {
      console.error('❌ RESTORE UPDATE ERROR:', updateError);
      return res.status(500).json({ error: "Failed to restore project" });
    }

    res.json({
      success: true,
      message: `Project "${project.title}" has been restored`,
      project_id: id,
      project_title: project.title,
      restore_fee: RESTORE_FEE_DOLLARS,
      active_projects_count: currentActiveCount,
      limit: effectiveLimits.projects
    });
    
  } catch (error) {
    console.error('❌ RESTORE PROJECT ERROR:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Edit a project (update name and/or description)
router.put("/:id", requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId; // Extracted from JWT token
  const { name, description, project_type, status, content_language, video_format, visual_style, settings, title, author, based_on, contact_info, copyright_notice, registration_number, estimated_duration } = req.body;

  // Check if project is archived first and user owns it
  const { data: existingProject, error: fetchError } = await supabase
    .from("projects")
    .select("status")
    .eq("id", id)
    .eq("user_id", userId) // Ensure user owns this project
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });

  // Prevent editing archived projects
  if (existingProject.status === 'archived') {
    return res.status(403).json({
      error: "Archived projects are read-only. You can unarchive this project for $5 to make it editable again.",
      can_unarchive: true,
      unarchive_fee: 5
    });
  }

  // Build update object - only include fields that are provided
  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (project_type !== undefined) updateData.project_type = project_type;
  if (status !== undefined) updateData.status = status;
  if (content_language !== undefined) updateData.content_language = content_language;
  if (video_format !== undefined) updateData.video_format = video_format;
  if (visual_style !== undefined) updateData.visual_style = resolveVisualStyleId(visual_style);
  if (settings !== undefined) updateData.settings = settings;
  // Handle estimated_duration by merging into settings JSONB
  if (estimated_duration !== undefined) {
    // If settings is already being updated, merge duration into it
    if (updateData.settings) {
      updateData.settings = { ...updateData.settings, duration: estimated_duration };
    } else {
      // Fetch existing settings to merge
      const { data: existingProject } = await supabase
        .from("projects")
        .select("settings")
        .eq("id", id)
        .single();
      const existingSettings = existingProject?.settings || {};
      updateData.settings = { ...existingSettings, duration: estimated_duration };
    }
  }
  if (title !== undefined) updateData.title = title;
  if (author !== undefined) updateData.author = author;
  if (based_on !== undefined) updateData.based_on = based_on;
  if (contact_info !== undefined) updateData.contact_info = contact_info;
  if (copyright_notice !== undefined) updateData.copyright_notice = copyright_notice;
  if (registration_number !== undefined) updateData.registration_number = registration_number;

  const { data, error } = await supabase
    .from("projects")
    .update(updateData)
    .eq("id", id)
    .eq("user_id", userId) // Ensure user owns this project
    .select()
    .single();

  if (error) {
    console.error('❌ PROJECT UPDATE ERROR:', {
      error: error,
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
      updateData: updateData
    });
    return res.status(500).json({ error: error.message });
  }

  // If project was just changed to an episodic type, ensure Season 1 + Episode 1 + Script exist
  if (isEpisodic(project_type)) {
    try {
      const { data: existingSeasons } = await supabase
        .from('seasons')
        .select('id')
        .eq('project_id', id)
        .limit(1);

      if (!existingSeasons || existingSeasons.length === 0) {
        // Create Season 1
        const { data: season } = await supabase
          .from('seasons')
          .insert([{ project_id: id, season_number: 1, title: 'Season 1' }])
          .select()
          .single();

        if (season) {
          // Create Episode 1
          const { data: episode } = await supabase
            .from('episodes')
            .insert([{ season_id: season.id, project_id: id, episode_number: 1, title: 'Episode 1' }])
            .select()
            .single();

          if (episode) {
            // Find the existing film script (no episode_id) and link it, or create a new one
            const { data: existingScript } = await supabase
              .from('scripts')
              .select('id')
              .eq('project_id', id)
              .is('episode_id', null)
              .order('created_at', { ascending: true })
              .limit(1)
              .single();

            if (existingScript) {
              // Link the existing script to the new episode
              await supabase
                .from('scripts')
                .update({ episode_id: episode.id })
                .eq('id', existingScript.id);
              await supabase
                .from('episodes')
                .update({ script_id: existingScript.id })
                .eq('id', episode.id);
            } else {
              // Create a fresh script for Episode 1
              const { data: newScript } = await supabase
                .from('scripts')
                .insert([{
                  project_id: id,
                  episode_id: episode.id,
                  title: 'Untitled Script',
                  content: { type: 'doc', content: [{ type: 'action' }] },
                  is_ai_generated: false
                }])
                .select()
                .single();
              if (newScript) {
                await supabase
                  .from('episodes')
                  .update({ script_id: newScript.id })
                  .eq('id', episode.id);
              }
            }
          }
        }
      }
    } catch (migrationError) {
      console.error('⚠️ Failed to migrate film → series structure:', migrationError);
      // Don't fail the response — the project update itself succeeded
    }
  }

  res.json(data);
});

// Update project status specifically
router.patch("/:id/status", requireAuth, extractUserId, async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.userId; // Extracted from JWT token
  const { status } = req.body;

  // Check if project exists and user owns it
  const { data: existingProject, error: fetchError } = await supabase
    .from("projects")
    .select("status, user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    console.error('❌ PATCH STATUS FETCH ERROR:', fetchError);
    return res.status(500).json({ error: fetchError.message });
  }

  if (!existingProject) {
    return res.status(404).json({ error: "Project not found" });
  }

  // Check ownership
  if (existingProject.user_id !== userId) {
    return res.status(403).json({ error: "Access denied - not the project owner" });
  }

  // Prevent changing status of archived projects (except to unarchive via separate endpoint)
  if (existingProject.status === 'archived' && status !== 'archived') {
    return res.status(403).json({
      error: "Archived projects are read-only. You can unarchive this project for $5 to make changes.",
      can_unarchive: true,
      unarchive_fee: 5
    });
  }

  // Validate status - allow 'archived' for setting but prevent editing archived projects above
  const validStatuses = ['draft', 'active', 'in_progress', 'review', 'completed', 'paused', 'archived'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  // All plans can archive. Unarchiving requires payment (handled separately).

  const { data, error } = await supabase
    .from("projects")
    .update({ status })
    .eq("id", id)
    .eq("user_id", userId) // Ensure user owns this project
    .select()
    .single();

  if (error) {
    console.error('❌ PATCH STATUS UPDATE ERROR:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// Delete a project (set deleted to true)
router.delete("/:id", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId; // Extracted from JWT token

  // Check if project exists and user owns it
  const { data: existingProject, error: fetchError } = await supabase
    .from("projects")
    .select("status, user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    console.error('❌ DELETE PROJECT FETCH ERROR:', fetchError);
    return res.status(500).json({ error: fetchError.message });
  }

  if (!existingProject) {
    return res.status(404).json({ error: "Project not found" });
  }

  // Check ownership
  if (existingProject.user_id !== userId) {
    return res.status(403).json({ error: "Access denied - not the project owner" });
  }

  // Prevent deleting archived projects
  if (existingProject.status === 'archived') {
    return res.status(403).json({
      error: "Archived projects cannot be deleted. You can unarchive this project for $5 first, then delete it.",
      can_unarchive: true,
      unarchive_fee: 5
    });
  }

  const { error } = await supabase
    .from("projects")
    .update({ deleted: true })
    .eq("id", id)
    .eq("user_id", userId); // Ensure user owns this project

  if (error) {
    console.error('❌ DELETE PROJECT UPDATE ERROR:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true });
});

// Permanently delete a project and all associated data
router.delete("/:id/permanent", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId; // Extracted from JWT token

  try {
    // Verify ownership before deleting anything
    const { data: project, error: ownerCheck } = await supabase
      .from("projects")
      .select("user_id")
      .eq("id", id)
      .single();

    if (ownerCheck || !project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.user_id !== userId) {
      return res.status(403).json({ error: "Access denied - not the project owner" });
    }

    // Delete in order of dependencies (children first, then parent)
    // 1. Delete conversations and messages
    await supabase.from("conversation_messages").delete().eq("project_id", id);
    await supabase.from("conversations").delete().eq("project_id", id);
    
    // 2. Delete storyboard scenes and storyboards
    const { data: storyboards } = await supabase
      .from("storyboards")
      .select("id")
      .eq("project_id", id);
    
    if (storyboards && storyboards.length > 0) {
      const storyboardIds = storyboards.map(sb => sb.id);
      await supabase.from("storyboard_scenes").delete().in("storyboard_id", storyboardIds);
    }
    await supabase.from("storyboards").delete().eq("project_id", id);
    
    // 3. Delete scripts and script scenes
    const { data: scripts } = await supabase
      .from("scripts")
      .select("id")
      .eq("project_id", id);
    
    if (scripts && scripts.length > 0) {
      const scriptIds = scripts.map(s => s.id);
      await supabase.from("script_scenes").delete().in("script_id", scriptIds);
    }
    await supabase.from("scripts").delete().eq("project_id", id);
    
    // 4. Delete project concepts
    await supabase.from("project_concepts").delete().eq("project_id", id);
    
    // 5. Delete characters and locations
    await supabase.from("characters").delete().eq("project_id", id);
    await supabase.from("locations").delete().eq("project_id", id);
    
    // 6. Finally delete the project itself (ensure user owns it)
    const { error } = await supabase.from("projects").delete().eq("id", id).eq("user_id", userId);
    
    if (error) {
      console.error("Error permanently deleting project:", error);
      return res.status(500).json({ error: error.message });
    }
    
    res.json({ success: true, message: "Project and all associated data permanently deleted" });
  } catch (error: any) {
    console.error("Error permanently deleting project:", error);
    res.status(500).json({ error: "Failed to permanently delete project" });
  }
});

// promote-project-concept endpoint removed - system now uses documents instead of project_concepts

// Get project owner's subscription (for collaborators to check version control access)
router.get("/:id/owner-subscription", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId; // Extracted from JWT token

  try{
    // First check if user has access to this project (owner or collaborator)
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("user_id")
      .eq("id", id)
      .single();
    
    if (projectError || !project) {
      if (DEBUG_AI) console.log('❌ Project not found:', projectError?.message);
      return res.status(404).json({ error: "Project not found" });
    }

    // Check if user is the owner
    if (project.user_id === userId) {
      // Query subscription directly from database (no need for internal HTTP call)
      const { data: ownerSubscription, error: subscriptionError } = await supabase
        .from("user_subscriptions")
        .select(`
          plan_id,
          status,
          stripe_subscription_id,
          created_at,
          updated_at
        `)
        .eq("user_id", userId)
        .maybeSingle();

      if (subscriptionError) {
        if (DEBUG_AI) console.log('❌ Error fetching owner subscription:', subscriptionError.message);
      }

      // Return default free subscription if none found
      if (!ownerSubscription) {
        return res.json({
          subscription: {
            plan_id: 'free',
            status: 'active'
          }
        });
      }

      return res.json({ subscription: ownerSubscription });
    }

    // Check if user is a collaborator
    const { data: collaborator, error: collaboratorError } = await supabase
      .from("project_collaborators")
      .select("id")
      .eq("project_id", id)
      .eq("user_id", userId)
      .eq("status", "active")
      .single();
    
    if (collaboratorError || !collaborator) {
      if (DEBUG_AI) console.log('❌ Access denied - not owner or collaborator:', collaboratorError?.message);
      return res.status(403).json({ error: "Access denied" });
    }

    // User is collaborator - fetch the project owner's subscription
    const { data: ownerSubscription, error: subscriptionError } = await supabase
      .from("user_subscriptions")
      .select(`
        plan_id,
        status,
        stripe_subscription_id,
        created_at,
        updated_at
      `)
      .eq("user_id", project.user_id)
      .maybeSingle();

    if (subscriptionError) {
      if (DEBUG_AI) console.log('❌ Error fetching owner subscription:', subscriptionError.message);
    }

    // Return default free subscription if none found
    if (!ownerSubscription) {
      return res.json({
        subscription: {
          plan_id: 'free',
          status: 'active'
        }
      });
    }

    // Return owner's subscription
    res.json({ subscription: ownerSubscription });
  } catch (error) {
    console.error('❌ GET PROJECT OWNER SUBSCRIPTION ERROR:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Purchase addon and unarchive project (triggers Stripe checkout + unarchive on success)
 * POST /api/projects/:id/purchase-and-unarchive
 */
router.post("/:id/purchase-and-unarchive", requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId!;
  const pricingService = req.pricingService!;

  try{
    // Get project and verify it's archived and user owns it
    const { data: project, error: fetchError } = await supabase
      .from("projects")
      .select("status, title")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (fetchError) return res.status(500).json({ error: fetchError.message });

    if (!project) {
      return res.status(404).json({ error: "Project not found or access denied" });
    }

    if (project.status !== 'archived') {
      return res.status(400).json({
        error: "Project is not archived",
        current_status: project.status
      });
    }

    const subscription = await pricingService.getUserSubscription(userId);

    // Block free plan users
    if (subscription.plan_id === 'free') {
      if (DEBUG_AI) console.log(`❌ UNARCHIVE BLOCKED: Free plan users cannot unarchive projects`);
      return res.status(403).json({
        error: 'feature_not_available',
        message: 'Unarchiving is only available for Pro subscribers.',
        redirect_to: '/profile/plans'
      });
    }

    // Store pending unarchive in localStorage (frontend will handle this)
    // We need to trigger addon purchase through Stripe checkout
    // When addon purchase succeeds (via webhook), we'll unarchive the project

    // Calculate new addon count
    const currentAddons = subscription.additional_projects || 0;
    const newAddonCount = currentAddons + 1;

    // Use unified billing service to create addon change request
    const { unifiedBillingService } = await import('../services/unifiedBillingService');

    const billingResult = await unifiedBillingService.executeBillingChange(userId, {
      type: 'addon_change',
      addons: {
        additional_projects: newAddonCount
      }
    });

    if (!billingResult.success) {
      return res.status(400).json({
        error: 'Failed to purchase addon',
        message: billingResult.message
      });
    }

    // Addon purchase succeeded - now unarchive the project immediately
    if (DEBUG_AI) console.log('✅ ADDON PURCHASE SUCCESS - Unarchiving project:', id);

    const { data: updatedProject, error: unarchiveError } = await supabase
      .from("projects")
      .update({ status: 'active' })
      .eq("id", id)
      .eq("user_id", userId)
      .select('id, status')
      .single();

    if (unarchiveError) {
      console.error('❌ UNARCHIVE ERROR after addon purchase:', unarchiveError);
      // Addon was purchased but unarchive failed - this is bad but we should still return success
      // The user can try unarchiving again manually
      return res.status(500).json({
        error: 'Addon purchased but project unarchive failed',
        message: 'Your addon was purchased successfully. Please try unarchiving the project again.',
        addon_purchased: true
      });
    }

    // Verify the update actually happened
    if (!updatedProject || updatedProject.status !== 'active') {
      console.error('❌ PROJECT STATUS NOT UPDATED:', { id, updatedProject });
      return res.status(500).json({
        error: 'Addon purchased but project status update verification failed',
        message: 'Your addon was purchased successfully. Please try unarchiving the project again.',
        addon_purchased: true
      });
    }

    if (DEBUG_AI) console.log('✅ PROJECT UNARCHIVED SUCCESSFULLY:', id, updatedProject);

    // Return success - no checkout redirect needed
    res.json({
      success: true,
      requires_checkout: false,
      project_id: id,
      project_title: project.title,
      message: 'Project reactivated successfully! Your addon has been added to your subscription.',
      new_addon_count: newAddonCount
    });

  } catch (error: any) {
    console.error('❌ PURCHASE AND UNARCHIVE ERROR:', error);
    res.status(500).json({
      error: 'Failed to purchase addon and unarchive project',
      details: error.message
    });
  }
});

/**
 * Check if unarchiving requires addon purchase
 * POST /api/projects/:id/unarchive-check
 */
router.post("/:id/unarchive-check", requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId!;
  const pricingService = req.pricingService!;

  if (DEBUG_AI) console.log('🔍 CHECK UNARCHIVE REQUIREMENTS:', { projectId: id, userId });

  try {
    // Get project and verify it's archived and user owns it
    const { data: project, error: fetchError } = await supabase
      .from("projects")
      .select("status, title")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (fetchError) return res.status(500).json({ error: fetchError.message });

    if (!project) {
      return res.status(404).json({ error: "Project not found or access denied" });
    }

    if (project.status !== 'archived') {
      return res.status(400).json({
        error: "Project is not archived",
        current_status: project.status
      });
    }

    const subscription = await pricingService.getUserSubscription(userId);

    // Block free plan users completely
    if (subscription.plan_id === 'free') {
      if (DEBUG_AI) console.log(`❌ UNARCHIVE BLOCKED: Free plan users cannot unarchive projects`);
      return res.status(403).json({
        error: 'feature_not_available',
        error_type: 'unarchive_blocked_free_plan',
        message: 'Unarchiving is only available for Pro subscribers. Please upgrade to access this feature.',
        redirect_to: '/profile/plans'
      });
    }

    // Count only NON-ARCHIVED projects (archived projects don't count towards limits)
    const { count: currentActiveCount, error: countError } = await supabase
      .from("projects")
      .select("id", { count: 'exact', head: true })
      .eq("user_id", userId)
      .eq("deleted", false)
      .neq("status", "archived");

    if (countError) {
      console.error('❌ ERROR COUNTING ACTIVE PROJECTS:', countError);
      return res.status(500).json({ error: "Failed to count active projects" });
    }

    const plan = pricingService.getPlan(subscription.plan_id);

    if (!plan) {
      return res.status(400).json({ error: "Invalid subscription plan" });
    }

    const effectiveLimits = pricingService.getEffectiveLimits(
      plan,
      subscription.additional_projects || 0,
      subscription.additional_collaborators || 0
    );

    const newActiveCount = currentActiveCount + 1; // After unarchiving

    // IMPORTANT: Unarchiving ALWAYS requires addon purchase to prevent gaming the system
    // Users cannot archive/unarchive repeatedly without paying
    const addonNeeded = true; // Always true for paid users

    res.json({
      success: true,
      addon_needed: addonNeeded,
      project_id: id,
      project_title: project.title,
      current_active_projects: currentActiveCount,
      project_limit: effectiveLimits.projects,
      after_unarchive_count: newActiveCount,
      addon_price: 3, // $3/month per additional project
      addon_currency: 'USD'
    });

  } catch (error: any) {
    console.error('❌ CHECK UNARCHIVE ERROR:', error);
    res.status(500).json({
      error: 'Failed to check unarchive requirements',
      details: error.message
    });
  }
});

/**
 * Unarchive a project (called after addon is purchased if needed)
 * POST /api/projects/:id/unarchive
 */
router.post("/:id/unarchive", requireAuth, extractUserId, addPricingService, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId!;
  const pricingService = req.pricingService!;

  if (DEBUG_AI) console.log('🔄 UNARCHIVE PROJECT:', { projectId: id, userId });

  try {
    // Get project and verify it's archived and user owns it
    const { data: project, error: fetchError } = await supabase
      .from("projects")
      .select("status, title")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (fetchError) return res.status(500).json({ error: fetchError.message });

    if (!project) {
      return res.status(404).json({ error: "Project not found or access denied" });
    }

    if (project.status !== 'archived') {
      return res.status(400).json({
        error: "Project is not archived",
        current_status: project.status
      });
    }

    const subscription = await pricingService.getUserSubscription(userId);

    // Block only if no subscription at all (no addons, no plan)
    const hasAnySubscription = !!subscription.stripe_subscription_id || (subscription.additional_projects || 0) > 0;
    if (!hasAnySubscription) {
      if (DEBUG_AI) console.log(`❌ UNARCHIVE BLOCKED: No subscription or addons`);
      return res.status(403).json({
        error: 'feature_not_available',
        message: 'Unarchiving requires an active subscription or project addon.',
        redirect_to: '/profile/plans'
      });
    }

    // Count active projects
    const { count: currentActiveCount, error: countError } = await supabase
      .from("projects")
      .select("id", { count: 'exact', head: true })
      .eq("user_id", userId)
      .eq("deleted", false)
      .neq("status", "archived");

    if (countError) {
      console.error('❌ ERROR COUNTING ACTIVE PROJECTS:', countError);
      return res.status(500).json({ error: "Failed to count active projects" });
    }

    const plan = pricingService.getPlan(subscription.plan_id);
    const effectiveLimits = pricingService.getEffectiveLimits(
      plan,
      subscription.additional_projects || 0,
      subscription.additional_collaborators || 0
    );

    const newActiveCount = currentActiveCount + 1;

    // Check if would exceed limits
    if (effectiveLimits.projects !== -1 && newActiveCount > effectiveLimits.projects) {
      if (DEBUG_AI) console.log(`❌ UNARCHIVE BLOCKED: Would exceed limit (${newActiveCount} > ${effectiveLimits.projects})`);
      return res.status(403).json({
        error: 'limit_exceeded',
        message: 'Cannot unarchive: would exceed project limit. Please purchase additional project addon first.',
        requires_addon: true
      });
    }

    // Unarchive the project
    const { data: updatedProject, error: updateError } = await supabase
      .from("projects")
      .update({
        status: 'active',
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("user_id", userId)
      .select('id, status')
      .single();

    if (updateError) {
      console.error('❌ UNARCHIVE UPDATE ERROR:', updateError);
      return res.status(500).json({ error: "Failed to unarchive project" });
    }

    // Verify the update actually happened
    if (!updatedProject || updatedProject.status !== 'active') {
      console.error('❌ UNARCHIVE VERIFICATION FAILED:', { id, updatedProject });
      return res.status(500).json({ error: "Project status update verification failed" });
    }

    if (DEBUG_AI) console.log('✅ PROJECT UNARCHIVED:', id, updatedProject);

    res.json({
      success: true,
      message: `Project "${project.title}" has been reactivated`,
      project_id: id,
      project_title: project.title,
      active_projects_count: newActiveCount
    });

  } catch (error: any) {
    console.error('❌ UNARCHIVE ERROR:', error);
    res.status(500).json({
      error: 'Failed to unarchive project',
      details: error.message
    });
  }
});

// Get screenplay cover page information
router.get("/:id/cover-page", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId;

  try {
    const { data, error } = await supabase
      .from("projects")
      .select("title, author, based_on, contact_info, copyright_notice, registration_number")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error) {
      console.error('❌ GET COVER PAGE ERROR:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (error: any) {
    console.error('❌ GET COVER PAGE ERROR:', error);
    res.status(500).json({ error: "Failed to get cover page information" });
  }
});

// Update screenplay cover page information
router.put("/:id/cover-page", requireAuth, extractUserId, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const userId = req.userId;
  const { title, author, based_on, contact_info, copyright_notice, registration_number } = req.body;

  if (DEBUG_AI) console.log('📄 COVER PAGE UPDATE REQUEST:', {
    projectId: id,
    userId,
    data: { title, author, based_on, contact_info, copyright_notice, registration_number }
  });

  try {
    // Check if project exists and user owns it
    const { data: existingProject, error: fetchError } = await supabase
      .from("projects")
      .select("status")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (fetchError) {
      console.error('❌ PROJECT NOT FOUND:', fetchError);
      return res.status(404).json({ error: "Project not found" });
    }

    // Prevent editing archived projects
    if (existingProject.status === 'archived') {
      return res.status(403).json({
        error: "Archived projects are read-only. Unarchive to edit.",
        can_unarchive: true
      });
    }

    // Update cover page fields
    const updateData: any = {};
    if (title !== undefined) updateData.title = title;
    if (author !== undefined) updateData.author = author;
    if (based_on !== undefined) updateData.based_on = based_on;
    if (contact_info !== undefined) updateData.contact_info = contact_info;
    if (copyright_notice !== undefined) updateData.copyright_notice = copyright_notice;
    if (registration_number !== undefined) updateData.registration_number = registration_number;

    const { data, error } = await supabase
      .from("projects")
      .update(updateData)
      .eq("id", id)
      .eq("user_id", userId)
      .select("title, author, based_on, contact_info, copyright_notice, registration_number")
      .single();

    if (error) {
      console.error('❌ COVER PAGE UPDATE ERROR:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (error: any) {
    console.error('❌ COVER PAGE UPDATE ERROR:', error);
    res.status(500).json({ error: "Failed to update cover page information" });
  }
});


export default router;