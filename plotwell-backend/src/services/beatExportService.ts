/**
 * BeatExportService
 * Exports beat sheets to various formats (PDF, DOCX, CSV)
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export interface Beat {
  id: string;
  project_id: string;
  episode_id?: string | null;
  title: string;
  description?: string;
  notes?: string;
  order: number;
  act: string;
  beat_type: string;
  color: string;
  page_estimate: number;
  duration_estimate?: number;
  conversion_status: string;
  ai_generated: boolean;
  ai_confidence?: number;
  created_at: string;
  updated_at: string;
}

export interface BeatExportOptions {
  includeNotes?: boolean;
  includePageEstimates?: boolean;
  includeActLabels?: boolean;
  groupByAct?: boolean;
}

const ACT_LABELS: Record<string, string> = {
  act1: 'Act 1',
  act2a: 'Act 2A',
  act2b: 'Act 2B',
  act3: 'Act 3',
  act4: 'Act 4',
  act5: 'Act 5',
  custom: 'Custom'
};

const BEAT_TYPE_LABELS: Record<string, string> = {
  setup: 'Setup',
  inciting_incident: 'Inciting Incident',
  midpoint: 'Midpoint',
  climax: 'Climax',
  resolution: 'Resolution',
  rising_action: 'Rising Action',
  turning_point: 'Turning Point',
  crisis: 'Crisis',
  custom: 'Custom'
};

export class BeatExportService {
  /**
   * Get beats for a project with project info
   */
  static async getBeatsWithProject(projectId: string, episodeId?: string) {
    // Get project info
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id, name, title, author, project_type')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      throw new Error('Project not found');
    }

    // Get beats
    let query = supabase
      .from('beats')
      .select('*')
      .eq('project_id', projectId)
      .order('order', { ascending: true });

    if (episodeId) {
      query = query.eq('episode_id', episodeId);
    }

    const { data: beats, error: beatsError } = await query;

    if (beatsError) {
      throw new Error('Failed to fetch beats');
    }

    // Get episode info if applicable
    let episode = null;
    if (episodeId) {
      const { data: ep } = await supabase
        .from('episodes')
        .select('id, title, episode_number')
        .eq('id', episodeId)
        .single();
      episode = ep;
    }

    return { project, beats: beats || [], episode };
  }

  /**
   * Export beats to CSV format
   */
  static async exportToCSV(projectId: string, episodeId?: string, options: BeatExportOptions = {}): Promise<string> {
    const { project, beats, episode } = await this.getBeatsWithProject(projectId, episodeId);

    // CSV header
    const headers = [
      'Order',
      'Title',
      'Act',
      'Beat Type',
      'Description',
      options.includePageEstimates !== false ? 'Page Estimate' : null,
      options.includeNotes !== false ? 'Notes' : null,
      'Status'
    ].filter(Boolean);

    const csvLines = [headers.join(',')];

    // CSV rows
    for (const beat of beats) {
      const row = [
        beat.order + 1,
        this.escapeCSV(beat.title),
        ACT_LABELS[beat.act] || beat.act,
        BEAT_TYPE_LABELS[beat.beat_type] || beat.beat_type,
        this.escapeCSV(beat.description || ''),
        options.includePageEstimates !== false ? beat.page_estimate : null,
        options.includeNotes !== false ? this.escapeCSV(beat.notes || '') : null,
        beat.conversion_status
      ].filter((_, i) => headers[i] !== null);

      csvLines.push(row.join(','));
    }

    return csvLines.join('\n');
  }

  /**
   * Export beats to plain text format (for DOCX conversion)
   */
  static async exportToText(projectId: string, episodeId?: string, options: BeatExportOptions = {}): Promise<string> {
    const { project, beats, episode } = await this.getBeatsWithProject(projectId, episodeId);

    const lines: string[] = [];

    // Title
    const projectTitle = project.title || project.name;
    lines.push('═══════════════════════════════════════════════════════════════════');
    lines.push(`                          BEAT SHEET`);
    lines.push('═══════════════════════════════════════════════════════════════════');
    lines.push('');
    lines.push(`Project: ${projectTitle}`);
    if (project.author) {
      lines.push(`Author: ${project.author}`);
    }
    if (episode) {
      lines.push(`Episode ${episode.episode_number}: ${episode.title}`);
    }
    lines.push(`Total Beats: ${beats.length}`);
    lines.push(`Total Pages: ${beats.reduce((sum, b) => sum + (b.page_estimate || 0), 0)}`);
    lines.push('');

    if (options.groupByAct !== false) {
      // Group by act
      const actGroups = this.groupBeatsByAct(beats);

      for (const [act, actBeats] of Object.entries(actGroups)) {
        if (actBeats.length === 0) continue;

        lines.push('───────────────────────────────────────────────────────────────────');
        lines.push(`                          ${ACT_LABELS[act] || act.toUpperCase()}`);
        lines.push('───────────────────────────────────────────────────────────────────');
        lines.push('');

        for (const beat of actBeats) {
          this.formatBeatForText(beat, lines, options);
        }
      }
    } else {
      // Linear order
      for (const beat of beats) {
        this.formatBeatForText(beat, lines, options);
      }
    }

    lines.push('═══════════════════════════════════════════════════════════════════');
    lines.push(`                           END OF BEAT SHEET`);
    lines.push('═══════════════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Export beats to DOCX-compatible format (simplified Word Document)
   */
  static async exportToDocx(projectId: string, episodeId?: string, options: BeatExportOptions = {}): Promise<Buffer> {
    const textContent = await this.exportToText(projectId, episodeId, options);
    return Buffer.from(textContent, 'utf-8');
  }

  /**
   * Export beats to HTML format (for PDF generation)
   */
  static async exportToHTML(projectId: string, episodeId?: string, options: BeatExportOptions = {}): Promise<string> {
    const { project, beats, episode } = await this.getBeatsWithProject(projectId, episodeId);

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
  <title>Beat Sheet - ${this.escapeHTML(projectTitle)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      color: #1e293b;
      line-height: 1.6;
      font-size: 12px;
    }

    /* Plotwell Branding Header */
    .plotwell-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
      border-radius: 8px;
      margin-bottom: 25px;
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
      fill: white;
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

    /* Title Section */
    .doc-title {
      text-align: center;
      margin-bottom: 25px;
    }
    .doc-title h1 {
      font-size: 26px;
      margin: 0 0 8px 0;
      color: #0f172a;
    }
    .doc-title .subtitle {
      font-size: 16px;
      color: #64748b;
      margin: 0;
    }

    /* Meta Info */
    .meta {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-bottom: 25px;
      padding: 15px;
      background: #fef3c7;
      border-radius: 8px;
      border-left: 4px solid #f59e0b;
    }
    .meta-item {
      font-size: 12px;
    }
    .meta-label {
      color: #92400e;
      font-weight: 600;
    }
    .meta-value {
      color: #1e293b;
    }

    /* Act Sections */
    .act-section {
      margin-bottom: 25px;
    }
    .act-header {
      font-size: 16px;
      font-weight: bold;
      padding: 10px 15px;
      background: #f59e0b;
      color: white;
      border-radius: 6px;
      margin-bottom: 12px;
    }

    /* Beat Cards */
    .beat-card {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px 15px;
      margin-bottom: 12px;
      page-break-inside: avoid;
      background: white;
    }
    .beat-card:hover {
      border-color: #f59e0b;
    }
    .beat-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .beat-title {
      font-size: 14px;
      font-weight: bold;
      color: #1e293b;
    }
    .beat-type {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      background: #fef3c7;
      color: #92400e;
    }
    .beat-description {
      font-size: 12px;
      color: #475569;
      margin-bottom: 6px;
    }
    .beat-notes {
      font-size: 11px;
      color: #64748b;
      font-style: italic;
      padding-top: 8px;
      border-top: 1px dashed #e2e8f0;
    }
    .page-estimate {
      font-size: 11px;
      color: #64748b;
    }

    /* Footer */
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
      body { padding: 15px; }
      .beat-card { break-inside: avoid; }
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
    <span class="header-doc-type">Beat Sheet</span>
  </div>

  <!-- Document Title -->
  <div class="doc-title">
    <h1>${this.escapeHTML(projectTitle)}</h1>
    ${episode ? `<p class="subtitle">Episode ${episode.episode_number}: ${this.escapeHTML(episode.title)}</p>` : ''}
  </div>

  <!-- Meta Information -->
  <div class="meta">
    ${project.author ? `<div class="meta-item"><span class="meta-label">Author:</span> <span class="meta-value">${this.escapeHTML(project.author)}</span></div>` : ''}
    <div class="meta-item"><span class="meta-label">Total Beats:</span> <span class="meta-value">${beats.length}</span></div>
    <div class="meta-item"><span class="meta-label">Est. Pages:</span> <span class="meta-value">${beats.reduce((sum, b) => sum + (b.page_estimate || 0), 0)}</span></div>
    <div class="meta-item"><span class="meta-label">Generated:</span> <span class="meta-value">${generatedDate}</span></div>
  </div>
`;

    if (options.groupByAct !== false) {
      const actGroups = this.groupBeatsByAct(beats);

      for (const [act, actBeats] of Object.entries(actGroups)) {
        if (actBeats.length === 0) continue;

        html += `
  <div class="act-section">
    <div class="act-header">${ACT_LABELS[act] || act}</div>
`;
        for (const beat of actBeats) {
          html += this.formatBeatForHTML(beat, options);
        }
        html += `  </div>
`;
      }
    } else {
      for (const beat of beats) {
        html += this.formatBeatForHTML(beat, options);
      }
    }

    html += `
  <!-- Plotwell Footer -->
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

  // Helper methods

  private static groupBeatsByAct(beats: Beat[]): Record<string, Beat[]> {
    const groups: Record<string, Beat[]> = {
      act1: [],
      act2a: [],
      act2b: [],
      act3: [],
      act4: [],
      act5: [],
      custom: []
    };

    for (const beat of beats) {
      const act = beat.act || 'custom';
      if (!groups[act]) groups[act] = [];
      groups[act].push(beat);
    }

    return groups;
  }

  private static formatBeatForText(beat: Beat, lines: string[], options: BeatExportOptions) {
    lines.push(`${beat.order + 1}. ${beat.title.toUpperCase()}`);
    lines.push(`   Type: ${BEAT_TYPE_LABELS[beat.beat_type] || beat.beat_type}`);

    if (options.includePageEstimates !== false && beat.page_estimate) {
      lines.push(`   Pages: ${beat.page_estimate}`);
    }

    if (beat.description) {
      lines.push('');
      lines.push(`   ${beat.description}`);
    }

    if (options.includeNotes !== false && beat.notes) {
      lines.push('');
      lines.push(`   Notes: ${beat.notes}`);
    }

    lines.push('');
    lines.push('');
  }

  private static formatBeatForHTML(beat: Beat, options: BeatExportOptions): string {
    return `
    <div class="beat-card">
      <div class="beat-header">
        <span class="beat-title">${beat.order + 1}. ${this.escapeHTML(beat.title)}</span>
        <span class="beat-type">${BEAT_TYPE_LABELS[beat.beat_type] || beat.beat_type}</span>
      </div>
      ${beat.description ? `<div class="beat-description">${this.escapeHTML(beat.description)}</div>` : ''}
      ${options.includePageEstimates !== false ? `<div class="page-estimate">Est. Pages: ${beat.page_estimate || 1}</div>` : ''}
      ${options.includeNotes !== false && beat.notes ? `<div class="beat-notes">${this.escapeHTML(beat.notes)}</div>` : ''}
    </div>
`;
  }

  private static escapeCSV(str: string): string {
    if (!str) return '';
    // Escape quotes and wrap in quotes if contains comma, newline, or quote
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

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
  static getExportFilename(projectName: string, format: string, episodeTitle?: string): string {
    const cleanName = projectName
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '_')
      .toLowerCase();

    const episodePart = episodeTitle
      ? `_${episodeTitle.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').toLowerCase()}`
      : '';

    const timestamp = new Date().toISOString().split('T')[0];

    return `${cleanName}${episodePart}_beat_sheet_${timestamp}.${format}`;
  }

  /**
   * Get MIME type for export format
   */
  static getExportMimeType(format: string): string {
    switch (format) {
      case 'csv':
        return 'text/csv';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'html':
        return 'text/html';
      case 'pdf':
        return 'application/pdf';
      default:
        return 'text/plain';
    }
  }
}
