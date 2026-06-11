/**
 * Input validation middleware for request body size and field length limits.
 * Prevents abuse via oversized payloads on AI prompts, comments, etc.
 */

import { Request, Response, NextFunction } from 'express';

// Maximum field sizes in characters
const FIELD_LIMITS = {
  // AI prompts and user-generated text
  aiPrompt: 50_000,      // ~50KB — generous for screenplay context
  comment: 10_000,        // ~10KB — comments/feedback
  name: 500,              // Character names, project names, etc.
  description: 5_000,     // Descriptions, notes
};

/**
 * Validates that specific string fields in req.body don't exceed length limits.
 * Usage: validateFieldLengths({ question: 'aiPrompt', content: 'aiPrompt' })
 */
export function validateFieldLengths(fieldMap: Record<string, keyof typeof FIELD_LIMITS>) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.body || typeof req.body !== 'object') return next();

    for (const [field, limitKey] of Object.entries(fieldMap)) {
      const value = req.body[field];
      if (typeof value === 'string' && value.length > FIELD_LIMITS[limitKey]) {
        return res.status(413).json({
          error: `Field "${field}" exceeds maximum length of ${FIELD_LIMITS[limitKey].toLocaleString()} characters`,
        });
      }
    }

    next();
  };
}

/**
 * Middleware that validates AI-related request bodies.
 * Checks common AI fields: question, content, prompt, context, instructions.
 */
export const validateAIInput = validateFieldLengths({
  question: 'aiPrompt',
  questionForAI: 'aiPrompt',
  content: 'aiPrompt',
  prompt: 'aiPrompt',
  context: 'aiPrompt',
  instructions: 'aiPrompt',
  feedback: 'aiPrompt',
  notes: 'aiPrompt',
});

/**
 * Middleware that validates comment/feedback input.
 */
export const validateCommentInput = validateFieldLengths({
  content: 'comment',
  text: 'comment',
});
