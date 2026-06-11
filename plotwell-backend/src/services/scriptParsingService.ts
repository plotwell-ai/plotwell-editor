import { createClient } from '@supabase/supabase-js';
import { ensureProsemirrorFormat } from '../utils/formatDetection';
import {
  isSceneHeadingText,
  parseSceneHeadingIdentity,
} from '../utils/locationIdentity';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Normalize character name by stripping ALL parenthetical extensions
 * Removes (V.O.), (O.S.), (CONT'D), (MORE), and any other (...) content
 * This ensures EDWARD, EDWARD (V.O.), and EDWARD (V.O.)(CONT'D) are all recognized as EDWARD
 */
function normalizeCharacterName(name: string): string {
  return name
    .replace(/\s*\([^)]*\)/g, '')  // Remove ALL parenthetical content: (anything)
    .trim()
    .toUpperCase();
}

export interface SceneData {
  scene_number: number;
  heading: string;
  location: string;
  time_of_day: 'day' | 'night' | 'dawn' | 'dusk';
  int_ext: 'INT' | 'EXT';
  action_content: string;
  characters: string[];
  dialogue_count: number;
  estimated_pages: number;
}

export interface StoryboardScene {
  scene_number: number;
  heading: string;
  description: string;
  characters: string[];
  location: string;
  time_of_day: 'day' | 'night' | 'dawn' | 'dusk';
}

export class ScriptParsingService {
  // =========================================================================
  // Page estimation constants — MUST match the plotwell-editor pagination plugin
  // Source of truth: plotwell-editor/src/plugins/pagination.ts  (CONTENT_H = 864px)
  //                  plotwell-editor/src/styles.css             (--pw-line-h: 16px)
  //
  // Page: US Letter at 96 dpi
  //   Total height:   11" = 1056px
  //   Top margin:      1" =   96px
  //   Bottom margin:   1" =   96px
  //   Content height:  9" =  864px  ← CONTENT_H in pagination.ts
  //
  // Typography: 12pt Courier Prime/New = 16px, line-height: 16px (1×, single-spaced)
  //   → 6 lines/inch  (96px/in ÷ 16px/line)
  //   → 54 lines/page (864px ÷ 16px/line)
  //
  // NOTE: screenplay.css sets `.screenplay-editor.ProseMirror { line-height: 1.5 }`
  // but that class is never applied to the plotwell-editor DOM — the editor's own
  // styles.css (--pw-line-h: 16px) is what takes effect.
  // =========================================================================
  private static readonly LINES_PER_PAGE = 54;

  // Characters per line per element type (Courier 12pt ≈ 10 chars/inch)
  // Content area = 6.0" (8.5" page - 1.5" left margin - 1.0" right margin)
  private static readonly ACTION_CHARS_PER_LINE = 60;        // 6.0" × 10 = 60 chars
  private static readonly DIALOGUE_CHARS_PER_LINE = 40;      // (6.0" - 1" left - 1" right) × 10 = 40 chars
  private static readonly PARENTHETICAL_CHARS_PER_LINE = 30; // (6.0" - 1.5" left - 1.5" right) × 10 = 30 chars

  // CSS vertical spacing in em (1 em = 1 line)
  // These match screenplay.css exactly
  private static readonly SPACING = {
    sceneHeadingTop: 3,          // margin-top: 3em (subsequent scenes)
    sceneHeadingFirstTop: 0,     // first scene: margin-top: 0
    sceneHeadingBottom: 1,       // margin-bottom: 1em
    actionTop: 1,                // margin-top: 1em
    actionAfterHeadingTop: 0,    // scene-heading + action: margin-top: 0
    actionBottom: 1,             // margin-bottom: 1em
    characterTop: 0.5,           // margin-top: 0.5em
    characterBottom: 0,          // margin-bottom: 0
    dialogueTop: 0,              // margin-top: 0
    dialogueBottom: 0,           // margin-bottom: 0
    parentheticalTop: 0,         // margin-top: 0
    parentheticalBottom: 0,      // margin-bottom: 0
    transitionTop: 1,            // margin-top: 1em
    transitionBottom: 1,         // margin-bottom: 1em
  };

  /**
   * Count wrapped text lines at a given column width.
   */
  private static wrapLines(text: string, charsPerLine: number): number {
    if (!text || text.length === 0) return 0;
    return Math.ceil(text.length / charsPerLine);
  }

  /**
   * CSS margin collapse: spacing between two adjacent elements = max(prevBottom, currTop).
   */
  private static collapsedMargin(prevBottom: number, currTop: number): number {
    return Math.max(prevBottom, currTop);
  }

  // Valid ProseMirror screenplay node types
  private static readonly SCREENPLAY_NODE_TYPES = new Set([
    'sceneHeading', 'action', 'character', 'dialogue', 'parenthetical', 'transition'
  ]);

  static parseScriptContent(scriptContent: any): SceneData[] {
    // Ensure content is in ProseMirror format (converts legacy TipTap if needed)
    scriptContent = ensureProsemirrorFormat(scriptContent);

    if (!scriptContent || !scriptContent.content || !Array.isArray(scriptContent.content)) {
      return [];
    }

    const scenes: SceneData[] = [];
    let currentScene: Partial<SceneData> & { _lines?: number; _prevType?: string; _prevBottom?: number } | null = null;
    let sceneNumber = 1;
    let isFirstScene = true;

    for (const node of scriptContent.content) {
      // Skip nodes that are not known screenplay types
      if (!this.SCREENPLAY_NODE_TYPES.has(node.type)) continue;

      // Get text content (empty nodes count as blank lines)
      const text = node.content
        ? node.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('')
        : '';

      const nodeType = node.type;

      // Scene heading detection
      if (nodeType === 'sceneHeading' || (text && this.isSceneHeading(text))) {
        // Save previous scene if exists
        if (currentScene && currentScene.heading) {
          scenes.push(this.completeScene(currentScene, sceneNumber - 1));
        }

        // Start new scene
        currentScene = this.parseSceneHeading(text);
        currentScene.scene_number = sceneNumber++;
        currentScene.action_content = '';
        currentScene.characters = [];
        currentScene.dialogue_count = 0;

        // Scene heading: collapsed margin before + 1 text line
        // First scene has 0 top margin, subsequent scenes have 3em
        const topMargin = isFirstScene ? this.SPACING.sceneHeadingFirstTop : this.SPACING.sceneHeadingTop;
        currentScene._lines = topMargin + 1; // text line
        currentScene._prevType = 'sceneHeading';
        currentScene._prevBottom = this.SPACING.sceneHeadingBottom;
        isFirstScene = false;
      }

      // Action/description content
      else if (nodeType === 'action' && currentScene) {
        currentScene.action_content = (currentScene.action_content || '') + text + '\n\n';
        const topMargin = currentScene._prevType === 'sceneHeading'
          ? this.SPACING.actionAfterHeadingTop
          : this.SPACING.actionTop;
        const spacing = this.collapsedMargin(currentScene._prevBottom || 0, topMargin);
        const textLines = this.wrapLines(text, this.ACTION_CHARS_PER_LINE);
        currentScene._lines = (currentScene._lines || 0) + spacing + textLines;
        currentScene._prevType = 'action';
        currentScene._prevBottom = this.SPACING.actionBottom;
      }

      // Character names
      else if (nodeType === 'character' && currentScene) {
        const character = normalizeCharacterName(text);
        if (character && !currentScene.characters!.includes(character)) {
          currentScene.characters!.push(character);
        }
        currentScene.action_content = (currentScene.action_content || '') + text.toUpperCase() + '\n';
        const spacing = this.collapsedMargin(currentScene._prevBottom || 0, this.SPACING.characterTop);
        currentScene._lines = (currentScene._lines || 0) + spacing + 1; // always 1 text line
        currentScene._prevType = 'character';
        currentScene._prevBottom = this.SPACING.characterBottom;
      }

      // Parenthetical
      else if (nodeType === 'parenthetical' && currentScene) {
        currentScene.action_content = (currentScene.action_content || '') + `(${text})\n`;
        const spacing = this.collapsedMargin(currentScene._prevBottom || 0, this.SPACING.parentheticalTop);
        const textLines = this.wrapLines(text, this.PARENTHETICAL_CHARS_PER_LINE);
        currentScene._lines = (currentScene._lines || 0) + spacing + textLines;
        currentScene._prevType = 'parenthetical';
        currentScene._prevBottom = this.SPACING.parentheticalBottom;
      }

      // Dialogue
      else if (nodeType === 'dialogue' && currentScene) {
        currentScene.dialogue_count = (currentScene.dialogue_count || 0) + 1;
        currentScene.action_content = (currentScene.action_content || '') + text + '\n\n';
        const spacing = this.collapsedMargin(currentScene._prevBottom || 0, this.SPACING.dialogueTop);
        const textLines = this.wrapLines(text, this.DIALOGUE_CHARS_PER_LINE);
        currentScene._lines = (currentScene._lines || 0) + spacing + textLines;
        currentScene._prevType = 'dialogue';
        currentScene._prevBottom = this.SPACING.dialogueBottom;
      }

      // Transition
      else if (nodeType === 'transition' && currentScene) {
        currentScene.action_content = (currentScene.action_content || '') + text.toUpperCase() + '\n\n';
        const spacing = this.collapsedMargin(currentScene._prevBottom || 0, this.SPACING.transitionTop);
        const textLines = this.wrapLines(text, this.ACTION_CHARS_PER_LINE);
        currentScene._lines = (currentScene._lines || 0) + spacing + textLines;
        currentScene._prevType = 'transition';
        currentScene._prevBottom = this.SPACING.transitionBottom;
      }
    }

    // Add the last scene
    if (currentScene && currentScene.heading) {
      scenes.push(this.completeScene(currentScene, sceneNumber - 1));
    }

    return scenes;
  }

  /**
   * Check if text looks like a scene heading
   */
  private static isSceneHeading(text: string): boolean {
    return isSceneHeadingText(text);
  }

  /**
   * Parse scene heading to extract location and time
   */
  private static parseSceneHeading(heading: string): Partial<SceneData> {
    const trimmed = heading.trim();
    const parsed = parseSceneHeadingIdentity(trimmed);

    return {
      heading: trimmed,
      location: parsed?.location || 'UNKNOWN LOCATION',
      time_of_day: parsed?.timeOfDay || 'day',
      int_ext: parsed?.intExt || 'INT',
    };
  }

  /**
   * Complete scene data with calculated fields
   */
  private static completeScene(scene: Partial<SceneData> & { _lines?: number; _prevType?: string; _prevBottom?: number }, sceneNumber: number): SceneData {
    // Convert line count to pages (54 lines per page, matching ProseMirror pagination)
    const lines = scene._lines || 0;
    const estimatedPages = lines / this.LINES_PER_PAGE;

    return {
      scene_number: scene.scene_number || sceneNumber,
      heading: scene.heading || '',
      location: scene.location || '',
      time_of_day: scene.time_of_day || 'day',
      int_ext: scene.int_ext || 'INT',
      action_content: (scene.action_content || '').trim(),
      characters: scene.characters || [],
      dialogue_count: scene.dialogue_count || 0,
      estimated_pages: Math.round(estimatedPages * 8) / 8 // Round to nearest 1/8
    };
  }

  /**
   * Get script content from database and parse it
   * Returns null if no script is found
   *
   * @param projectId - The project ID
   * @param userId - The user ID
   * @param scriptId - Optional specific script ID to use
   * @param episodeId - Optional episode ID for TV series (looks up episode's script)
   */
  static async parseScriptFromProject(projectId: string, userId: string, scriptId?: string, episodeId?: string): Promise<{
    scenes: SceneData[];
    storyboardScenes: StoryboardScene[];
    scriptTitle: string;
    scriptId: string;
  } | null> {
    try {
      let script;

      if (scriptId) {
        // Use the specified script ID
        const { data: scriptData, error } = await supabase
          .from('scripts')
          .select('id, title, content, scenes')
          .eq('id', scriptId)
          .eq('project_id', projectId)
          .single();

        if (error) throw error;
        if (!scriptData) throw new Error('Script not found');
        script = scriptData;
      } else if (episodeId) {
        // For TV series: look up the episode's script
        const { data: episode, error: episodeError } = await supabase
          .from('episodes')
          .select('script_id')
          .eq('id', episodeId)
          .eq('project_id', projectId)
          .single();

        if (episodeError) {
          console.error('Error fetching episode:', episodeError);
          return null;
        }

        if (!episode?.script_id) {
          // Episode has no script yet - return null (valid state for new episodes)
          return null;
        }

        const { data: scriptData, error: scriptError } = await supabase
          .from('scripts')
          .select('id, title, content, scenes')
          .eq('id', episode.script_id)
          .single();

        if (scriptError) {
          console.error('Error fetching episode script:', scriptError);
          return null;
        }

        script = scriptData;
      } else {
        // Fall back to production script (prod_script_id) or latest script
        const { data: project, error: projectError } = await supabase
          .from('projects')
          .select('prod_script_id, active_script_id')
          .eq('id', projectId)
          .single();

        if (projectError) throw projectError;

        let scriptQuery = supabase
          .from('scripts')
          .select('id, title, content, scenes')
          .eq('project_id', projectId);

        // Prioritize: active_script_id > prod_script_id > latest
        if (project?.active_script_id) {
          scriptQuery = scriptQuery.eq('id', project.active_script_id);
        } else if (project?.prod_script_id) {
          // Use the production script
          scriptQuery = scriptQuery.eq('id', project.prod_script_id);
        } else {
          // Fall back to latest script
          scriptQuery = scriptQuery.order('created_at', { ascending: false }).limit(1);
        }

        const { data: scripts, error } = await scriptQuery;

        if (error) throw error;

        if (!scripts || (Array.isArray(scripts) && scripts.length === 0)) {
          // No script found - return null instead of throwing error
          return null;
        }

        script = Array.isArray(scripts) ? scripts[0] : scripts;
      }

      // Always parse from ProseMirror content for accurate page estimation.
      // The scenes cache may have stale estimated_pages from an older formula.
      let scenes: SceneData[] = this.parseScriptContent(script.content);

      // Update cache with fresh parse results
      await this.cacheScenesInScript(script.id, scenes);

      // Normalize character names and deduplicate
      scenes = scenes.map(scene => ({
        ...scene,
        characters: [...new Set(scene.characters.map((char: string) => normalizeCharacterName(char)))]
      }));

      // Convert scenes to storyboard format
      const storyboardScenes: StoryboardScene[] = scenes.map(scene => ({
        scene_number: scene.scene_number,
        heading: scene.heading,
        description: scene.action_content,
        characters: scene.characters,
        location: scene.location,
        time_of_day: scene.time_of_day
      }));

      return {
        scenes,
        storyboardScenes,
        scriptTitle: script.title,
        scriptId: script.id
      };

    } catch (error) {
      console.error('Error parsing script:', error);
      throw error;
    }
  }

  /**
   * Cache parsed scenes in the scripts table for faster future access
   */
  static async cacheScenesInScript(scriptId: string, scenes: SceneData[]): Promise<void> {
    try {
      const { error } = await supabase
        .from('scripts')
        .update({
          scenes: scenes,
          updated_at: new Date().toISOString()
        })
        .eq('id', scriptId);

      if (error) {
        console.error('Error caching scenes:', error);
        // Don't throw - this is just a performance optimization
      }
    } catch (error) {
      console.error('Error caching scenes:', error);
      // Don't throw - this is just a performance optimization
    }
  }

  /**
   * Invalidate cached scenes when script content changes
   * Call this whenever a script is updated
   */
  static async invalidateSceneCache(scriptId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('scripts')
        .update({
          scenes: null,
          scene_version_hash: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', scriptId);

      if (error) {
        console.error('Error invalidating scene cache:', error);
      }
    } catch (error) {
      console.error('Error invalidating scene cache:', error);
    }
  }

  /**
   * Import scenes to production scene cards
   */
  static async importScenestoProduction(
    projectId: string,
    userId: string,
    scenes: SceneData[],
    clearExisting: boolean = false
  ) {
    try {
      let skippedCount = 0;
      
      // If clearExisting is true, delete existing scenes first
      if (clearExisting) {
        const { error: deleteError } = await supabase
          .from('scene_cards')
          .delete()
          .eq('project_id', projectId)
          .eq('user_id', userId);

        if (deleteError) {
          console.error('Error clearing existing scenes:', deleteError);
          throw deleteError;
        }
      } else {
        // If not clearing, check what scene numbers already exist
        const { data: existingScenes, error: checkError } = await supabase
          .from('scene_cards')
          .select('scene_number')
          .eq('project_id', projectId)
          .eq('user_id', userId);

        if (checkError) {
          console.error('Error checking existing scenes:', checkError);
          throw checkError;
        }

        const existingNumbers = new Set(existingScenes?.map(s => s.scene_number) || []);
        const originalScenesCount = scenes.length;
        
        // Filter out scenes that would conflict
        scenes = scenes.filter(scene => !existingNumbers.has(scene.scene_number));
        
        skippedCount = originalScenesCount - scenes.length;
        
        // If no scenes to import after filtering
        if (scenes.length === 0) {
          return {
            sceneCards: [],
            importedCount: 0,
            skippedCount
          };
        }
      }

      const sceneCardsToInsert = scenes.map(scene => {
        return {
          project_id: projectId,
          user_id: userId,
          scene_number: scene.scene_number,
          heading: scene.heading,
          location: scene.location,
          time_of_day: scene.time_of_day,
          complexity: 'medium' as const, // Default complexity
          characters: scene.characters,
          estimated_shoot_days: 1, // Default 1 day
          budget: 0, // No budget estimation
          notes: `Imported from script. ${scene.dialogue_count} dialogue exchanges.`
        };
      });

      const { data, error } = await supabase
        .from('scene_cards')
        .insert(sceneCardsToInsert)
        .select();

      if (error) throw error;
      
      return {
        sceneCards: data || [],
        importedCount: data?.length || 0,
        skippedCount
      };

    } catch (error) {
      console.error('Error importing scenes to production:', error);
      throw error;
    }
  }

  /**
   * Import scenes to storyboard
   */
  static async importScenesToStoryboard(
    projectId: string,
    userId: string,
    storyboardScenes: StoryboardScene[]
  ) {
    try {
      // Create storyboard scenes array for the storyboard format
      const storyboardData = {
        scenes: storyboardScenes.map(scene => ({
          id: `scene-${scene.scene_number}`,
          sceneNumber: scene.scene_number,
          title: scene.heading,
          description: scene.description,
          characters: scene.characters,
          location: scene.location,
          timeOfDay: scene.time_of_day,
          imageUrl: null,
          notes: ''
        }))
      };

      const { data, error } = await supabase
        .from('storyboards')
        .insert({
          project_id: projectId,
          title: 'Imported from Script',
          scenes: storyboardData.scenes,
          is_ai_generated: false
        })
        .select()
        .single();

      if (error) throw error;
      return data;

    } catch (error) {
      console.error('Error importing scenes to storyboard:', error);
      throw error;
    }
  }
}

// Export commonly used functions for direct import
export const parseScriptFromProject = ScriptParsingService.parseScriptFromProject.bind(ScriptParsingService);
export const parseScriptContent = ScriptParsingService.parseScriptContent.bind(ScriptParsingService);
export const invalidateSceneCache = ScriptParsingService.invalidateSceneCache.bind(ScriptParsingService);
