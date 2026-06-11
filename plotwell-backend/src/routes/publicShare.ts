/**
 * Public Share Routes
 *
 * Manages shareable read-only links to projects.
 * Public GET endpoint requires NO authentication (token-based access).
 * Management endpoints (CRUD) require authentication + project ownership.
 */

import { Router, Request, Response } from "express";
import { supabase } from "../config/database";
import { requireAuth } from "../middleware/auth";
import { extractUserId } from "../middleware/pricingMiddleware";
import { getSignedUrl, resolveImageUrls, resolveNestedImageUrls, BUCKETS } from "../services/storageService";
import rateLimit from "express-rate-limit";
import { ipKeyGenerator } from "express-rate-limit";
import { createHash } from "crypto";
const DEBUG_AI = process.env.DEBUG_AI === 'true';

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

const router = Router();

// Rate limiter for public share endpoint (IP-based, stricter)
const publicShareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many requests, please try again later.",
  keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
});

// Rate limiter for management endpoints (user-based)
const manageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many requests, please try again later.",
  keyGenerator: (req) => {
    if (req.user?.id) return req.user.id;
    return ipKeyGenerator(req.ip || 'unknown');
  },
});

async function generateShareToken(): Promise<string> {
  const { randomBytes } = await import('crypto');
  return randomBytes(32).toString('hex');
}

// =============================================
// PUBLIC ENDPOINT (no auth)
// =============================================

/**
 * GET /api/share/:token
 * Fetch shared project data. No authentication required.
 * Returns only the sections the owner chose to share.
 */
router.get('/:token', publicShareLimiter, async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    if (!token || token.length !== 64) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    // Lookup share record
    const { data: share, error: shareError } = await supabase
      .from('public_project_shares')
      .select('id, project_id, shared_sections, is_active, expires_at, password_hash, view_count')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (shareError || !share) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    // Check expiry
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(404).json({ error: 'Share link has expired' });
    }

    // Check password if set
    if (share.password_hash) {
      const password = req.query.password as string || req.headers['x-share-password'] as string;
      if (!password) {
        return res.status(401).json({ error: 'password_required' });
      }
      if (hashPassword(password) !== share.password_hash) {
        return res.status(401).json({ error: 'invalid_password' });
      }
    }

    // Fetch project (only safe fields)
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name, project_type, description, title, author, based_on, status')
      .eq('id', share.project_id)
      .eq('deleted', false)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    const sections = share.shared_sections as string[];
    const result: Record<string, any> = {
      project: {
        name: project.name,
        project_type: project.project_type,
        description: project.description,
        title: project.title,
        author: project.author,
        based_on: project.based_on,
      },
      shared_sections: sections,
    };

    // Fetch each shared section
    if (sections.includes('script')) {
      const { data: scripts } = await supabase
        .from('scripts')
        .select('id, title, content, scenes')
        .eq('project_id', share.project_id)
        .order('created_at', { ascending: true })
        .limit(1);

      result.script = scripts?.[0] ? {
        title: scripts[0].title,
        content: scripts[0].content,
        scenes: scripts[0].scenes,
      } : null;
    }

    if (sections.includes('characters')) {
      const { data: characters, error: charError } = await supabase
        .from('characters')
        .select(`
          id, name, description, character_type, primary_role, importance_level,
          character_images(id, image_url, is_primary)
        `)
        .eq('project_id', share.project_id)
        .order('importance_level', { ascending: false })
        .order('name', { ascending: true });

      if (charError) {
        console.error('❌ SHARE CHARACTERS QUERY ERROR:', charError);
      }

      if (characters?.length) {
        // Extract primary image (or first image) like the main characters endpoint
        const transformed = characters.map((char: any) => {
          const images = char.character_images || [];
          const primaryImage = images.find((img: any) => img.is_primary) || images[0];
          return {
            id: char.id,
            name: char.name,
            description: char.description,
            character_type: char.character_type,
            primary_role: char.primary_role,
            importance_level: char.importance_level,
            image_url: primaryImage?.image_url || null,
          };
        });
        result.characters = await resolveImageUrls(
          transformed.filter((c: any) => c.image_url),
          [{ field: 'image_url', bucket: BUCKETS.CHARACTER_IMAGES }]
        ).then(resolved => {
          // Merge back characters without images
          const resolvedMap = new Map(resolved.map((r: any) => [r.id, r]));
          return transformed.map((c: any) => resolvedMap.get(c.id) || c);
        });
      } else {
        result.characters = [];
      }
    }

    if (sections.includes('locations')) {
      const { data: locations } = await supabase
        .from('locations')
        .select('id, name, description, location_type, atmosphere, image_url')
        .eq('project_id', share.project_id)
        .order('name', { ascending: true });

      if (locations?.length) {
        result.locations = await resolveImageUrls(locations, [
          { field: 'image_url', bucket: BUCKETS.LOCATION_IMAGES },
        ]);
      } else {
        result.locations = [];
      }
    }

    if (sections.includes('storyboard')) {
      const { data: panels } = await supabase
        .from('storyboard_panels')
        .select('id, scene_id, scene_number, scene_heading, panel_number, scene_description, image_url, shot_type, camera_movement')
        .eq('project_id', share.project_id)
        .order('scene_number', { ascending: true })
        .order('panel_number', { ascending: true });

      if (panels?.length) {
        let resolvedPanels = await resolveImageUrls(panels, [
          { field: 'image_url', bucket: BUCKETS.STORYBOARD_IMAGES },
        ]);

        // Group panels by scene_id
        const sceneMap = new Map<string, { scene_heading: string; scene_number: number; panels: any[] }>();
        for (const p of resolvedPanels) {
          const key = p.scene_id || `scene-${p.scene_number}`;
          if (!sceneMap.has(key)) {
            sceneMap.set(key, {
              scene_heading: p.scene_heading || '',
              scene_number: p.scene_number || 0,
              panels: [],
            });
          }
          sceneMap.get(key)!.panels.push({
            description: p.scene_description,
            image_url: p.image_url,
            shot_type: p.shot_type,
            camera_movement: p.camera_movement,
            panel_number: p.panel_number,
          });
        }
        result.storyboard = Array.from(sceneMap.values());
      } else {
        result.storyboard = [];
      }
    }

    // Update view count (fire and forget)
    supabase
      .from('public_project_shares')
      .update({ view_count: (share.view_count || 0) + 1, last_viewed_at: new Date().toISOString() })
      .eq('id', share.id)
      .then(() => {});

    return res.json(result);
  } catch (error) {
    console.error('❌ PUBLIC SHARE GET ERROR:', error);
    return res.status(500).json({ error: 'Failed to load shared project' });
  }
});

// =============================================
// PROTECTED ENDPOINTS (require auth + ownership)
// =============================================

/**
 * POST /api/share
 * Create a new share link for a project. Owner only.
 */
router.post('/', requireAuth, extractUserId, manageLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { project_id, shared_sections, label, expires_at, password } = req.body;

    if (!project_id) {
      return res.status(400).json({ error: 'project_id is required' });
    }

    // Verify ownership
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, user_id')
      .eq('id', project_id)
      .eq('deleted', false)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.user_id !== userId) {
      return res.status(403).json({ error: 'Only the project owner can create share links' });
    }

    // Validate shared_sections
    const validSections = ['script', 'characters', 'locations', 'storyboard'];
    const sections = shared_sections || validSections;
    if (!Array.isArray(sections) || !sections.every((s: string) => validSections.includes(s))) {
      return res.status(400).json({ error: 'Invalid shared_sections' });
    }

    // Validate expires_at if provided
    if (expires_at) {
      const expiryDate = new Date(expires_at);
      if (isNaN(expiryDate.getTime()) || expiryDate <= new Date()) {
        return res.status(400).json({ error: 'expires_at must be a future date' });
      }
    }

    const token = await generateShareToken();

    const { data: share, error: insertError } = await supabase
      .from('public_project_shares')
      .insert({
        project_id,
        created_by: userId,
        token,
        shared_sections: sections,
        label: label || null,
        expires_at: expires_at || null,
        password_hash: password ? hashPassword(password) : null,
      })
      .select()
      .single();

    if (insertError) {
      console.error('❌ CREATE SHARE ERROR:', insertError);
      return res.status(500).json({ error: 'Failed to create share link' });
    }

    if (DEBUG_AI) console.log('🔗 SHARE LINK CREATED:', { project_id, share_id: share.id });

    return res.status(201).json({
      ...share,
      password_hash: undefined,
      has_password: !!password,
      url: `/share/${token}`,
    });
  } catch (error) {
    console.error('❌ CREATE SHARE ERROR:', error);
    return res.status(500).json({ error: 'Failed to create share link' });
  }
});

/**
 * GET /api/share/project/:projectId
 * List all share links for a project. Owner only.
 */
router.get('/project/:projectId', requireAuth, extractUserId, manageLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { projectId } = req.params;

    // Verify ownership
    const { data: project } = await supabase
      .from('projects')
      .select('id, user_id')
      .eq('id', projectId)
      .eq('deleted', false)
      .single();

    if (!project || project.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: shares, error } = await supabase
      .from('public_project_shares')
      .select('id, token, shared_sections, is_active, expires_at, view_count, last_viewed_at, label, password_hash, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ LIST SHARES ERROR:', error);
      return res.status(500).json({ error: 'Failed to list share links' });
    }

    // Map password_hash to has_password boolean, never expose hash
    const safeShares = (shares || []).map((s: any) => ({
      ...s,
      has_password: !!s.password_hash,
      password_hash: undefined,
    }));

    return res.json(safeShares);
  } catch (error) {
    console.error('❌ LIST SHARES ERROR:', error);
    return res.status(500).json({ error: 'Failed to list share links' });
  }
});

/**
 * PATCH /api/share/:shareId
 * Update a share link (toggle active, change sections, set expiry). Owner only.
 */
router.patch('/:shareId', requireAuth, extractUserId, manageLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { shareId } = req.params;
    const { is_active, shared_sections, label, expires_at } = req.body;

    // Lookup share + verify ownership
    const { data: share } = await supabase
      .from('public_project_shares')
      .select('id, project_id, projects!inner(user_id)')
      .eq('id', shareId)
      .single();

    if (!share || (share as any).projects?.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updates: Record<string, any> = {};

    if (typeof is_active === 'boolean') updates.is_active = is_active;
    if (label !== undefined) updates.label = label || null;
    if (expires_at !== undefined) updates.expires_at = expires_at || null;

    if (shared_sections) {
      const validSections = ['script', 'characters', 'locations', 'storyboard'];
      if (!Array.isArray(shared_sections) || !shared_sections.every((s: string) => validSections.includes(s))) {
        return res.status(400).json({ error: 'Invalid shared_sections' });
      }
      updates.shared_sections = shared_sections;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data: updated, error } = await supabase
      .from('public_project_shares')
      .update(updates)
      .eq('id', shareId)
      .select()
      .single();

    if (error) {
      console.error('❌ UPDATE SHARE ERROR:', error);
      return res.status(500).json({ error: 'Failed to update share link' });
    }

    return res.json(updated);
  } catch (error) {
    console.error('❌ UPDATE SHARE ERROR:', error);
    return res.status(500).json({ error: 'Failed to update share link' });
  }
});

/**
 * DELETE /api/share/:shareId
 * Permanently delete a share link. Owner only.
 */
router.delete('/:shareId', requireAuth, extractUserId, manageLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { shareId } = req.params;

    // Lookup share + verify ownership
    const { data: share } = await supabase
      .from('public_project_shares')
      .select('id, project_id, projects!inner(user_id)')
      .eq('id', shareId)
      .single();

    if (!share || (share as any).projects?.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { error } = await supabase
      .from('public_project_shares')
      .delete()
      .eq('id', shareId);

    if (error) {
      console.error('❌ DELETE SHARE ERROR:', error);
      return res.status(500).json({ error: 'Failed to delete share link' });
    }

    if (DEBUG_AI) console.log('🗑️ SHARE LINK DELETED:', { shareId });
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ DELETE SHARE ERROR:', error);
    return res.status(500).json({ error: 'Failed to delete share link' });
  }
});

export default router;
