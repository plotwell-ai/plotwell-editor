/**
 * Structure Templates Routes
 *
 * Handles story structure templates (Hero's Journey, Save the Cat, etc.)
 * Includes built-in templates and user-custom templates
 */

import { Router, Request, Response } from 'express';
import { supabase } from '../config/database';
import { requireAuth, getUserId } from '../middleware/auth';
import { extractUserId } from '../middleware/pricingMiddleware';

const router = Router();

// =============================================================================
// GET ALL TEMPLATES (Public + User's Custom)
// =============================================================================

/**
 * GET /api/structure-templates
 * Get all available templates (built-in + user's custom templates)
 */
router.get('/structure-templates', requireAuth, extractUserId, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const { category } = req.query; // Optional filter: 'film', 'tv', 'both'

    let query = supabase
      .from('structure_templates')
      .select('*')
      .or(`is_default.eq.true,created_by.eq.${userId}`)
      .order('is_default', { ascending: false })
      .order('usage_count', { ascending: false });

    // Filter by category if provided
    if (category && ['film', 'tv', 'both'].includes(category as string)) {
      query = query.or(`category.eq.${category},category.eq.both`);
    }

    const { data: templates, error } = await query;

    if (error) {
      console.error('❌ TEMPLATES FETCH ERROR:', error);
      return res.status(500).json({ error: 'Failed to fetch templates' });
    }

    res.json(templates || []);

  } catch (error) {
    console.error('❌ GET TEMPLATES ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// GET SINGLE TEMPLATE
// =============================================================================

/**
 * GET /api/structure-templates/:templateId
 * Get a specific template by ID
 */
router.get('/structure-templates/:templateId', requireAuth, extractUserId, async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const userId = req.userId;

    const { data: template, error } = await supabase
      .from('structure_templates')
      .select('*')
      .eq('id', templateId)
      .or(`is_default.eq.true,created_by.eq.${userId}`)
      .single();

    if (error || !template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json(template);

  } catch (error) {
    console.error('❌ GET TEMPLATE ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// CREATE CUSTOM TEMPLATE
// =============================================================================

/**
 * POST /api/structure-templates
 * Create a custom structure template
 */
router.post('/structure-templates', requireAuth, extractUserId, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    const {
      name,
      description,
      beats, // Array of beat definitions
      category,
      genre_hints,
      is_public
    } = req.body;

    // Validation
    if (!name || !beats || !Array.isArray(beats) || beats.length === 0) {
      return res.status(400).json({
        error: 'Name and beats array are required'
      });
    }

    // Generate slug from name
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Create template
    const { data: template, error } = await supabase
      .from('structure_templates')
      .insert([{
        name,
        description: description || null,
        slug: `${slug}-${Date.now()}`, // Add timestamp to ensure uniqueness
        beats,
        category: category || 'both',
        genre_hints: genre_hints || [],
        is_default: false,
        created_by: userId,
        is_public: is_public || false,
        usage_count: 0
      }])
      .select()
      .single();

    if (error) {
      console.error('❌ TEMPLATE CREATE ERROR:', error);
      return res.status(500).json({ error: 'Failed to create template' });
    }

    res.status(201).json(template);

  } catch (error) {
    console.error('❌ CREATE TEMPLATE ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// APPLY TEMPLATE TO PROJECT
// =============================================================================

/**
 * POST /api/projects/:projectId/apply-template
 * Apply a structure template to a project (creates beats from template)
 */
router.post(
  '/projects/:projectId/apply-template',
  requireAuth,
  extractUserId,
  async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const userId = req.userId;
      const { template_id, episode_id } = req.body;

      // Verify project ownership
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('id, name, project_type')
        .eq('id', projectId)
        .eq('user_id', userId)
        .eq('deleted', false)
        .single();

      if (projectError || !project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // If episode_id provided, verify it
      if (episode_id) {
        const { data: episode, error: episodeError } = await supabase
          .from('episodes')
          .select('id')
          .eq('id', episode_id)
          .eq('project_id', projectId)
          .single();

        if (episodeError || !episode) {
          return res.status(404).json({ error: 'Episode not found' });
        }
      }

      // Get template
      const { data: template, error: templateError } = await supabase
        .from('structure_templates')
        .select('*')
        .eq('id', template_id)
        .or(`is_default.eq.true,created_by.eq.${userId}`)
        .single();

      if (templateError || !template) {
        return res.status(404).json({ error: 'Template not found' });
      }

      // Create beats from template
      const templateBeats = template.beats as any[];
      const beatsToCreate = templateBeats.map((beatDef: any, index: number) => ({
        project_id: projectId,
        episode_id: episode_id || null,
        title: beatDef.title,
        description: beatDef.description || '',
        order: index,
        act: beatDef.act || 'act1',
        beat_type: beatDef.beat_type || 'custom',
        color: '#3b82f6', // Default blue
        page_estimate: 2, // Default estimate
        template_id: template_id,
        ai_generated: false,
        conversion_status: 'not_converted'
      }));

      const { data: createdBeats, error: createError } = await supabase
        .from('beats')
        .insert(beatsToCreate)
        .select();

      if (createError) {
        console.error('❌ BEATS CREATE ERROR:', createError);
        return res.status(500).json({ error: 'Failed to create beats from template' });
      }

      // Increment template usage count
      await supabase
        .from('structure_templates')
        .update({ usage_count: (template.usage_count || 0) + 1 })
        .eq('id', template_id);

      res.status(201).json({
        message: 'Template applied successfully',
        beats: createdBeats,
        template: template
      });

    } catch (error) {
      console.error('❌ APPLY TEMPLATE ERROR:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// =============================================================================
// UPDATE CUSTOM TEMPLATE
// =============================================================================

/**
 * PATCH /api/structure-templates/:templateId
 * Update a custom template (only user's own templates)
 */
router.patch('/structure-templates/:templateId', requireAuth, extractUserId, async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const userId = req.userId;
    const updates = req.body;

    // Verify template ownership (can't edit default templates)
    const { data: template, error: templateError } = await supabase
      .from('structure_templates')
      .select('*')
      .eq('id', templateId)
      .eq('created_by', userId)
      .single();

    if (templateError || !template) {
      return res.status(404).json({ error: 'Template not found or not editable' });
    }

    // Only allow specific fields
    const allowedFields = ['name', 'description', 'beats', 'category', 'genre_hints', 'is_public'];
    const updateData: any = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateData[field] = updates[field];
      }
    }

    const { data: updatedTemplate, error: updateError } = await supabase
      .from('structure_templates')
      .update(updateData)
      .eq('id', templateId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ TEMPLATE UPDATE ERROR:', updateError);
      return res.status(500).json({ error: 'Failed to update template' });
    }

    res.json(updatedTemplate);

  } catch (error) {
    console.error('❌ UPDATE TEMPLATE ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================================================
// DELETE CUSTOM TEMPLATE
// =============================================================================

/**
 * DELETE /api/structure-templates/:templateId
 * Delete a custom template (only user's own templates)
 */
router.delete('/structure-templates/:templateId', requireAuth, extractUserId, async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const userId = req.userId;

    // Verify template ownership (can't delete default templates)
    const { data: template, error: templateError } = await supabase
      .from('structure_templates')
      .select('id')
      .eq('id', templateId)
      .eq('created_by', userId)
      .single();

    if (templateError || !template) {
      return res.status(404).json({ error: 'Template not found or not deletable' });
    }

    const { error: deleteError } = await supabase
      .from('structure_templates')
      .delete()
      .eq('id', templateId);

    if (deleteError) {
      console.error('❌ TEMPLATE DELETE ERROR:', deleteError);
      return res.status(500).json({ error: 'Failed to delete template' });
    }

    res.json({ message: 'Template deleted successfully' });

  } catch (error) {
    console.error('❌ DELETE TEMPLATE ERROR:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
