// Request Deduplication Middleware
// Prevents duplicate concurrent requests for the same operation
// Uses database-backed locks (operation_locks table) for multi-instance safety

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { acquireLock, releaseLock } from '../services/operationLockService';

interface DeduplicationRequest extends Request {
  requestHash?: string;
}

/**
 * Creates a hash for request deduplication
 */
function createRequestHash(userId: string, operationType: string, content?: string, projectId?: string): string {
  const data = `${userId}:${operationType}:${projectId || 'no-project'}:${content ? crypto.createHash('md5').update(content).digest('hex') : 'no-content'}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

/**
 * Middleware to prevent duplicate concurrent requests
 */
export function preventDuplicateRequests(
  operationType: string,
  getContentFn?: (req: Request) => string,
  timeoutMinutes: number = 15
) {
  return async (req: DeduplicationRequest, res: Response, next: NextFunction) => {
    const userId = req.user?.id || req.userId;
    const projectId = req.body.project_id || req.params.project_id;

    if (!userId) {
      return next(); // Let auth middleware handle this
    }

    // Create unique hash for this request
    const content = getContentFn ? getContentFn(req) : undefined;
    const requestHash = createRequestHash(userId, operationType, content, projectId);
    req.requestHash = requestHash;

    // Try to acquire lock — if already held, request is a duplicate
    const acquired = await acquireLock('request_dedup', requestHash, timeoutMinutes * 60);
    if (!acquired) {
      return res.status(409).json({
        error: "Request already in progress",
        message: `A ${operationType} request is already being processed. Please wait for it to complete.`,
        requestHash,
      });
    }

    // Release lock when response finishes
    const cleanup = () => {
      releaseLock('request_dedup', requestHash).catch(() => {});
    };
    res.on('finish', cleanup);
    res.on('close', cleanup);

    next();
  };
}

/**
 * Middleware specifically for treatment/concept generation
 */
export const preventDuplicateTreatmentGeneration = preventDuplicateRequests(
  'treatment-generation',
  (req) => req.body.film_treatment || req.body.conversation || req.body.project_concept || '',
  10 // 10 minute timeout for treatments
);

/**
 * Middleware for character generation
 */
export const preventDuplicateCharacterGeneration = preventDuplicateRequests(
  'character-generation',
  (req) => req.body.conversation || req.body.script_content || '',
  5 // 5 minute timeout for characters
);

/**
 * Middleware for location generation
 */
export const preventDuplicateLocationGeneration = preventDuplicateRequests(
  'location-generation',
  (req) => req.body.conversation || req.body.script_content || '',
  5 // 5 minute timeout for locations
);

/**
 * Middleware for storyboard generation
 */
export const preventDuplicateStoryboardGeneration = preventDuplicateRequests(
  'storyboard-generation',
  (req) => req.body.script_id || '',
  10 // 10 minute timeout for storyboards
);

/**
 * Middleware for character image generation
 */
export const preventDuplicateCharacterImageGeneration = preventDuplicateRequests(
  'character-image-generation',
  (req) => req.body.character_name + (req.body.description || ''),
  3 // 3 minute timeout for character images
);

/**
 * Middleware for location image generation
 */
export const preventDuplicateLocationImageGeneration = preventDuplicateRequests(
  'location-image-generation',
  (req) => req.body.location_name + (req.body.description || '') + (req.body.visual_notes || ''),
  3 // 3 minute timeout for location images
);

/**
 * Middleware for storyboard image generation
 */
export const preventDuplicateStoryboardImageGeneration = preventDuplicateRequests(
  'storyboard-image-generation',
  (req) => req.body.scene_description + (req.body.panel_number || ''),
  5 // 5 minute timeout for storyboard images
);

/**
 * Middleware for beat description generation
 */
export const preventDuplicateBeatDescriptionGeneration = preventDuplicateRequests(
  'beat-description-generation',
  (req) => req.body.title || '',
  1 // 1 minute timeout for beat descriptions (short operation)
);

/**
 * Middleware for beat AI suggest
 */
export const preventDuplicateBeatSuggest = preventDuplicateRequests(
  'beat-suggest',
  (req) => `suggest-${req.params.projectId || req.body.project_id || ''}`,
  2 // 2 minute timeout
);

/**
 * Middleware for beat AI analyze
 */
export const preventDuplicateBeatAnalyze = preventDuplicateRequests(
  'beat-analyze',
  (req) => `analyze-${req.params.projectId || req.body.project_id || ''}`,
  2
);

/**
 * Middleware for beat AI expand
 */
export const preventDuplicateBeatExpand = preventDuplicateRequests(
  'beat-expand',
  (req) => `expand-${req.params.beatId || ''}`,
  2
);
