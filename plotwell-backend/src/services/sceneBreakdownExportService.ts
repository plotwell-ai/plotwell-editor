/**
 * SceneBreakdownExportService
 * Exports scene breakdowns and Day Out of Days reports to HTML (for PDF)
 */

import { createClient } from '@supabase/supabase-js';
import { canonicalizeCharacterName } from '../utils/characterIdentity';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// =====================================================
// TYPES
// =====================================================

export interface SceneBreakdownData {
  id: string | null;
  sceneId: string;
  sceneNumber: number;
  heading: string;
  intExt: 'INT' | 'EXT';
  location: string;
  timeOfDay: string;
  synopsis: string;
  characters: string[];
  complexity: 'simple' | 'medium' | 'complex';
  estimatedShootDays: number;
  budgetEstimate: number;
  estimatedPages: number;
  productionNotes: string;
  shots: any[];
  shootDate: string | null;
  shootOrder: number | null;
}

export interface DOODEntry {
  characterName: string;
  shootDays: Record<string, 'SW' | 'W' | 'WF' | 'SWF' | 'H' | 'R' | ''>;
  totalDays: number;
  firstDay: string | null;
  lastDay: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  title: string | null;
  author: string | null;
  projectType: string;
}

export interface EpisodeInfo {
  id: string;
  title: string;
  episodeNumber: number;
}

// =====================================================
// COMPLEXITY LABELS & COLORS
// =====================================================

const COMPLEXITY_LABELS: Record<string, string> = {
  simple: 'Simple',
  medium: 'Medium',
  complex: 'Complex'
};

const COMPLEXITY_COLORS: Record<string, string> = {
  simple: '#22c55e',   // green
  medium: '#f59e0b',   // amber
  complex: '#ef4444'   // red
};

const TIME_OF_DAY_LABELS: Record<string, string> = {
  day: 'DAY',
  night: 'NIGHT',
  dawn: 'DAWN',
  dusk: 'DUSK'
};

// =====================================================
// EXPORT SERVICE
// =====================================================

export class SceneBreakdownExportService {

  /**
   * Get scene breakdown data with project info
   */
  static async getBreakdownData(projectId: string, episodeId?: string): Promise<{
    project: ProjectInfo;
    scenes: SceneBreakdownData[];
    episode: EpisodeInfo | null;
  }> {
    // Get project info
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name, title, author, project_type')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      throw new Error('Project not found');
    }

    // Get production scene data
    let query = supabase
      .from('production_scene_data')
      .select('*')
      .eq('project_id', projectId)
      .order('scene_number', { ascending: true });

    if (episodeId) {
      query = query.eq('episode_id', episodeId);
    }

    const { data: productionScenes, error: scenesError } = await query;

    if (scenesError) {
      throw new Error('Failed to fetch scene data');
    }

    // Get script scenes for synopsis/action content (and as fallback)
    let scriptsQuery = supabase
      .from('scripts')
      .select('id, scenes')
      .eq('project_id', projectId);

    if (episodeId) {
      scriptsQuery = scriptsQuery.eq('episode_id', episodeId);
    }

    const { data: scripts } = await scriptsQuery;

    // Build scene lookup from scripts
    const scriptSceneMap = new Map<number, any>();
    const allScriptScenes: any[] = [];
    if (scripts) {
      for (const script of scripts) {
        if (script.scenes && Array.isArray(script.scenes)) {
          for (const scene of script.scenes) {
            if (scene.number) {
              scriptSceneMap.set(scene.number, scene);
              allScriptScenes.push(scene);
            }
          }
        }
      }
    }

    let scenes: SceneBreakdownData[];

    // If we have production data, use it and merge with script data
    if (productionScenes && productionScenes.length > 0) {
      scenes = productionScenes.map((ps: any) => {
        const scriptScene = scriptSceneMap.get(ps.scene_number);

        return {
          id: ps.id,
          sceneId: ps.scene_id,
          sceneNumber: ps.scene_number,
          heading: scriptScene?.heading || ps.location || `Scene ${ps.scene_number}`,
          intExt: scriptScene?.int_ext || 'INT',
          location: ps.location || scriptScene?.location || '',
          timeOfDay: scriptScene?.time_of_day || 'day',
          synopsis: scriptScene?.action_content?.substring(0, 300) || '',
          characters: [...new Set(((scriptScene?.characters || []) as string[]).map(canonicalizeCharacterName).filter(Boolean))],
          complexity: ps.complexity || 'medium',
          estimatedShootDays: ps.estimated_shoot_days || 0,
          budgetEstimate: ps.budget_estimate || 0,
          estimatedPages: ps.estimated_pages || scriptScene?.page_count || 0,
          productionNotes: ps.production_notes || '',
          shots: ps.shots || [],
          shootDate: ps.shoot_date,
          shootOrder: ps.shoot_order
        };
      });
    } else {
      // Fallback: Use script scenes directly if no production data exists
      scenes = allScriptScenes
        .sort((a, b) => (a.number || 0) - (b.number || 0))
        .map((scene: any) => ({
          id: null,
          sceneId: scene.id || `scene-${scene.number}`,
          sceneNumber: scene.number || 0,
          heading: scene.heading || `Scene ${scene.number}`,
          intExt: scene.int_ext || scene.intExt || 'INT',
          location: scene.location || '',
          timeOfDay: scene.time_of_day || scene.timeOfDay || 'day',
          synopsis: scene.action_content?.substring(0, 300) || scene.content?.substring(0, 300) || '',
          characters: [...new Set(((scene.characters || []) as string[]).map(canonicalizeCharacterName).filter(Boolean))],
          complexity: 'medium' as const,
          estimatedShootDays: 0,
          budgetEstimate: 0,
          estimatedPages: scene.page_count || scene.pageCount || 0,
          productionNotes: '',
          shots: [],
          shootDate: null,
          shootOrder: null
        }));
    }

    // Get episode info if applicable
    let episode: EpisodeInfo | null = null;
    if (episodeId) {
      const { data: ep } = await supabase
        .from('episodes')
        .select('id, title, episode_number')
        .eq('id', episodeId)
        .single();

      if (ep) {
        episode = {
          id: ep.id,
          title: ep.title,
          episodeNumber: ep.episode_number
        };
      }
    }

    return {
      project: {
        id: project.id,
        name: project.name,
        title: project.title,
        author: project.author,
        projectType: project.project_type
      },
      scenes,
      episode
    };
  }

  /**
   * Export breakdown sheets to HTML (for PDF)
   */
  static async exportBreakdownToHTML(projectId: string, episodeId?: string): Promise<string> {
    const { project, scenes, episode } = await this.getBreakdownData(projectId, episodeId);

    const projectTitle = project.title || project.name;
    const generatedDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Scene Breakdown - ${this.escapeHTML(projectTitle)}</title>
  <style>
    * {
      box-sizing: border-box;
    }

    @page {
      size: letter portrait;
      margin: 0.5in;
    }

    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      margin: 0;
      padding: 20px;
      color: #1e293b;
      line-height: 1.4;
      font-size: 11px;
    }

    /* Plotwell Branding Header */
    .plotwell-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .plotwell-logo {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .plotwell-logo-icon {
      width: 32px;
      height: 32px;
      background: #f59e0b;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .plotwell-logo-icon svg {
      width: 20px;
      height: 20px;
    }
    .plotwell-logo-text {
      font-size: 20px;
      font-weight: 700;
      color: white;
      letter-spacing: -0.5px;
    }
    .plotwell-logo-text span {
      color: #f59e0b;
    }
    .header-doc-type {
      color: #94a3b8;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Title Page */
    .title-page {
      text-align: center;
      padding: 60px 40px;
      page-break-after: always;
    }

    .title-page h1 {
      font-size: 32px;
      margin-bottom: 10px;
      color: #0f172a;
    }

    .title-page .subtitle {
      font-size: 24px;
      color: #475569;
      margin-bottom: 30px;
    }

    .title-page .meta {
      display: inline-block;
      text-align: left;
      font-size: 14px;
      color: #64748b;
      margin-top: 40px;
      padding: 20px 30px;
      background: #fef3c7;
      border-radius: 8px;
      border-left: 4px solid #f59e0b;
    }

    .title-page .meta p {
      margin: 8px 0;
    }

    .title-page .meta strong {
      color: #92400e;
    }

    /* Plotwell Footer */
    .plotwell-footer {
      margin-top: 30px;
      padding-top: 15px;
      border-top: 2px solid #f59e0b;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: #64748b;
    }
    .footer-brand {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .footer-logo {
      width: 16px;
      height: 16px;
      background: #f59e0b;
      border-radius: 3px;
    }
    .footer-text {
      font-weight: 600;
      color: #475569;
    }

    .breakdown-sheet {
      page-break-after: always;
      border: 2px solid #1e293b;
      padding: 0;
      margin-bottom: 20px;
      border-radius: 8px;
      overflow: hidden;
    }

    .breakdown-sheet:last-child {
      page-break-after: auto;
    }

    .sheet-header {
      background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
      color: white;
      padding: 12px 15px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .sheet-header .project-title {
      font-weight: bold;
      font-size: 14px;
    }

    .sheet-header .scene-number {
      font-size: 18px;
      font-weight: bold;
      background: #f59e0b;
      padding: 4px 12px;
      border-radius: 4px;
    }

    .scene-info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid #e2e8f0;
    }

    .scene-info-item {
      padding: 8px 15px;
      border-right: 1px solid #e2e8f0;
    }

    .scene-info-item:last-child {
      border-right: none;
    }

    .scene-info-label {
      font-size: 9px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .scene-info-value {
      font-size: 12px;
      font-weight: 600;
      color: #1e293b;
      margin-top: 2px;
    }

    .scene-heading {
      background: #fef3c7;
      padding: 10px 15px;
      font-weight: bold;
      font-size: 13px;
      border-bottom: 1px solid #e2e8f0;
      color: #92400e;
    }

    .section {
      border-bottom: 1px solid #e2e8f0;
    }

    .section:last-child {
      border-bottom: none;
    }

    .section-header {
      background: #f8fafc;
      padding: 6px 15px;
      font-weight: bold;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #475569;
      border-bottom: 1px solid #e2e8f0;
    }

    .section-content {
      padding: 10px 15px;
    }

    .cast-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }

    .cast-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .cast-list li {
      color: #dc2626;
      font-weight: 600;
      padding: 3px 0;
      font-size: 11px;
    }

    .cast-list li::before {
      content: "\\2022";
      margin-right: 8px;
    }

    .estimates-box {
      background: #fef3c7;
      padding: 10px;
      border-radius: 4px;
      border-left: 3px solid #f59e0b;
    }

    .estimate-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      font-size: 11px;
    }

    .estimate-label {
      color: #92400e;
    }

    .estimate-value {
      font-weight: bold;
      color: #1e293b;
    }

    .synopsis-text {
      font-size: 11px;
      color: #475569;
      line-height: 1.5;
    }

    .shots-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }

    .shot-item {
      background: #f1f5f9;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 10px;
    }

    .shot-number {
      font-weight: bold;
      color: #1e293b;
    }

    .shot-desc {
      color: #64748b;
    }

    .notes-text {
      font-size: 11px;
      color: #475569;
      font-style: italic;
      line-height: 1.5;
    }

    .complexity-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      color: white;
    }

    .no-data {
      color: #94a3b8;
      font-style: italic;
    }

    @media print {
      body { padding: 0; }
      .breakdown-sheet { break-after: page; }
      .breakdown-sheet:last-child { break-after: auto; }
    }
  </style>
</head>
<body>
  <!-- Plotwell Branded Header -->
  <div class="plotwell-header">
    <div class="plotwell-logo">
      <div class="plotwell-logo-icon">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="white"/>
          <path d="M2 17L12 22L22 17" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 12L12 17L22 12" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span class="plotwell-logo-text">Plot<span>well</span></span>
    </div>
    <span class="header-doc-type">Scene Breakdown</span>
  </div>

  <!-- Title Page -->
  <div class="title-page">
    <h1>Scene Breakdown</h1>
    <div class="subtitle">${this.escapeHTML(projectTitle)}</div>
    ${episode ? `<p style="font-size: 16px; color: #64748b;">Episode ${episode.episodeNumber}: ${this.escapeHTML(episode.title)}</p>` : ''}
    <div class="meta">
      ${project.author ? `<p><strong>Author:</strong> ${this.escapeHTML(project.author)}</p>` : ''}
      <p><strong>Total Scenes:</strong> ${scenes.length}</p>
      <p><strong>Total Shoot Days:</strong> ${scenes.reduce((sum, s) => sum + (s.estimatedShootDays || 0), 0).toFixed(1)}</p>
      <p><strong>Total Budget:</strong> $${scenes.reduce((sum, s) => sum + (s.budgetEstimate || 0), 0).toLocaleString()}</p>
      <p><strong>Generated:</strong> ${generatedDate}</p>
    </div>
  </div>
`;

    // Generate breakdown sheet for each scene
    for (const scene of scenes) {
      html += this.generateBreakdownSheet(scene, projectTitle, episode);
    }

    // Plotwell Footer
    html += `
  <div class="plotwell-footer">
    <div class="footer-brand">
      <div class="footer-logo"></div>
      <span class="footer-text">Generated with Plotwell</span>
    </div>
    <span>${generatedDate}</span>
  </div>
</body>
</html>`;

    return html;
  }

  /**
   * Generate HTML for a single breakdown sheet
   */
  private static generateBreakdownSheet(
    scene: SceneBreakdownData,
    projectTitle: string,
    episode: EpisodeInfo | null
  ): string {
    const complexityColor = COMPLEXITY_COLORS[scene.complexity] || '#64748b';
    const complexityLabel = COMPLEXITY_LABELS[scene.complexity] || scene.complexity;
    const timeOfDayLabel = TIME_OF_DAY_LABELS[scene.timeOfDay] || scene.timeOfDay.toUpperCase();

    return `
  <!-- Scene ${scene.sceneNumber} -->
  <div class="breakdown-sheet">
    <div class="sheet-header">
      <span class="project-title">${this.escapeHTML(projectTitle)}${episode ? ` - Ep ${episode.episodeNumber}` : ''}</span>
      <span class="scene-number">Scene #${scene.sceneNumber}</span>
    </div>

    <div class="scene-info">
      <div class="scene-info-item">
        <div class="scene-info-label">INT/EXT</div>
        <div class="scene-info-value">${scene.intExt}</div>
      </div>
      <div class="scene-info-item">
        <div class="scene-info-label">Location</div>
        <div class="scene-info-value">${this.escapeHTML(scene.location) || '<span class="no-data">Not set</span>'}</div>
      </div>
      <div class="scene-info-item">
        <div class="scene-info-label">Time of Day</div>
        <div class="scene-info-value">${timeOfDayLabel}</div>
      </div>
      <div class="scene-info-item">
        <div class="scene-info-label">Complexity</div>
        <div class="scene-info-value">
          <span class="complexity-badge" style="background: ${complexityColor}">${complexityLabel}</span>
        </div>
      </div>
    </div>

    <div class="scene-heading">${this.escapeHTML(scene.heading)}</div>

    <div class="section">
      <div class="section-header">Synopsis</div>
      <div class="section-content">
        <p class="synopsis-text">${scene.synopsis ? this.escapeHTML(scene.synopsis) : '<span class="no-data">No synopsis available</span>'}</p>
      </div>
    </div>

    <div class="section">
      <div class="section-header">Cast & Estimates</div>
      <div class="section-content">
        <div class="cast-grid">
          <div>
            <ul class="cast-list">
              ${scene.characters.length > 0
                ? scene.characters.map(c => `<li>${this.escapeHTML(c)}</li>`).join('\n              ')
                : '<li class="no-data" style="color: #94a3b8;">No characters listed</li>'
              }
            </ul>
          </div>
          <div>
            <div class="estimates-box">
              <div class="estimate-row">
                <span class="estimate-label">Shoot Days:</span>
                <span class="estimate-value">${scene.estimatedShootDays || 0}</span>
              </div>
              <div class="estimate-row">
                <span class="estimate-label">Budget:</span>
                <span class="estimate-value">$${(scene.budgetEstimate || 0).toLocaleString()}</span>
              </div>
              <div class="estimate-row">
                <span class="estimate-label">Pages:</span>
                <span class="estimate-value">${scene.estimatedPages || 0}</span>
              </div>
              ${scene.shootDate ? `
              <div class="estimate-row">
                <span class="estimate-label">Shoot Date:</span>
                <span class="estimate-value">${new Date(scene.shootDate).toLocaleDateString()}</span>
              </div>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>

    ${scene.shots && scene.shots.length > 0 ? `
    <div class="section">
      <div class="section-header">Shots (${scene.shots.length})</div>
      <div class="section-content">
        <div class="shots-grid">
          ${scene.shots.slice(0, 9).map((shot: any, i: number) => `
          <div class="shot-item">
            <span class="shot-number">${i + 1}.</span>
            <span class="shot-desc">${this.escapeHTML(shot.description || shot.shot_type || 'Shot')}</span>
          </div>
          `).join('')}
          ${scene.shots.length > 9 ? `<div class="shot-item"><span class="shot-desc">+${scene.shots.length - 9} more</span></div>` : ''}
        </div>
      </div>
    </div>
    ` : ''}

    <div class="section">
      <div class="section-header">Production Notes</div>
      <div class="section-content">
        <p class="notes-text">${scene.productionNotes ? this.escapeHTML(scene.productionNotes) : '<span class="no-data">No notes</span>'}</p>
      </div>
    </div>
  </div>
`;
  }

  /**
   * Export Day Out of Days to HTML (for PDF)
   */
  static async exportDayOutOfDaysToHTML(projectId: string, episodeId?: string): Promise<string> {
    const { project, scenes, episode } = await this.getBreakdownData(projectId, episodeId);

    const projectTitle = project.title || project.name;
    const generatedDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Build shoot days from scenes
    const shootDays = new Set<string>();
    const characterScenes = new Map<string, Set<string>>();

    for (const scene of scenes) {
      if (scene.shootDate) {
        shootDays.add(scene.shootDate);

        for (const character of scene.characters) {
          if (!characterScenes.has(character)) {
            characterScenes.set(character, new Set());
          }
          characterScenes.get(character)!.add(scene.shootDate);
        }
      }
    }

    // Sort shoot days
    const sortedDays = Array.from(shootDays).sort();

    // Build DOOD entries
    const doodEntries: DOODEntry[] = [];

    for (const [character, days] of characterScenes) {
      const sortedCharDays = Array.from(days).sort();
      const firstDay = sortedCharDays[0];
      const lastDay = sortedCharDays[sortedCharDays.length - 1];

      const shootDaysMap: Record<string, 'SW' | 'W' | 'WF' | 'SWF' | 'H' | 'R' | ''> = {};

      for (const day of sortedDays) {
        if (days.has(day)) {
          if (sortedCharDays.length === 1) {
            shootDaysMap[day] = 'SWF';
          } else if (day === firstDay) {
            shootDaysMap[day] = 'SW';
          } else if (day === lastDay) {
            shootDaysMap[day] = 'WF';
          } else {
            shootDaysMap[day] = 'W';
          }
        } else {
          shootDaysMap[day] = '';
        }
      }

      doodEntries.push({
        characterName: character,
        shootDays: shootDaysMap,
        totalDays: days.size,
        firstDay,
        lastDay
      });
    }

    // Sort by total days descending
    doodEntries.sort((a, b) => b.totalDays - a.totalDays);

    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Day Out of Days - ${this.escapeHTML(projectTitle)}</title>
  <style>
    * {
      box-sizing: border-box;
    }

    @page {
      size: letter landscape;
      margin: 0.5in;
    }

    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      margin: 0;
      padding: 20px;
      color: #1e293b;
      font-size: 10px;
    }

    /* Plotwell Branding Header */
    .plotwell-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .plotwell-logo {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .plotwell-logo-icon {
      width: 32px;
      height: 32px;
      background: #f59e0b;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .plotwell-logo-icon svg {
      width: 20px;
      height: 20px;
    }
    .plotwell-logo-text {
      font-size: 20px;
      font-weight: 700;
      color: white;
      letter-spacing: -0.5px;
    }
    .plotwell-logo-text span {
      color: #f59e0b;
    }
    .header-doc-type {
      color: #94a3b8;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .report-header {
      text-align: center;
      margin-bottom: 25px;
      padding-bottom: 20px;
      border-bottom: 2px solid #f59e0b;
    }

    .report-header h1 {
      font-size: 24px;
      margin: 0 0 5px 0;
      color: #0f172a;
    }

    .report-header .subtitle {
      font-size: 16px;
      color: #64748b;
      margin: 0;
    }

    .meta {
      display: flex;
      justify-content: center;
      gap: 30px;
      margin-top: 15px;
      font-size: 11px;
      color: #64748b;
    }

    .meta-item {
      background: #fef3c7;
      padding: 6px 12px;
      border-radius: 4px;
      border-left: 3px solid #f59e0b;
    }

    .meta-item strong {
      color: #92400e;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      border-radius: 8px;
      overflow: hidden;
      border: 2px solid #1e293b;
    }

    th, td {
      border: 1px solid #e2e8f0;
      padding: 6px 8px;
      text-align: center;
    }

    th {
      background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
      color: white;
      font-weight: 600;
      font-size: 9px;
    }

    th.character-col {
      text-align: left;
      width: 150px;
    }

    td.character-name {
      text-align: left;
      font-weight: 600;
      color: #dc2626;
    }

    tr:nth-child(even) {
      background: #f8fafc;
    }

    .day-col {
      width: 50px;
    }

    .total-col {
      width: 60px;
      background: #fef3c7 !important;
      font-weight: bold;
      color: #92400e;
    }

    .status-sw { background: #dcfce7 !important; color: #166534; font-weight: bold; }
    .status-w { background: #e0f2fe !important; color: #0369a1; }
    .status-wf { background: #fef3c7 !important; color: #a16207; font-weight: bold; }
    .status-swf { background: #f3e8ff !important; color: #7c3aed; font-weight: bold; }
    .status-h { background: #fee2e2 !important; color: #dc2626; }
    .status-r { background: #fef9c3 !important; color: #ca8a04; }

    .legend {
      margin-top: 20px;
      padding: 15px 20px;
      background: #f8fafc;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
    }

    .legend h3 {
      margin: 0 0 12px 0;
      font-size: 12px;
      color: #1e293b;
      border-bottom: 2px solid #f59e0b;
      padding-bottom: 8px;
      display: inline-block;
    }

    .legend-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 10px;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 10px;
    }

    .legend-badge {
      padding: 2px 8px;
      border-radius: 3px;
      font-weight: bold;
      font-size: 9px;
    }

    .no-data {
      text-align: center;
      padding: 40px;
      color: #64748b;
      font-style: italic;
      background: #fef3c7;
      border-radius: 8px;
      border: 1px dashed #f59e0b;
    }

    /* Plotwell Footer */
    .plotwell-footer {
      margin-top: 30px;
      padding-top: 15px;
      border-top: 2px solid #f59e0b;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: #64748b;
    }
    .footer-brand {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .footer-logo {
      width: 16px;
      height: 16px;
      background: #f59e0b;
      border-radius: 3px;
    }
    .footer-text {
      font-weight: 600;
      color: #475569;
    }

    @media print {
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <!-- Plotwell Branded Header -->
  <div class="plotwell-header">
    <div class="plotwell-logo">
      <div class="plotwell-logo-icon">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="white"/>
          <path d="M2 17L12 22L22 17" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 12L12 17L22 12" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <span class="plotwell-logo-text">Plot<span>well</span></span>
    </div>
    <span class="header-doc-type">Day Out of Days</span>
  </div>

  <div class="report-header">
    <h1>${this.escapeHTML(projectTitle)}</h1>
    ${episode ? `<p class="subtitle">Episode ${episode.episodeNumber}: ${this.escapeHTML(episode.title)}</p>` : ''}
    <div class="meta">
      <span class="meta-item"><strong>Characters:</strong> ${doodEntries.length}</span>
      <span class="meta-item"><strong>Shoot Days:</strong> ${sortedDays.length}</span>
      <span class="meta-item"><strong>Generated:</strong> ${generatedDate}</span>
    </div>
  </div>
`;

    if (sortedDays.length === 0 || doodEntries.length === 0) {
      html += `
  <div class="no-data">
    <p>No shoot dates have been scheduled yet.</p>
    <p>Assign shoot dates to scenes in the Production Planner to generate the Day Out of Days report.</p>
  </div>
`;
    } else {
      html += `
  <table>
    <thead>
      <tr>
        <th class="character-col">Character</th>
        ${sortedDays.map(day => {
          const date = new Date(day);
          return `<th class="day-col">${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</th>`;
        }).join('\n        ')}
        <th class="total-col">Total Days</th>
      </tr>
    </thead>
    <tbody>
      ${doodEntries.map(entry => `
      <tr>
        <td class="character-name">${this.escapeHTML(entry.characterName)}</td>
        ${sortedDays.map(day => {
          const status = entry.shootDays[day];
          const statusClass = status ? `status-${status.toLowerCase()}` : '';
          return `<td class="${statusClass}">${status}</td>`;
        }).join('\n        ')}
        <td class="total-col">${entry.totalDays}</td>
      </tr>
      `).join('')}
    </tbody>
  </table>

  <div class="legend">
    <h3>Legend</h3>
    <div class="legend-grid">
      <div class="legend-item">
        <span class="legend-badge status-sw">SW</span>
        <span>Start Work</span>
      </div>
      <div class="legend-item">
        <span class="legend-badge status-w">W</span>
        <span>Work</span>
      </div>
      <div class="legend-item">
        <span class="legend-badge status-wf">WF</span>
        <span>Work Finish</span>
      </div>
      <div class="legend-item">
        <span class="legend-badge status-swf">SWF</span>
        <span>Start-Work-Finish (Single Day)</span>
      </div>
      <div class="legend-item">
        <span class="legend-badge status-h">H</span>
        <span>Hold</span>
      </div>
      <div class="legend-item">
        <span class="legend-badge status-r">R</span>
        <span>Rehearsal</span>
      </div>
    </div>
  </div>
`;
    }

    // Plotwell Footer
    html += `
  <div class="plotwell-footer">
    <div class="footer-brand">
      <div class="footer-logo"></div>
      <span class="footer-text">Generated with Plotwell</span>
    </div>
    <span>${generatedDate}</span>
  </div>
</body>
</html>`;

    return html;
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  private static escapeHTML(str: string): string {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Get export filename
   */
  static getExportFilename(projectName: string, type: 'breakdown' | 'dood', episodeTitle?: string): string {
    const cleanName = projectName
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '_')
      .toLowerCase();

    const episodePart = episodeTitle
      ? `_${episodeTitle.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').toLowerCase()}`
      : '';

    const timestamp = new Date().toISOString().split('T')[0];
    const typeLabel = type === 'breakdown' ? 'scene_breakdown' : 'day_out_of_days';

    return `${cleanName}${episodePart}_${typeLabel}_${timestamp}.pdf`;
  }
}
