import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import multer from 'multer';
import { checkProjectArchived, checkProjectArchivedByRecordId } from "../middleware/archiveMiddleware";
import { requireFeature, extractUserId, PricingRequest } from "../middleware/pricingMiddleware";
import { requireAuth } from "../middleware/auth";
import { Response, NextFunction } from 'express';
import { PricingService } from '../services/pricingService';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Document types configuration
const DOCUMENT_TYPES = {
  treatment: { name: 'Treatment', description: 'Film industry standard treatment document' },
  logline: { name: 'Logline', description: 'One-sentence pitch capturing story essence, protagonist, and conflict' },
  synopsis: { name: 'Synopsis', description: 'Brief plot summary' },
  character_breakdown: { name: 'Character Breakdown', description: 'Detailed character descriptions' },
  pitch_deck: { name: 'Pitch Deck', description: 'Presentation for investors/stakeholders' },
  mood_board: { name: 'Mood Board', description: 'Visual reference board with images and color palettes' },
  custom: { name: 'Custom', description: 'User-defined document type' }
} as const;

// Custom middleware for document creation limit checking
const checkDocumentCreationLimit = async (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }


    // Get user's subscription and document count
    const pricingService = new PricingService(supabase);
    const subscription = await pricingService.getUserSubscription(userId);
    
    // Get user's projects first, then count documents across those projects
    const { data: userProjects, error: projectsError } = await supabase
      .from('projects')
      .select('id')
      .eq('user_id', userId)
      .eq('deleted', false);

    if (projectsError) {
      throw projectsError;
    }

    let documentCount = 0;
    if (userProjects && userProjects.length > 0) {
      const projectIds = userProjects.map(p => p.id);
      const { count, error: countError } = await supabase
        .from('project_documents')
        .select('id', { count: 'exact' })
        .in('project_id', projectIds);

      if (countError) {
        throw countError;
      }
      
      documentCount = count || 0;
    }

    const currentDocumentCount = documentCount || 0;
    const planId = subscription?.plan_id || 'free';
    
    // Check limits - free plan: 2 documents, others: unlimited
    if (planId === 'free' && currentDocumentCount >= 2) {
      return res.status(403).json({ 
        error: `Document creation limit reached. Free plan allows 2 documents maximum.`,
        type: 'LIMIT_EXCEEDED',
        current_plan: planId,
        current_count: currentDocumentCount,
        limit: 2,
        action_required: 'upgrade'
      });
    }


    next();
  } catch (error) {
    console.error('Error checking document creation limit:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Custom middleware for document version control access with collaboration support
const requireDocumentVersionControl = async (req: PricingRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params; // document ID
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }


    // Get document's project_id
    const { data: document, error: documentError } = await supabase
      .from("project_documents")
      .select("project_id")
      .eq("id", id)
      .single();

    if (documentError || !document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const projectId = document.project_id;
    let targetUserId = userId; // Default to requesting user
    let isCollaborator = false;

    // Check if user owns this project
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

    if (project && project.user_id !== userId) {
      // User doesn't own the project, check if they're a collaborator
      const { data: collaborator, error: collabError } = await supabase
        .from('project_collaborators')
        .select('project_id')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (collaborator && !collabError) {
        // User is a collaborator, use project owner's subscription
        isCollaborator = true;
        targetUserId = project.user_id;
      }
    }

    // Check version control access using the appropriate user ID (owner or collaborator's owner)
    const pricingService = new PricingService(supabase);
    const hasVersionControl = await pricingService.hasPaidPlan(targetUserId);

    if (!hasVersionControl) {
      return res.status(403).json({
        error: 'Version control requires a Pro plan',
        feature: 'version_control'
      });
    }

    // Store project_id for other handlers to use
    req.project_id = projectId;
    next();
  } catch (error) {
    console.error('Error checking document version control access:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Intelligent Retention Configuration (same as concepts/scripts)
const RETENTION_CONFIG = {
  activeDays: 14,
  recentDays: 60,
  sessionWindowHours: 4,
  significantChangeThreshold: 0.05,
  mediumDays: 365,
  weeklySnapshotInterval: 7,
  maxVersionsPerDocument: 500,
  minVersionsToKeep: 10
};

// Helper function to calculate change significance
function calculateChangeSignificance(oldContent: any, newContent: any): number {
  try {
    const oldText = JSON.stringify(oldContent);
    const newText = JSON.stringify(newContent);
    
    const oldWordCount = oldText.split(/\s+/).length;
    const newWordCount = newText.split(/\s+/).length;
    const wordCountDelta = Math.abs(newWordCount - oldWordCount);
    const wordCountChange = oldWordCount > 0 ? wordCountDelta / oldWordCount : 1;
    
    // Document specific patterns
    const structuralPatterns = [
      /^#+ /gm, // Headers
      /\*\*.*\*\*/g, // Bold text (emphasis)
      /- /gm, // List items
      /^\d+\. /gm // Numbered lists
    ];
    
    let structuralScore = 0;
    structuralPatterns.forEach(pattern => {
      const oldMatches = (oldText.match(pattern) || []).length;
      const newMatches = (newText.match(pattern) || []).length;
      if (oldMatches !== newMatches) structuralScore += 25;
    });
    
    return Math.min(100, (wordCountChange * 30) + structuralScore);
  } catch (error) {
    console.warn('Error calculating change significance:', error);
    return 50;
  }
}

// Intelligent cleanup for document versions
// Optimized: fetches only metadata first, content only when needed for significance check
async function cleanupOldDocumentVersions(documentId: string) {
  try {
    const now = new Date();

    // First pass: fetch only metadata (no content) for fast filtering
    const { data: allVersions, error: versionsError } = await supabase
      .from('project_document_versions')
      .select('id, created_at, change_summary')
      .eq('project_document_id', documentId)
      .order('created_at', { ascending: false });

    if (versionsError) throw versionsError;
    if (!allVersions || allVersions.length === 0) return;

    if (allVersions.length <= RETENTION_CONFIG.minVersionsToKeep) return;

    // Hard limit safety check - delete oldest without content analysis
    if (allVersions.length > RETENTION_CONFIG.maxVersionsPerDocument) {
      const excess = allVersions.length - RETENTION_CONFIG.maxVersionsPerDocument;
      const oldestVersions = allVersions.slice(-excess);
      await deleteDocumentVersions(oldestVersions.map(v => v.id));
      return;
    }

    const versionsToDelete: string[] = [];
    const versionsNeedingContentCheck: string[] = [];

    // First pass: filter by time and metadata only (no content needed)
    for (const version of allVersions) {
      const versionAge = now.getTime() - new Date(version.created_at).getTime();
      const ageInDays = versionAge / (1000 * 60 * 60 * 24);

      // Tier 1: Keep all recent versions (0-14 days) - no content check needed
      if (ageInDays <= RETENTION_CONFIG.activeDays) {
        continue;
      }

      // Never delete manual checkpoints - no content check needed
      if (version.change_summary &&
          (version.change_summary.includes('Checkpoint:') ||
           version.change_summary.includes('Tagged:') ||
           version.change_summary.includes('Manual:'))) {
        continue;
      }

      // Tier 2 & 3: Mark for potential content-based significance check
      if (ageInDays <= RETENTION_CONFIG.recentDays || ageInDays <= RETENTION_CONFIG.mediumDays) {
        const versionDate = new Date(version.created_at).toDateString();
        const isFirstVersionOfDay = !allVersions.some(v =>
          new Date(v.created_at).toDateString() === versionDate &&
          new Date(v.created_at) < new Date(version.created_at)
        );

        if (isFirstVersionOfDay) continue;

        // Check session window (time-based, no content needed)
        const lastKeptVersion = allVersions.find(v =>
          !versionsToDelete.includes(v.id) &&
          !versionsNeedingContentCheck.includes(v.id) &&
          new Date(v.created_at) < new Date(version.created_at)
        );
        if (lastKeptVersion) {
          const timeDiff = new Date(version.created_at).getTime() - new Date(lastKeptVersion.created_at).getTime();
          const hoursDiff = timeDiff / (1000 * 60 * 60);
          if (hoursDiff >= RETENTION_CONFIG.sessionWindowHours) {
            continue;
          }
        }

        // Mark for content check (will be deleted unless significant change)
        versionsNeedingContentCheck.push(version.id);
      }
      // Tier 4: Long-term archive with monthly snapshots - no content check
      else {
        const daysSinceMonthStart = ageInDays % 30;
        if (daysSinceMonthStart < 1) continue;

        versionsToDelete.push(version.id);
      }
    }

    // Second pass: fetch content ONLY for versions that need significance check
    // This is the key optimization - usually very few versions need this
    if (versionsNeedingContentCheck.length > 0) {
      const { data: versionsWithContent } = await supabase
        .from('project_document_versions')
        .select('id, content, created_at')
        .in('id', versionsNeedingContentCheck)
        .order('created_at', { ascending: false });

      if (versionsWithContent && versionsWithContent.length > 0) {
        for (let i = 0; i < versionsWithContent.length; i++) {
          const version = versionsWithContent[i];
          const prevVersion = versionsWithContent[i + 1];

          if (prevVersion) {
            const significance = calculateChangeSignificance(prevVersion.content, version.content);
            // Keep if significant change (threshold varies by tier, use 50% as default)
            if (significance >= RETENTION_CONFIG.significantChangeThreshold * 100) {
              continue;
            }
          }

          versionsToDelete.push(version.id);
        }
      }
    }

    if (versionsToDelete.length > 0) {
      const versionsToKeep = allVersions.length - versionsToDelete.length;
      if (versionsToKeep >= RETENTION_CONFIG.minVersionsToKeep) {
        await deleteDocumentVersions(versionsToDelete);
      }
    }

  } catch (error) {
    console.error('Error in intelligent document version cleanup:', error);
  }
}

// Helper function to delete document versions
async function deleteDocumentVersions(versionIds: string[]) {
  if (versionIds.length === 0) return;
  
  const { error } = await supabase
    .from('project_document_versions')
    .delete()
    .in('id', versionIds);
    
  if (error) throw error;
}

// Helper function to create a document version
async function createDocumentVersion(documentId: string, userId: string, changeSummary: string = 'Auto-save') {
  try {
    // Get current document data
    const { data: currentDocument, error: documentError } = await supabase
      .from('project_documents')
      .select('title, content')
      .eq('id', documentId)
      .single();

    if (documentError) throw new Error('Document not found');

    // Get next version number
    const { data: lastVersion, error: versionError } = await supabase
      .from('project_document_versions')
      .select('version_number')
      .eq('project_document_id', documentId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = (lastVersion?.version_number || 0) + 1;

    // Create version
    const { error: insertError } = await supabase
      .from('project_document_versions')
      .insert({
        project_document_id: documentId,
        version_number: nextVersion,
        title: currentDocument.title,
        content: currentDocument.content,
        change_summary: changeSummary,
        created_by: userId
      });

    if (insertError) throw new Error('Failed to create version');

    // Cleanup old versions in background (don't block the save)
    // This is a performance optimization - cleanup is not critical path
    cleanupOldDocumentVersions(documentId).catch(err => {
      console.error('Background cleanup failed:', err);
    });

    return nextVersion;
  } catch (error) {
    console.error('Error creating document version:', error);
    throw error;
  }
}

// DOCUMENT TYPES ENDPOINTS

// Get available document types
router.get("/types", async (req, res) => {
  res.json(DOCUMENT_TYPES);
});

// DOCUMENT CRUD ENDPOINTS

// Get pinned documents for a project (for sidebar quick links)
router.get("/pinned", requireAuth, extractUserId, async (req, res) => {
  const { project_id } = req.query;
  if (!project_id) return res.status(400).json({ error: "Missing project_id" });

  const { data, error } = await supabase
    .from("project_documents")
    .select("id, document_type, title")
    .eq("project_id", project_id)
    .eq("is_pinned", true)
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Toggle pin status of a document
router.patch("/:id/pin", requireAuth, extractUserId, async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  // Get current pin status
  const { data: doc, error: fetchError } = await supabase
    .from("project_documents")
    .select("id, is_pinned, project_id")
    .eq("id", id)
    .single();

  if (fetchError || !doc) return res.status(404).json({ error: "Document not found" });

  // Verify ownership
  const { data: project } = await supabase
    .from("projects")
    .select("user_id")
    .eq("id", doc.project_id)
    .single();

  if (!project) return res.status(404).json({ error: "Project not found" });
  if (project.user_id !== userId) {
    const { data: collab } = await supabase
      .from("project_collaborators")
      .select("role")
      .eq("project_id", doc.project_id)
      .eq("user_id", userId)
      .eq("status", "active")
      .single();
    if (!collab || collab.role === 'viewer') {
      return res.status(403).json({ error: "Not authorized" });
    }
  }

  const newPinned = !doc.is_pinned;
  const { data: updated, error: updateError } = await supabase
    .from("project_documents")
    .update({ is_pinned: newPinned })
    .eq("id", id)
    .select("id, is_pinned")
    .single();

  if (updateError) return res.status(500).json({ error: updateError.message });
  res.json(updated);
});

// Get all documents for a project (lightweight - excludes content for performance)
router.get("/", requireAuth, extractUserId, async (req, res) => {
  const { project_id, type } = req.query;
  if (!project_id) return res.status(400).json({ error: "Missing project_id" });

  // PERFORMANCE: Don't include 'content' in list view - it can be very large
  let query = supabase
    .from("project_documents")
    .select("id, document_type, title, created_at, updated_at, is_ai_generated, project_id, is_pinned")
    .eq("project_id", project_id)
    .order("updated_at", { ascending: false });

  // Filter by document type if specified
  if (type) {
    query = query.eq("document_type", type);
  }

  const { data: documents, error: documentsError } = await query;

  if (documentsError) return res.status(500).json({ error: documentsError.message });

  res.json({
    documents: documents || []
  });
});

// Get a single document with full content
router.get("/:id", requireAuth, extractUserId, async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;

  try {
    const { data: document, error } = await supabase
      .from("project_documents")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !document) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Check if user owns the project or is a collaborator
    const { data: project } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', document.project_id)
      .single();

    const isOwner = project?.user_id === userId;
    let hasAccess = isOwner;

    if (!isOwner) {
      const { data: collaborator } = await supabase
        .from('project_collaborators')
        .select('project_id')
        .eq('project_id', document.project_id)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      hasAccess = !!collaborator;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Access denied" });
    }

    res.json(document);
  } catch (error: any) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Create a new document
router.post("/", requireAuth, extractUserId, checkDocumentCreationLimit, checkProjectArchived, async (req, res) => {
  const { document_type = 'treatment', project_id, title } = req.body;

  if (!project_id) return res.status(400).json({ error: "Missing project_id" });

  // Validate document type
  if (!Object.keys(DOCUMENT_TYPES).includes(document_type)) {
    return res.status(400).json({ error: "Invalid document_type" });
  }

  // Insert the new document
  const { data, error } = await supabase
    .from("project_documents")
    .insert([{ 
      document_type, 
      project_id, 
      title: title || `New ${DOCUMENT_TYPES[document_type as keyof typeof DOCUMENT_TYPES].name}`,
      content: document_type === 'mood_board'
        ? { sections: [], palette: [] }
        : { type: "doc", content: [] }
    }])
    .select()
    .single();

  if (error) {
    console.error("Supabase insert error:", error);
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// Update a document (title or content)
router.put("/:id", requireAuth, extractUserId, async (req, res) => {
  const { id } = req.params;
  const { title, content, change_summary, create_version = false } = req.body;
  const userId = req.user?.id;

  if (!title && !content) return res.status(400).json({ error: "Nothing to update" });

  // Check if document exists and user has write access
  const { data: document, error: fetchError } = await supabase
    .from("project_documents")
    .select("project_id")
    .eq("id", id)
    .single();

  if (fetchError || !document) {
    return res.status(404).json({ error: "Document not found" });
  }

  // Check if user owns the project or is a collaborator with write access
  const { data: project } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', document.project_id)
    .single();

  const isOwner = project?.user_id === userId;
  let hasWriteAccess = isOwner;

  if (!isOwner) {
    const { data: collaborator } = await supabase
      .from('project_collaborators')
      .select('role, status')
      .eq('project_id', document.project_id)
      .eq('user_id', userId)
      .single();

    // Must be active collaborator with editor or admin role
    if (collaborator && collaborator.status === 'active') {
      hasWriteAccess = collaborator.role === 'editor' || collaborator.role === 'admin';
    }
  }

  if (!hasWriteAccess) {
    return res.status(403).json({
      error: "Access denied - you don't have write permission for this document",
      role: 'viewer'
    });
  }

  // Smart version creation logic:
  // 1. Always create version if explicitly requested (create_version=true)
  // 2. Always create version for manual edits with custom change_summary
  // 3. For auto-saves, only create version if 5+ minutes since last version
  let shouldCreateVersion = create_version || (change_summary && change_summary !== 'Auto-save');

  if (!shouldCreateVersion && change_summary === 'Auto-save') {
    // Check if we should create a periodic auto-version (every 5 minutes)
    const { data: lastVersion } = await supabase
      .from('project_document_versions')
      .select('created_at')
      .eq('project_document_id', id)
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

      // Create auto-version every 5 minutes
      if (minutesSinceLastVersion >= 5) {
        shouldCreateVersion = true;
      }
    }
  }

  if (shouldCreateVersion) {
    try {
      const userId = req.user?.id;
      await createDocumentVersion(id, userId, change_summary || 'Manual edit');
    } catch (error) {
      console.error('Failed to create version backup:', error);
      // Continue with update even if version creation fails
    }
  }

  const updateObj: any = {};
  if (title) updateObj.title = title;
  if (content) updateObj.content = content;

  const { data, error } = await supabase
    .from("project_documents")
    .update(updateObj)
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Delete a document
router.delete("/:id", requireAuth, extractUserId, checkProjectArchivedByRecordId('project_documents'), async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;
  
  
  try {
    // First check if document exists and user has permission
    const { data: document, error: fetchError } = await supabase
      .from("project_documents")
      .select("project_id")
      .eq("id", id)
      .single();
    
    if (fetchError || !document) {
      return res.status(404).json({ error: "Document not found" });
    }
    
    // Check if user owns the project or is a collaborator
    const { data: project } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', document.project_id)
      .single();
    
    const isOwner = project?.user_id === userId;
    let hasAccess = isOwner;
    
    if (!isOwner) {
      const { data: collaborator } = await supabase
        .from('project_collaborators')
        .select('project_id')
        .eq('project_id', document.project_id)
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();
      
      hasAccess = !!collaborator;
    }
    
    if (!hasAccess) {
      return res.status(403).json({ error: "Access denied" });
    }
    
    const { error } = await supabase
      .from("project_documents")
      .delete()
      .eq("id", id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// VERSION CONTROL ENDPOINTS

// Get version history for a document
router.get("/:id/versions", requireAuth, extractUserId, requireDocumentVersionControl, async (req, res) => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  const { data: versions, error } = await supabase
    .from("project_document_versions")
    .select("id, version_number, title, change_summary, created_at, created_by")
    .eq("project_document_id", id)
    .order("version_number", { ascending: false })
    .range(offset, offset + Number(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });

  const { count, error: countError } = await supabase
    .from("project_document_versions")
    .select("id", { count: "exact", head: true })
    .eq("project_document_id", id);

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
});

// Get specific version content
router.get("/:id/versions/:version", requireAuth, extractUserId, requireDocumentVersionControl, async (req, res) => {
  const { id, version } = req.params;

  const { data, error } = await supabase
    .from("project_document_versions")
    .select("*")
    .eq("project_document_id", id)
    .eq("version_number", version)
    .single();

  if (error) return res.status(404).json({ error: "Version not found" });
  res.json(data);
});

// Restore version to current
router.post("/:id/versions/:version/restore", requireAuth, extractUserId, requireDocumentVersionControl, async (req, res) => {
  const { id, version } = req.params;
  const { change_summary } = req.body;

  try {
    // Check if the document's project is archived
    const { data: document, error: documentError } = await supabase
      .from("project_documents")
      .select("project_id")
      .eq("id", id)
      .single();
    
    if (documentError) return res.status(500).json({ error: documentError.message });
    
    const { data: existingProject, error: fetchError } = await supabase
      .from("projects")
      .select("status")
      .eq("id", document.project_id)
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
      .from("project_document_versions")
      .select("title, content")
      .eq("project_document_id", id)
      .eq("version_number", version)
      .single();

    if (versionError) return res.status(404).json({ error: "Version not found" });

    // Create backup of current state first
    const userId = req.user?.id;
    await createDocumentVersion(id, userId, `Auto-backup before restore to v${version}`);

    // Update current document with version data
    const { data: updatedDocument, error: updateError } = await supabase
      .from("project_documents")
      .update({
        title: versionData.title,
        content: versionData.content
      })
      .eq("id", id)
      .select()
      .single();

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Create new version entry for the restore action
    await createDocumentVersion(id, userId, change_summary || `Restored from version ${version}`);

    res.json(updatedDocument);
  } catch (error: any) {
    console.error('Error restoring document version:', error);
    res.status(500).json({ error: error.message || 'Failed to restore version' });
  }
});

// Create manual checkpoint/version
router.post("/:id/versions/checkpoint", requireAuth, extractUserId, requireDocumentVersionControl, async (req, res) => {
  const { id } = req.params;
  const { change_summary } = req.body;

  try {
    // Check if the document's project is archived
    const { data: document, error: documentError } = await supabase
      .from("project_documents")
      .select("project_id")
      .eq("id", id)
      .single();
    
    if (documentError) return res.status(500).json({ error: documentError.message });
    
    const { data: existingProject, error: fetchError } = await supabase
      .from("projects")
      .select("status")
      .eq("id", document.project_id)
      .single();
    
    if (fetchError) return res.status(500).json({ error: fetchError.message });
    
    // Prevent creating checkpoints in archived projects
    if (existingProject.status === 'archived') {
      return res.status(403).json({ 
        error: "Archived projects are read-only. Contact support to unarchive this project." 
      });
    }

    const userId = req.user?.id;
    const versionNumber = await createDocumentVersion(id, userId, change_summary || 'Manual checkpoint');
    
    res.json({ 
      success: true, 
      version_number: versionNumber,
      message: 'Checkpoint created successfully'
    });
  } catch (error: any) {
    console.error('Error creating document checkpoint:', error);
    res.status(500).json({ error: error.message || 'Failed to create checkpoint' });
  }
});

// Export document to Word Document (.docx) format
router.get("/:id/export/docx", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    // Get document to check if it exists
    const { data: document, error } = await supabase
      .from("project_documents")
      .select(`
        id,
        title,
        content,
        document_type,
        project_id,
        projects!inner(
          title,
          name,
          author,
          based_on,
          contact_info,
          copyright_notice,
          registration_number
        )
      `)
      .eq("id", id)
      .single();

    if (error || !document) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Generate Word document content
    const docxContent = generateDocumentDocx(document);
    
    // Clean filename
    const cleanTitle = (document.title || 'document')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '_')
      .toLowerCase();
    
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${cleanTitle}_${timestamp}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(docxContent);
  } catch (error: any) {
    console.error('Error exporting document to Word:', error);
    res.status(500).json({ error: 'Failed to export to Word Document format' });
  }
});

// Helper function to generate Word document content
function generateDocumentDocx(document: any): Buffer {
  let docxContent = '';
  
  // Add document title
  if (document.title) {
    docxContent += `${document.title.toUpperCase()}\n\n`;
  }
  
  // Add document type
  const typeName = DOCUMENT_TYPES[document.document_type as keyof typeof DOCUMENT_TYPES]?.name || 'Document';
  docxContent += `${typeName}\n\n`;
  
  // Add project info if available
  const project = Array.isArray(document.projects) ? document.projects[0] : document.projects;
  if (project) {
    if (project.title || project.name) {
      docxContent += `Project: ${project.title || project.name}\n`;
    }
    if (project.author) {
      docxContent += `Author: ${project.author}\n`;
    }
    docxContent += '\n';
  }
  
  // Convert document content
  if (document.content && document.content.content && Array.isArray(document.content.content)) {
    docxContent += convertTipTapToText(document.content.content);
  } else if (typeof document.content === 'string') {
    docxContent += document.content;
  }
  
  // Add footer info
  docxContent += '\n\n---\n';
  if (project?.copyright_notice) {
    docxContent += `${project.copyright_notice}\n`;
  }
  if (project?.contact_info) {
    docxContent += `Contact: ${project.contact_info}\n`;
  }
  
  return Buffer.from(docxContent, 'utf-8');
}

// Helper function to convert TipTap content to text
function convertTipTapToText(content: any[]): string {
  let text = '';
  
  for (const node of content) {
    if (node.type === 'paragraph') {
      const textContent = node.content?.map((c: any) => {
        if (c.type === 'text') {
          let nodeText = c.text || '';
          // Apply formatting
          if (c.marks) {
            for (const mark of c.marks) {
              if (mark.type === 'bold') {
                nodeText = `**${nodeText}**`;
              } else if (mark.type === 'italic') {
                nodeText = `*${nodeText}*`;
              }
            }
          }
          return nodeText;
        }
        return '';
      }).join('') || '';
      
      text += textContent + '\n';
    } else if (node.type === 'heading') {
      const level = node.attrs?.level || 1;
      const headingText = node.content?.map((c: any) => c.text || '').join('') || '';
      text += '#'.repeat(level) + ' ' + headingText + '\n';
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      node.content?.forEach((listItem: any, index: number) => {
        const bullet = node.type === 'bulletList' ? '• ' : `${index + 1}. `;
        const itemText = listItem.content?.map((p: any) => 
          p.content?.map((c: any) => c.text || '').join('') || ''
        ).join('') || '';
        text += bullet + itemText + '\n';
      });
    }
    text += '\n';
  }
  
  return text;
}

// =============================================================================
// MOOD BOARD: Image Upload
// =============================================================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// Upload a mood board image
router.post("/:id/mood-board-image", requireAuth, extractUserId, upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    // Check document exists and user has access
    const { data: document, error: fetchError } = await supabase
      .from("project_documents")
      .select("project_id, document_type")
      .eq("id", id)
      .single();

    if (fetchError || !document) {
      return res.status(404).json({ error: "Document not found" });
    }

    if (document.document_type !== 'mood_board') {
      return res.status(400).json({ error: "Document is not a mood board" });
    }

    // Check ownership or collaborator access
    const { data: project } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', document.project_id)
      .single();

    const isOwner = project?.user_id === userId;
    if (!isOwner) {
      const { data: collaborator } = await supabase
        .from('project_collaborators')
        .select('role, status')
        .eq('project_id', document.project_id)
        .eq('user_id', userId)
        .single();

      if (!collaborator || collaborator.status !== 'active' || collaborator.role === 'viewer') {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    // Upload to project-assets bucket
    const ext = file.originalname.split('.').pop() || 'jpg';
    const storagePath = `mood-board/${uuidv4()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('project-assets')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
      });

    if (uploadError) {
      console.error('❌ Mood board image upload error:', uploadError);
      return res.status(500).json({ error: "Failed to upload image" });
    }

    // Generate signed URL for immediate display
    const { data: signedUrlData } = await supabase.storage
      .from('project-assets')
      .createSignedUrl(storagePath, 3600);

    res.json({
      path: storagePath,
      signedUrl: signedUrlData?.signedUrl || null,
    });
  } catch (error) {
    console.error('❌ Mood board image upload error:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Resolve storage paths to signed URLs (batch)
router.post("/:id/resolve-urls", requireAuth, extractUserId, async (req, res) => {
  try {
    const { id } = req.params;
    const { paths } = req.body;
    const userId = req.user?.id;

    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.json({ urls: {} });
    }

    // Check document exists and user has access
    const { data: document, error: fetchError } = await supabase
      .from("project_documents")
      .select("project_id")
      .eq("id", id)
      .single();

    if (fetchError || !document) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Check ownership or collaborator/share access
    const { data: project } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', document.project_id)
      .single();

    const isOwner = project?.user_id === userId;
    if (!isOwner) {
      const { data: collaborator } = await supabase
        .from('project_collaborators')
        .select('role, status')
        .eq('project_id', document.project_id)
        .eq('user_id', userId)
        .single();

      if (!collaborator || collaborator.status !== 'active') {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    // Generate signed URLs for all paths
    const urls: Record<string, string> = {};
    for (const path of paths.slice(0, 50)) { // Limit to 50
      const { data: signedUrlData } = await supabase.storage
        .from('project-assets')
        .createSignedUrl(path, 3600);
      if (signedUrlData?.signedUrl) {
        urls[path] = signedUrlData.signedUrl;
      }
    }

    res.json({ urls });
  } catch (error) {
    console.error('❌ Resolve URLs error:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;