/**
 * CastService
 * Manages cast members and their scene assignments
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface CastMember {
  id?: string;
  project_id: string;
  user_id: string;
  character_name: string;
  actor_name?: string;
  actor_contact?: any;
  category?: string;
  rate_per_day?: number; // in cents
  availability_dates?: string[];
  notes?: string;
}

interface CastSceneAssignment {
  cast_id: string;
  scene_id: string;
  call_time?: string;
  wrap_time?: string;
  has_dialogue?: boolean;
  is_background?: boolean;
  notes?: string;
}

class CastService {
  /**
   * Create a new cast member
   */
  async createCast(projectId: string, userId: string, data: Partial<CastMember> & { season_id?: string }) {
    const insertData: Record<string, any> = {
      project_id: projectId,
      user_id: userId,
      character_name: data.character_name,
      actor_name: data.actor_name || null,
      actor_contact: data.actor_contact || {},
      category: data.category || null,
      rate_per_day: data.rate_per_day || null,
      availability_dates: data.availability_dates || [],
      scenes: [], // Deprecated, but keep for backward compatibility
      notes: data.notes || null
    };

    if (data.season_id) {
      insertData.season_id = data.season_id;
    }

    const { data: cast, error } = await supabase
      .from('production_cast')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Error creating cast member:', error);
      throw error;
    }

    return cast;
  }

  /**
   * Get all cast members for a project
   */
  async getCast(projectId: string, seasonId?: string) {
    let query = supabase
      .from('production_cast')
      .select('*')
      .eq('project_id', projectId);

    if (seasonId) {
      query = query.eq('season_id', seasonId);
    } else {
      query = query.is('season_id', null);
    }

    const { data: cast, error } = await query.order('character_name');

    if (error) {
      console.error('Error fetching cast:', error);
      throw error;
    }

    return cast;
  }

  /**
   * Get a single cast member by ID
   */
  async getCastById(castId: string) {
    const { data: cast, error } = await supabase
      .from('production_cast')
      .select('*')
      .eq('id', castId)
      .single();

    if (error) {
      console.error('Error fetching cast member:', error);
      throw error;
    }

    return cast;
  }

  /**
   * Update a cast member
   * Note: Access control should be verified by the caller before invoking this method
   */
  async updateCast(castId: string, userId: string, updates: Partial<CastMember> & { season_id?: string | null }) {
    const updateData: Record<string, any> = {
      character_name: updates.character_name,
      actor_name: updates.actor_name,
      actor_contact: updates.actor_contact,
      category: updates.category,
      rate_per_day: updates.rate_per_day,
      availability_dates: updates.availability_dates,
      notes: updates.notes,
      updated_at: new Date().toISOString()
    };

    // Allow setting or clearing season_id
    if (updates.season_id !== undefined) {
      updateData.season_id = updates.season_id || null;
    }

    const { data: cast, error } = await supabase
      .from('production_cast')
      .update(updateData)
      .eq('id', castId)
      .select()
      .single();

    if (error) {
      console.error('Error updating cast member:', error);
      throw error;
    }

    return cast;
  }

  /**
   * Delete a cast member
   * Note: Access control should be verified by the caller before invoking this method
   */
  async deleteCast(castId: string, userId: string) {
    // Delete scene assignments first (CASCADE should handle this, but being explicit)
    await supabase
      .from('production_cast_scenes')
      .delete()
      .eq('cast_id', castId);

    // Delete cast member
    const { error } = await supabase
      .from('production_cast')
      .delete()
      .eq('id', castId);

    if (error) {
      console.error('Error deleting cast member:', error);
      throw error;
    }

    return { success: true };
  }

  /**
   * Assign cast member to scenes
   */
  async assignCastToScenes(
    projectId: string,
    userId: string,
    castId: string,
    sceneAssignments: CastSceneAssignment[]
  ) {
    // Remove existing assignments for these scenes
    const sceneIds = sceneAssignments.map(a => a.scene_id);
    await supabase
      .from('production_cast_scenes')
      .delete()
      .eq('cast_id', castId)
      .in('scene_id', sceneIds);

    // Insert new assignments
    const assignments = sceneAssignments.map(assignment => ({
      project_id: projectId,
      user_id: userId,
      cast_id: castId,
      scene_id: assignment.scene_id,
      call_time: assignment.call_time || null,
      wrap_time: assignment.wrap_time || null,
      has_dialogue: assignment.has_dialogue !== undefined ? assignment.has_dialogue : true,
      is_background: assignment.is_background !== undefined ? assignment.is_background : false,
      notes: assignment.notes || null
    }));

    const { data, error } = await supabase
      .from('production_cast_scenes')
      .insert(assignments)
      .select();

    if (error) {
      console.error('Error assigning cast to scenes:', error);
      throw error;
    }

    return data;
  }

  /**
   * Remove cast member from a scene
   * Note: Access control should be verified by the caller before invoking this method
   */
  async removeCastFromScene(castId: string, sceneId: string, userId: string) {
    const { error } = await supabase
      .from('production_cast_scenes')
      .delete()
      .eq('cast_id', castId)
      .eq('scene_id', sceneId);

    if (error) {
      console.error('Error removing cast from scene:', error);
      throw error;
    }

    return { success: true };
  }

  /**
   * Get cast for a specific scene
   */
  async getCastForScene(sceneId: string) {
    const { data: cast, error } = await supabase
      .from('production_cast_scenes')
      .select(`
        *,
        cast:production_cast(
          id,
          character_name,
          actor_name,
          actor_contact,
          rate_per_day
        )
      `)
      .eq('scene_id', sceneId)
      .order('has_dialogue', { ascending: false });

    if (error) {
      console.error('Error fetching cast for scene:', error);
      throw error;
    }

    return cast;
  }

  /**
   * Get scenes for a cast member
   */
  async getScenesForCast(castId: string) {
    const { data: scenes, error } = await supabase
      .from('production_cast_scenes')
      .select(`
        *,
        scene:production_scene_data!production_cast_scenes_scene_id_fkey(
          scene_number,
          scene_id,
          shoot_date,
          shoot_order,
          call_time,
          estimated_duration_hours
        )
      `)
      .eq('cast_id', castId)
      .order('scene.shoot_order');

    if (error) {
      console.error('Error fetching scenes for cast:', error);
      throw error;
    }

    return scenes;
  }

  /**
   * Bulk assign cast from characters database
   * Analyzes script and creates cast entries for all characters
   */
  async bulkCreateCastFromCharacters(projectId: string, userId: string) {
    // Get all characters for the project
    const { data: characters, error: charError } = await supabase
      .from('characters')
      .select('*')
      .eq('project_id', projectId);

    if (charError) {
      console.error('Error fetching characters:', charError);
      throw charError;
    }

    if (!characters || characters.length === 0) {
      return [];
    }

    // Batch-fetch all existing cast members for this project to avoid N+1 queries
    const { data: existingCast } = await supabase
      .from('production_cast')
      .select('character_name')
      .eq('project_id', projectId);

    const existingNames = new Set(
      (existingCast || []).map(c => c.character_name?.toUpperCase())
    );

    // Create cast members for each character (if they don't already exist)
    const castToCreate = characters
      .filter(character => !existingNames.has(character.name?.toUpperCase()))
      .map(character => ({
        project_id: projectId,
        user_id: userId,
        character_name: character.name,
        actor_name: null,
        actor_contact: {},
        category: character.character_type || 'minor',
        rate_per_day: null,
        availability_dates: [],
        scenes: [],
        notes: character.description || null
      }));

    if (castToCreate.length === 0) {
      return [];
    }

    const { data: newCast, error: insertError } = await supabase
      .from('production_cast')
      .insert(castToCreate)
      .select();

    if (insertError) {
      console.error('Error creating cast from characters:', insertError);
      throw insertError;
    }

    return newCast;
  }

  /**
   * Update call time for a cast member in a specific scene
   * Note: Access control should be verified by the caller before invoking this method
   */
  async updateCallTime(castId: string, sceneId: string, userId: string, callTime: string) {
    const { data, error } = await supabase
      .from('production_cast_scenes')
      .update({ call_time: callTime })
      .eq('cast_id', castId)
      .eq('scene_id', sceneId)
      .select()
      .single();

    if (error) {
      console.error('Error updating call time:', error);
      throw error;
    }

    return data;
  }
}

export default new CastService();
