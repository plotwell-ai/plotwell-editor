import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import { extractUserId, PricingRequest } from "../middleware/pricingMiddleware";
import { Request, Response, NextFunction } from "express";
import { ScriptTimingService } from "../services/scriptTimingService";
import { ScriptExportService } from "../services/scriptExportService";
import { invalidateSceneCache, parseScriptContent } from "../services/scriptParsingService";
import { syncStoryboardSceneIds } from "../services/sceneIdentityService";
import { createScriptVersionSnapshot } from "../services/scriptVersionService";
import {
  applyScriptContentToActiveRoom,
  flushActiveScriptRoomToDatabase,
  getActiveScriptRoomContent,
  hasActiveCollaborationRoom,
  invalidateCollaborationDocumentState,
  isEmptyProseMirrorDoc,
  replaceActiveScriptRoomContent,
} from "../services/collaborationServer";
import { requireAuth, checkProjectAccess } from "../middleware/auth";
import { isEpisodic } from "../utils/projectType";
import { detectWholeDocumentDuplication } from "../utils/scriptContentGuard";
const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();

// Helper: verify user has access to a project (owner or active collaborator)
// Returns { hasAccess, isOwner, role, canEdit }
async function checkProjectAccessForUser(projectId: string, userId: string, supabaseClient: any): Promise<{
  hasAccess: boolean;
  isOwner: boolean;
  role: string | null;
  canEdit: boolean;
}> {
  const { data: project, error: projectError } = await supabaseClient
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

  const { data: collaborator, error: collabError } = await supabaseClient
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

// Helper: get userId from request (set by requireAuth)
function getUserId(req: any): string | null {
  return req.user?.sub || req.user?.id || null;
}

// Middleware: verify script access by looking up its project, then checking project access
// Sets req.scriptProjectId for downstream use. If requireWrite=true, blocks viewers.
function checkScriptAccess(requireWrite: boolean = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const scriptId = req.params.id;
      if (!scriptId) {
        return res.status(400).json({ error: 'Script ID is required' });
      }

      const { data: script, error: scriptError } = await supabase
        .from('scripts')
        .select('project_id')
        .eq('id', scriptId)
        .single();

      if (scriptError || !script) {
        return res.status(404).json({ error: 'Script not found' });
      }

      const access = await checkProjectAccessForUser(script.project_id, userId, supabase);
      if (!access.hasAccess) {
        return res.status(403).json({ error: 'Access denied - not authorized for this project' });
      }

      if (requireWrite && !access.canEdit) {
        return res.status(403).json({
          error: 'Read-only access - viewers cannot make changes',
          role: 'viewer'
        });
      }

      req.scriptProjectId = script.project_id;
      req.collaboratorRole = access.role;
      next();
    } catch (error) {
      console.error('Error in checkScriptAccess:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Middleware to check version history access for script endpoints.
// Version history is a safety/recovery feature, so it is available on all plans.
const requireScriptVersionControl = async (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    
    // Get script's project_id
    const { data: script, error: scriptError } = await supabase
      .from("scripts")
      .select("project_id")
      .eq("id", id)
      .single();

    if (scriptError || !script) {
      console.error('Script not found:', scriptError);
      return res.status(404).json({ error: "Script not found" });
    }

    const projectId = script.project_id;
    
    // Check if user owns this project
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

    if (projectError) {
      console.error('Error fetching project:', projectError);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (project.user_id === userId) {
      req.project_id = projectId;
      return next();
    } else {
      // Check if user is a collaborator
      const { data: collaborator, error: collabError } = await supabase
        .from('project_collaborators')
        .select('project_id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (collabError || !collaborator) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Store project_id for endpoint handlers to use
    req.project_id = projectId;
    
    next();
    
  } catch (error) {
    console.error('Error in requireScriptVersionControl middleware:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Intelligent Retention Configuration
const RETENTION_CONFIG = {
  // Tier 1: Active work - keep everything (0-14 days)
  activeDays: 14,
  
  // Tier 2: Recent history (15-60 days) 
  recentDays: 60,
  sessionWindowHours: 4, // Group saves within 4-hour windows
  significantChangeThreshold: 0.05, // 5% content change
  
  // Tier 3: Medium archive (61 days - 1 year)
  mediumDays: 365,
  weeklySnapshotInterval: 7,
  
  // Tier 4: Long-term archive (1+ years)
  // Keep monthly snapshots and special versions only
  
  // Safety limits
  maxVersionsPerScript: 500, // Hard limit for runaway cases
  minVersionsToKeep: 10 // Never go below this number
};

const AUTO_VERSION_INTERVAL_MINUTES = 1;

// Helper function to calculate change significance
function calculateChangeSignificance(oldContent: any, newContent: any): number {
  try {
    // Convert content to text for analysis
    const oldText = JSON.stringify(oldContent);
    const newText = JSON.stringify(newContent);
    
    // Calculate word count change
    const oldWordCount = oldText.split(/\s+/).length;
    const newWordCount = newText.split(/\s+/).length;
    const wordCountDelta = Math.abs(newWordCount - oldWordCount);
    const wordCountChange = oldWordCount > 0 ? wordCountDelta / oldWordCount : 1;
    
    // Check for structural changes (scene headings, character names)
    const structuralPatterns = [
      /FADE IN:/gi,
      /FADE OUT:/gi,
      /(INT\.|EXT\.)/gi,
      /^[A-Z][A-Z\s]{2,}$/gm // Character names
    ];
    
    let structuralScore = 0;
    structuralPatterns.forEach(pattern => {
      const oldMatches = (oldText.match(pattern) || []).length;
      const newMatches = (newText.match(pattern) || []).length;
      if (oldMatches !== newMatches) structuralScore += 25;
    });
    
    // Combine scores (0-100 scale)
    return Math.min(100, (wordCountChange * 30) + structuralScore);
  } catch (error) {
    console.warn('Error calculating change significance:', error);
    return 50; // Default to medium significance
  }
}

// Helper function for intelligent version cleanup
async function cleanupOldVersions(scriptId: string) {
  try {
    const now = new Date();
    
    // Get all versions for analysis
    const { data: allVersions, error: versionsError } = await supabase
      .from('script_versions')
      .select('*')
      .eq('script_id', scriptId)
      .order('created_at', { ascending: false });

    if (versionsError) throw versionsError;
    if (!allVersions || allVersions.length === 0) return;

    // Safety check - never go below minimum
    if (allVersions.length <= RETENTION_CONFIG.minVersionsToKeep) return;

    // Safety check - hard limit for runaway cases
    if (allVersions.length > RETENTION_CONFIG.maxVersionsPerScript) {
      const excess = allVersions.length - RETENTION_CONFIG.maxVersionsPerScript;
      const oldestVersions = allVersions.slice(-excess);
      await deleteVersions(oldestVersions.map(v => v.id));
      return;
    }

    const versionsToDelete = [];
    
    for (const version of allVersions) {
      const versionAge = now.getTime() - new Date(version.created_at).getTime();
      const ageInDays = versionAge / (1000 * 60 * 60 * 24);
      
      // Tier 1: Active work (0-14 days) - KEEP ALL
      if (ageInDays <= RETENTION_CONFIG.activeDays) {
        continue; // Always keep recent versions
      }
      
      // Never delete manual checkpoints or tagged versions
      if (version.change_summary && 
          (version.change_summary.includes('Checkpoint:') || 
           version.change_summary.includes('Tagged:') ||
           version.change_summary.includes('Manual:'))) {
        continue;
      }
      
      // Tier 2: Recent history (15-60 days)
      if (ageInDays <= RETENTION_CONFIG.recentDays) {
        // Check if this is a daily snapshot (keep first version each day)
        const versionDate = new Date(version.created_at).toDateString();
        const isFirstVersionOfDay = !allVersions.some(v => 
          new Date(v.created_at).toDateString() === versionDate && 
          new Date(v.created_at) < new Date(version.created_at)
        );
        
        if (isFirstVersionOfDay) continue; // Keep daily snapshots
        
        // Keep versions with significant changes
        const prevVersion = allVersions.find(v => 
          new Date(v.created_at) < new Date(version.created_at)
        );
        if (prevVersion) {
          const significance = calculateChangeSignificance(prevVersion.content, version.content);
          if (significance >= RETENTION_CONFIG.significantChangeThreshold * 100) {
            continue; // Keep significant changes
          }
        }
        
        // Session consolidation - keep if outside 4-hour window from last kept version
        const lastKeptVersion = allVersions.find(v => 
          !versionsToDelete.includes(v.id) && 
          new Date(v.created_at) < new Date(version.created_at)
        );
        if (lastKeptVersion) {
          const timeDiff = new Date(version.created_at).getTime() - new Date(lastKeptVersion.created_at).getTime();
          const hoursDiff = timeDiff / (1000 * 60 * 60);
          if (hoursDiff >= RETENTION_CONFIG.sessionWindowHours) {
            continue; // Keep session boundaries
          }
        }
        
        // Mark for deletion if doesn't meet criteria
        versionsToDelete.push(version.id);
      }
      
      // Tier 3: Medium archive (61 days - 1 year)
      else if (ageInDays <= RETENTION_CONFIG.mediumDays) {
        // Keep weekly snapshots
        const daysSinceWeekStart = ageInDays % RETENTION_CONFIG.weeklySnapshotInterval;
        if (daysSinceWeekStart < 1) continue; // Keep weekly snapshots
        
        // Keep versions with high structural significance
        const prevVersion = allVersions.find(v => 
          new Date(v.created_at) < new Date(version.created_at)
        );
        if (prevVersion) {
          const significance = calculateChangeSignificance(prevVersion.content, version.content);
          if (significance >= 75) continue; // Keep highly significant changes
        }
        
        versionsToDelete.push(version.id);
      }
      
      // Tier 4: Long-term archive (1+ years)
      else {
        // Keep monthly snapshots
        const daysSinceMonthStart = ageInDays % 30;
        if (daysSinceMonthStart < 1) continue; // Keep monthly snapshots
        
        versionsToDelete.push(version.id);
      }
    }
    
    // Apply deletions
    if (versionsToDelete.length > 0) {
      // Ensure we don't delete too many versions
      const versionsToKeep = allVersions.length - versionsToDelete.length;
      if (versionsToKeep >= RETENTION_CONFIG.minVersionsToKeep) {
        await deleteVersions(versionsToDelete);
      } else {
      }
    }
    
  } catch (error) {
    console.error('Error in intelligent version cleanup:', error);
    // Don't throw - cleanup failures shouldn't break version creation
  }
}

// Helper function to delete versions by IDs
async function deleteVersions(versionIds: string[]) {
  if (versionIds.length === 0) return;
  
  const { error } = await supabase
    .from('script_versions')
    .delete()
    .in('id', versionIds);
    
  if (error) throw error;
}

// Helper function to create a script version
async function createScriptVersion(
  scriptId: string,
  userId: string,
  changeSummary: string = 'Auto-save',
  options: { skipIfUnchanged?: boolean } = {}
) {
  try {
    const nextVersion = await createScriptVersionSnapshot(supabase, {
      scriptId,
      userId,
      changeSummary,
      skipIfUnchanged: options.skipIfUnchanged,
    });
    
    // Cleanup old versions after successful creation
    await cleanupOldVersions(scriptId);
    
    return nextVersion;
  } catch (error) {
    console.error('Error creating script version:', error);
    throw error;
  }
}

// Get all scripts for a project + prod_script_id (optionally filtered by episode_id)
// Query params:
//   - project_id (required): Project to fetch scripts for
//   - episode_id (optional): Filter by episode
//   - include_content (optional): Set to "false" to exclude content field (for existence checks)
router.get("/", requireAuth, checkProjectAccess, async (req, res) => {
  const { project_id, episode_id, include_content } = req.query;
  if (!project_id) return res.status(400).json({ error: "Missing project_id" });

  // Get project type to determine how to fetch production script
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("prod_script_id, project_type")
    .eq("id", project_id)
    .single();

  if (projectError) {
    console.error('❌ Failed to fetch project:', projectError);
    return res.status(500).json({ error: projectError.message });
  }

  const isSeries = isEpisodic(project.project_type);

  // Build query - exclude content if include_content=false (saves ~68% of query time)
  const shouldIncludeContent = include_content !== 'false';
  const selectFields = shouldIncludeContent
    ? "id, title, content, created_at, updated_at, is_ai_generated, episode_id"
    : "id, title, created_at, updated_at, is_ai_generated, episode_id";

  let query = supabase
    .from("scripts")
    .select(selectFields)
    .eq("project_id", project_id);

  // Filter by episode_id if provided
  if (episode_id) {
    query = query.eq("episode_id", episode_id);
  }

  const { data: scripts, error: scriptsError } = await query.order("created_at", { ascending: true });

  if (scriptsError) {
    console.error('❌ Failed to fetch scripts:', scriptsError);
    return res.status(500).json({ error: scriptsError.message });
  }

  // Determine prod_script_id based on project type and context
  let prod_script_id = null;

  if (episode_id) {
    // If filtering by episode, get the episode's script_id as the production script
    const { data: episode, error: episodeError } = await supabase
      .from("episodes")
      .select("script_id")
      .eq("id", episode_id)
      .single();

    if (!episodeError && episode) {
      prod_script_id = episode.script_id;
    }
  } else if (isSeries) {
    // For TV series without episode filter, don't return a single prod_script_id
    // The frontend should query by episode_id to get the right production script
    prod_script_id = null;
  } else {
    // For movies/films, use the project's prod_script_id
    prod_script_id = project.prod_script_id;
  }

  res.json({
    scripts,
    prod_script_id: prod_script_id || null,
    project_type: project.project_type,
  });
});

// Get a single script by ID
router.get("/:id", requireAuth, checkScriptAccess(false), async (req, res) => {
  const { id } = req.params;

  try {
    const { data: script, error } = await supabase
      .from("scripts")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !script) {
      return res.status(404).json({ error: "Script not found" });
    }

    if (hasActiveCollaborationRoom(script.project_id, 'script', id)) {
      const activeContent = getActiveScriptRoomContent(script.project_id, id);
      if (activeContent && !isEmptyProseMirrorDoc(activeContent)) {
        script.content = activeContent;
      }
    }

    res.json({ script });
  } catch (error: any) {
    console.error('Error fetching script:', error);
    res.status(500).json({ error: 'Failed to fetch script' });
  }
});

// Create a new script
router.post("/", requireAuth, checkProjectAccess, async (req, res) => {
  const { project_id, content, is_ai_generated, episode_id, title } = req.body;
  if (!project_id || !content) return res.status(400).json({ error: "Missing fields" });

  // Viewers cannot create scripts
  if (req.collaboratorRole === 'viewer') {
    return res.status(403).json({ error: 'Read-only access - viewers cannot create scripts', role: 'viewer' });
  }

  // Check if project is archived first
  const { data: existingProject, error: fetchError } = await supabase
    .from("projects")
    .select("status, project_type")
    .eq("id", project_id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });

  // Prevent creating scripts in archived projects
  if (existingProject.status === 'archived') {
    return res.status(403).json({
      error: "Archived projects are read-only. Contact support to unarchive this project."
    });
  }

  const isSeries = isEpisodic(existingProject.project_type);

  // For TV series, check if this is the first script for THIS EPISODE
  // For movies, check if this is the first script for the PROJECT
  let isFirstScript = false;

  if (isSeries && episode_id) {
    // Check if episode already has scripts
    const { data: episodeScripts } = await supabase
      .from("scripts")
      .select("id")
      .eq("project_id", project_id)
      .eq("episode_id", episode_id)
      .limit(1);

    isFirstScript = !episodeScripts || episodeScripts.length === 0;
  } else if (!isSeries) {
    // Check if this is the first script for this project
    const { data: existingScripts } = await supabase
      .from("scripts")
      .select("id")
      .eq("project_id", project_id)
      .limit(1);

    isFirstScript = !existingScripts || existingScripts.length === 0;
  }

  const { data, error } = await supabase
    .from("scripts")
    .insert([{
      title: title || "Script",
      project_id,
      content,
      is_ai_generated: !!is_ai_generated,
      ...(episode_id && { episode_id }) // Include episode_id if provided
    }])
    .select()
    .single();

  if (error) {
    console.error('❌ Failed to create script:', error);
    return res.status(500).json({ error: error.message });
  }

  // Auto-promote the first script to production
  if (isFirstScript) {
    if (isSeries && episode_id) {
      // For TV series: update episode's script_id
      const { error: episodeUpdateError } = await supabase
        .from("episodes")
        .update({ script_id: data.id })
        .eq("id", episode_id);

      if (episodeUpdateError) {
        console.error("❌ Failed to auto-promote first episode script:", episodeUpdateError);
      }
    } else if (!isSeries) {
      // For movies: update project's prod_script_id
      const { error: promoteError } = await supabase
        .from("projects")
        .update({ prod_script_id: data.id })
        .eq("id", project_id);

      if (promoteError) {
        console.error("❌ Failed to auto-promote first script to production:", promoteError);
      }
    }
  }

  res.json(data);
});

// Update a script (content and/or title)
router.put("/:id", requireAuth, checkScriptAccess(true), extractUserId, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const {
    content,
    title,
    page_count,
    change_summary,
    create_version = false,
    preserve_collaboration_state = false,
  } = req.body;
  if (content === undefined && title === undefined && page_count === undefined) {
    return res.status(400).json({ error: "Nothing to update" });
  }

  // Check if the script's project is archived
  const { data: script, error: scriptError } = await supabase
    .from("scripts")
    .select("project_id, episode_id, content")
    .eq("id", id)
    .single();

  if (scriptError) return res.status(500).json({ error: scriptError.message });

  const { data: existingProject, error: fetchError } = await supabase
    .from("projects")
    .select("status")
    .eq("id", script.project_id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });

  // Prevent updating scripts in archived projects
  if (existingProject.status === 'archived') {
    return res.status(403).json({
      error: "Archived projects are read-only. Contact support to unarchive this project."
    });
  }

  let effectiveContent = content;
  let blockedDuplicatedContent = false;

  if (content !== undefined) {
    const duplication = detectWholeDocumentDuplication(script.content, content);
    if (duplication.duplicated) {
      blockedDuplicatedContent = true;
      effectiveContent = script.content;
      console.warn('Blocked duplicated script content update:', {
        scriptId: id,
        projectId: script.project_id,
        repeatCount: duplication.repeatCount,
      });
    }
  }

  const hasActiveRoomForContent = content !== undefined
    && !blockedDuplicatedContent
    && hasActiveCollaborationRoom(script.project_id, 'script', id);

  // Smart version creation logic:
  // 1. Always create version if explicitly requested (create_version=true)
  // 2. Always create version for manual edits with custom change_summary
  // 3. For auto-saves, create periodic versions and skip duplicates
  const isContentUpdate = content !== undefined && !blockedDuplicatedContent;
  const effectiveChangeSummary = change_summary || (isContentUpdate ? 'Auto-save' : undefined);
  let shouldCreateVersion = create_version || (effectiveChangeSummary && effectiveChangeSummary !== 'Auto-save');

  if (!shouldCreateVersion && effectiveChangeSummary === 'Auto-save') {
    // Check if we should create a periodic auto-version.
    const { data: lastVersion } = await supabase
      .from('script_versions')
      .select('created_at')
      .eq('script_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastVersion) {
      // No versions exist, create first one
      shouldCreateVersion = true;
    } else {
      const lastVersionTime = new Date(lastVersion.created_at).getTime();
      const now = new Date().getTime();
      const minutesSinceLastVersion = (now - lastVersionTime) / (1000 * 60);

      if (minutesSinceLastVersion >= AUTO_VERSION_INTERVAL_MINUTES) {
        shouldCreateVersion = true;
      }
    }
  }

  if (shouldCreateVersion && !hasActiveRoomForContent) {
    try {
      const userId = req.userId;
      await createScriptVersion(id, userId, effectiveChangeSummary || 'Manual edit', {
        skipIfUnchanged: effectiveChangeSummary === 'Auto-save',
      });
    } catch (error) {
      console.error('Failed to create version backup:', error);
      // Continue with update even if version creation fails
    }
  }

  // Build update object
  const updateData: any = {};
  if (content !== undefined && !blockedDuplicatedContent) {
    if (script.content && !isEmptyProseMirrorDoc(script.content) && isEmptyProseMirrorDoc(effectiveContent)) {
      return res.status(400).json({
        error: "Refusing to overwrite non-empty script with empty content",
      });
    }

    if (!hasActiveRoomForContent) {
      updateData.content = effectiveContent;
    }
  }
  if (title !== undefined) updateData.title = title;
  if (page_count !== undefined && Number.isInteger(page_count) && page_count > 0) {
    updateData.page_count = page_count;
  }

  let data: any = null;
  if (Object.keys(updateData).length > 0) {
    const { data: updatedData, error } = await supabase
      .from("scripts")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    data = updatedData;
  } else {
    const { data: currentData, error } = await supabase
      .from("scripts")
      .select("*")
      .eq("id", id)
      .single();

    if (error) return res.status(500).json({ error: error.message });
    data = currentData;
  }

  if (content !== undefined) {
    if (blockedDuplicatedContent) {
      if (hasActiveCollaborationRoom(script.project_id, 'script', id) && script.content) {
        replaceActiveScriptRoomContent(script.project_id, id, script.content);
      }
      data = {
        ...data,
        content: script.content,
        duplicate_content_blocked: true,
      };
    } else if (hasActiveRoomForContent) {
      if (shouldCreateVersion) {
        await flushActiveScriptRoomToDatabase(script.project_id, id, {
          userId: req.userId,
          changeSummary: effectiveChangeSummary || 'Before external script update',
          createVersion: true,
        });
      }

      const result = await applyScriptContentToActiveRoom(script.project_id, id, effectiveContent, {
        userId: req.userId,
        changeSummary: effectiveChangeSummary || 'External script update',
        createVersion: false,
        flush: true,
      });
      data = {
        ...data,
        content: result.content || effectiveContent,
      };
    } else if (preserve_collaboration_state) {
      replaceActiveScriptRoomContent(script.project_id, id, effectiveContent);
    } else {
      await invalidateCollaborationDocumentState(script.project_id, 'script', id);
    }
  }

  // Invalidate scene cache so production planner gets fresh scene data
  try {
    await invalidateSceneCache(id);
  } catch (cacheError) {
    console.error('Failed to invalidate scene cache:', cacheError);
    // Don't fail the request, cache will be refreshed on next parse
  }

  // Sync storyboard panel scene_ids if content changed (handles scene renames)
  if (effectiveContent && !blockedDuplicatedContent) {
    try {
      const scenes = parseScriptContent(effectiveContent);
      if (scenes.length > 0) {
        const syncResult = await syncStoryboardSceneIds(
          script.project_id,
          scenes,
          supabase,
          script.episode_id
        );
        if (syncResult.updated > 0) {
          if (DEBUG_AI) console.log(`🔄 STORYBOARD SYNC: Re-linked ${syncResult.updated} scene(s), ${syncResult.orphaned} orphaned`);
        }
      }
    } catch (syncError) {
      console.error('Failed to sync storyboard scene IDs:', syncError);
    }
  }

  res.json(data);
});

// Delete a script
router.delete("/:id", requireAuth, checkScriptAccess(true), async (req, res) => {
  const { id } = req.params;

  // Check if the script's project is archived and get script details
  const { data: script, error: scriptError } = await supabase
    .from("scripts")
    .select("project_id, episode_id")
    .eq("id", id)
    .single();

  if (scriptError) {
    console.error('❌ Script not found:', scriptError);
    return res.status(500).json({ error: scriptError.message });
  }

  const { data: existingProject, error: fetchError } = await supabase
    .from("projects")
    .select("status, prod_script_id, project_type")
    .eq("id", script.project_id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });

  // Prevent deleting scripts in archived projects
  if (existingProject.status === 'archived') {
    return res.status(403).json({
      error: "Archived projects are read-only. Contact support to unarchive this project."
    });
  }

  const isSeries = isEpisodic(existingProject.project_type);

  // Check if this is a production script and warn/prevent deletion
  const isProductionScript = existingProject.prod_script_id === id;
  const isEpisodeProductionScript = script.episode_id ? await checkIfEpisodeProductionScript(id, script.episode_id) : false;

  if (isProductionScript || isEpisodeProductionScript) {
    console.warn('⚠️ Attempting to delete a production script:', id);
    // Allow deletion but clear the production reference first
    if (isProductionScript && !isSeries) {
      await supabase
        .from("projects")
        .update({ prod_script_id: null })
        .eq("id", script.project_id);
    }
    if (isEpisodeProductionScript && script.episode_id) {
      await supabase
        .from("episodes")
        .update({ script_id: null })
        .eq("id", script.episode_id);
    }
  }

  const { error } = await supabase
    .from("scripts")
    .delete()
    .eq("id", id);

  if (error) {
    console.error('❌ Failed to delete script:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true });
});

// Helper function to check if script is an episode's production script
async function checkIfEpisodeProductionScript(scriptId: string, episodeId: string): Promise<boolean> {
  const { data: episode } = await supabase
    .from("episodes")
    .select("script_id")
    .eq("id", episodeId)
    .single();

  return episode?.script_id === scriptId;
}

// Promote a script to production
router.post("/:id/promote", requireAuth, checkScriptAccess(true), async (req, res) => {
  const { id } = req.params;
  const { project_id, episode_id } = req.body;
  if (!project_id) return res.status(400).json({ error: "Missing project_id" });

  // Check if project is archived first
  const { data: existingProject, error: fetchError } = await supabase
    .from("projects")
    .select("status, project_type")
    .eq("id", project_id)
    .single();

  if (fetchError) return res.status(500).json({ error: fetchError.message });

  // Prevent promoting scripts in archived projects
  if (existingProject.status === 'archived') {
    return res.status(403).json({
      error: "Archived projects are read-only. Contact support to unarchive this project."
    });
  }

  // Get the script to verify it belongs to this project and check episode_id
  const { data: script, error: scriptError } = await supabase
    .from("scripts")
    .select("project_id, episode_id")
    .eq("id", id)
    .single();

  if (scriptError || !script) {
    console.error('❌ Script not found:', scriptError);
    return res.status(404).json({ error: "Script not found" });
  }

  // Verify script belongs to the project
  if (script.project_id !== project_id) {
    console.error('❌ Script does not belong to project');
    return res.status(403).json({ error: "Script does not belong to this project" });
  }

  // Handle TV series (project_type === 'series') differently than movies
  const isSeries = isEpisodic(existingProject.project_type);
  const scriptEpisodeId = episode_id || script.episode_id;

  if (isSeries && scriptEpisodeId) {
    // For TV series: update the episode's script_id to make this the production script for that episode
    const { error: episodeError } = await supabase
      .from("episodes")
      .update({ script_id: id })
      .eq("id", scriptEpisodeId)
      .eq("project_id", project_id); // Security: ensure episode belongs to project

    if (episodeError) {
      console.error('❌ Failed to promote episode script:', episodeError);
      return res.status(500).json({ error: episodeError.message });
    }

    res.json({ success: true, context: 'episode', episode_id: scriptEpisodeId });
  } else {
    // For movies/films: update the project's prod_script_id
    const { error } = await supabase
      .from("projects")
      .update({ prod_script_id: id })
      .eq("id", project_id);

    if (error) {
      console.error('❌ Failed to promote project script:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, context: 'project' });
  }
});

// SCRIPT TIMING ENDPOINTS

// Get timing analysis for a script
router.get("/:id/timing", requireAuth, checkScriptAccess(false), async (req, res) => {
  const { id } = req.params;
  const { project_type } = req.query;

  try {
    const { data: script, error } = await supabase
      .from("scripts")
      .select("content, title")
      .eq("id", id)
      .single();

    if (error || !script) {
      return res.status(404).json({ error: "Script not found" });
    }

    const timing = ScriptTimingService.calculateScriptTiming(script.content);
    
    // Apply project type multiplier if provided
    if (project_type && typeof project_type === 'string') {
      const multiplier = ScriptTimingService.getFormatTimingMultiplier(project_type);
      timing.totalMinutes = Math.round(timing.totalMinutes * multiplier);
      timing.sceneBreakdown.forEach((scene) => {
        scene.minutes = Math.round(scene.minutes * multiplier);
      });
    }

    const readingTime = ScriptTimingService.calculateReadingTime(script.content);
    const pageBreakdown = ScriptTimingService.getPageBreakdown(script.content);

    res.json({
      timing,
      readingTime,
      pageBreakdown,
      scriptTitle: script.title
    });
  } catch (error: any) {
    console.error('Error calculating script timing:', error);
    res.status(500).json({ error: 'Failed to calculate timing' });
  }
});

// Get timing for a specific section of script
router.post("/:id/timing/section", requireAuth, checkScriptAccess(false), async (req, res) => {
  const { id } = req.params;
  const { startIndex, endIndex, project_type } = req.body;

  try {
    const { data: script, error } = await supabase
      .from("scripts")
      .select("content")
      .eq("id", id)
      .single();

    if (error || !script) {
      return res.status(404).json({ error: "Script not found" });
    }

    const timing = ScriptTimingService.calculateSectionTiming(
      script.content, 
      startIndex, 
      endIndex
    );
    
    // Apply project type multiplier if provided
    if (project_type) {
      const multiplier = ScriptTimingService.getFormatTimingMultiplier(project_type);
      timing.totalMinutes = Math.round(timing.totalMinutes * multiplier);
    }

    res.json({ timing });
  } catch (error: any) {
    console.error('Error calculating section timing:', error);
    res.status(500).json({ error: 'Failed to calculate section timing' });
  }
});

// SCRIPT EXPORT ENDPOINTS

// Export script to Final Draft (.fdx) format
router.get("/:id/export/fdx", requireAuth, checkScriptAccess(false), async (req, res) => {
  const { id } = req.params;
  const { 
    scene_numbers = false, 
    page_numbering = true, 
    revision_colors = false 
  } = req.query;

  try {
    const { data: script, error } = await supabase
      .from("scripts")
      .select("title")
      .eq("id", id)
      .single();

    if (error || !script) {
      return res.status(404).json({ error: "Script not found" });
    }

    const exportOptions = {
      includeSceneNumbers: scene_numbers === 'true',
      pageNumbering: page_numbering === 'true',
      revisionColors: revision_colors === 'true',
      includeTitlePage: true
    };

    const fdxContent = await ScriptExportService.exportToFinalDraft(id, exportOptions);
    const filename = ScriptExportService.getExportFilename(script.title, 'fdx');
    const mimeType = ScriptExportService.getExportMimeType('fdx');

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fdxContent);
  } catch (error: any) {
    console.error('Error exporting to Final Draft:', error);
    res.status(500).json({ error: 'Failed to export to Final Draft format' });
  }
});

// Export script to Fountain format
router.get("/:id/export/fountain", requireAuth, checkScriptAccess(false), async (req, res) => {
  const { id } = req.params;
  const { 
    scene_numbers = false, 
    more_dialogue_breaks = false 
  } = req.query;

  try {
    const { data: script, error } = await supabase
      .from("scripts")
      .select("title")
      .eq("id", id)
      .single();

    if (error || !script) {
      return res.status(404).json({ error: "Script not found" });
    }

    const exportOptions = {
      includeSceneNumbers: scene_numbers === 'true',
      moreDialogueBreaks: more_dialogue_breaks === 'true',
      includeTitlePage: true
    };

    const fountainContent = await ScriptExportService.exportToFountain(id, exportOptions);
    const filename = ScriptExportService.getExportFilename(script.title, 'fountain');
    const mimeType = ScriptExportService.getExportMimeType('fountain');

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fountainContent);
  } catch (error: any) {
    console.error('Error exporting to Fountain:', error);
    res.status(500).json({ error: 'Failed to export to Fountain format' });
  }
});

// Export script to Word Document (.docx) format
router.get("/:id/export/docx", requireAuth, checkScriptAccess(false), async (req, res) => {
  const { id } = req.params;

  try {
    // Get script to check if it exists
    const { data: script, error } = await supabase
      .from("scripts")
      .select("title")
      .eq("id", id)
      .single();

    if (error || !script) {
      return res.status(404).json({ error: "Script not found" });
    }

    const exportOptions = {
      includeTitlePage: true
    };

    const docxBuffer = await ScriptExportService.exportToDocx(id, exportOptions);
    const filename = ScriptExportService.getExportFilename(script.title, 'docx');
    const mimeType = ScriptExportService.getExportMimeType('docx');

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(docxBuffer);
  } catch (error: any) {
    console.error('Error exporting to Word Document:', error);
    res.status(500).json({ error: 'Failed to export to Word Document format' });
  }
});

// VERSION CONTROL ENDPOINTS

// Get version history for a script
router.get("/:id/versions", extractUserId, requireScriptVersionControl, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {

    const { data: versions, error } = await supabase
      .from("script_versions")
      .select("id, version_number, title, change_summary, created_at, created_by")
      .eq("script_id", id)
      .order("version_number", { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) return res.status(500).json({ error: error.message });

    const { count, error: countError } = await supabase
      .from("script_versions")
      .select("id", { count: "exact", head: true })
      .eq("script_id", id);

    if (countError) return res.status(500).json({ error: countError.message });

    res.json({
      versions,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: count,
        pages: Math.ceil((count || 0) / Number(limit))
      }
    });
  } catch (error) {
    console.error('Error getting script versions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific version content
router.get("/:id/versions/:version", extractUserId, requireScriptVersionControl, async (req: PricingRequest, res) => {
  const { id, version } = req.params;

  try {

    const { data, error } = await supabase
      .from("script_versions")
      .select("*")
      .eq("script_id", id)
      .eq("version_number", version)
      .single();

    if (error) return res.status(404).json({ error: "Version not found" });
    res.json(data);
  } catch (error) {
    console.error('Error getting script version:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Restore version to current
router.post("/:id/versions/:version/restore", extractUserId, requireScriptVersionControl, async (req: PricingRequest, res) => {
  const { id, version } = req.params;
  const { change_summary } = req.body;

  try {
    // Get project_id that was set by the middleware
    const projectId = req.project_id as string;

    // Check if the script's project is archived
    const { data: existingProject, error: fetchError } = await supabase
      .from("projects")
      .select("status")
      .eq("id", projectId)
      .single();
    
    if (fetchError) return res.status(500).json({ error: fetchError.message });
    
    // Prevent restoring versions in archived projects
    if (existingProject.status === 'archived') {
      return res.status(403).json({ 
        error: "Archived projects are read-only. Contact support to unarchive this project." 
      });
    }

    // Get version data to restore
    const { data: versionData, error: versionError } = await supabase
      .from("script_versions")
      .select("content")
      .eq("script_id", id)
      .eq("version_number", version)
      .single();

    if (versionError) return res.status(404).json({ error: "Version not found" });

    // Create backup of current state first
    const userId = req.userId;
    await createScriptVersion(id, userId, `Auto-backup before restore to v${version}`);

    // Update current script with version data
    const { data: updatedScript, error: updateError } = await supabase
      .from("scripts")
      .update({
        content: versionData.content
      })
      .eq("id", id)
      .select()
      .single();

    if (updateError) return res.status(500).json({ error: updateError.message });

    await invalidateCollaborationDocumentState(projectId, 'script', id);

    // Invalidate scene cache since content changed
    try {
      await invalidateSceneCache(id);
    } catch (cacheError) {
      console.error('Failed to invalidate scene cache:', cacheError);
    }

    // Create new version entry for the restore action
    await createScriptVersion(id, userId, change_summary || `Restored from version ${version}`);

    res.json(updatedScript);
  } catch (error: any) {
    console.error('Error restoring script version:', error);
    res.status(500).json({ error: error.message || 'Failed to restore version' });
  }
});

// Create manual checkpoint/version
router.post("/:id/versions/checkpoint", extractUserId, requireScriptVersionControl, async (req: PricingRequest, res) => {
  const { id } = req.params;
  const { change_summary } = req.body;

  try {
    // Get project_id that was set by the middleware
    const projectId = req.project_id as string;

    // Check if the script's project is archived
    const { data: existingProject, error: fetchError } = await supabase
      .from("projects")
      .select("status")
      .eq("id", projectId)
      .single();
    
    if (fetchError) return res.status(500).json({ error: fetchError.message });
    
    // Prevent creating checkpoints in archived projects
    if (existingProject.status === 'archived') {
      return res.status(403).json({ 
        error: "Archived projects are read-only. Contact support to unarchive this project." 
      });
    }

    const userId = req.userId;
    const versionNumber = await createScriptVersion(id, userId, change_summary || 'Manual checkpoint');
    
    res.json({ 
      success: true, 
      version_number: versionNumber,
      message: 'Checkpoint created successfully'
    });
  } catch (error: any) {
    console.error('Error creating script checkpoint:', error);
    res.status(500).json({ error: error.message || 'Failed to create checkpoint' });
  }
});

export default router;
