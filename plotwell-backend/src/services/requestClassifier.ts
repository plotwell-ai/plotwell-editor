// AI Request Classification Service
// Intelligently analyzes requests to determine optimal AI processing strategy

import { AITokenService, ProjectContext } from './aiTokenService';

export interface RequestClassification {
  complexity: 'simple' | 'moderate' | 'complex' | 'epic';
  estimatedTokens: number;
  estimatedDuration: number; // seconds
  strategy: 'direct' | 'optimized' | 'chunked' | 'streaming';
  priority: 'low' | 'normal' | 'high';
  reasoning: string;
  shouldUseStreaming: boolean;
  shouldUseChunking: boolean;
  recommendedChunkSize?: number;
}

export interface RequestMetrics {
  inputLength: number;
  contextSize: number;
  expectedOutputSize: number;
  projectComplexity: number;
  userTier: 'free' | 'pro' | 'teams' | 'business';
}

export class RequestClassifier {
  
  /**
   * Classify an AI request and determine optimal processing strategy
   */
  static classifyRequest(
    requestType: 'chat' | 'script-generation' | 'concept-generation' | 'character-generation' | 'location-generation' | 'storyboard-generation' | 'feature-screenplay',
    projectContext: ProjectContext,
    requestMetrics: RequestMetrics
  ): RequestClassification {
    
    // Calculate token limits using existing service
    const tokenLimits = AITokenService.calculateTokenLimits(
      requestType === 'feature-screenplay' ? 'feature-screenplay' : 
      requestType === 'script-generation' ? 'script-generation' : 
      requestType === 'storyboard-generation' ? 'storyboard-generation' :
      requestType === 'chat' ? 'chat' : 'chat', 
      projectContext
    );

    const classification = this.analyzeComplexity(requestType, requestMetrics, tokenLimits.maxTokens);
    
    return {
      ...classification,
      estimatedTokens: tokenLimits.maxTokens,
      reasoning: `${tokenLimits.reasoning}. ${classification.reasoning}`
    };
  }

  /**
   * Analyze request complexity and determine processing strategy
   */
  private static analyzeComplexity(
    requestType: string,
    metrics: RequestMetrics,
    maxTokens: number
  ): Omit<RequestClassification, 'estimatedTokens'> {
    
    let complexity: RequestClassification['complexity'] = 'simple';
    let strategy: RequestClassification['strategy'] = 'direct';
    let estimatedDuration = 5; // seconds
    let priority: RequestClassification['priority'] = 'normal';
    let shouldUseStreaming = false;
    let shouldUseChunking = false;
    let recommendedChunkSize: number | undefined;
    let reasoning = '';

    // Base complexity analysis
    if (requestType === 'feature-screenplay') {
      complexity = 'epic';
      estimatedDuration = 120; // 2 minutes for epic screenplays
      strategy = 'optimized';
      priority = 'high';
      shouldUseStreaming = true;
      reasoning = 'Feature screenplay generation requires maximum resources';
      
      if (maxTokens > 90000) {
        shouldUseChunking = true;
        recommendedChunkSize = 32000;
        strategy = 'chunked';
        estimatedDuration = 300; // 5 minutes for chunked generation
        reasoning += ' - using chunked strategy for optimal quality';
      }
      
    } else if (requestType === 'script-generation') {
      if (maxTokens > 50000) {
        complexity = 'complex';
        estimatedDuration = 90;
        strategy = 'optimized';
        shouldUseStreaming = true;
        reasoning = 'Large script generation';
      } else if (maxTokens > 20000) {
        complexity = 'moderate';
        estimatedDuration = 45;
        strategy = 'optimized';
        reasoning = 'Standard script generation';
      } else {
        complexity = 'simple';
        estimatedDuration = 15;
        reasoning = 'Short script generation';
      }
      
    } else if (requestType === 'storyboard-generation') {
      if (maxTokens > 30000) {
        complexity = 'complex';
        estimatedDuration = 60;
        strategy = 'optimized';
        reasoning = 'Comprehensive storyboard generation';
      } else {
        complexity = 'moderate';
        estimatedDuration = 30;
        reasoning = 'Standard storyboard generation';
      }
      
    } else if (requestType === 'chat') {
      if (metrics.inputLength > 10000) {
        complexity = 'moderate';
        estimatedDuration = 20;
        reasoning = 'Complex chat with large context';
      } else {
        complexity = 'simple';
        estimatedDuration = 8;
        reasoning = 'Standard chat interaction';
      }
      
    } else {
      // character-generation, location-generation, concept-generation
      complexity = 'simple';
      estimatedDuration = 15;
      reasoning = 'Standard content generation';
    }

    // Adjust based on project complexity
    if (metrics.projectComplexity > 15) {
      if (complexity === 'simple') complexity = 'moderate';
      else if (complexity === 'moderate') complexity = 'complex';
      estimatedDuration *= 1.3;
      reasoning += ' - increased complexity due to rich project context';
    }

    // Adjust based on user tier (business users get priority)
    if (metrics.userTier === 'business') {
      priority = 'high';
      reasoning += ' - business tier priority';
    } else if (metrics.userTier === 'free') {
      priority = 'low';
      estimatedDuration *= 1.2; // Slightly longer for free tier
    }

    // Enable streaming for complex operations
    if (complexity === 'complex' || complexity === 'epic') {
      shouldUseStreaming = true;
    }

    // Chunking strategy for very large requests
    if (maxTokens > 80000 && requestType.includes('script')) {
      shouldUseChunking = true;
      recommendedChunkSize = Math.min(32000, Math.floor(maxTokens / 3));
      strategy = 'chunked';
      reasoning += ` - chunked processing (${Math.ceil(maxTokens / recommendedChunkSize)} chunks)`;
    }

    return {
      complexity,
      estimatedDuration: Math.round(estimatedDuration),
      strategy,
      priority,
      shouldUseStreaming,
      shouldUseChunking,
      recommendedChunkSize,
      reasoning
    };
  }

  /**
   * Determine if request should be queued vs processed immediately
   */
  static shouldQueue(classification: RequestClassification, currentServerLoad: number = 0.5): boolean {
    // Queue epic requests during high server load
    if (classification.complexity === 'epic' && currentServerLoad > 0.8) {
      return true;
    }
    
    // Queue complex requests during very high load
    if (classification.complexity === 'complex' && currentServerLoad > 0.9) {
      return true;
    }
    
    // Process high priority requests immediately
    if (classification.priority === 'high') {
      return false;
    }
    
    return false;
  }

  /**
   * Get optimal chunk configuration for chunked processing
   */
  static getChunkConfig(classification: RequestClassification) {
    if (!classification.shouldUseChunking || !classification.recommendedChunkSize) {
      return null;
    }

    return {
      chunkSize: classification.recommendedChunkSize,
      overlapTokens: Math.floor(classification.recommendedChunkSize * 0.1), // 10% overlap
      maxChunks: Math.ceil(classification.estimatedTokens / classification.recommendedChunkSize),
      mergeStrategy: 'sequential' as const
    };
  }

  /**
   * Cost estimation removed - we only track token usage now
   */
  static estimateTokens(classification: RequestClassification): { estimatedTokens: number; breakdown: string } {
    let inputTokens = classification.estimatedTokens * 0.3; // Rough estimate of input vs output ratio
    let outputTokens = classification.estimatedTokens * 0.7;
    
    // Chunking increases token usage due to overlap and coordination
    if (classification.shouldUseChunking) {
      const chunkConfig = this.getChunkConfig(classification);
      if (chunkConfig) {
        const overheadMultiplier = 1 + (chunkConfig.overlapTokens / chunkConfig.chunkSize);
        inputTokens *= overheadMultiplier;
        outputTokens *= overheadMultiplier;
      }
    }
    
    const totalTokens = inputTokens + outputTokens;
    
    const breakdown = classification.shouldUseChunking ? 
      `Chunked: ~${Math.round(inputTokens).toLocaleString()} input + ~${Math.round(outputTokens).toLocaleString()} output tokens` :
      `Direct: ~${Math.round(inputTokens).toLocaleString()} input + ~${Math.round(outputTokens).toLocaleString()} output tokens`;
    
    return {
      estimatedTokens: totalTokens,
      breakdown
    };
  }

  /**
   * Build project metrics from request data
   */
  static buildRequestMetrics(
    inputText: string,
    projectContext: ProjectContext,
    userTier: RequestMetrics['userTier'] = 'free'
  ): RequestMetrics {
    const contextSize = this.calculateContextSize(projectContext);
    const projectComplexity = (projectContext.characters?.length || 0) + (projectContext.locations?.length || 0);
    
    return {
      inputLength: inputText.length,
      contextSize,
      expectedOutputSize: this.estimateOutputSize(inputText, projectContext),
      projectComplexity,
      userTier
    };
  }

  /**
   * Calculate total context size from project data
   */
  private static calculateContextSize(context: ProjectContext): number {
    let size = 0;
    
    if (context.conceptContent) {
      const conceptAnalysis = AITokenService['analyzeContentSize'](context.conceptContent);
      size += conceptAnalysis.wordCount * 1.3; // Rough token estimate
    }
    
    if (context.scriptContent) {
      const scriptAnalysis = AITokenService['analyzeContentSize'](context.scriptContent);
      size += scriptAnalysis.wordCount * 1.3;
    }
    
    size += (context.characters?.length || 0) * 100; // ~100 tokens per character
    size += (context.locations?.length || 0) * 50; // ~50 tokens per location
    
    return Math.round(size);
  }

  /**
   * Estimate expected output size based on input and context
   */
  private static estimateOutputSize(inputText: string, context: ProjectContext): number {
    const inputLength = inputText.length;
    const contextSize = this.calculateContextSize(context);
    
    // Feature screenplays can be 10x+ larger than input
    if (inputLength > 5000 && context.projectType === 'film') {
      return inputLength * 12;
    }
    
    // Standard scripts are ~5x input size
    if (inputLength > 1000) {
      return inputLength * 5;
    }
    
    // Chat responses are typically similar to input size
    return inputLength * 1.5;
  }
}