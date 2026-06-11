/**
 * Script Import API Routes
 * Handles importing scripts from Final Draft (.fdx) and Fountain (.fountain) formats
 */

import express, { Request, Response } from 'express';
import { supabase } from '../config/database';

const router = express.Router();

interface ImportRequest {
  project_id: string;
  episode_id?: string;
  file_type: 'fdx' | 'fountain';
  title?: string;
  content: any; // TipTap JSON
  options: {
    import_characters: boolean;
    import_locations: boolean;
    target_script_id?: string;
  };
  metadata: {
    author?: string;
    draft_date?: string;
    characters: string[];
    locations: Array<{ name: string; type: 'interior' | 'exterior' | 'both' | 'unknown' }>;
    scene_count: number;
  };
}

/**
 * POST /api/scripts/import
 * Import a script from FDX or Fountain format
 */
router.post('/scripts/import', async (req: Request, res: Response) => {
  try {
    const userId = req.userId || req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      project_id,
      episode_id,
      file_type,
      title,
      content,
      options,
      metadata
    }: ImportRequest = req.body;

    // Validate file_type is an allowed value
    if (!file_type || !['fdx', 'fountain'].includes(file_type)) {
      return res.status(400).json({ error: 'Invalid file_type. Must be "fdx" or "fountain".' });
    }

    // Validate content exists and isn't absurdly large (50MB JSON limit already in server.ts, but check structure)
    if (!content || typeof content !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid content. Expected TipTap JSON object.' });
    }

    // Validate required fields
    if (!project_id) {
      return res.status(400).json({ error: 'Missing project_id.' });
    }

    // Validate ownership of project
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, user_id')
      .eq('id', project_id)
      .eq('user_id', userId)
      .single();

    if (projectError || !project) {
      console.error('❌ PROJECT NOT FOUND OR UNAUTHORIZED:', projectError);
      return res.status(403).json({ error: 'Project not found or unauthorized' });
    }

    let scriptId: string;

    // Replace existing script or create new one
    if (options.target_script_id) {
      // Replace existing script
      const { data: updatedScript, error: updateError } = await supabase
        .from('scripts')
        .update({
          title: title || 'Imported Script',
          content,
          updated_at: new Date().toISOString()
        })
        .eq('id', options.target_script_id)
        .eq('project_id', project_id)
        .select()
        .single();

      if (updateError) {
        console.error('❌ SCRIPT UPDATE ERROR:', updateError);
        return res.status(500).json({ error: 'Failed to update script' });
      }

      scriptId = updatedScript.id;

    } else {
      // Create new script
      const { data: newScript, error: createError } = await supabase
        .from('scripts')
        .insert([{
          project_id,
          episode_id: episode_id || null,
          title: title || 'Imported Script',
          content,
          is_ai_generated: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (createError) {
        console.error('❌ SCRIPT CREATE ERROR:', createError);
        return res.status(500).json({ error: 'Failed to create script' });
      }

      scriptId = newScript.id;
    }

    // NOTE: Character and location import has been removed
    // Users should extract these using AI after importing the script
    // This prevents duplicate issues and provides better accuracy

    // Return success response
    return res.json({
      script_id: scriptId,
      scenes_count: metadata.scene_count,
      pages_estimated: Math.ceil(metadata.scene_count * 2.2), // Rough estimate
      message: 'Script imported successfully. Use AI tools to extract characters and locations.'
    });

  } catch (error: any) {
    console.error('❌ IMPORT ERROR:', error);
    return res.status(500).json({ error: error.message || 'Import failed' });
  }
});

export default router;
