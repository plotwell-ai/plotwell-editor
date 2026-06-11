/**
 * ScheduleService
 * Manages shooting schedule and AI-powered optimization
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface SceneSchedule {
  scene_id: string;
  scene_number: number;
  shoot_date?: string;
  shoot_day?: number;
  shoot_order?: number;
}

interface OptimizationOptions {
  prioritize?: 'minimize_days' | 'group_location' | 'cast_availability';
  startDate?: string;
  constraints?: {
    maxShootDays?: number;
    unavailableDates?: string[];
    preferredLocations?: string[];
  };
}

class ScheduleService {
  /**
   * Get shooting schedule for a project
   */
  async getSchedule(projectId: string) {
    const { data: scenes, error } = await supabase
      .from('production_scene_data')
      .select(`
        id,
        scene_id,
        scene_number,
        shoot_date,
        shoot_day,
        shoot_order,
        call_time,
        estimated_duration_hours,
        complexity,
        estimated_shoot_days,
        status,
        script_id
      `)
      .eq('project_id', projectId)
      .neq('status', 'archived')
      .order('shoot_order', { ascending: true, nullsFirst: false })
      .order('scene_number', { ascending: true });

    if (error) {
      console.error('Error fetching schedule:', error);
      throw error;
    }

    return scenes;
  }

  /**
   * Assign a scene to a shoot date
   */
  async assignSceneToDate(sceneId: string, shootDate: string, shootDay?: number) {
    const { data, error } = await supabase
      .from('production_scene_data')
      .update({
        shoot_date: shootDate,
        shoot_day: shootDay || null,
        updated_at: new Date().toISOString()
      })
      .eq('scene_id', sceneId)
      .select()
      .single();

    if (error) {
      console.error('Error assigning scene to date:', error);
      throw error;
    }

    return data;
  }

  /**
   * Bulk update scene order and day assignments
   */
  async reorderScenes(projectId: string, userId: string, sceneOrder: { scene_id?: string; sceneId?: string; shoot_order?: number; shootOrder?: number; shoot_day?: number | null; shootDay?: number | null; shoot_date?: string | null; shootDate?: string | null }[]) {
    // Normalize field names (accept both camelCase and snake_case)
    const normalized = sceneOrder.map(item => ({
      scene_id: item.scene_id || item.sceneId,
      shoot_order: item.shoot_order ?? item.shootOrder ?? 0,
      shoot_day: item.shoot_day !== undefined ? item.shoot_day : (item.shootDay !== undefined ? item.shootDay : undefined),
      shoot_date: item.shoot_date !== undefined ? item.shoot_date : (item.shootDate !== undefined ? item.shootDate : undefined),
    }));

    // Update each scene's shoot_order, shoot_day, and shoot_date
    const updates = normalized.map(({ scene_id, shoot_order, shoot_day, shoot_date }) => {
      const updateData: Record<string, any> = { shoot_order };
      if (shoot_day !== undefined) {
        updateData.shoot_day = shoot_day;
      }
      if (shoot_date !== undefined) {
        updateData.shoot_date = shoot_date;
      }
      return supabase
        .from('production_scene_data')
        .update(updateData)
        .eq('scene_id', scene_id)
        .eq('project_id', projectId);
    });

    const results = await Promise.all(updates);

    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
      console.error('Errors reordering scenes:', errors);
      throw errors[0].error;
    }

    return { success: true, updated: sceneOrder.length };
  }

  /**
   * AI-powered schedule optimization
   */
  async optimizeSchedule(projectId: string, userId: string, options: OptimizationOptions = {}) {
    // 1. Get all scenes with full context
    const { data: scenes, error: scenesError } = await supabase
      .from('production_scene_data')
      .select(`
        *,
        cast:production_cast_scenes(
          cast:production_cast(character_name)
        )
      `)
      .eq('project_id', projectId)
      .neq('status', 'archived')
      .order('scene_number');

    if (scenesError || !scenes) {
      console.error('Error fetching scenes:', scenesError);
      throw scenesError;
    }

    // 2. Get script content for scene details
    const scriptIds = [...new Set(scenes.map(s => s.script_id))];
    const { data: scripts } = await supabase
      .from('scripts')
      .select('id, content')
      .in('id', scriptIds);

    // Parse script content to get scene details (heading, location, time of day)
    const sceneDetails = this.parseSceneDetails(scenes, scripts || []);

    // 3. Build AI optimization prompt
    const prompt = this.buildOptimizationPrompt(sceneDetails, options);

    // 4. Call AI
    const completion = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a professional assistant director specializing in shooting schedule optimization. Return only valid JSON.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const aiResult = JSON.parse(completion.choices[0].message.content || '{}');

    // 5. Apply the optimized schedule
    const startDate = options.startDate ? new Date(options.startDate) : new Date();
    const appliedSchedule = await this.applySchedule(
      projectId,
      userId,
      aiResult.schedule || [],
      startDate
    );

    return {
      success: true,
      totalShootDays: aiResult.totalShootDays || aiResult.schedule?.length || 0,
      reasoning: aiResult.reasoning || '',
      schedule: appliedSchedule
    };
  }

  /**
   * Apply AI-generated schedule to database
   */
  private async applySchedule(
    projectId: string,
    userId: string,
    schedule: Array<{ day: number; sceneIds: string[]; location?: string }>,
    startDate: Date
  ) {
    const updates = [];

    for (const daySchedule of schedule) {
      const shootDate = new Date(startDate);
      shootDate.setDate(shootDate.getDate() + daySchedule.day - 1);
      const shootDateStr = shootDate.toISOString().split('T')[0];

      for (let i = 0; i < daySchedule.sceneIds.length; i++) {
        const sceneId = daySchedule.sceneIds[i];
        updates.push(
          supabase
            .from('production_scene_data')
            .update({
              shoot_date: shootDateStr,
              shoot_day: daySchedule.day,
              shoot_order: (daySchedule.day - 1) * 100 + i // e.g., Day 1 = 0-99, Day 2 = 100-199
            })
            .eq('scene_id', sceneId)
            .eq('project_id', projectId)
        );
      }
    }

    await Promise.all(updates);

    return schedule;
  }

  /**
   * Parse scene details from script content
   */
  private parseSceneDetails(scenes: any[], scripts: any[]) {
    const scriptMap = new Map(scripts.map(s => [s.id, s.content]));

    return scenes.map(scene => {
      const script = scriptMap.get(scene.script_id);
      let heading = '';
      let location = '';
      let timeOfDay = 'day';
      let intExt = 'INT';

      // Try to parse from script if available
      if (script && typeof script === 'object' && script.content) {
        // TipTap format - look for scene heading
        const content = script.content;
        if (content.content) {
          const nodes = content.content;
          // Find scene heading node for this scene
          const sceneNode = nodes.find((node: any) =>
            node.type === 'sceneHeading' &&
            node.attrs?.sceneNumber === scene.scene_number
          );

          if (sceneNode && sceneNode.attrs) {
            heading = sceneNode.attrs.text || '';
            location = sceneNode.attrs.location || '';
            timeOfDay = sceneNode.attrs.timeOfDay || 'day';
            intExt = sceneNode.attrs.intExt || 'INT';
          }
        }
      }

      return {
        scene_id: scene.scene_id,
        scene_number: scene.scene_number,
        heading,
        location,
        timeOfDay,
        intExt,
        characters: scene.cast?.map((c: any) => c.cast?.character_name).filter(Boolean) || [],
        complexity: scene.complexity,
        estimatedShootDays: scene.estimated_shoot_days,
        estimatedPages: scene.estimated_pages || 1
      };
    });
  }

  /**
   * Build AI optimization prompt
   */
  private buildOptimizationPrompt(scenes: any[], options: OptimizationOptions) {
    const prioritize = options.prioritize || 'minimize_days';
    const constraints = options.constraints || {};

    return `
Optimize this shooting schedule for a film production.

**SCENES (${scenes.length} total):**
${scenes.map(s => `
Scene ${s.scene_number}: ${s.heading || 'No heading'}
- Location: ${s.location || 'Unknown'}
- Time: ${s.timeOfDay || 'day'}
- Int/Ext: ${s.intExt || 'INT'}
- Characters: ${s.characters.join(', ') || 'None'}
- Complexity: ${s.complexity}
- Estimated Days: ${s.estimatedShootDays}
- Scene ID: ${s.scene_id}
`).join('\n')}

**OPTIMIZATION PRIORITY:** ${prioritize}

${prioritize === 'minimize_days' ? `
Primary Goal: Minimize total shooting days
- Group scenes by location to reduce setup/teardown time
- Group scenes by time of day (day/night) to avoid multiple lighting setups per day
- Consider cast availability (minimize days each actor is needed)
` : prioritize === 'group_location' ? `
Primary Goal: Group scenes by location
- All scenes at the same location should shoot together
- Within each location, group by time of day
- Minimize location changes
` : `
Primary Goal: Optimize for cast availability
- Minimize the number of days each actor needs to be on set
- Group scenes with the same characters
- Reduce overall cast costs
`}

${constraints.maxShootDays ? `**Constraint:** Must complete in ${constraints.maxShootDays} days or less` : ''}
${constraints.unavailableDates?.length ? `**Unavailable Dates:** ${constraints.unavailableDates.join(', ')}` : ''}

**OUTPUT FORMAT (JSON):**
{
  "schedule": [
    {
      "day": 1,
      "sceneIds": ["scene_id_1", "scene_id_2"],
      "location": "Coffee Shop",
      "reasoning": "All coffee shop scenes, all daytime"
    },
    {
      "day": 2,
      "sceneIds": ["scene_id_3", "scene_id_4"],
      "location": "Park",
      "reasoning": "All park scenes, grouped by location"
    }
  ],
  "totalShootDays": 2,
  "reasoning": "Grouped all scenes by location first, then by time of day. This minimizes setup time and reduces overall shooting days from X to Y."
}

**IMPORTANT:**
- Use the exact scene_id values provided
- Return valid JSON only
- Ensure every scene is scheduled
- Days should be sequential (1, 2, 3, ...)
`.trim();
  }

  /**
   * Get daily breakdown (for call sheets)
   */
  async getDailyBreakdown(projectId: string, shootDate: string) {
    const { data: scenes, error } = await supabase
      .from('production_scene_data')
      .select(`
        *,
        cast:production_cast_scenes(
          *,
          cast:production_cast(
            character_name,
            actor_name,
            actor_contact
          )
        )
      `)
      .eq('project_id', projectId)
      .eq('shoot_date', shootDate)
      .order('shoot_order');

    if (error) {
      console.error('Error fetching daily breakdown:', error);
      throw error;
    }

    return scenes;
  }

  /**
   * Clear all schedule data (reset)
   */
  async clearSchedule(projectId: string, userId: string) {
    const { error } = await supabase
      .from('production_scene_data')
      .update({
        shoot_date: null,
        shoot_day: null,
        shoot_order: null
      })
      .eq('project_id', projectId);

    if (error) {
      console.error('Error clearing schedule:', error);
      throw error;
    }

    return { success: true };
  }
}

export default new ScheduleService();
