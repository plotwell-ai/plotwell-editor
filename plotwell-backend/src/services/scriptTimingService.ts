import { ScriptParsingService } from './scriptParsingService';

export interface TimingBreakdown {
  totalPages: number;
  totalMinutes: number;
  sceneBreakdown: SceneTimingInfo[];
  elementBreakdown: {
    sceneHeadings: number;
    action: number;
    dialogue: number;
    transitions: number;
    parentheticals: number;
  };
  stats: {
    averageSceneLength: number;
    longestScene: number;
    shortestScene: number;
    totalScenes: number;
  };
}

export interface SceneTimingInfo {
  sceneNumber: number;
  heading: string;
  pages: number;
  minutes: number;
  wordCount: number;
  elements: {
    action: number;
    dialogue: number;
    parentheticals: number;
  };
}

export class ScriptTimingService {
  
  // Industry standard: 1 page = 1 minute for properly formatted screenplays
  private static readonly PAGES_PER_MINUTE = 1;
  
  // Word count estimates for different elements (industry standards)
  private static readonly WORDS_PER_PAGE = {
    action: 250,      // Action lines are denser
    dialogue: 200,    // Dialogue with character names
    sceneHeading: 10, // Short scene headings
    transition: 5,    // Brief transitions
    parenthetical: 15 // Short parentheticals
  };

  /**
   * Calculate timing for a script from TipTap JSON content
   */
  static calculateScriptTiming(scriptContent: any): TimingBreakdown {
    
    if (!scriptContent || !scriptContent.content || !Array.isArray(scriptContent.content)) {
      return this.getEmptyTiming();
    }

    const scenes: SceneTimingInfo[] = [];
    let currentScene: Partial<SceneTimingInfo> | null = null;
    let sceneNumber = 1;
    
    const elementCounts = {
      sceneHeadings: 0,
      action: 0,
      dialogue: 0,
      transitions: 0,
      parentheticals: 0
    };

    for (const node of scriptContent.content) {
      if (node.type !== 'paragraph' || !node.content) continue;

      const text = node.content
        .filter((content: any) => content.type === 'text')
        .map((content: any) => content.text)
        .join('');

      const className = node.attrs?.class || '';
      const wordCount = this.countWords(text);

      // Scene heading detection
      if (className === 'scene-heading' || this.isSceneHeading(text)) {
        
        // Save previous scene if exists
        if (currentScene && currentScene.heading) {
          const completedScene = this.completeSceneTiming(currentScene, sceneNumber - 1);
          scenes.push(completedScene);
        }

        // Start new scene
        currentScene = {
          sceneNumber: sceneNumber++,
          heading: text.trim(),
          wordCount: wordCount,
          elements: {
            action: 0,
            dialogue: 0,
            parentheticals: 0
          }
        };

        elementCounts.sceneHeadings++;
      }
      
      // Process other elements
      else if (currentScene) {
        switch (className) {
          case 'action':
          case 'shot-description':
            currentScene.elements!.action += wordCount;
            currentScene.wordCount = (currentScene.wordCount || 0) + wordCount;
            elementCounts.action++;
            break;
            
          case 'dialogue':
            currentScene.elements!.dialogue += wordCount;
            currentScene.wordCount = (currentScene.wordCount || 0) + wordCount;
            elementCounts.dialogue++;
            break;
            
          case 'parenthetical':
            currentScene.elements!.parentheticals += wordCount;
            currentScene.wordCount = (currentScene.wordCount || 0) + wordCount;
            elementCounts.parentheticals++;
            break;
            
          case 'transition':
          case 'aligned':
            elementCounts.transitions++;
            break;
            
          case 'character-name':
            // Character names don't add significant timing but count for structure
            break;
            
          default:
            // Treat unknown elements as action
            if (text.trim()) {
              if (currentScene) {
                currentScene.elements!.action += wordCount;
                currentScene.wordCount = (currentScene.wordCount || 0) + wordCount;
              }
              elementCounts.action++;
            }
        }
      }
      
      // Handle content without a current scene (no scene headings detected yet)
      else if (text.trim()) {

        // Count elements even without scenes
        switch (className) {
          case 'action':
          case 'shot-description':
            elementCounts.action++;
            break;
          case 'dialogue':
            elementCounts.dialogue++;
            break;
          case 'parenthetical':
            elementCounts.parentheticals++;
            break;
          case 'character-name':
            // Don't count character names as elements
            break;
          default:
            if (text.trim()) {
              elementCounts.action++; // Treat unknown as action
            }
        }
      }
    }

    // Add the last scene
    if (currentScene && currentScene.heading) {
      const completedScene = this.completeSceneTiming(currentScene, sceneNumber - 1);
      scenes.push(completedScene);
    }

    // If no scenes were detected but we have content, treat the entire script as one scene
    if (scenes.length === 0 && (elementCounts.action > 0 || elementCounts.dialogue > 0)) {
      
      // Create a fallback scene with all the content
      const fallbackScene: SceneTimingInfo = {
        sceneNumber: 1,
        heading: 'Script Content',
        pages: Math.max(0.125, (elementCounts.action * 250 + elementCounts.dialogue * 200) / 250), // Rough estimate
        minutes: 0, // Will be calculated below
        wordCount: 0, // Could be calculated if needed
        elements: {
          action: elementCounts.action,
          dialogue: elementCounts.dialogue,
          parentheticals: elementCounts.parentheticals
        }
      };
      
      fallbackScene.minutes = Math.round(fallbackScene.pages * this.PAGES_PER_MINUTE);
      scenes.push(fallbackScene);
      
    }

    // Calculate totals and stats
    const totalPages = scenes.reduce((sum, scene) => sum + scene.pages, 0);
    const totalMinutes = Math.round(totalPages * this.PAGES_PER_MINUTE);
    
    const sceneLengths = scenes.map(s => s.pages);
    const stats = {
      totalScenes: scenes.length,
      averageSceneLength: sceneLengths.length > 0 ? 
        Math.round((sceneLengths.reduce((a, b) => a + b, 0) / sceneLengths.length) * 100) / 100 : 0,
      longestScene: sceneLengths.length > 0 ? Math.max(...sceneLengths) : 0,
      shortestScene: sceneLengths.length > 0 ? Math.min(...sceneLengths) : 0
    };

    return {
      totalPages: Math.round(totalPages * 100) / 100, // Round to 2 decimal places
      totalMinutes,
      sceneBreakdown: scenes,
      elementBreakdown: elementCounts,
      stats
    };
  }

  /**
   * Calculate timing for a specific scene or script section
   */
  static calculateSectionTiming(content: any, startIndex: number = 0, endIndex?: number): TimingBreakdown {
    if (!content || !content.content || !Array.isArray(content.content)) {
      return this.getEmptyTiming();
    }

    const sectionContent = {
      ...content,
      content: content.content.slice(startIndex, endIndex)
    };

    return this.calculateScriptTiming(sectionContent);
  }

  /**
   * Get timing estimate for different script formats
   */
  static getFormatTimingMultiplier(projectType: string): number {
    switch (projectType) {
      case 'feature':
        return 1.0;  // Standard feature film timing
      case 'short':
        return 1.1;  // Shorts tend to be slightly denser
      case 'series':
        return 0.95; // TV episodes slightly faster
      default:
        return 1.0;
    }
  }

  /**
   * Calculate reading time (different from screen time)
   */
  static calculateReadingTime(scriptContent: any): number {
    const timing = this.calculateScriptTiming(scriptContent);
    const totalWords = timing.sceneBreakdown.reduce((sum, scene) => sum + scene.wordCount, 0);
    
    // Average reading speed: 200-250 words per minute
    const readingSpeed = 225;
    return Math.ceil(totalWords / readingSpeed);
  }

  /**
   * Get page-by-page breakdown for detailed analysis
   */
  static getPageBreakdown(scriptContent: any): Array<{
    page: number;
    startScene: number;
    endScene: number;
    elements: string[];
    estimatedMinutes: number;
  }> {
    const timing = this.calculateScriptTiming(scriptContent);
    const pageBreakdown = [];
    let currentPage = 1;
    let currentPageContent = 0;
    let startScene = 1;

    for (const scene of timing.sceneBreakdown) {
      const scenePages = scene.pages;
      
      if (currentPageContent + scenePages > 1) {
        // Scene spans multiple pages
        pageBreakdown.push({
          page: currentPage,
          startScene,
          endScene: scene.sceneNumber,
          elements: this.getSceneElements(scene),
          estimatedMinutes: Math.round(currentPageContent * this.PAGES_PER_MINUTE)
        });
        
        currentPage++;
        currentPageContent = scenePages - (1 - currentPageContent);
        startScene = scene.sceneNumber;
        
        // Handle scenes longer than 1 page
        while (currentPageContent > 1) {
          pageBreakdown.push({
            page: currentPage,
            startScene: scene.sceneNumber,
            endScene: scene.sceneNumber,
            elements: this.getSceneElements(scene),
            estimatedMinutes: 1
          });
          currentPage++;
          currentPageContent -= 1;
        }
      } else {
        currentPageContent += scenePages;
      }
    }

    // Add final page if there's remaining content
    if (currentPageContent > 0) {
      pageBreakdown.push({
        page: currentPage,
        startScene,
        endScene: timing.stats.totalScenes,
        elements: ['Final content'],
        estimatedMinutes: Math.round(currentPageContent * this.PAGES_PER_MINUTE)
      });
    }

    return pageBreakdown;
  }

  // Private helper methods

  private static countWords(text: string): number {
    return text.trim().split(/\s+/).filter(word => word.length > 0).length;
  }

  private static isSceneHeading(text: string): boolean {
    const sceneHeadingPattern = /^(INT\.|EXT\.|INTERIOR|EXTERIOR)/i;
    return sceneHeadingPattern.test(text.trim());
  }

  private static completeSceneTiming(scene: Partial<SceneTimingInfo>, sceneNumber: number): SceneTimingInfo {
    const wordCount = scene.wordCount || 0;
    const elements = scene.elements || { action: 0, dialogue: 0, parentheticals: 0 };
    
    // Calculate pages based on element types and word counts
    const actionPages = elements.action / this.WORDS_PER_PAGE.action;
    const dialoguePages = elements.dialogue / this.WORDS_PER_PAGE.dialogue;
    const parentheticalPages = elements.parentheticals / this.WORDS_PER_PAGE.parenthetical;
    
    const totalPages = Math.max(0.125, actionPages + dialoguePages + parentheticalPages); // Minimum 1/8 page
    const minutes = Math.round(totalPages * this.PAGES_PER_MINUTE);

    return {
      sceneNumber: scene.sceneNumber || sceneNumber,
      heading: scene.heading || '',
      pages: Math.round(totalPages * 8) / 8, // Round to nearest 1/8 page
      minutes,
      wordCount,
      elements
    };
  }

  private static getEmptyTiming(): TimingBreakdown {
    return {
      totalPages: 0,
      totalMinutes: 0,
      sceneBreakdown: [],
      elementBreakdown: {
        sceneHeadings: 0,
        action: 0,
        dialogue: 0,
        transitions: 0,
        parentheticals: 0
      },
      stats: {
        averageSceneLength: 0,
        longestScene: 0,
        shortestScene: 0,
        totalScenes: 0
      }
    };
  }

  private static getSceneElements(scene: SceneTimingInfo): string[] {
    const elements = [];
    if (scene.elements.action > 0) elements.push('Action');
    if (scene.elements.dialogue > 0) elements.push('Dialogue');
    if (scene.elements.parentheticals > 0) elements.push('Parentheticals');
    return elements;
  }
}