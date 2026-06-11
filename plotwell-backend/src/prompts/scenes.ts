/**
 * Scene Generation, Refinement & Transformation Prompts
 * Source: routes/ai/scenes.ts
 */

import { PromptConfig } from './types';
import { FORMAT_EXAMPLE, JSON_FORMAT_REQUIREMENTS } from './shared';

// =============================================================================
// CONFIGS
// =============================================================================

export const SCENE_GENERATOR_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 32768,
  requestType: 'generation',
};

export const SCENE_REFINER_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 16384,
  requestType: 'generation',
};

export const SCENE_TRANSFORMER_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 32768,
  requestType: 'generation',
};

export const PARAGRAPH_TRANSFORMER_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 4096, // Dynamic: Math.min(text.length * 3, 4096)
  requestType: 'generation',
};

// =============================================================================
// SYSTEM MESSAGES
// =============================================================================

export const SCENE_GENERATOR_SYSTEM = "You are a professional screenplay scene generator. Generate only valid screenplay JSON for scenes. CRITICAL: Your response must be a COMPLETE, valid JSON object. Always ensure you close all brackets and braces. Keep scenes concise (12-20 paragraphs) to ensure completion. Never truncate - if running long, end the scene naturally with proper JSON closure.";

export const SCENE_REFINER_SYSTEM = "You are a professional screenplay editor. Modify scenes based on user feedback while maintaining professional quality.";

export const SCENE_TRANSFORMER_SYSTEM = "You are a professional screenplay editor. Transform scenes exactly as requested while maintaining screenplay JSON format and conventions.";

export const PARAGRAPH_TRANSFORMER_SYSTEM = "You are a professional screenplay editor. Transform text exactly as requested while maintaining screenplay formatting standards.";

// =============================================================================
// SCENE GENERATOR V1
// =============================================================================

interface SceneGeneratorParams {
  sceneDescription: string;
  language: string;
  contextText: string;
  characterContext: string;
  documentsContext: string;
  locationsContext: string;
  scriptContext: string;
  conversationContextText: string;
  previousSceneContext: string;
  stylePreferences: string | null;
  formatGuidance?: string; // Project-format-specific writing guidance (e.g. vertical short-form)
}

/** Format-aware scene-writing guidance keyed off project type. */
export function sceneFormatGuidance(projectType?: string): string {
  if (projectType === 'vertical_series') {
    return `VERTICAL SHORT-FORM FORMAT (9:16 micro-drama):
- Keep the scene SHORT and punchy — aim for ~6-12 paragraph objects, fast in and out.
- Open on conflict or a hook; cut filler and long establishing action.
- Dialogue is brisk, high-emotion, and propulsive; favor reactions and reveals.
- Build toward a beat that could land on a cliffhanger; every line must earn its place.`;
  }
  return '';
}

export function buildSceneGeneratorPrompt(params: SceneGeneratorParams): string {
  return `SYSTEM FUNCTION: SCENE_GENERATOR_V1

You are a professional screenplay scene generator. Your PRIMARY task is to generate the scene described below.

========================================
PRIMARY REQUEST - GENERATE THIS SCENE:
========================================
${params.sceneDescription}
========================================

This is what the user wants. Everything below is SUPPORTING CONTEXT to help you write this scene accurately.
The scene you generate MUST match the user's description above. Use the context below to ensure consistency with the project, but the PRIMARY focus is the scene description.

LANGUAGE: Write in ${params.language.toUpperCase()}

--- SUPPORTING CONTEXT (use to maintain consistency) ---
${params.contextText}
${params.characterContext}
${params.documentsContext}
${params.locationsContext}
${params.scriptContext}
${params.conversationContextText}
${params.previousSceneContext}
--- END CONTEXT ---

STYLE: ${params.stylePreferences || 'Standard screenplay format'}
${params.formatGuidance ? `\n${params.formatGuidance}\n` : ''}
FORMATTING REQUIREMENTS:
- Generate exactly ONE scene that matches the PRIMARY REQUEST above
- Keep scenes CONCISE (12-20 paragraph objects maximum)
- Scene heading format: "INT. LOCATION - TIME OF DAY" or "EXT. LOCATION - TIME OF DAY" (uppercase)
- Reuse an existing project location name exactly when the scene takes place there
- Use "INT./EXT." only when the scene genuinely crosses between interior and exterior
- Character names in ALL UPPERCASE when speaking
- Action lines in present tense
- Prioritize COMPLETING the JSON over adding more content

Generate the scene in the following JSON format with proper screenplay formatting:
${FORMAT_EXAMPLE}

${JSON_FORMAT_REQUIREMENTS}`;
}

// =============================================================================
// SCENE REFINER V1
// =============================================================================

export const MODIFICATION_INSTRUCTIONS: Record<string, string> = {
  'refine': 'Improve the scene quality, dialogue, and pacing while maintaining the core story',
  'expand': 'Add more detail, action, and dialogue to make the scene longer and more developed',
  'shorten': 'Condense the scene while keeping the essential story elements',
  'restyle': 'Change the writing style or tone while keeping the same story content',
  'custom': 'Apply the provided feedback to improve the scene',
};

interface SceneRefinerParams {
  existingSceneContent: any;
  sceneHeading: string;
  feedback: string;
  modificationType: string;
  specificInstructions?: string;
}

export function buildSceneRefinerPrompt(params: SceneRefinerParams): string {
  const modInstruction = MODIFICATION_INSTRUCTIONS[params.modificationType] || params.specificInstructions || 'Apply the provided feedback to improve the scene';

  return `SYSTEM FUNCTION: SCENE_REFINER_V1
OPERATING MODE: SCENE_MODIFICATION

You are a professional screenplay editor. Modify the existing scene based on the feedback provided.

CURRENT SCENE CONTENT:
${JSON.stringify(params.existingSceneContent, null, 2)}

SCENE HEADING: ${params.sceneHeading}

USER FEEDBACK: ${params.feedback}

MODIFICATION TYPE: ${params.modificationType}
INSTRUCTIONS: ${modInstruction}

${params.specificInstructions ? `SPECIFIC INSTRUCTIONS: ${params.specificInstructions}` : ''}

REQUIREMENTS:
- Maintain the same JSON structure
- Keep the scene heading unless specifically asked to change it
- Apply the feedback thoughtfully and professionally
- Ensure the modified scene flows well and makes sense
- Preserve the screenplay formatting conventions

Generate the modified scene in the exact same JSON format:
{
  "type": "doc",
  "content": [
    // Modified scene content here
  ]
}

CRITICAL REQUIREMENTS:
- Start immediately with: {"type":"doc","content":[
- Only respond with valid JSON
- Apply the requested changes thoughtfully
- Ensure JSON is complete and properly formatted
- End with proper closing brackets: ]}`;
}

// =============================================================================
// SCENE TRANSFORMER V1
// =============================================================================

export const TRANSFORM_OPERATION_INSTRUCTIONS: Record<string, string | ((tone?: string, instructions?: string) => string)> = {
  'rephrase': 'Rewrite the scene with different wording and phrasing while preserving the exact same story beats, character interactions, and emotional arc. The scene should feel fresh but tell the same story.',
  'expand': 'Expand the scene by adding more detail, description, action, and dialogue. Develop the moments more fully. Add subtext and nuance to the characters. The scene should become richer and more cinematic.',
  'shorten': 'Condense the scene while keeping the essential story elements, key dialogue, and emotional beats. Remove unnecessary description and tighten the pacing. Keep it punchy and efficient.',
  'change-tone': (tone?: string) => `Change the tone of the scene to be more ${tone}. Adjust the dialogue style, action descriptions, and overall mood to match the ${tone} tone while keeping the same story events and character actions.`,
  'custom': (_tone?: string, instructions?: string) => instructions || 'Apply the provided instructions to modify the scene.',
};

interface SceneTransformerParams {
  operation: string;
  tone?: string;
  instructions?: string;
  sceneContent: any;
  positionContext: string;
  characterContext: string;
  documentsContext: string;
  locationsContext: string;
  scriptContext: string;
  contentLanguage: string;
}

export function getTransformOperationInstruction(operation: string, tone?: string, instructions?: string): string {
  const entry = TRANSFORM_OPERATION_INSTRUCTIONS[operation];
  if (typeof entry === 'function') {
    return entry(tone, instructions);
  }
  return entry || (instructions || 'Apply the provided instructions to modify the scene.');
}

export function buildSceneTransformerPrompt(params: SceneTransformerParams): string {
  const operationInstruction = getTransformOperationInstruction(params.operation, params.tone, params.instructions);

  return `SYSTEM FUNCTION: SCENE_TRANSFORMER_V1
OPERATING MODE: SCENE_TRANSFORMATION

You are a professional screenplay editor. Transform the following scene as requested while maintaining proper screenplay formatting.

OPERATION: ${params.operation.toUpperCase()}
INSTRUCTIONS: ${operationInstruction}

${params.operation === 'change-tone' ? `TARGET TONE: ${params.tone}` : ''}
${params.operation === 'custom' ? `USER INSTRUCTIONS: ${params.instructions}` : ''}

CURRENT SCENE CONTENT (screenplay JSON):
${JSON.stringify(params.sceneContent, null, 2)}

${params.positionContext}
${params.characterContext}
${params.documentsContext}
${params.locationsContext}
${params.scriptContext}

${params.contentLanguage !== 'en' ? `IMPORTANT: Generate the output in ${params.contentLanguage} language.` : ''}

REQUIREMENTS:
- Maintain the JSON structure with proper node types
- Use these node types: sceneHeading, action, character, dialogue, parenthetical, transition
- Keep the scene heading unless the operation specifically requires changing it
- Maintain continuity with the surrounding script
- Preserve character voices consistent with the project characters
- Apply the transformation thoughtfully and professionally

Generate the transformed scene in screenplay JSON format:
{
  "type": "doc",
  "content": [
    // Transformed scene content here
  ]
}

CRITICAL REQUIREMENTS:
- Start immediately with: {"type":"doc","content":[
- Only respond with valid JSON
- Ensure JSON is complete and properly formatted`;
}

// =============================================================================
// PARAGRAPH TRANSFORMER
// =============================================================================

export const PARAGRAPH_OPERATION_INSTRUCTIONS: Record<string, (paragraphType?: string) => string> = {
  'expand': (paragraphType?: string) => `Expand and elaborate on the following ${paragraphType || 'text'} while maintaining the same style and tone. Add more detail, description, and depth. Keep the same format and voice.`,
  'rewrite': (paragraphType?: string) => `Rewrite and improve the following ${paragraphType || 'text'} to be more compelling, clear, and professional. Maintain the core meaning but enhance the quality of the writing.`,
};

export const PARAGRAPH_GUIDELINES: Record<string, string> = {
  'action': 'This is screenplay action/description. Use present tense, active voice, and vivid but concise language.',
  'dialogue': 'This is screenplay dialogue. Make it natural, character-appropriate, and emotionally resonant.',
  'sceneHeading': 'This is a scene heading. Follow the format INT. LOCATION - TIME or EXT. LOCATION - TIME. Use INT./EXT. only for a scene that genuinely crosses both.',
  'character': 'This is a character name for dialogue attribution. Keep it in UPPERCASE.',
  'parenthetical': 'This is a parenthetical direction. Keep it brief and in parentheses.',
  'transition': 'This is a screenplay transition. Common formats: CUT TO:, FADE TO:, DISSOLVE TO:',
};

interface ParagraphTransformerParams {
  operation: 'expand' | 'rewrite';
  text: string;
  paragraphType?: string;
  contextBefore?: string;
  contextAfter?: string;
  contentLanguage: string;
}

export function buildParagraphTransformerPrompt(params: ParagraphTransformerParams): string {
  const operationInstruction = PARAGRAPH_OPERATION_INSTRUCTIONS[params.operation]?.(params.paragraphType)
    || `Transform the following ${params.paragraphType || 'text'}.`;
  const paragraphHint = params.paragraphType ? (PARAGRAPH_GUIDELINES[params.paragraphType] || '') : '';

  let contextHint = '';
  if (params.contextBefore || params.contextAfter) {
    contextHint = '\n\nContext:';
    if (params.contextBefore) contextHint += `\nBefore: "${params.contextBefore.slice(-200)}"`;
    if (params.contextAfter) contextHint += `\nAfter: "${params.contextAfter.slice(0, 200)}"`;
  }

  return `${operationInstruction}

${paragraphHint}
${contextHint}

Original text:
"${params.text}"

${params.contentLanguage !== 'en' ? `IMPORTANT: Generate the output in ${params.contentLanguage} language.` : ''}

Provide ONLY the transformed text, nothing else. No explanations, no quotes, no formatting markers. Just the improved text.`;
}
