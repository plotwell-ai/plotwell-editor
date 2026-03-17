// AI Token Management Service
// Dynamically calculates optimal token limits based on project content and context
import { extractTextFromTipTapJSON } from '../utils/aiHelpers';

export interface ProjectContext {
  projectType: 'film' | 'series';
  conceptContent?: any;
  scriptContent?: any;
  characters?: any[];
  locations?: any[];
}

export interface TokenLimits {
  maxTokens: number;
  reasoning: string;
}

export class AITokenService {
  // Enhanced token limits leveraging GPT-5-Mini's 128K output capacity
  private static readonly BASE_LIMITS = {
    'suggest-next-line': 512,
    'chat-minimal': 2048,
    'chat-standard': 4096,
    'chat-extended': 8192,
    'script-short': 4096,
    'script-standard': 8192,
    'script-feature': 32768,        // Increased for feature films
    'script-feature-large': 65536,  // Large feature films (120+ pages)
    'script-series': 65536,         // Series episodes
    'script-feature-epic': 98304,   // Epic features (200+ pages) - 75% of max capacity
    'storyboard-basic': 4096,
    'storyboard-detailed': 8192,
    'storyboard-comprehensive': 16384,
    'storyboard-feature': 32768,    // Feature film storyboards
  };

  // GPT-5-Mini model specifications
  private static readonly MODEL_SPECS = {
    maxInputTokens: 272000,
    maxOutputTokens: 128000,
    totalContextWindow: 400000,
    safetyBuffer: 0.95  // Use 95% of capacity to allow for overhead
  };

  /**
   * Calculate dynamic token limits based on project context
   */
  static calculateTokenLimits(
    context: 'script-generation' | 'storyboard-generation' | 'chat' | 'suggest-next-line' | 'feature-screenplay',
    projectContext: ProjectContext
  ): TokenLimits {
    switch (context) {
      case 'script-generation':
        return this.calculateScriptTokens(projectContext);
      case 'feature-screenplay':
        return this.calculateFeatureScreenplayTokens(projectContext);
      case 'storyboard-generation':
        return this.calculateStoryboardTokens(projectContext);
      case 'chat':
        return this.calculateChatTokens(projectContext);
      case 'suggest-next-line':
        return {
          maxTokens: this.BASE_LIMITS['suggest-next-line'],
          reasoning: 'Single line suggestion - minimal tokens needed'
        };
      default:
        return {
          maxTokens: this.BASE_LIMITS['chat-standard'],
          reasoning: 'Default fallback limit'
        };
    }
  }

  /**
   * Calculate tokens specifically for large feature screenplay generation
   * Optimized for 200+ page screenplays with chunked generation support
   */
  private static calculateFeatureScreenplayTokens(projectContext: ProjectContext): TokenLimits {
    const { conceptContent, characters, locations } = projectContext;
    
    // Always use maximum safe capacity for feature screenplay generation
    const maxSafeTokens = Math.floor(this.MODEL_SPECS.maxOutputTokens * this.MODEL_SPECS.safetyBuffer);
    
    let reasoning = 'Large feature screenplay generation';
    
    // Analyze concept to determine screenplay scale
    if (conceptContent) {
      const conceptSize = this.analyzeContentSize(conceptContent);
      
      if (conceptSize.wordCount > 10000) {
        reasoning += ` - Epic concept (${conceptSize.wordCount} words) requires maximum capacity`;
      } else if (conceptSize.wordCount > 5000) {
        reasoning += ` - Large concept (${conceptSize.wordCount} words) suggests 200+ page screenplay`;
      } else {
        reasoning += ` - Standard concept (${conceptSize.wordCount} words) with potential for expansion`;
      }
    }

    // Factor in project complexity
    const totalContextItems = (characters?.length || 0) + (locations?.length || 0);
    if (totalContextItems > 20) {
      reasoning += ` - Complex project (${totalContextItems} elements)`;
    } else if (totalContextItems > 10) {
      reasoning += ` - Rich project context`;
    }

    reasoning += ` - Using maximum capacity (${maxSafeTokens.toLocaleString()} tokens)`;

    return {
      maxTokens: maxSafeTokens,
      reasoning
    };
  }

  /**
   * Calculate tokens for script generation based on concept size and project type
   * Enhanced to support large-scale screenplay generation up to 200 pages
   */
  private static calculateScriptTokens(projectContext: ProjectContext): TokenLimits {
    const { projectType, conceptContent, characters, locations } = projectContext;
    
    // Enhanced base limits by project type and scale
    let baseTokens: number;
    let reasoning = `${projectType} project`;

    if (projectType === 'series') {
      baseTokens = this.BASE_LIMITS['script-series'];
      reasoning += ' - TV series episode';
    } else {
      // Default to feature for films
      baseTokens = this.BASE_LIMITS['script-feature'];
      reasoning += ' - feature film';
    }

    let multiplier = 1;
    let scriptScale: 'short' | 'standard' | 'feature' | 'large-feature' | 'epic' = 'standard';

    // Analyze concept content to determine project scale
    if (conceptContent) {
      const conceptSize = this.analyzeContentSize(conceptContent);
      
      // Enhanced scale detection for large screenplays
      if (conceptSize.wordCount > 5000) {
        // Epic concept = 200+ page screenplay
        scriptScale = 'epic';
        baseTokens = this.BASE_LIMITS['script-feature-epic'];
        reasoning += ` - Epic concept (${conceptSize.wordCount} words) suggests 200+ page screenplay`;
      } else if (conceptSize.wordCount > 3000) {
        // Large concept = 120+ page screenplay  
        scriptScale = 'large-feature';
        baseTokens = this.BASE_LIMITS['script-feature-large'];
        reasoning += ` - Large concept (${conceptSize.wordCount} words) suggests 120+ page screenplay`;
      } else if (conceptSize.wordCount > 2000) {
        // Long concept = standard feature film
        scriptScale = 'feature';
        baseTokens = this.BASE_LIMITS['script-feature'];
        reasoning += ` - Standard concept (${conceptSize.wordCount} words) suggests feature film`;
      } else if (conceptSize.wordCount > 800) {
        // Medium concept = standard film or series episode
        multiplier = projectType === 'film' ? 1.5 : 1.2;
        reasoning += ` - Medium concept (${conceptSize.wordCount} words) suggests standard ${projectType}`;
      } else if (conceptSize.wordCount < 200) {
        // Small concept = short film or simple episode
        multiplier = 0.7;
        reasoning += ` - Small concept (${conceptSize.wordCount} words) suggests short ${projectType}`;
      }

      // Additional complexity adjustments
      if (conceptSize.paragraphCount > 15) {
        multiplier *= 1.3;
        reasoning += ` - Complex structure (${conceptSize.paragraphCount} sections)`;
      } else if (conceptSize.paragraphCount > 8) {
        multiplier *= 1.1;
        reasoning += ` - Detailed structure`;
      }

      if (conceptSize.characterMentions > 10) {
        multiplier *= 1.2;
        reasoning += ` - Many characters (${conceptSize.characterMentions})`;
      } else if (conceptSize.characterMentions > 5) {
        multiplier *= 1.1;
        reasoning += ` - Multiple characters`;
      }
    }

    // Factor in additional project context
    const totalContextItems = (characters?.length || 0) + (locations?.length || 0);
    if (totalContextItems > 20) {
      multiplier *= 1.2;
      reasoning += ` - Rich context (${totalContextItems} elements)`;
    } else if (totalContextItems > 10) {
      multiplier *= 1.1;
      reasoning += ` - Detailed context`;
    }

    // Calculate final tokens with safety buffer
    const calculatedTokens = Math.round(baseTokens * multiplier);
    const maxSafeTokens = Math.floor(this.MODEL_SPECS.maxOutputTokens * this.MODEL_SPECS.safetyBuffer);
    
    const finalTokens = Math.min(calculatedTokens, maxSafeTokens);

    // Add scale info to reasoning
    reasoning += ` - Scale: ${scriptScale} (${finalTokens.toLocaleString()} tokens)`;

    return {
      maxTokens: finalTokens,
      reasoning
    };
  }

  /**
   * Calculate tokens for storyboard generation
   */
  private static calculateStoryboardTokens(projectContext: ProjectContext): TokenLimits {
    const { projectType, scriptContent } = projectContext;
    
    let baseTokens = this.BASE_LIMITS['storyboard-basic'];
    let multiplier = 1;
    let reasoning = `Base storyboard limit for ${projectType}`;

    if (scriptContent) {
      const scriptSize = this.analyzeContentSize(scriptContent);
      
      // More script content = more detailed storyboard
      if (scriptSize.wordCount > 3000) {
        multiplier = 2;
        reasoning += ` - Large script (${scriptSize.wordCount} words) needs comprehensive storyboard`;
      } else if (scriptSize.wordCount > 1500) {
        multiplier = 1.5;
        reasoning += ` - Medium script (${scriptSize.wordCount} words) needs detailed storyboard`;
      } else if (scriptSize.wordCount > 500) {
        multiplier = 1.2;
        reasoning += ` - Standard script length`;
      }

      // Count scene headings to estimate visual complexity
      const sceneCount = this.countSceneHeadings(scriptContent);
      if (sceneCount > 10) {
        multiplier *= 1.3;
        reasoning += ` - Multiple scenes (${sceneCount}) require more panels`;
      } else if (sceneCount > 5) {
        multiplier *= 1.1;
        reasoning += ` - Several scenes (${sceneCount})`;
      }
    }

    const calculatedTokens = Math.round(baseTokens * multiplier);
    const maxSafeTokens = Math.floor(this.MODEL_SPECS.maxOutputTokens * this.MODEL_SPECS.safetyBuffer);
    const finalTokens = Math.min(calculatedTokens, maxSafeTokens);

    return {
      maxTokens: finalTokens,
      reasoning
    };
  }

  /**
   * Calculate tokens for chat/Q&A based on context complexity
   * Optimized for quick responses by default, scales up only when needed
   */
  private static calculateChatTokens(projectContext: ProjectContext): TokenLimits {
    const { conceptContent, scriptContent, characters, locations } = projectContext;

    // Default to quick chat mode - short, conversational responses
    // 2048 tokens is ~1500 words, plenty for 3-4 paragraphs
    let baseTokens = 2048;
    let reasoning = 'Quick chat mode - concise responses';

    // Only increase if project has substantial content requiring detailed context
    const totalContentSize = [conceptContent, scriptContent]
      .filter(Boolean)
      .reduce((total, content) => total + this.analyzeContentSize(content).wordCount, 0);

    // Scale up token limit based on context size
    if (totalContentSize > 10000) {
      baseTokens = 8192; // Large context may need longer responses
      reasoning = 'Large project content - expanded chat limit';
    } else if (totalContentSize > 5000) {
      baseTokens = 4096; // Moderate context
      reasoning = 'Moderate project content';
    } else if (totalContentSize > 2000) {
      baseTokens = 3072; // Some context attached
      reasoning = 'Light context attached';
    }

    // Additional context increases complexity slightly
    const contextItems = [characters?.length || 0, locations?.length || 0];
    const totalContextItems = contextItems.reduce((sum, count) => sum + count, 0);

    if (totalContextItems > 15) {
      baseTokens = Math.max(baseTokens, 4096);
      reasoning += ` - Rich context (${totalContextItems} elements)`;
    }

    return {
      maxTokens: baseTokens,
      reasoning
    };
  }

  /**
   * Analyze content size and complexity
   */
  private static analyzeContentSize(content: any): {
    wordCount: number;
    paragraphCount: number;
    characterMentions: number;
  } {
    if (!content) return { wordCount: 0, paragraphCount: 0, characterMentions: 0 };

    let text = '';
    
    // Extract text from TipTap JSON structure
    if (content.content && Array.isArray(content.content)) {
      text = extractTextFromTipTapJSON(content, 'plain');
    } else if (typeof content === 'string') {
      text = content;
    }

    const words = text.split(/\s+/).filter(word => word.length > 0);
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    // Count potential character mentions (capitalized words/names)
    const characterMentions = (text.match(/\b[A-Z][A-Z\s]+\b/g) || []).length;

    return {
      wordCount: words.length,
      paragraphCount: paragraphs.length,
      characterMentions
    };
  }

  /**
   * Count scene headings in script content
   */
  private static countSceneHeadings(scriptContent: any): number {
    if (!scriptContent?.content) return 0;
    
    return scriptContent.content.filter((block: any) => 
      block.attrs?.class?.includes('scene-heading')
    ).length;
  }

  // extractTextFromContent replaced by unified extractTextFromTipTapJSON from aiHelpers

  /**
   * Extract text content from document (TipTap JSON or string)
   */
  private static extractDocumentText(content: any): string {
    if (!content) return '';
    
    if (typeof content === 'string') {
      return content;
    }
    
    // Handle TipTap JSON structure
    if (content.content && Array.isArray(content.content)) {
      return extractTextFromTipTapJSON(content, 'plain');
    }
    
    return JSON.stringify(content);
  }

  /**
   * Get project context from database data
   */
  static async buildProjectContext(
    projectId: string,
    supabaseClient: any,
    includeScript = true,
    includeDocuments = true
  ): Promise<ProjectContext> {
    // Get project basic info
    const { data: project } = await supabaseClient
      .from('projects')
      .select('project_type, prod_script_id')
      .eq('id', projectId)
      .single();

    if (!project) {
      throw new Error('Project not found');
    }

    const context: ProjectContext = {
      projectType: project.project_type || 'film'
    };

    // Get documents content if requested (replaces concept system)
    if (includeDocuments) {
      const { data: documents } = await supabaseClient
        .from('project_documents')
        .select('title, document_type, content')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
      
      if (documents && documents.length > 0) {
        // Convert documents to concept content format for backward compatibility
        const documentsText = documents.map((doc: any) => 
          `${doc.title || 'Untitled Document'} (${doc.document_type || 'document'}):\n${this.extractDocumentText(doc.content) || ''}`
        ).join('\n\n');
        
        context.conceptContent = { content: [{ content: [{ text: documentsText }] }] };
      }
    }

    // Get script content if requested and available
    if (includeScript && project.prod_script_id) {
      const { data: script } = await supabaseClient
        .from('scripts')
        .select('content')
        .eq('id', project.prod_script_id)
        .single();
      
      if (script) {
        context.scriptContent = script.content;
      }
    }

    // Get characters and locations
    const [{ data: characters }, { data: locations }] = await Promise.all([
      supabaseClient.from('characters').select('name, description, character_type, importance_level').eq('project_id', projectId),
      supabaseClient.from('locations').select('name, description').eq('project_id', projectId)
    ]);

    context.characters = characters || [];
    context.locations = locations || [];

    return context;
  }
}