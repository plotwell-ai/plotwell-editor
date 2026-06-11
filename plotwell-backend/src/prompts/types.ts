/**
 * Prompt Management System - Type Definitions
 *
 * Centralized types for the prompt system.
 * Each prompt has a config with model, temperature, maxTokens, and version.
 * Version is a string identifier used for tracking and future A/B testing.
 */

export interface PromptConfig {
  /** Version identifier for this prompt (e.g., 'v1', 'v2-concise') */
  version: string;
  /** Model to use (e.g., 'grok'). null = use default routing */
  model: string | null;
  /** Temperature for generation (0-1) */
  temperature: number;
  /** Max output tokens */
  maxTokens: number;
  /** Request type for AI model router */
  requestType: 'generation' | 'extraction' | 'chat';
}

export interface PromptWithConfig {
  prompt: string;
  systemMessage: string;
  config: PromptConfig;
}
