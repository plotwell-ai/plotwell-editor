/**
 * ProductionExportService
 * Exports production data (call sheets, cast, crew, schedules) to various formats
 */

import { createClient } from '@supabase/supabase-js';
import callSheetService from './callSheetService';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export class ProductionExportService {
  /**
   * Export call sheet to CSV format
   */
  static async exportCallSheetToCSV(projectId: string, shootDate: string): Promise<string> {
    const callSheet = await callSheetService.generateCallSheet(projectId, shootDate);

    const lines: string[] = [];

    // Header info
    lines.push(`Call Sheet - Day ${callSheet.shootDay}`);
    lines.push(`Project,${this.escapeCSV(callSheet.project.title)}`);
    lines.push(`Date,${callSheet.date}`);
    lines.push('');

    // Scenes section
    lines.push('SCENES');
    lines.push('Scene #,INT/EXT,Location,Time of Day,Est. Duration (h),Est. Pages');
    for (const scene of callSheet.scenes) {
      lines.push([
        scene.sceneNumber,
        scene.intExt,
        this.escapeCSV(scene.location),
        scene.timeOfDay,
        scene.estimatedDuration,
        scene.estimatedPages
      ].join(','));
    }
    lines.push('');

    // Cast section
    lines.push('CAST');
    lines.push('Character,Actor,Scenes,Call Time');
    for (const member of callSheet.cast) {
      lines.push([
        this.escapeCSV(member.characterName),
        this.escapeCSV(member.actorName || 'TBD'),
        this.escapeCSV(member.scenes.join('; ')),
        member.callTime || callSheet.summary.earliestCall || 'TBD'
      ].join(','));
    }
    lines.push('');

    // Crew section
    lines.push('CREW');
    lines.push('Department,Role,Name');
    for (const member of callSheet.crew) {
      lines.push([
        this.escapeCSV(member.department),
        this.escapeCSV(member.role),
        this.escapeCSV(member.name || '')
      ].join(','));
    }
    lines.push('');

    // Summary
    lines.push('SUMMARY');
    lines.push(`Total Scenes,${callSheet.summary.totalScenes}`);
    lines.push(`Total Cast,${callSheet.summary.totalCast}`);
    lines.push(`Total Crew,${callSheet.summary.totalCrew}`);
    lines.push(`Estimated Hours,${callSheet.summary.estimatedHours}`);
    if (callSheet.summary.earliestCall) {
      lines.push(`First Call,${callSheet.summary.earliestCall}`);
    }
    if (callSheet.summary.estimatedWrap) {
      lines.push(`Est. Wrap,${callSheet.summary.estimatedWrap}`);
    }

    return lines.join('\n');
  }

  /**
   * Export call sheet to HTML (for PDF generation)
   */
  static async exportCallSheetToHTML(projectId: string, shootDate: string): Promise<string> {
    const callSheet = await callSheetService.generateCallSheet(projectId, shootDate);

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Call Sheet - Day ${callSheet.shootDay}</title>
  <style>
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      max-width: 900px;
      margin: 0 auto;
      padding: 30px 20px;
      color: #1e293b;
      font-size: 12px;
    }
    h1 {
      text-align: center;
      font-size: 24px;
      margin-bottom: 5px;
    }
    .subtitle {
      text-align: center;
      font-size: 16px;
      color: #64748b;
      margin-bottom: 20px;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 20px;
      padding: 10px;
      background: #f8fafc;
      border-radius: 6px;
    }
    .meta-item {
      text-align: center;
    }
    .meta-label {
      font-size: 10px;
      color: #64748b;
      text-transform: uppercase;
    }
    .meta-value {
      font-size: 14px;
      font-weight: bold;
    }
    .section {
      margin-bottom: 20px;
    }
    .section-header {
      font-size: 14px;
      font-weight: bold;
      padding: 8px 10px;
      background: #1e293b;
      color: white;
      margin-bottom: 10px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 15px;
    }
    th {
      background: #e2e8f0;
      padding: 8px;
      text-align: left;
      font-size: 11px;
      font-weight: 600;
    }
    td {
      padding: 8px;
      border-bottom: 1px solid #e2e8f0;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    .summary-item {
      padding: 10px;
      background: #f1f5f9;
      border-radius: 4px;
      text-align: center;
    }
    .summary-value {
      font-size: 18px;
      font-weight: bold;
      color: #0f172a;
    }
    .summary-label {
      font-size: 10px;
      color: #64748b;
      text-transform: uppercase;
    }
    @media print {
      body { padding: 10px; }
    }
  </style>
</head>
<body>
  <h1>CALL SHEET</h1>
  <div class="subtitle">Day ${callSheet.shootDay} - ${this.escapeHTML(callSheet.project.title)}</div>

  <div class="meta-row">
    <div class="meta-item">
      <div class="meta-label">Date</div>
      <div class="meta-value">${new Date(callSheet.date).toLocaleDateString()}</div>
    </div>
    <div class="meta-item">
      <div class="meta-label">First Call</div>
      <div class="meta-value">${callSheet.summary.earliestCall || 'TBD'}</div>
    </div>
    <div class="meta-item">
      <div class="meta-label">Est. Wrap</div>
      <div class="meta-value">${callSheet.summary.estimatedWrap || 'TBD'}</div>
    </div>
    ${callSheet.location ? `
    <div class="meta-item">
      <div class="meta-label">Location</div>
      <div class="meta-value">${this.escapeHTML(callSheet.location.name)}</div>
    </div>
    ` : ''}
  </div>

  <div class="section">
    <div class="section-header">SCENES</div>
    <table>
      <thead>
        <tr>
          <th>Scene</th>
          <th>INT/EXT</th>
          <th>Location</th>
          <th>Time</th>
          <th>Duration</th>
          <th>Pages</th>
        </tr>
      </thead>
      <tbody>
        ${callSheet.scenes.map(scene => `
        <tr>
          <td>${scene.sceneNumber}</td>
          <td>${scene.intExt}</td>
          <td>${this.escapeHTML(scene.location)}</td>
          <td>${scene.timeOfDay}</td>
          <td>${scene.estimatedDuration}h</td>
          <td>${scene.estimatedPages}</td>
        </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-header">CAST</div>
    <table>
      <thead>
        <tr>
          <th>Character</th>
          <th>Actor</th>
          <th>Scenes</th>
          <th>Call Time</th>
        </tr>
      </thead>
      <tbody>
        ${callSheet.cast.map(member => `
        <tr>
          <td>${this.escapeHTML(member.characterName)}</td>
          <td>${this.escapeHTML(member.actorName || 'TBD')}</td>
          <td>${member.scenes.join(', ')}</td>
          <td>${member.callTime || callSheet.summary.earliestCall || 'TBD'}</td>
        </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  ${callSheet.crew.length > 0 ? `
  <div class="section">
    <div class="section-header">CREW</div>
    <table>
      <thead>
        <tr>
          <th>Department</th>
          <th>Role</th>
          <th>Name</th>
        </tr>
      </thead>
      <tbody>
        ${callSheet.crew.map(member => `
        <tr>
          <td>${this.escapeHTML(member.department)}</td>
          <td>${this.escapeHTML(member.role)}</td>
          <td>${this.escapeHTML(member.name || '')}</td>
        </tr>
        `).join('')}
      </tbody>
    </table>
  </div>
  ` : ''}

  <div class="section">
    <div class="section-header">SUMMARY</div>
    <div class="summary-grid">
      <div class="summary-item">
        <div class="summary-value">${callSheet.summary.totalScenes}</div>
        <div class="summary-label">Scenes</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${callSheet.summary.totalCast}</div>
        <div class="summary-label">Cast</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${callSheet.summary.estimatedHours}h</div>
        <div class="summary-label">Est. Duration</div>
      </div>
    </div>
  </div>
</body>
</html>`;

    return html;
  }

  /**
   * Export cast list to CSV
   */
  static async exportCastToCSV(projectId: string): Promise<string> {
    const { data: cast, error } = await supabase
      .from('production_cast')
      .select('*')
      .eq('project_id', projectId)
      .order('character_name');

    if (error) {
      throw new Error('Failed to fetch cast');
    }

    const headers = ['Character Name', 'Actor Name', 'Actor Contact', 'Rate Per Day', 'Notes'];
    const lines = [headers.join(',')];

    for (const member of cast || []) {
      lines.push([
        this.escapeCSV(member.character_name),
        this.escapeCSV(member.actor_name || ''),
        this.escapeCSV(member.actor_contact || ''),
        member.rate_per_day || '',
        this.escapeCSV(member.notes || '')
      ].join(','));
    }

    return lines.join('\n');
  }

  /**
   * Export locations to CSV
   */
  static async exportLocationsToCSV(projectId: string): Promise<string> {
    const { data: locations, error } = await supabase
      .from('production_locations')
      .select('*')
      .eq('project_id', projectId)
      .order('name');

    if (error) {
      throw new Error('Failed to fetch locations');
    }

    const headers = ['Name', 'Address', 'Contact Info', 'Permit Required', 'Cost Per Day', 'Notes'];
    const lines = [headers.join(',')];

    for (const loc of locations || []) {
      lines.push([
        this.escapeCSV(loc.name),
        this.escapeCSV(loc.address || ''),
        this.escapeCSV(loc.contact_info || ''),
        loc.permit_required ? 'Yes' : 'No',
        loc.cost_per_day || '',
        this.escapeCSV(loc.notes || '')
      ].join(','));
    }

    return lines.join('\n');
  }

  /**
   * Export schedule to CSV
   */
  static async exportScheduleToCSV(projectId: string): Promise<string> {
    const { data: scenes, error } = await supabase
      .from('production_scene_data')
      .select('*')
      .eq('project_id', projectId)
      .order('shoot_date')
      .order('shoot_order');

    if (error) {
      throw new Error('Failed to fetch schedule');
    }

    const headers = [
      'Scene #',
      'Shoot Date',
      'Shoot Day',
      'Shoot Order',
      'Location',
      'Int/Ext',
      'Time of Day',
      'Est. Duration (h)',
      'Est. Pages',
      'Status'
    ];
    const lines = [headers.join(',')];

    for (const scene of scenes || []) {
      lines.push([
        scene.scene_number,
        scene.shoot_date || '',
        scene.shoot_day || '',
        scene.shoot_order || '',
        this.escapeCSV(scene.location || ''),
        scene.int_ext || '',
        scene.time_of_day || '',
        scene.estimated_duration_hours || '',
        scene.estimated_pages || '',
        scene.status || 'pending'
      ].join(','));
    }

    return lines.join('\n');
  }

  // Helper methods

  private static escapeCSV(str: string): string {
    if (!str) return '';
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
  static getExportFilename(projectName: string, type: string, format: string, date?: string): string {
    const cleanName = projectName
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '_')
      .toLowerCase();

    const datePart = date ? `_${date}` : '';
    const timestamp = new Date().toISOString().split('T')[0];

    return `${cleanName}_${type}${datePart}_${timestamp}.${format}`;
  }

  /**
   * Get MIME type for export format
   */
  static getExportMimeType(format: string): string {
    switch (format) {
      case 'csv':
        return 'text/csv';
      case 'html':
        return 'text/html';
      default:
        return 'text/plain';
    }
  }
}
