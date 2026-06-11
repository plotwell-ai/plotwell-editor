/**
 * Plotwell Prompt Management System
 *
 * Centralized prompt definitions organized by domain.
 * Each module exports:
 *   - PromptConfig objects (model, temperature, maxTokens, version)
 *   - System message constants
 *   - Builder functions for dynamic prompts
 *
 * Usage:
 *   import { buildSceneGeneratorPrompt, SCENE_GENERATOR_CONFIG } from '../prompts';
 *
 * Future: Integrate with LangFuse for A/B testing, versioning, and observability.
 */

// Types
export type { PromptConfig, PromptWithConfig } from './types';

// Shared constants
export {
  TIPTAP_FORMAT_EXAMPLE,
  TIPTAP_JSON_REQUIREMENTS,
  SCOPE_RESTRICTION_FILM,
  SCOPE_RESTRICTION_SERIES,
  NO_META_COMMENTARY,
  BRAINSTORMING_FORMAT,
  CHARACTER_TYPE_OPTIONS,
  PRIMARY_ROLE_OPTIONS,
  LOCATION_TYPE_OPTIONS,
  STORY_IMPORTANCE_OPTIONS,
  CHARACTER_JSON_FORMAT,
  CHARACTER_APPEARANCE_SPLIT_RULE,
  LOCATION_JSON_FORMAT,
  VISUAL_STYLE_PRESETS,
  resolveVisualStyleId,
  buildStyleEnforcement,
  buildVisualStyleAnchor,
  SUBJECT_FIDELITY,
  WARDROBE_FIDELITY,
  SIMPLE_IMAGE_PROMPTS,
} from './shared';
export type { VisualStyleId, VisualStylePreset } from './shared';

// Chat & Brainstorming
export {
  CHAT_CONFIG,
  CHAT_LANGUAGE_POLICY,
  SYSTEM_MESSAGE_DEFAULT,
  BRAINSTORMING_ROLE_FILM,
  BRAINSTORMING_ROLE_SERIES,
  BRAINSTORMING_ROLE_DEFAULT,
  BRAINSTORMING_FORMAT_FILM,
  BRAINSTORMING_FORMAT_SERIES,
  BRAINSTORMING_FORMAT_DEFAULT,
  CONTEXT_PROJECT_CONCEPT_FILM,
  CONTEXT_SCRIPT_FILM,
  CONTEXT_DEFAULT,
  TOOL_USE_INSTRUCTIONS,
  getBrainstormingPrompts,
  getContextPrompts,
} from './chat';

// Scene Generation
export {
  SCENE_GENERATOR_CONFIG,
  SCENE_REFINER_CONFIG,
  SCENE_TRANSFORMER_CONFIG,
  PARAGRAPH_TRANSFORMER_CONFIG,
  SCENE_GENERATOR_SYSTEM,
  SCENE_REFINER_SYSTEM,
  SCENE_TRANSFORMER_SYSTEM,
  PARAGRAPH_TRANSFORMER_SYSTEM,
  MODIFICATION_INSTRUCTIONS,
  TRANSFORM_OPERATION_INSTRUCTIONS,
  PARAGRAPH_OPERATION_INSTRUCTIONS,
  PARAGRAPH_GUIDELINES,
  buildSceneGeneratorPrompt,
  sceneFormatGuidance,
  buildSceneRefinerPrompt,
  buildSceneTransformerPrompt,
  buildParagraphTransformerPrompt,
  getTransformOperationInstruction,
} from './scenes';

// Character Extraction
export {
  CHARACTER_EXTRACTION_CONFIG,
  CHARACTER_IMAGE_CONFIG,
  DOCUMENTS_TO_CHARACTERS_SYSTEM,
  SCRIPT_TO_CHARACTERS_SYSTEM,
  buildDocumentsToCharactersPrompt,
  buildScriptToCharactersPrompt,
  buildCharacterImagePrompt,
  buildCharacterViewPrompt,
  CHARACTER_VIEW_ANGLES,
} from './characters';
export type { CharacterViewAngle } from './characters';

// Location Extraction
export {
  LOCATION_EXTRACTION_CONFIG,
  LOCATION_IMAGE_CONFIG,
  DOCUMENTS_TO_LOCATIONS_SYSTEM,
  SCRIPT_TO_LOCATIONS_SYSTEM,
  buildDocumentsToLocationsPrompt,
  buildScriptToLocationsPrompt,
  buildLocationImagePrompt,
} from './locations';

// Document Generation
export {
  DOCUMENT_GENERATION_CONFIG,
  DOCUMENT_GENERATION_SYSTEM,
  getDocumentInstructions,
  buildDocumentGenerationPrompt,
  calculateDocumentTokens,
} from './documents';

// Storyboard Generation
export {
  SCENE_TO_STORYBOARD_CONFIG,
  STORYBOARD_SYSTEM,
  SHOT_COMPOSITION,
  CAMERA_STYLE,
  LIGHTING_STYLES,
  MOOD_STYLES,
  buildSceneToStoryboardPrompt,
  buildStoryboardImagePrompt,
  buildVideoMotionPrompt,
  buildCharacterPromptDescription,
  buildLocationPromptDescription,
  buildEnhancedSceneDescription,
} from './storyboards';
export type { StoryboardFidelity, StoryboardVisualStyle, StoryboardImagePromptParams, VideoMotionPromptParams } from './storyboards';

// Beat Sheet
export {
  BEAT_SUGGEST_CONFIG,
  BEAT_ANALYZE_CONFIG,
  BEAT_EXPAND_CONFIG,
  BEAT_DESCRIPTION_CONFIG,
  BEAT_SUGGEST_SYSTEM,
  BEAT_ANALYZE_SYSTEM,
  BEAT_EXPAND_SYSTEM,
  BEAT_DESCRIPTION_SYSTEM,
  buildBeatSuggestPrompt,
  buildBeatAnalyzePrompt,
  buildBeatExpandPrompt,
  buildBeatDescriptionPrompt,
} from './beats';

// Agent Writer (autonomous screenplay generation)
export {
  AGENT_PLAN_CONFIG,
  AGENT_SCENE_CONFIG,
  AGENT_REVIEW_CONFIG,
  AGENT_REVISION_CONFIG,
  AGENT_PLANNER_SYSTEM,
  AGENT_SCENE_WRITER_SYSTEM,
  AGENT_REVIEWER_SYSTEM,
  AGENT_REVISER_SYSTEM,
  buildAgentPlanPrompt,
  buildAgentScenePrompt,
  buildAgentReviewPrompt,
  buildAgentRevisionPrompt,
} from './agent';

// Production Analysis
export {
  SHOT_LIST_CONFIG,
  BUDGET_OPTIMIZATION_CONFIG,
  buildBudgetOptimizationSystem,
  buildShotListPrompt,
  buildBudgetOptimizationPrompt,
} from './production';
