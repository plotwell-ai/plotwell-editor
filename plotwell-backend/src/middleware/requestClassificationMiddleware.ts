import { Request, Response, NextFunction } from 'express';
import { RequestClassifier, RequestClassification, RequestMetrics } from '../services/requestClassifier';
import { AITokenService } from '../services/aiTokenService';
import { AITrackingRequest } from './aiUsageMiddleware';

export interface ClassifiedRequest extends AITrackingRequest {
  requestClassification?: RequestClassification;
  requestMetrics?: RequestMetrics;
  shouldQueue?: boolean;
  tokenEstimate?: { estimatedTokens: number; breakdown: string };
}

/**
 * Middleware to classify AI requests and determine optimal processing strategy
 */
export const classifyAIRequest = (
  requestType: 'chat' | 'script-generation' | 'concept-generation' | 'character-generation' | 'location-generation' | 'storyboard-generation' | 'feature-screenplay'
) => {
  return async (req: ClassifiedRequest, res: Response, next: NextFunction) => {
    try {
      // Build project context
      const projectId = req.body?.project_id || req.body?.projectId || req.params?.project_id;
      
      if (!projectId) {
        console.warn('Request classification: No project ID provided');
        return next();
      }

      // Get user tier from subscription context (fallback to free)
      const userTier = req.body?.userTier || 'free';
      
      // Build project context for token calculation
      let projectContext;
      try {
        // Import here to avoid circular dependencies
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
        
        projectContext = await AITokenService.buildProjectContext(
          projectId,
          supabase,
          true, // include script
          true  // include concept
        );
      } catch (error) {
        console.error('Failed to build project context for classification:', error);
        // Continue with minimal context
        projectContext = { projectType: 'film' as const };
      }

      // Extract input text from various request body fields
      const inputText = req.body?.question || req.body?.content || req.body?.prompt || 
                       req.body?.conversation || req.body?.project_concept || '';

      // Build request metrics
      const requestMetrics = RequestClassifier.buildRequestMetrics(
        inputText,
        projectContext,
        userTier
      );

      // Classify the request
      const classification = RequestClassifier.classifyRequest(
        requestType,
        projectContext,
        requestMetrics
      );

      // Determine if request should be queued
      const shouldQueue = RequestClassifier.shouldQueue(classification);

      // Estimate token usage
      const tokenEstimate = RequestClassifier.estimateTokens(classification);

      // Attach classification data to request
      req.requestClassification = classification;
      req.requestMetrics = requestMetrics;
      req.shouldQueue = shouldQueue;
      req.tokenEstimate = tokenEstimate;

      // Add response headers for frontend awareness
      res.setHeader('X-AI-Complexity', classification.complexity);
      res.setHeader('X-AI-Strategy', classification.strategy);
      res.setHeader('X-AI-Estimated-Duration', classification.estimatedDuration.toString());
      res.setHeader('X-AI-Estimated-Tokens', tokenEstimate.estimatedTokens.toString());

      next();
      
    } catch (error) {
      console.error('Request classification error:', error);
      // Don't block the request if classification fails
      next();
    }
  };
};

/**
 * Middleware to handle request queuing based on classification
 */
export const handleRequestQueue = async (req: ClassifiedRequest, res: Response, next: NextFunction) => {
  if (req.shouldQueue) {
    // In a production environment, this would integrate with a proper queue system
    // For now, we'll add a small delay and continue processing
    const delay = Math.min(req.requestClassification?.estimatedDuration || 10, 30);
    
    res.setHeader('X-AI-Queued', 'true');
    res.setHeader('X-AI-Queue-Delay', delay.toString());
    
    await new Promise(resolve => setTimeout(resolve, delay * 1000));
  }
  
  next();
};

/**
 * Middleware to apply request-specific optimizations
 */
export const applyRequestOptimizations = (req: ClassifiedRequest, res: Response, next: NextFunction) => {
  const classification = req.requestClassification;
  
  if (!classification) {
    return next();
  }

  // Apply timeout based on classification
  if (classification.complexity === 'epic') {
    req.setTimeout(15 * 60 * 1000); // 15 minutes for epic requests
    res.setTimeout(15 * 60 * 1000);
  } else if (classification.complexity === 'complex') {
    req.setTimeout(12 * 60 * 1000); // 12 minutes for complex requests
    res.setTimeout(12 * 60 * 1000);
  }

  // Set priority headers for load balancer/proxy
  if (classification.priority === 'high') {
    res.setHeader('X-AI-Priority', 'high');
  }

  // Add streaming indicators
  if (classification.shouldUseStreaming) {
    res.setHeader('X-AI-Supports-Streaming', 'true');
  }

  // Add chunking configuration
  if (classification.shouldUseChunking) {
    const chunkConfig = RequestClassifier.getChunkConfig(classification);
    if (chunkConfig) {
      res.setHeader('X-AI-Chunk-Size', chunkConfig.chunkSize.toString());
      res.setHeader('X-AI-Max-Chunks', chunkConfig.maxChunks.toString());
    }
  }

  next();
};

/**
 * Combined middleware for full request classification pipeline
 */
export const fullRequestClassification = (
  requestType: 'chat' | 'script-generation' | 'concept-generation' | 'character-generation' | 'location-generation' | 'storyboard-generation' | 'feature-screenplay'
) => {
  return [
    classifyAIRequest(requestType),
    handleRequestQueue,
    applyRequestOptimizations
  ];
};