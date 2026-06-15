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

export default router;
