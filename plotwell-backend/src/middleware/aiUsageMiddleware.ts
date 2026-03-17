import { Request, Response, NextFunction } from 'express';
import { AIUsageTracker, createAIUsageTracker } from '../services/aiUsageTracker';
import { createClient } from '@supabase/supabase-js';

const DEBUG_AI = process.env.DEBUG_AI === 'true';

// Initialize Supabase client lazily
let supabase: ReturnType<typeof createClient> | null = null;
const getSupabaseClient = () => {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Missing Supabase environment variables');
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
};

export interface AITrackingRequest extends Request {
  aiUsageTracker?: AIUsageTracker;
  userId?: string;
  projectId?: string;
  aiOperationType?: 'chat_completion' | 'script_generation' | 'concept_generation' | 'document_generation' | 'character_generation' | 'location_generation' | 'storyboard_generation';
  aiStartTime?: number;
  aiRequestId?: string;
}

/**
 * Middleware to add AI usage tracker to request
 */
export const addAIUsageTracker = (req: AITrackingRequest, res: Response, next: NextFunction) => {
  req.aiUsageTracker = createAIUsageTracker(getSupabaseClient());
  req.aiStartTime = Date.now();
  req.aiRequestId = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  next();
};

/**
 * Middleware to set operation type for tracking
 */
export const setOperationType = (operationType: AITrackingRequest['aiOperationType']) => {
  return (req: AITrackingRequest, res: Response, next: NextFunction) => {
    req.aiOperationType = operationType;
    next();
  };
};

/**
 * Middleware to track OpenAI completion usage
 * This should be called after the OpenAI API call is made
 */
/**
 * Helper function to track OpenAI completion from within route handlers
 */
export async function trackOpenAIUsageInRoute(
  req: AITrackingRequest,
  operationType: AITrackingRequest['aiOperationType'],
  modelUsed: string,
  tokenUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  options: {
    conversationId?: string;
    metadata?: Record<string, any>;
  } = {}
): Promise<void> {
  if (!req.aiUsageTracker || !req.userId) {
    console.warn('AI usage tracker or user ID not available');
    return;
  }

  const durationMs = req.aiStartTime ? Date.now() - req.aiStartTime : undefined;
  
  try {
    await req.aiUsageTracker.trackOpenAIUsage(
      req.userId,
      operationType || 'chat_completion',
      modelUsed,
      tokenUsage,
      {
        projectId: req.projectId,
        requestId: req.aiRequestId,
        conversationId: options.conversationId,
        durationMs,
        metadata: options.metadata
      }
    );
  } catch (error) {
    console.error('Failed to track OpenAI usage in route:', error);
  }
}

/**
 * Helper function to track image generation from within route handlers
 */
export async function trackImageUsageInRoute(
  req: AITrackingRequest,
  operationType: 'character_image' | 'storyboard_image' | 'concept_art' | 'location_image' | 'presentation_image',
  serviceProvider: 'replicate' | 'openai' | 'stability_ai' | 'openrouter',
  modelUsed: string,
  options: {
    imageDimensions?: string;
    imageFormat?: string;
    imageQuality?: number;
    imageUrl?: string;
    promptText?: string;
    metadata?: Record<string, any>;
  } = {}
): Promise<void> {
  if (DEBUG_AI) console.log(`🖼️ trackImageUsageInRoute called: type=${operationType}, userId=${req.userId}, hasTracker=${!!req.aiUsageTracker}`);

  if (!req.aiUsageTracker || !req.userId) {
    console.warn('⚠️ AI usage tracker or user ID not available - cannot track image usage');
    return;
  }

  const durationMs = req.aiStartTime ? Date.now() - req.aiStartTime : undefined;
  
  try {
    await req.aiUsageTracker.trackImageGeneration(
      req.userId,
      operationType,
      serviceProvider,
      modelUsed,
      {
        projectId: req.projectId,
        imageDimensions: options.imageDimensions,
        imageFormat: options.imageFormat,
        imageQuality: options.imageQuality,
        durationMs,
        imageUrl: options.imageUrl,
        promptText: options.promptText,
        metadata: options.metadata
      }
    );
  } catch (error) {
    console.error('Failed to track image usage in route:', error);
  }
}

/**
 * Middleware to extract project ID from request body or params
 */
export const extractProjectId = (req: AITrackingRequest, res: Response, next: NextFunction) => {
  // Try to get project ID from various sources
  req.projectId = req.body?.project_id || req.body?.projectId || req.params?.project_id || req.query?.project_id;
  next();
};

