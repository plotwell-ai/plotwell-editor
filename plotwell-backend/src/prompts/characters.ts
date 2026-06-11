/**
 * Character Extraction & Image Generation Prompts
 * Source: routes/ai/characters.ts
 */

import { PromptConfig } from './types';
import {
  CHARACTER_JSON_FORMAT,
  CHARACTER_APPEARANCE_SPLIT_RULE,
  CHARACTER_TYPE_OPTIONS,
  PRIMARY_ROLE_OPTIONS,
  VISUAL_STYLE_PRESETS,
  resolveVisualStyleId,
  buildStyleEnforcement,
  SUBJECT_FIDELITY,
  WARDROBE_FIDELITY,
  SIMPLE_IMAGE_PROMPTS,
} from './shared';

// =============================================================================
// CONFIGS
// =============================================================================

export const CHARACTER_EXTRACTION_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 16384,
  requestType: 'extraction',
};

export const CHARACTER_IMAGE_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'flux.2-klein-4b',
  temperature: 0, // N/A for image models
  maxTokens: 0, // N/A for image models
  requestType: 'generation',
};

// =============================================================================
// SYSTEM MESSAGES
// =============================================================================

export const DOCUMENTS_TO_CHARACTERS_SYSTEM = "You are a precise text analysis assistant. Your job is to carefully extract only the characters explicitly mentioned in conversations, not to create new ones. Always output valid JSON.";

export const SCRIPT_TO_CHARACTERS_SYSTEM = "You are a professional script analyst specializing in character analysis. Always output valid JSON.";

// =============================================================================
// DOCUMENTS-TO-CHARACTERS PROMPT
// =============================================================================

interface DocumentsToCharactersParams {
  projectType: string;
  scriptText: string;
  conceptText: string;
  fullConversation: string;
  existingCharactersList: string | null;
  languageInstructions: string;
}

export function buildDocumentsToCharactersPrompt(params: DocumentsToCharactersParams): string {
  return `
TASK: Find all characters mentioned in this ${params.projectType === "film" ? "film" : "video"} project and return detailed character information as JSON.

${params.existingCharactersList ? `
EXISTING CHARACTERS (DO NOT EXTRACT THESE AGAIN):
${params.existingCharactersList}

CRITICAL: Only extract NEW characters that are NOT in the existing list above. If a character already exists, skip it completely.

` : ""}

SOURCES TO ANALYZE:

${params.scriptText ? `
=== SCRIPT CONTENT ===
${params.scriptText}

` : ""}

${params.conceptText ? `
=== CONCEPT/TREATMENT ===
${params.conceptText}

` : ""}

=== BRAINSTORMING CONVERSATION ===
${params.fullConversation}

INSTRUCTIONS:
1. ${params.existingCharactersList ? 'Extract ONLY NEW characters not in the existing list above' : 'Extract EVERY character mentioned in any source above'}
2. Look for names, roles, descriptions, and character details
3. ${params.scriptText ? 'PRIORITIZE SCRIPT - use dialogue cue names (all-caps above dialogue) as the canonical character name, not the full name from action lines' : 'Focus on characters discussed in conversation and concept'}
4. Combine information from all sources for each character
5. Include both speaking and non-speaking characters if they're important

${CHARACTER_APPEARANCE_SPLIT_RULE}

REQUIRED JSON FORMAT:
${CHARACTER_JSON_FORMAT}

CHARACTER_TYPE OPTIONS: ${CHARACTER_TYPE_OPTIONS}
IMPORTANT: Do NOT use "supporting" as character_type - it is not valid. Use "minor" instead.
PRIMARY_ROLE OPTIONS: ${PRIMARY_ROLE_OPTIONS}
IMPORTANCE_LEVEL: 1-5 (1=background, 5=main protagonist)
STATUS OPTIONS: "active", "deceased", "missing", "introduced_later"

CRITICAL: Return ONLY valid JSON array. NO explanations, NO markdown, NO extra text.
If no characters found, return: []${params.languageInstructions}`;
}

// =============================================================================
// SCRIPT-TO-CHARACTERS PROMPT
// =============================================================================

interface ScriptToCharactersParams {
  projectType: string;
  scriptText: string;
  existingCharactersList: string | null;
  languageInstructions: string;
}

export function buildScriptToCharactersPrompt(params: ScriptToCharactersParams): string {
  return `
Analyze this ${params.projectType === "film" ? "film screenplay" : "video script"} and extract ALL characters that appear in the script.

Script:
${params.scriptText}

${params.existingCharactersList ? `
EXISTING CHARACTERS (DO NOT EXTRACT THESE AGAIN):
${params.existingCharactersList}

CRITICAL: Only extract NEW characters that are NOT in the existing list above. If a character already exists, skip it completely.
` : ''}

INSTRUCTIONS:
- Find ALL characters mentioned in the script (speaking and non-speaking)
- ${params.existingCharactersList ? 'SKIP any characters that appear in the existing list above' : 'Extract all characters found'}
- CANONICAL NAME RULE: A character's name must come from their dialogue cue line (the all-caps name that appears directly above their dialogue). This is ALWAYS the correct name. For example, if a character speaks as "WILL" in dialogue cues but is introduced in an action line as "WILL BLOOM, 30s", their name is "WILL".
- Action lines and scene descriptions may contain full names or descriptions, but never override the dialogue cue name — use that context only for background/non-speaking characters who never have a dialogue cue.
- DEDUPLICATION RULE: If a name from an action line appears to be the full name of a character who already has a dialogue cue (e.g., "EDWARD BLOOM" in an action line and "EDWARD" as a dialogue cue), treat them as the SAME character. Use the dialogue cue name ("EDWARD") and enrich the description with context from the action line. Never create two separate entries for the same person.
- Extract both named characters and important unnamed roles (e.g., "WAITER", "POLICE OFFICER")
- Analyze their roles, importance, and story function based on their presence in the script

For each character found, provide detailed analysis:
- Name (exact name from script, or role if unnamed)
- Appearance (ONLY concrete physical/visual traits for an image: species i.e. human/animal/creature, age, build, skin/fur/hair color and style, eye color, distinctive marks, and wardrobe ONLY if the script explicitly describes it. NO personality, NO role, NO story. Empty string if the script gives no physical detail — do NOT invent looks.)
- Description (personality, role in the story, behavior — NOT physical appearance)
- Character type (main, minor, ensemble, background) based on screen time and story impact
- Primary role (protagonist, antagonist, mentor, sidekick, love_interest, villain, hero, etc.)
- Importance level (1-5) based on dialogue amount and story impact
- Status in story (active, deceased, missing, introduced_later) if determinable
- Story arc (character journey/development if apparent)
- Motivations (what drives them based on dialogue/actions)
- Fears (what they fear based on script content)
- Goals (what they want to achieve based on script)

Return as a JSON array:
[
  {
    "name": "Character Name",
    "appearance": "Concrete physical/visual traits only (species, age, build, coloring, distinctive features, wardrobe if stated). Empty string if none in the script.",
    "description": "Personality, role, and behavior — NOT physical appearance",
    "character_type": "main|minor|ensemble|background",
    "primary_role": "protagonist|antagonist|mentor|sidekick|love_interest|villain|hero|anti_hero|deuteragonist|comic_relief|rival|character",
    "importance_level": 1-5,
    "status": "active|deceased|missing|introduced_later",
    "story_arc": "Character development journey or null",
    "motivations": "Character motivations or null",
    "fears": "Character fears or null",
    "goals": "Character goals or null"
  }
]

${CHARACTER_APPEARANCE_SPLIT_RULE}

ANALYSIS GUIDELINES:
- MAIN characters: protagonists, central figures with major story arcs
- SUPPORTING: important secondary characters with significant dialogue/scenes
- MINOR: characters with some dialogue but limited story impact
- ENSEMBLE: part of a main group but individual importance varies
- BACKGROUND: minimal dialogue, functional roles only

Return only valid JSON, no markdown or explanations.${params.languageInstructions}`;
}

// =============================================================================
// CHARACTER IMAGE PROMPTS
// =============================================================================

interface CharacterImageParams {
  characterName: string;
  descriptionPart: string;
  elementPromptSection: string;
  imageStyle: string;
  imageContext: string;
  ageAnchor: string;
  hasReference: boolean;
  similarityPercent?: number;
}

export function buildCharacterImagePrompt(params: CharacterImageParams): string {
  // Style comes from the project-wide registry (anchor leads, enforcement closes).
  // SUBJECT/WARDROBE fidelity keep non-human characters natural and stop the model
  // from turning role words ("criminal mastermind") into invented armor/uniforms.
  const styleId = resolveVisualStyleId(params.imageStyle);
  const styleAnchor = VISUAL_STYLE_PRESETS[styleId].anchor;
  const enforcement = buildStyleEnforcement(styleId);

  // Animals must stay natural. "Character portrait" framing + stylized 3D pushes the
  // model toward anthropomorphic, clothed, bipedal animals (Puss-in-Boots), so we use
  // neutral "subject" framing and an explicit anti-anthropomorphization negative.
  // These negatives only trigger on animals; human characters are unaffected.
  const antiAnthro = ' Keep any animal in its natural anatomy and posture (four legs where appropriate); not anthropomorphic, not upright or bipedal, no human body, hands, or facial expressions.';

  // Experiment: short prompt — anchor + subject + the (load-bearing) fidelity rules,
  // dropping reinforcement and the long negative list.
  if (SIMPLE_IMAGE_PROMPTS) {
    return `${styleAnchor}. ${params.ageAnchor}Portrait of ${params.characterName}.${params.descriptionPart} ${SUBJECT_FIDELITY} ${WARDROBE_FIDELITY}${antiAnthro}${params.elementPromptSection}${params.imageContext} No text, no watermarks.`;
  }

  if (params.hasReference) {
    return `A single-subject portrait. ${styleAnchor}. ${params.ageAnchor}Subject: ${params.characterName}.${params.descriptionPart} ${SUBJECT_FIDELITY} ${WARDROBE_FIDELITY}${antiAnthro}${params.elementPromptSection} Style intensity: ${params.similarityPercent || 70}%.${params.imageContext} Convey personality through expression and pose, not through invented costume.${enforcement} No collage, no grid, no split-screen, no multiple panels, no montage, no age progression. No text, no labels, no watermarks.`;
  }

  return `A single-subject portrait. ${styleAnchor}. ${params.ageAnchor}Portrait of ${params.characterName}.${params.descriptionPart} ${SUBJECT_FIDELITY} ${WARDROBE_FIDELITY}${antiAnthro}${params.elementPromptSection}${params.imageContext} Focus on the subject's defining physical features.${enforcement} No collage, no grid, no split-screen, no multiple panels, no montage, no age progression. No text, no labels, no watermarks.`;
}

// =============================================================================
// CHARACTER VIEW (turnaround / multi-angle) PROMPT
// =============================================================================
//
// Generates additional camera angles of an ALREADY-DEFINED character from their
// primary reference image. The point is identity-locked reference coverage
// (front/3-4/profile) so downstream storyboard + image-to-video keep the face
// consistent across shots. Run with the cheap fallback image model at 100%
// reference strength.

export const CHARACTER_VIEW_ANGLES = ['front', 'three-quarter', 'profile', 'back', 'full-body'] as const;
export type CharacterViewAngle = typeof CHARACTER_VIEW_ANGLES[number];

const CHARACTER_VIEW_ANGLE_DESC: Record<CharacterViewAngle, string> = {
  'front':         'front view, facing the camera directly, neutral expression',
  'three-quarter': 'three-quarter view, head and body turned roughly 45 degrees away from the camera',
  'profile':       'full side profile, face turned 90 degrees to the side',
  'back':          'rear view seen from behind, head turned slightly toward the camera',
  'full-body':     'full-body shot from head to toe, standing in a relaxed neutral pose',
};

export function buildCharacterViewPrompt(params: {
  characterName: string;
  angle: string;
  descriptionPart?: string;
  ageAnchor?: string;
  imageStyle?: string;
}): string {
  const angleDesc = CHARACTER_VIEW_ANGLE_DESC[params.angle as CharacterViewAngle] || CHARACTER_VIEW_ANGLE_DESC['three-quarter'];
  const framing = params.angle === 'full-body' ? 'full-body' : 'portrait';
  const styleId = resolveVisualStyleId(params.imageStyle);
  return `A single ${framing} reference image of the SAME single subject shown in the reference image. ${VISUAL_STYLE_PRESETS[styleId].anchor}. ${params.ageAnchor || ''}${angleDesc}. Preserve their EXACT identity, face/head shape, features, coloring, age, build, and wardrobe from the reference; ONLY the camera angle and pose change. If the reference subject is an animal, creature, robot, or other non-human being, keep it as that being and do not make it human.${params.descriptionPart || ''} Plain neutral studio background, even soft lighting, character reference-sheet quality.${buildStyleEnforcement(styleId)} No collage, no grid, no split-screen, no multiple panels, no montage, no age progression, no text, no labels, no watermarks.`;
}
