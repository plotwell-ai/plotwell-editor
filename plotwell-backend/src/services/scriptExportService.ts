import { createClient } from '@supabase/supabase-js';
import { ScriptParsingService } from './scriptParsingService';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export interface ExportOptions {
  includeSceneNumbers?: boolean;
  pageNumbering?: boolean;
  revisionColors?: boolean;
  moreDialogueBreaks?: boolean;
  includeTitlePage?: boolean;
}

export interface TitlePageData {
  title: string;
  subtitle?: string;
  author?: string;
  basedOn?: string;
  contactInfo?: string;
  draftDate?: string;
  draftNumber?: string;
  copyrightNotice?: string;
  registrationNumber?: string;
}

export class ScriptExportService {
  
  /**
   * Export script to Final Draft (.fdx) format
   * Final Draft XML format specification
   */
  static async exportToFinalDraft(scriptId: string, options: ExportOptions = {}): Promise<string> {
    try {
      // Get script content and project data for title page
      const { data: script, error } = await supabase
        .from('scripts')
        .select(`
          title,
          content,
          projects!scripts_project_id_fkey(
            title,
            name,
            author,
            based_on,
            contact_info,
            copyright_notice,
            registration_number
          )
        `)
        .eq('id', scriptId)
        .single();

      if (error || !script) {
        throw new Error('Script not found');
      }

      const { title, content, projects } = script;
      const project = Array.isArray(projects) ? projects[0] : projects;

      // Prepare title page data
      const titlePageData: TitlePageData = {
        title: project?.title || project?.name || title,
        author: project?.author,
        basedOn: project?.based_on,
        contactInfo: project?.contact_info,
        draftDate: new Date().toISOString().split('T')[0],
        draftNumber: 'First Draft',
        copyrightNotice: project?.copyright_notice,
        registrationNumber: project?.registration_number
      };

      // Parse TipTap content to Final Draft XML
      const fdxContent = this.convertToFinalDraftXML(title, content, options, titlePageData);
      
      return fdxContent;
    } catch (error) {
      console.error('Error exporting to Final Draft:', error);
      throw error;
    }
  }

  /**
   * Export script to Word Document (.docx) format
   */
  static async exportToDocx(scriptId: string, options: ExportOptions = {}): Promise<Buffer> {
    try {
      // Get script content and project data for title page
      const { data: script, error } = await supabase
        .from('scripts')
        .select(`
          title,
          content,
          projects!scripts_project_id_fkey(
            title,
            name,
            author,
            based_on,
            contact_info,
            copyright_notice,
            registration_number
          )
        `)
        .eq('id', scriptId)
        .single();

      if (error || !script) {
        throw new Error('Script not found');
      }

      const { title, content, projects } = script;
      const project = Array.isArray(projects) ? projects[0] : projects;

      // Prepare title page data
      const titlePageData: TitlePageData = {
        title: project?.title || project?.name || title,
        author: project?.author,
        basedOn: project?.based_on,
        contactInfo: project?.contact_info,
        draftDate: new Date().toISOString().split('T')[0],
        draftNumber: 'First Draft',
        copyrightNotice: project?.copyright_notice,
        registrationNumber: project?.registration_number
      };

      // Convert TipTap content to Word Document format
      const docxBuffer = this.convertToDocx(title, content, options, titlePageData);
      
      return docxBuffer;
    } catch (error) {
      console.error('Error exporting to Word Document:', error);
      throw error;
    }
  }

  /**
   * Export script to Fountain format
   * Fountain is a plain text markup language for screenwriting
   */
  static async exportToFountain(scriptId: string, options: ExportOptions = {}): Promise<string> {
    try {
      // Get script content and project data for title page
      const { data: script, error } = await supabase
        .from('scripts')
        .select(`
          title,
          content,
          projects!scripts_project_id_fkey(
            title,
            name,
            author,
            based_on,
            contact_info,
            copyright_notice,
            registration_number
          )
        `)
        .eq('id', scriptId)
        .single();

      if (error) {
        console.error('🔍 Fountain export - Supabase error:', error);
        console.error('🔍 Script ID:', scriptId);
        throw new Error(`Script not found: ${error.message}`);
      }

      if (!script) {
        console.error('🔍 Fountain export - No script returned for ID:', scriptId);
        throw new Error('Script not found');
      }

      const { title, content, projects } = script;
      const project = Array.isArray(projects) ? projects[0] : projects;

      // Prepare title page data
      const titlePageData: TitlePageData = {
        title: project?.title || project?.name || title,
        author: project?.author,
        basedOn: project?.based_on,
        contactInfo: project?.contact_info,
        draftDate: new Date().toISOString().split('T')[0],
        draftNumber: 'First Draft',
        copyrightNotice: project?.copyright_notice,
        registrationNumber: project?.registration_number
      };

      // Parse TipTap content to Fountain markup
      const fountainContent = this.convertToFountain(title, content, options, titlePageData);

      return fountainContent;
    } catch (error: any) {
      console.error('Error exporting to Fountain:', error?.message || error);
      throw error;
    }
  }

  /**
   * Convert TipTap JSON content to Final Draft XML
   */
  private static convertToFinalDraftXML(title: string, content: any, options: ExportOptions, titlePageData?: TitlePageData): string {
    if (!content || !content.content || !Array.isArray(content.content)) {
      return this.getEmptyFinalDraftXML(title);
    }

    let xmlContent = '';
    let sceneNumber = 1;
    
    // Process each paragraph/element
    for (const node of content.content) {
      if (node.type !== 'paragraph' || !node.content) continue;

      const text = node.content
        .filter((content: any) => content.type === 'text')
        .map((content: any) => content.text)
        .join('');

      const className = node.attrs?.class || '';

      // Convert based on element type
      switch (className) {
        case 'scene-heading':
          const sceneText = options.includeSceneNumbers ? `${sceneNumber}. ${text}` : text;
          xmlContent += this.createFDXElement('Scene Heading', sceneText);
          sceneNumber++;
          break;
          
        case 'action':
        case 'shot-description':
          xmlContent += this.createFDXElement('Action', text);
          break;
          
        case 'character-name':
          xmlContent += this.createFDXElement('Character', text.toUpperCase());
          break;
          
        case 'dialogue':
          xmlContent += this.createFDXElement('Dialogue', text);
          break;
          
        case 'parenthetical':
          xmlContent += this.createFDXElement('Parenthetical', text);
          break;
          
        case 'transition':
        case 'aligned':
          xmlContent += this.createFDXElement('Transition', text.toUpperCase());
          break;
          
        case 'shot-heading':
          xmlContent += this.createFDXElement('Shot', text.toUpperCase());
          break;

        default:
          // Treat unknown as action
          if (text.trim()) {
            xmlContent += this.createFDXElement('Action', text);
          }
      }
    }

    return this.wrapFinalDraftXML(title, xmlContent, titlePageData);
  }

  /**
   * Convert TipTap JSON content to Fountain format
   */
  private static convertToFountain(title: string, content: any, options: ExportOptions, titlePageData?: TitlePageData): string {
    if (!content || !content.content || !Array.isArray(content.content)) {
      return this.getEmptyFountain(title);
    }

    let fountainContent = '';
    let sceneNumber = 1;
    let lastElementType = '';
    
    // Add Fountain title page with all available metadata
    if (options.includeTitlePage !== false && titlePageData) {
      fountainContent += `Title: ${titlePageData.title}\n`;
      
      if (titlePageData.author) {
        fountainContent += `Author: ${titlePageData.author}\n`;
      }
      
      if (titlePageData.basedOn) {
        fountainContent += `Source: ${titlePageData.basedOn}\n`;
      }
      
      if (titlePageData.draftDate) {
        fountainContent += `Date: ${titlePageData.draftDate}\n`;
      }
      
      if (titlePageData.contactInfo) {
        fountainContent += `Contact: ${titlePageData.contactInfo}\n`;
      }
      
      if (titlePageData.draftNumber) {
        fountainContent += `Draft: ${titlePageData.draftNumber}\n`;
      }
      
      if (titlePageData.copyrightNotice) {
        fountainContent += `Copyright: ${titlePageData.copyrightNotice}\n`;
      }
      
      if (titlePageData.registrationNumber) {
        fountainContent += `Registration: ${titlePageData.registrationNumber}\n`;
      }
      
      fountainContent += '\n';
    } else {
      // Fallback to simple title
      fountainContent += `Title: ${title}\n\n`;
    }
    
    fountainContent += `FADE IN:\n\n`;

    // Process each paragraph/element
    for (const node of content.content) {
      if (node.type !== 'paragraph' || !node.content) continue;

      const text = node.content
        .filter((content: any) => content.type === 'text')
        .map((content: any) => content.text)
        .join('');

      const className = node.attrs?.class || '';

      // Add spacing based on element transitions
      const needsSpacing = this.needsFountainSpacing(lastElementType, className);
      if (needsSpacing) {
        fountainContent += '\n';
      }

      // Convert based on element type
      switch (className) {
        case 'scene-heading':
          const sceneText = options.includeSceneNumbers ? `${sceneNumber}. ${text}` : text;
          // Fountain scene headings are automatically detected if they start with INT./EXT.
          // Force scene heading with period if needed
          const isAutoDetected = /^(INT\.|EXT\.)/i.test(sceneText);
          fountainContent += isAutoDetected ? `${sceneText}\n` : `.${sceneText}\n`;
          sceneNumber++;
          break;
          
        case 'action':
        case 'shot-description':
          fountainContent += `${text}\n`;
          break;
          
        case 'character-name':
          fountainContent += `${text.toUpperCase()}\n`;
          break;
          
        case 'dialogue':
          fountainContent += `${text}\n`;
          break;
          
        case 'parenthetical':
          fountainContent += `${text}\n`;
          break;
          
        case 'transition':
        case 'aligned':
          // Fountain transitions end with TO:
          const transitionText = text.toUpperCase();
          if (transitionText.endsWith('TO:') || transitionText === 'FADE IN:' || transitionText === 'FADE OUT:') {
            fountainContent += `${transitionText}\n`;
          } else {
            fountainContent += `> ${transitionText}\n`; // Force transition with >
          }
          break;
          
        case 'shot-heading':
          fountainContent += `@${text}\n`; // Shot headings with @ prefix
          break;

        default:
          // Treat unknown as action
          if (text.trim()) {
            fountainContent += `${text}\n`;
          }
      }

      lastElementType = className;
    }

    fountainContent += '\nFADE OUT.\n\nTHE END';
    
    return fountainContent;
  }

  // Helper methods for Final Draft XML

  private static createFDXElement(type: string, text: string): string {
    const elementMap: { [key: string]: string } = {
      'Scene Heading': 'Scene Heading',
      'Action': 'Action',
      'Character': 'Character',
      'Dialogue': 'Dialogue',
      'Parenthetical': 'Parenthetical',
      'Transition': 'Transition',
      'Shot': 'Shot'
    };

    const fdxType = elementMap[type] || 'Action';
    const escapedText = this.escapeXML(text);
    
    return `    <Paragraph Type="${fdxType}">
      <Text>${escapedText}</Text>
    </Paragraph>
`;
  }

  private static escapeXML(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private static wrapFinalDraftXML(title: string, content: string, titlePageData?: TitlePageData): string {
    const now = new Date().toISOString();
    
    // Generate title page content
    let titlePageContent = '';
    if (titlePageData) {
      titlePageContent = `
      <Paragraph Type="Title">
        <Text>${this.escapeXML(titlePageData.title)}</Text>
      </Paragraph>`;
      
      if (titlePageData.author) {
        titlePageContent += `
      <Paragraph Type="Author">
        <Text>by</Text>
      </Paragraph>
      <Paragraph Type="Author">
        <Text>${this.escapeXML(titlePageData.author)}</Text>
      </Paragraph>`;
      }
      
      if (titlePageData.basedOn) {
        titlePageContent += `
      <Paragraph Type="Based On">
        <Text>${this.escapeXML(titlePageData.basedOn)}</Text>
      </Paragraph>`;
      }
      
      // Add spacing and contact info in the lower half
      titlePageContent += `
      <Paragraph Type="General">
        <Text></Text>
      </Paragraph>
      <Paragraph Type="General">
        <Text></Text>
      </Paragraph>
      <Paragraph Type="General">
        <Text></Text>
      </Paragraph>`;
      
      if (titlePageData.draftNumber) {
        titlePageContent += `
      <Paragraph Type="General">
        <Text>${this.escapeXML(titlePageData.draftNumber)}</Text>
      </Paragraph>`;
      }
      
      if (titlePageData.draftDate) {
        titlePageContent += `
      <Paragraph Type="General">
        <Text>${this.escapeXML(titlePageData.draftDate)}</Text>
      </Paragraph>`;
      }
      
      if (titlePageData.contactInfo) {
        titlePageContent += `
      <Paragraph Type="Contact">
        <Text>${this.escapeXML(titlePageData.contactInfo)}</Text>
      </Paragraph>`;
      }
      
      if (titlePageData.copyrightNotice) {
        titlePageContent += `
      <Paragraph Type="Copyright">
        <Text>${this.escapeXML(titlePageData.copyrightNotice)}</Text>
      </Paragraph>`;
      }
      
      if (titlePageData.registrationNumber) {
        titlePageContent += `
      <Paragraph Type="General">
        <Text>Registration: ${this.escapeXML(titlePageData.registrationNumber)}</Text>
      </Paragraph>`;
      }
    } else {
      titlePageContent = `
      <Paragraph Type="Title">
        <Text>${this.escapeXML(title)}</Text>
      </Paragraph>`;
    }
    
    return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="1">
  <Content>
    <Paragraph Type="Title">
      <Text>${this.escapeXML(title)}</Text>
    </Paragraph>
${content}
  </Content>
  <TitlePage>
    <Content>${titlePageContent}
    </Content>
  </TitlePage>
  <Settings>
    <Page>
      <Size>Letter</Size>
      <NumberStart>1</NumberStart>
    </Page>
  </Settings>
  <Revisions NextColor="2">
    <Revision Number="1" Color="1" Date="${now}" />
  </Revisions>
  <Actors />
  <Cast />
  <Characters />
  <Extensions />
  <HeaderAndFooter />
  <MoreDialogueBreaks />
  <ScriptNotes />
  <SmartType />
  <Spell />
  <Shortcuts />
  <UserData />
</FinalDraft>`;
  }

  private static getEmptyFinalDraftXML(title: string): string {
    return this.wrapFinalDraftXML(title, '');
  }

  // Helper methods for Fountain

  private static needsFountainSpacing(lastType: string, currentType: string): boolean {
    // Add spacing between different element types for readability
    if (!lastType) return false;
    
    const spacingRules: { [key: string]: string[] } = {
      'scene-heading': ['action', 'shot-description', 'character-name'],
      'action': ['scene-heading', 'character-name', 'transition'],
      'shot-description': ['scene-heading', 'character-name', 'transition'],
      'dialogue': ['scene-heading', 'action', 'shot-description', 'character-name', 'transition'],
      'parenthetical': ['scene-heading', 'action', 'shot-description', 'character-name'],
      'transition': ['scene-heading'],
    };
    
    const needsSpacing = spacingRules[lastType]?.includes(currentType);
    return !!needsSpacing;
  }

  private static getEmptyFountain(title: string): string {
    return `Title: ${title}\n\nFADE IN:\n\n\n\nFADE OUT.\n\nTHE END`;
  }

  /**
   * Convert TipTap JSON content to Word Document
   */
  private static convertToDocx(title: string, content: any, options: ExportOptions, titlePageData?: TitlePageData): Buffer {
    // Simple DOCX implementation using basic text format
    // For now, we'll convert to plain text with proper formatting
    
    let docxContent = '';
    
    // Add title page if enabled
    if (options.includeTitlePage !== false && titlePageData) {
      docxContent += `${titlePageData.title.toUpperCase()}\n\n`;
      
      if (titlePageData.author) {
        docxContent += `by\n${titlePageData.author}\n\n`;
      }
      
      if (titlePageData.basedOn) {
        docxContent += `${titlePageData.basedOn}\n\n`;
      }
      
      // Add spacing before bottom info
      docxContent += '\n\n\n\n\n\n\n\n\n\n';
      
      // Left side info
      if (titlePageData.draftNumber) {
        docxContent += `${titlePageData.draftNumber}\n`;
      }
      
      if (titlePageData.draftDate) {
        docxContent += `${titlePageData.draftDate}\n`;
      }
      
      if (titlePageData.copyrightNotice) {
        docxContent += `${titlePageData.copyrightNotice}\n`;
      }
      
      if (titlePageData.registrationNumber) {
        docxContent += `Registration: ${titlePageData.registrationNumber}\n`;
      }
      
      // Contact info (right aligned in concept)
      if (titlePageData.contactInfo) {
        const lines = titlePageData.contactInfo.split('\n');
        docxContent += '\n' + lines.join('\n');
      }
      
      docxContent += '\n\n\f'; // Page break
    }
    
    // Convert script content
    if (content && content.content && Array.isArray(content.content)) {
      docxContent += this.convertTipTapToPlainText(content.content);
    }
    
    // Create a simple text buffer (for now, could be enhanced with actual DOCX format)
    return Buffer.from(docxContent, 'utf-8');
  }

  /**
   * Convert TipTap content to plain text for DOCX
   */
  private static convertTipTapToPlainText(content: any[]): string {
    let text = '';
    
    for (const node of content) {
      if (node.type === 'paragraph') {
        const className = node.attrs?.class || '';
        
        if (className.includes('scene-heading')) {
          text += (node.content?.[0]?.text || '').toUpperCase() + '\n\n';
        } else if (className.includes('character')) {
          text += '                    ' + (node.content?.[0]?.text || '').toUpperCase() + '\n';
        } else if (className.includes('dialogue')) {
          text += '          ' + (node.content?.[0]?.text || '') + '\n';
        } else if (className.includes('parenthetical')) {
          text += '                    (' + (node.content?.[0]?.text || '') + ')\n';
        } else if (className.includes('action')) {
          text += (node.content?.[0]?.text || '') + '\n\n';
        } else {
          // Default paragraph
          text += (node.content?.[0]?.text || '') + '\n';
        }
      }
    }
    
    return text;
  }

  /**
   * Get export filename with proper extension
   */
  static getExportFilename(scriptTitle: string, format: 'fdx' | 'fountain' | 'docx'): string {
    // Clean title for filename
    const cleanTitle = scriptTitle
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '_')     // Replace spaces with underscores
      .toLowerCase();
    
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    return `${cleanTitle}_${timestamp}.${format}`;
  }

  /**
   * Get MIME type for export format
   */
  static getExportMimeType(format: 'fdx' | 'fountain' | 'docx'): string {
    switch (format) {
      case 'fdx':
        return 'application/xml';
      case 'fountain':
        return 'text/plain';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      default:
        return 'text/plain';
    }
  }
}