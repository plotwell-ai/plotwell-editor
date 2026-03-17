// Context Optimization Service
// Intelligently manages and optimizes context sent to AI models for maximum quality

import { AITokenService, ProjectContext } from './aiTokenService';

export interface OptimizedContext {
  systemPrompt: string;
  userPrompt: string;
  contextData: {
    concept?: any;
    script?: any;
    characters: any[];
    locations: any[];
    conversation?: any[];
  };
  totalEstimatedTokens: number;
  optimizations: string[];
  priorityLevels: {
    essential: string[];
    important: string[];
    supplementary: string[];
  };
}

export interface ContextOptimizationOptions {
  maxTokens: number;
  requestType: 'chat' | 'script-generation' | 'concept-generation' | 'character-generation' | 'location-generation' | 'storyboard-generation' | 'feature-screenplay';
  preserveCriticalContext: boolean;
  allowSummarization: boolean;
  prioritizeRecent: boolean;
}

export class ContextOptimizer {
  
  /**
   * Optimize context for AI requests while preserving quality
   */
  static optimizeContext(
    projectContext: ProjectContext,
    userInput: string,
    options: ContextOptimizationOptions,
    conversation?: any[]
  ): OptimizedContext {
    
    const optimizations: string[] = [];
    const contextData: OptimizedContext['contextData'] = {
      characters: [],
      locations: []
    };

    // Start with user input (always preserved)
    let estimatedTokens = this.estimateTokens(userInput);
    
    // Priority classification
    const priorityLevels: OptimizedContext['priorityLevels'] = {
      essential: ['user_input'],
      important: [],
      supplementary: []
    };

    // Analyze and optimize each context component
    const { concept, conceptTokens } = this.optimizeConcept(
      projectContext.conceptContent, 
      options, 
      estimatedTokens
    );
    
    if (concept) {
      contextData.concept = concept.content;
      estimatedTokens += conceptTokens;
      priorityLevels[concept.priority].push('concept');
      if (concept.optimized) {
        optimizations.push(`Concept ${concept.optimized}`);
      }
    }

    const { script, scriptTokens } = this.optimizeScript(
      projectContext.scriptContent, 
      options, 
      estimatedTokens
    );
    
    if (script) {
      contextData.script = script.content;
      estimatedTokens += scriptTokens;
      priorityLevels[script.priority].push('script');
      if (script.optimized) {
        optimizations.push(`Script ${script.optimized}`);
      }
    }

    const { characters, charactersTokens } = this.optimizeCharacters(
      projectContext.characters || [], 
      options, 
      estimatedTokens
    );
    
    contextData.characters = characters.content;
    estimatedTokens += charactersTokens;
    priorityLevels[characters.priority].push('characters');
    if (characters.optimized) {
      optimizations.push(`Characters ${characters.optimized}`);
    }

    const { locations, locationsTokens } = this.optimizeLocations(
      projectContext.locations || [], 
      options, 
      estimatedTokens
    );
    
    contextData.locations = locations.content;
    estimatedTokens += locationsTokens;
    priorityLevels[locations.priority].push('locations');
    if (locations.optimized) {
      optimizations.push(`Locations ${locations.optimized}`);
    }

    const { conversationHistory, conversationTokens } = this.optimizeConversation(
      conversation || [], 
      options, 
      estimatedTokens
    );
    
    if (conversationHistory) {
      contextData.conversation = conversationHistory.content;
      estimatedTokens += conversationTokens;
      priorityLevels[conversationHistory.priority].push('conversation');
      if (conversationHistory.optimized) {
        optimizations.push(`Conversation ${conversationHistory.optimized}`);
      }
    }

    // Generate optimized prompts
    const { systemPrompt, userPrompt } = this.generateOptimizedPrompts(
      userInput,
      contextData,
      options.requestType,
      projectContext.projectType
    );

    return {
      systemPrompt,
      userPrompt,
      contextData,
      totalEstimatedTokens: estimatedTokens,
      optimizations,
      priorityLevels
    };
  }

  /**
   * Optimize concept content based on available token budget
   */
  private static optimizeConcept(
    conceptContent: any,
    options: ContextOptimizationOptions,
    currentTokens: number
  ) {
    if (!conceptContent) {
      return { concept: null, conceptTokens: 0 };
    }

    const conceptAnalysis = AITokenService['analyzeContentSize'](conceptContent);
    const conceptTokens = conceptAnalysis.wordCount * 1.3;
    const remainingBudget = options.maxTokens - currentTokens;

    if (conceptTokens <= remainingBudget * 0.4) { // Use max 40% for concept
      return {
        concept: { content: conceptContent, priority: 'essential' as const, optimized: null },
        conceptTokens
      };
    }

    if (!options.allowSummarization) {
      return { concept: null, conceptTokens: 0 };
    }

    // Summarize concept if too large
    const targetLength = Math.floor(remainingBudget * 0.3 / 1.3); // 30% of remaining budget
    const summarizedConcept = this.summarizeContent(conceptContent, targetLength);
    
    return {
      concept: { 
        content: summarizedConcept, 
        priority: 'important' as const, 
        optimized: `summarized to ${targetLength} words`
      },
      conceptTokens: targetLength * 1.3
    };
  }

  /**
   * Optimize script content based on request type and token budget
   */
  private static optimizeScript(
    scriptContent: any,
    options: ContextOptimizationOptions,
    currentTokens: number
  ) {
    if (!scriptContent) {
      return { script: null, scriptTokens: 0 };
    }

    const scriptAnalysis = AITokenService['analyzeContentSize'](scriptContent);
    const scriptTokens = scriptAnalysis.wordCount * 1.3;
    const remainingBudget = options.maxTokens - currentTokens;

    // For storyboard generation, script is essential
    if (options.requestType === 'storyboard-generation') {
      if (scriptTokens <= remainingBudget * 0.6) { // Use up to 60% for script
        return {
          script: { content: scriptContent, priority: 'essential' as const, optimized: null },
          scriptTokens
        };
      }
      
      if (options.allowSummarization) {
        const targetLength = Math.floor(remainingBudget * 0.5 / 1.3); // 50% of remaining
        const summarizedScript = this.summarizeContent(scriptContent, targetLength);
        return {
          script: { 
            content: summarizedScript, 
            priority: 'essential' as const, 
            optimized: `summarized to ${targetLength} words`
          },
          scriptTokens: targetLength * 1.3
        };
      }
    }

    // For other requests, script is supplementary
    if (scriptTokens <= remainingBudget * 0.2) { // Use max 20%
      return {
        script: { content: scriptContent, priority: 'supplementary' as const, optimized: null },
        scriptTokens
      };
    }

    return { script: null, scriptTokens: 0 };
  }

  /**
   * Optimize character list based on relevance and token budget
   */
  private static optimizeCharacters(
    characters: any[],
    options: ContextOptimizationOptions,
    currentTokens: number
  ) {
    if (!characters || characters.length === 0) {
      return { characters: { content: [], priority: 'supplementary' as const, optimized: null }, charactersTokens: 0 };
    }

    const remainingBudget = options.maxTokens - currentTokens;
    const maxCharacterTokens = remainingBudget * 0.30; // Max 30% for characters

    // Sort characters by importance (main > ensemble > minor > background)
    // Uses actual DB fields: character_type and importance_level
    const sortedCharacters = [...characters].sort((a, b) => {
      const typeOrder: Record<string, number> = { 'main': 1, 'ensemble': 2, 'minor': 3, 'background': 4 };
      const aType = typeOrder[a.character_type as string] || 3;
      const bType = typeOrder[b.character_type as string] || 3;
      if (aType !== bType) return aType - bType;
      // Secondary sort by importance_level (5=most important, 1=least)
      return (b.importance_level || 3) - (a.importance_level || 3);
    });

    const optimizedCharacters = [];
    let characterTokens = 0;

    for (const character of sortedCharacters) {
      const charTokens = this.estimateTokens(JSON.stringify(character));
      
      if (characterTokens + charTokens <= maxCharacterTokens) {
        optimizedCharacters.push(character);
        characterTokens += charTokens;
      } else if (optimizedCharacters.length === 0) {
        // Include at least one character with truncated description
        const truncatedCharacter = {
          ...character,
          description: this.truncateText(character.description || '', 100),
          backstory: this.truncateText(character.backstory || '', 50)
        };
        optimizedCharacters.push(truncatedCharacter);
        characterTokens = this.estimateTokens(JSON.stringify(truncatedCharacter));
        break;
      } else {
        break;
      }
    }

    const optimized = optimizedCharacters.length < characters.length ? 
      `reduced from ${characters.length} to ${optimizedCharacters.length} characters` : null;

    return {
      characters: { 
        content: optimizedCharacters, 
        priority: 'important' as const, 
        optimized 
      },
      charactersTokens: characterTokens
    };
  }

  /**
   * Optimize locations based on relevance and token budget
   */
  private static optimizeLocations(
    locations: any[],
    options: ContextOptimizationOptions,
    currentTokens: number
  ) {
    if (!locations || locations.length === 0) {
      return { locations: { content: [], priority: 'supplementary' as const, optimized: null }, locationsTokens: 0 };
    }

    const remainingBudget = options.maxTokens - currentTokens;
    const maxLocationTokens = remainingBudget * 0.1; // Max 10% for locations

    // Sort locations by importance if available
    const sortedLocations = [...locations].sort((a, b) => {
      const importanceOrder = { 'primary': 1, 'secondary': 2, 'background': 3 };
      const aImportance = importanceOrder[a.location_importance as keyof typeof importanceOrder] || 4;
      const bImportance = importanceOrder[b.location_importance as keyof typeof importanceOrder] || 4;
      return aImportance - bImportance;
    });

    const optimizedLocations = [];
    let locationTokens = 0;

    for (const location of sortedLocations) {
      const locTokens = this.estimateTokens(JSON.stringify(location));
      
      if (locationTokens + locTokens <= maxLocationTokens) {
        optimizedLocations.push(location);
        locationTokens += locTokens;
      } else if (optimizedLocations.length === 0) {
        // Include at least one location with truncated description
        const truncatedLocation = {
          ...location,
          description: this.truncateText(location.description || '', 100)
        };
        optimizedLocations.push(truncatedLocation);
        locationTokens = this.estimateTokens(JSON.stringify(truncatedLocation));
        break;
      } else {
        break;
      }
    }

    const optimized = optimizedLocations.length < locations.length ? 
      `reduced from ${locations.length} to ${optimizedLocations.length} locations` : null;

    return {
      locations: { 
        content: optimizedLocations, 
        priority: 'supplementary' as const, 
        optimized 
      },
      locationsTokens: locationTokens
    };
  }

  /**
   * Optimize conversation history based on recency and relevance
   */
  private static optimizeConversation(
    conversation: any[],
    options: ContextOptimizationOptions,
    currentTokens: number
  ) {
    if (!conversation || conversation.length === 0) {
      return { conversationHistory: null, conversationTokens: 0 };
    }

    const remainingBudget = options.maxTokens - currentTokens;
    const maxConversationTokens = remainingBudget * 0.3; // Max 30% for conversation

    let conversationTokens = 0;
    const optimizedConversation = [];

    // Start from the most recent messages if prioritizing recent
    const processOrder = options.prioritizeRecent ? [...conversation].reverse() : conversation;

    for (const message of processOrder) {
      const msgTokens = this.estimateTokens(JSON.stringify(message));
      
      if (conversationTokens + msgTokens <= maxConversationTokens) {
        optimizedConversation.push(message);
        conversationTokens += msgTokens;
      } else {
        break;
      }
    }

    // Restore original order if we reversed it
    if (options.prioritizeRecent) {
      optimizedConversation.reverse();
    }

    const optimized = optimizedConversation.length < conversation.length ? 
      `reduced from ${conversation.length} to ${optimizedConversation.length} messages` : null;

    return {
      conversationHistory: { 
        content: optimizedConversation, 
        priority: 'important' as const, 
        optimized 
      },
      conversationTokens
    };
  }

  /**
   * Generate optimized system and user prompts
   */
  private static generateOptimizedPrompts(
    userInput: string,
    contextData: OptimizedContext['contextData'],
    requestType: string,
    projectType?: string
  ) {
    const rolePrompts = {
      'script-generation': 'You are a professional screenwriter specializing in creating engaging, properly formatted screenplays.',
      'feature-screenplay': 'You are an expert screenwriter specializing in feature-length screenplays with complex narrative structures.',
      'storyboard-generation': 'You are a professional storyboard artist and cinematographer.',
      'character-generation': 'You are a character development specialist and creative writer.',
      'location-generation': 'You are a location scout and production designer.',
      'concept-generation': 'You are a creative development specialist and story consultant.',
      'chat': 'You are a knowledgeable writing assistant specialized in screenplay and film production.'
    };

    let systemPrompt = rolePrompts[requestType as keyof typeof rolePrompts] || rolePrompts['chat'];
    
    // Add project type context
    if (projectType) {
      systemPrompt += ` You are working on a ${projectType} project.`;
    }

    // Add context-specific instructions
    if (requestType === 'feature-screenplay') {
      systemPrompt += ` Focus on creating a comprehensive, feature-length screenplay with proper three-act structure, character development, and cinematic storytelling. Aim for 90-120 pages of properly formatted screenplay content.`;
    } else if (requestType === 'script-generation') {
      systemPrompt += ` Create well-structured screenplay content with proper formatting, engaging dialogue, and clear scene descriptions.`;
    }

    systemPrompt += ` Always maintain professional screenplay formatting and industry standards.`;

    // Build user prompt with available context
    let userPrompt = userInput;

    if (contextData.concept) {
      userPrompt += `\n\nProject Concept:\n${JSON.stringify(contextData.concept, null, 2)}`;
    }

    if (contextData.characters && contextData.characters.length > 0) {
      userPrompt += `\n\nCharacters:\n${JSON.stringify(contextData.characters, null, 2)}`;
    }

    if (contextData.locations && contextData.locations.length > 0) {
      userPrompt += `\n\nLocations:\n${JSON.stringify(contextData.locations, null, 2)}`;
    }

    if (contextData.script) {
      userPrompt += `\n\nExisting Script:\n${JSON.stringify(contextData.script, null, 2)}`;
    }

    if (contextData.conversation && contextData.conversation.length > 0) {
      userPrompt += `\n\nConversation History:\n${JSON.stringify(contextData.conversation, null, 2)}`;
    }

    return { systemPrompt, userPrompt };
  }

  /**
   * Estimate token count for text content
   */
  private static estimateTokens(text: string): number {
    if (typeof text !== 'string') {
      text = JSON.stringify(text);
    }
    // Rough estimation: 1 token ≈ 0.75 words ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate text to specified word count
   */
  private static truncateText(text: string, maxWords: number): string {
    if (!text) return '';
    const words = text.split(' ');
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + '...';
  }

  /**
   * Summarize content to target word count (simplified version)
   */
  private static summarizeContent(content: any, targetWords: number): any {
    if (!content) return content;
    
    // For TipTap JSON content
    if (content.content && Array.isArray(content.content)) {
      const { extractTextFromTipTapJSON } = require('../utils/aiHelpers');
      const extractedText = extractTextFromTipTapJSON(content);
      const summarizedText = this.truncateText(extractedText, targetWords);
      
      return {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{
            type: 'text',
            text: summarizedText
          }]
        }]
      };
    }
    
    // For plain text
    if (typeof content === 'string') {
      return this.truncateText(content, targetWords);
    }
    
    return content;
  }

  /**
   * Create context optimization options based on request classification
   */
  static createOptimizationOptions(
    requestType: ContextOptimizationOptions['requestType'],
    maxTokens: number,
    complexity: 'simple' | 'moderate' | 'complex' | 'epic'
  ): ContextOptimizationOptions {
    return {
      maxTokens,
      requestType,
      preserveCriticalContext: complexity === 'epic' || requestType === 'feature-screenplay',
      allowSummarization: complexity !== 'simple',
      prioritizeRecent: requestType === 'chat'
    };
  }
}