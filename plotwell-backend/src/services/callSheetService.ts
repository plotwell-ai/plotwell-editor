/**
 * CallSheetService
 * Generates formatted call sheets from production data
 */

import { createClient } from '@supabase/supabase-js';
import { ScriptParsingService, SceneData } from './scriptParsingService';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface CallSheet {
  date: string;
  shootDay: number;
  project: {
    id: string;
    title: string;
  };
  scenes: Array<{
    sceneNumber: number;
    heading: string;
    location: string;
    intExt: string;
    timeOfDay: string;
    estimatedDuration: number;
    estimatedPages: number;
    callTime?: string;
    filmingLocation?: {
      id: string;
      name: string;
      address?: string;
      contact?: any;
    } | null;
  }>;
  cast: Array<{
    characterName: string;
    actorName?: string;
    scenes: number[];
    callTime?: string;
    contact?: any;
  }>;
  crew: Array<{
    role: string;
    department: string;
    name?: string;
    contact?: any;
  }>;
  location?: {
    name: string;
    address?: string;
    contact?: any;
  };
  summary: {
    totalScenes: number;
    totalCast: number;
    totalCrew: number;
    estimatedHours: number;
    earliestCall?: string;
    estimatedWrap?: string;
  };
}

class CallSheetService {
  /**
   * Generate call sheet for a specific date
   */
  async generateCallSheet(projectId: string, shootDate: string): Promise<CallSheet> {
    // Get project info
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, title')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      throw new Error('Project not found');
    }

    // Get day settings for call times
    const { data: daySettings } = await supabase
      .from('shooting_day_settings')
      .select('*')
      .eq('project_id', projectId)
      .eq('shoot_date', shootDate)
      .single();

    // Default settings if none exist
    const settings = daySettings || {
      general_call_time: '07:00',
      department_call_times: {},
      estimated_wrap_time: null
    };

    // Get all shooting days to calculate the correct shootDay number
    const shootingDays = await this.getShootingDays(projectId);
    const shootDayIndex = shootingDays.findIndex(d => d.date === shootDate);
    const calculatedShootDay = shootDayIndex >= 0 ? shootDayIndex + 1 : 1;

    // Get scenes for this date with script info
    const { data: sceneData, error: scenesError } = await supabase
      .from('production_scene_data')
      .select(`
        *,
        script:scripts(id, content)
      `)
      .eq('project_id', projectId)
      .eq('shoot_date', shootDate)
      .order('shoot_order');

    if (scenesError) {
      console.error('Error fetching scenes:', scenesError);
      throw scenesError;
    }

    if (!sceneData || sceneData.length === 0) {
      throw new Error('No scenes scheduled for this date');
    }

    // Use the UUID primary key (id), not scene_id (content hash)
    const sceneUuids = sceneData.map(s => s.id);

    // Get cast for these scenes from production_cast_scenes junction table
    const { data: castData, error: castError } = await supabase
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
      .eq('project_id', projectId)
      .in('scene_id', sceneUuids);

    if (castError) {
      console.error('Error fetching cast:', castError);
    }

    // If no explicit cast-scene assignments, auto-link by character name
    let effectiveCastData = castData || [];
    if (effectiveCastData.length === 0) {
      // Get all cast members for the project
      const { data: allCast } = await supabase
        .from('production_cast')
        .select('id, character_name, actor_name, actor_contact, rate_per_day')
        .eq('project_id', projectId);

      if (allCast && allCast.length > 0) {
        // Parse script to get characters for each scene
        const scriptContent = sceneData[0]?.script?.content;
        if (scriptContent) {
          const parsedScenes = ScriptParsingService.parseScriptContent(scriptContent);

          // Build a map of scene numbers to their characters
          const sceneCharactersMap = new Map<number, string[]>();
          for (const scene of parsedScenes) {
            sceneCharactersMap.set(scene.scene_number, scene.characters || []);
          }

          // Auto-link cast to scenes based on character name matching
          for (const scene of sceneData) {
            const sceneCharacters = sceneCharactersMap.get(scene.scene_number) || [];

            for (const castMember of allCast) {
              // Case-insensitive character name matching
              const castCharName = castMember.character_name?.toUpperCase() || '';
              const isInScene = sceneCharacters.some(char =>
                char.toUpperCase() === castCharName
              );

              if (isInScene) {
                effectiveCastData.push({
                  cast_id: castMember.id,
                  scene_id: scene.id,
                  project_id: projectId,
                  cast: castMember,
                  call_time: null
                });
              }
            }
          }
        }
      }
    }

    // Get crew assigned to this shoot date
    const { data: crewDaysData, error: crewError } = await supabase
      .from('production_crew_days')
      .select(`
        *,
        crew:production_crew(
          id,
          name,
          role,
          department,
          contact,
          rate_per_day
        )
      `)
      .eq('project_id', projectId)
      .eq('shoot_date', shootDate);

    if (crewError) {
      console.error('Error fetching crew:', crewError);
    }

    // If no explicit crew-day assignments, show ALL crew members (typical for small productions)
    let crewData = crewDaysData || [];
    if (crewData.length === 0) {
      const { data: allCrew } = await supabase
        .from('production_crew')
        .select('id, name, role, department, contact, rate_per_day')
        .eq('project_id', projectId);

      if (allCrew && allCrew.length > 0) {
        // Wrap in the same format as crew_days join
        crewData = allCrew.map(crew => ({
          crew_id: crew.id,
          shoot_date: shootDate,
          call_time: null,
          crew: crew
        }));
      }
    }

    // Get production locations for scenes
    // First, collect all unique production_location_ids from scenes
    const productionLocationIds = [...new Set(
      sceneData
        .filter(s => s.production_location_id)
        .map(s => s.production_location_id)
    )];

    // Fetch production locations by ID if any scenes have them assigned
    let productionLocationsMap: Map<string, any> = new Map();
    if (productionLocationIds.length > 0) {
      const { data: prodLocs } = await supabase
        .from('production_locations')
        .select('*')
        .in('id', productionLocationIds);

      if (prodLocs) {
        for (const loc of prodLocs) {
          productionLocationsMap.set(loc.id, loc);
        }
      }
    }

    // Get primary location for the call sheet header:
    // 1. Use the first scene's production_location_id if set
    // 2. Fall back to text-based location matching
    let locationInfo = null;
    if (sceneData[0]?.production_location_id && productionLocationsMap.has(sceneData[0].production_location_id)) {
      locationInfo = productionLocationsMap.get(sceneData[0].production_location_id);
    } else if (sceneData[0]?.location) {
      // Fallback: text-based location matching
      const { data: loc } = await supabase
        .from('production_locations')
        .select('*')
        .eq('project_id', projectId)
        .ilike('name', `%${sceneData[0].location}%`)
        .limit(1)
        .single();

      locationInfo = loc;
    }

    // Parse script to get scene headings
    const scriptContent = sceneData[0]?.script?.content;
    const parsedScriptScenes = scriptContent
      ? ScriptParsingService.parseScriptContent(scriptContent)
      : [];

    // Parse scenes with script data and production locations
    const scenes = this.parseScenes(sceneData, parsedScriptScenes, productionLocationsMap);

    // Parse cast (uses effectiveCastData which includes auto-linked cast by character name)
    // Use 'cast' department call time or fall back to general call time
    const castCallTime = settings.department_call_times?.cast || settings.general_call_time;
    const cast = this.parseCast(effectiveCastData, sceneData, castCallTime);

    // Parse crew with department-specific call times
    const crew = this.parseCrew(crewData || [], settings);

    // Calculate summary with day settings
    const summary = this.calculateSummary(scenes, cast, crew, settings);

    return {
      date: shootDate,
      shootDay: calculatedShootDay,
      project: {
        id: project.id,
        title: project.title
      },
      scenes,
      cast,
      crew,
      location: locationInfo ? {
        name: locationInfo.name,
        address: locationInfo.address,
        contact: locationInfo.contact_info
      } : undefined,
      summary
    };
  }

  /**
   * Parse scene data from database, enriched with script scene info and production locations
   */
  private parseScenes(sceneData: any[], parsedScriptScenes: SceneData[], productionLocationsMap: Map<string, any>) {
    // Create a map of script scenes by scene number for quick lookup
    const scriptSceneMap = new Map<number, SceneData>();
    for (const scriptScene of parsedScriptScenes) {
      scriptSceneMap.set(scriptScene.scene_number, scriptScene);
    }

    return sceneData.map(scene => {
      // Find matching script scene by scene number
      const scriptScene = scriptSceneMap.get(scene.scene_number);

      // Get scene info from parsed script, or use defaults
      const heading = scriptScene?.heading || '';
      const location = scriptScene?.location || scene.location || '';
      const timeOfDay = scriptScene?.time_of_day || 'day';
      const intExt = scriptScene?.int_ext || 'INT';

      // Calculate estimated pages (default to 1 if not available)
      const pages = scriptScene?.estimated_pages || scene.estimated_pages || 1;

      // Duration in minutes: 1 page ≈ 1 minute of screen time
      // But shooting takes longer - rule of thumb: 1 page = 15-30 min of shooting
      // We'll use 20 minutes per page as a rough estimate
      const estimatedMinutes = Math.round(pages * 20);

      // Get filming location details if production_location_id is assigned
      let filmingLocation = null;
      if (scene.production_location_id && productionLocationsMap.has(scene.production_location_id)) {
        const prodLoc = productionLocationsMap.get(scene.production_location_id);
        filmingLocation = {
          id: prodLoc.id,
          name: prodLoc.name,
          address: prodLoc.address,
          contact: prodLoc.contact_info
        };
      }

      return {
        sceneNumber: scene.scene_number,
        heading,
        location,
        intExt,
        timeOfDay,
        estimatedDuration: estimatedMinutes / 60, // Still in hours for compatibility
        estimatedPages: pages,
        callTime: scene.call_time,
        filmingLocation // Full production location details if assigned
      };
    });
  }

  /**
   * Parse cast data, grouping by character
   * @param castData - Cast scene assignments
   * @param sceneData - Scene data for scene number lookup
   * @param defaultCallTime - Default call time from day settings (cast department or general)
   */
  private parseCast(castData: any[], sceneData: any[], defaultCallTime: string = '07:00') {
    const castMap = new Map();

    for (const castScene of castData) {
      const key = castScene.cast_id;
      const castInfo = castScene.cast; // Nested cast object from join

      if (!castMap.has(key)) {
        // Use individual call_time if set, otherwise use default from day settings
        const individualCallTime = castScene.call_time;
        castMap.set(key, {
          characterName: castInfo?.character_name || 'Unknown',
          actorName: castInfo?.actor_name || 'TBD',
          scenes: [],
          callTime: individualCallTime || defaultCallTime,
          contact: castInfo?.actor_contact
        });
      }

      // Add scene number - castScene.scene_id is the UUID (production_scene_data.id)
      const sceneNum = sceneData.find(s => s.id === castScene.scene_id)?.scene_number;
      if (sceneNum && !castMap.get(key).scenes.includes(sceneNum)) {
        castMap.get(key).scenes.push(sceneNum);
      }

      // Use earliest individual call time if multiple scenes have different times
      if (castScene.call_time && castScene.call_time < (castMap.get(key).callTime || '23:59')) {
        castMap.get(key).callTime = castScene.call_time;
      }
    }

    return Array.from(castMap.values()).sort((a, b) => a.characterName.localeCompare(b.characterName));
  }

  /**
   * Parse crew data from production_crew_days join
   * @param crewData - Crew day assignments
   * @param settings - Day settings with department call times
   */
  private parseCrew(crewData: any[], settings: any) {
    const crewMap = new Map();
    const departmentCallTimes = settings.department_call_times || {};
    const generalCallTime = settings.general_call_time || '07:00';

    for (const crewDay of crewData) {
      const crew = crewDay.crew; // Nested crew object from join
      if (!crew) continue;

      const department = (crew.department || 'general').toLowerCase();
      const key = `${department}-${crew.role}-${crew.name || 'unnamed'}`;

      if (!crewMap.has(key)) {
        // Priority: individual call_time > department call_time > general call_time
        const individualCallTime = crewDay.call_time;
        const deptCallTime = departmentCallTimes[department];
        const effectiveCallTime = individualCallTime || deptCallTime || generalCallTime;

        crewMap.set(key, {
          role: crew.role,
          department: crew.department || 'General',
          name: crew.name || null,
          contact: crew.contact,
          callTime: effectiveCallTime
        });
      }
    }

    return Array.from(crewMap.values()).sort((a, b) => {
      // Sort by department first, then role
      if (a.department !== b.department) {
        return (a.department || '').localeCompare(b.department || '');
      }
      return (a.role || '').localeCompare(b.role || '');
    });
  }

  /**
   * Format time to HH:MM (PostgreSQL TIME type returns HH:MM:SS)
   */
  private formatTime(time: string | null | undefined): string | null {
    if (!time) return null;
    // Handle HH:MM:SS format from PostgreSQL TIME type
    const parts = time.split(':');
    if (parts.length >= 2) {
      return `${parts[0]}:${parts[1]}`;
    }
    return time;
  }

  /**
   * Calculate summary statistics
   * @param settings - Day settings with general call time and estimated wrap
   */
  private calculateSummary(scenes: any[], cast: any[], crew: any[], settings: any) {
    const totalHours = scenes.reduce((sum, s) => sum + s.estimatedDuration, 0);

    // Use general call time from settings, or find earliest from cast/crew
    // Format to HH:MM (PostgreSQL TIME returns HH:MM:SS)
    const generalCallTime = this.formatTime(settings.general_call_time) || '07:00';

    // Collect all call times to find the true earliest
    const allCallTimes = [
      generalCallTime,
      ...cast.filter(c => c.callTime).map(c => this.formatTime(c.callTime)),
      ...crew.filter(c => c.callTime).map(c => this.formatTime(c.callTime))
    ].filter(Boolean) as string[];

    const earliestCall = allCallTimes.length > 0
      ? allCallTimes.sort()[0]
      : generalCallTime;

    // Use estimated wrap from settings if set, otherwise calculate
    // Format to HH:MM (PostgreSQL TIME returns HH:MM:SS)
    let estimatedWrap = this.formatTime(settings.estimated_wrap_time);
    if (!estimatedWrap && earliestCall) {
      const [hours, minutes] = earliestCall.split(':').map(Number);
      const wrapHour = hours + Math.floor(totalHours);
      const wrapMinute = minutes + Math.round((totalHours % 1) * 60);
      estimatedWrap = `${String(wrapHour).padStart(2, '0')}:${String(wrapMinute).padStart(2, '0')}`;
    }

    return {
      totalScenes: scenes.length,
      totalCast: cast.length,
      totalCrew: crew.length,
      estimatedHours: totalHours,
      earliestCall,
      estimatedWrap
    };
  }

  /**
   * Format call sheet as plain text (for PDF generation or email)
   */
  formatAsText(callSheet: CallSheet): string {
    const lines = [];

    lines.push('═══════════════════════════════════════════════════');
    lines.push(`              CALL SHEET - DAY ${callSheet.shootDay}`);
    lines.push('═══════════════════════════════════════════════════');
    lines.push('');
    lines.push(`PROJECT: ${callSheet.project.title}`);
    lines.push(`DATE: ${new Date(callSheet.date).toLocaleDateString()}`);
    lines.push('');

    if (callSheet.location) {
      lines.push('───────────────────────────────────────────────────');
      lines.push('LOCATION');
      lines.push('───────────────────────────────────────────────────');
      lines.push(`${callSheet.location.name}`);
      if (callSheet.location.address) {
        lines.push(`${callSheet.location.address}`);
      }
      lines.push('');
    }

    lines.push('───────────────────────────────────────────────────');
    lines.push('SCENES SHOOTING TODAY');
    lines.push('───────────────────────────────────────────────────');
    for (const scene of callSheet.scenes) {
      lines.push(`Scene ${scene.sceneNumber}: ${scene.intExt}. ${scene.location} - ${scene.timeOfDay.toUpperCase()}`);
      if (scene.heading) {
        lines.push(`  ${scene.heading}`);
      }
      // Show filming location if assigned (actual production location with address)
      if (scene.filmingLocation) {
        const locInfo = scene.filmingLocation.address
          ? `${scene.filmingLocation.name} - ${scene.filmingLocation.address}`
          : scene.filmingLocation.name;
        lines.push(`  Filming at: ${locInfo}`);
      }
      lines.push(`  Duration: ~${Math.round(scene.estimatedPages * 20)} min | Pages: ${scene.estimatedPages}`);
      lines.push('');
    }

    lines.push('───────────────────────────────────────────────────');
    lines.push('CAST CALL');
    lines.push('───────────────────────────────────────────────────');
    for (const member of callSheet.cast) {
      const callTime = member.callTime || callSheet.summary.earliestCall || 'TBD';
      lines.push(`${member.characterName.padEnd(30)} ${member.actorName.padEnd(20)} ${callTime}`);
      lines.push(`  Scenes: ${member.scenes.join(', ')}`);
      lines.push('');
    }

    lines.push('───────────────────────────────────────────────────');
    lines.push('CREW');
    lines.push('───────────────────────────────────────────────────');

    const deptMap = new Map();
    for (const member of callSheet.crew) {
      if (!deptMap.has(member.department)) {
        deptMap.set(member.department, []);
      }
      deptMap.get(member.department).push(member);
    }

    for (const [dept, members] of deptMap) {
      lines.push(`${dept}:`);
      for (const member of members) {
        lines.push(`  - ${member.role}${member.name ? ` (${member.name})` : ''}`);
      }
      lines.push('');
    }

    lines.push('───────────────────────────────────────────────────');
    lines.push('SUMMARY');
    lines.push('───────────────────────────────────────────────────');
    lines.push(`Total Scenes: ${callSheet.summary.totalScenes}`);
    lines.push(`Cast Members: ${callSheet.summary.totalCast}`);
    lines.push(`Crew Members: ${callSheet.summary.totalCrew}`);
    lines.push(`Estimated Hours: ${callSheet.summary.estimatedHours}h`);
    if (callSheet.summary.earliestCall) {
      lines.push(`First Call: ${callSheet.summary.earliestCall}`);
    }
    if (callSheet.summary.estimatedWrap) {
      lines.push(`Estimated Wrap: ${callSheet.summary.estimatedWrap}`);
    }
    lines.push('');
    lines.push('═══════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Get all scheduled shooting days for a project
   * Returns format: { date: string, shootDay: number, scenesCount: number }
   */
  async getShootingDays(projectId: string, episodeId?: string) {
    let query = supabase
      .from('production_scene_data')
      .select('shoot_date')
      .eq('project_id', projectId)
      .not('shoot_date', 'is', null)
      .order('shoot_date');

    if (episodeId) query = query.eq('episode_id', episodeId);

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching shooting days:', error);
      throw error;
    }

    // Group by date and count scenes per day
    const dateMap = new Map<string, number>();

    data?.forEach((item) => {
      const dateStr = item.shoot_date;
      if (dateMap.has(dateStr)) {
        dateMap.set(dateStr, dateMap.get(dateStr)! + 1);
      } else {
        dateMap.set(dateStr, 1);
      }
    });

    // Convert to array with sequential shoot day numbers (1, 2, 3...)
    const result: { date: string; shootDay: number; scenesCount: number }[] = [];
    let dayNumber = 1;

    // Map is ordered by insertion order, which follows the database order (by shoot_date)
    dateMap.forEach((count, dateStr) => {
      result.push({
        date: dateStr,
        shootDay: dayNumber,
        scenesCount: count
      });
      dayNumber++;
    });

    return result;
  }
}

export default new CallSheetService();
