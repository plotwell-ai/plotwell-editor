/**
 * Storyboard Generation Prompts
 *
 * Contains prompts for:
 * - Scene-to-storyboard panel generation (text AI)
 * - Storyboard image generation (image AI)
 * - Enhanced description assembly (characters, locations, custom instructions)
 */

import { PromptConfig } from './types';
import { VISUAL_CONTINUITY_REQUIREMENTS, VISUAL_STYLE_PRESETS, resolveVisualStyleId, buildStyleEnforcement, SIMPLE_IMAGE_PROMPTS, type VisualStyleId } from './shared';

// =============================================================================
// CONFIGS
// =============================================================================

export const SCENE_TO_STORYBOARD_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 4096,
  requestType: 'generation',
};

// =============================================================================
// SYSTEM MESSAGES
// =============================================================================

export const STORYBOARD_SYSTEM = "You are a professional storyboard artist and cinematographer. Return only valid JSON arrays, no markdown or explanations.";

// =============================================================================
// SHOT & CAMERA MAPPINGS
// =============================================================================

export const SHOT_COMPOSITION: Record<string, string> = {
  'extreme-wide':     'extreme wide shot, very distant view showing the entire environment',
  'wide-shot':        'wide shot, full scene and environment visible',
  'medium-shot':      'medium shot, waist-up framing of characters',
  'close-up':         'close-up shot, tight framing on face showing emotion',
  'extreme-close-up': 'extreme close-up, very tight framing on eyes or small detail',
  'over-shoulder':    'over-the-shoulder shot, view from behind one character looking past them',
  'point-of-view':    "point-of-view shot, subjective camera from character's perspective",
  'two-shot':         'two-shot, both characters framed together in the same shot',
  'insert':           'insert shot, isolated close-up detail of an object or action',
  'cutaway':          'cutaway shot, reaction or detail shot away from the main action',
  'tracking':         'tracking shot composition, camera follows moving subject',
  'bird-eye':         "bird's eye view, aerial top-down perspective",
  'low-angle':        'low angle shot, camera looking up at the subject, subject appears powerful',
  'high-angle':       'high angle shot, camera looking down at the subject, subject appears small',
};

export const CAMERA_STYLE: Record<string, string> = {
  'static':    'static camera, stable fixed composition',
  'pan':       'smooth horizontal pan across the scene',
  'pan-left':  'smooth pan left, camera sweeps horizontally to the left',
  'pan-right': 'smooth pan right, camera sweeps horizontally to the right',
  'tilt':      'smooth vertical tilt movement',
  'tilt-up':   'tilt up, camera tilts upward revealing height',
  'tilt-down': 'tilt down, camera tilts downward',
  'zoom':      'zoom movement, adjusting focal length',
  'zoom-in':   'slow zoom in, pushing closer to subject',
  'zoom-out':  'slow zoom out, pulling back from subject',
  'dolly':     'dolly shot, physical camera movement through space',
  'dolly-in':  'slow dolly push in, camera physically moves toward the subject',
  'dolly-out': 'dolly pull out, camera physically moves away from subject',
  'tracking':  'tracking shot, camera follows the moving subject',
  'handheld':  'handheld camera, organic imperfect movement with slight shake',
  'steadicam': 'steadicam, fluid gliding camera movement following action',
  'crane':     'crane shot, sweeping vertical or arcing camera movement from above',
};

// Auto-derived depth of field + focal length based on shot type
const SHOT_OPTICS: Record<string, { dof: string; focal: string }> = {
  'extreme-wide':     { dof: 'deep focus, everything sharp front to back',                          focal: '14mm ultra-wide angle lens' },
  'wide-shot':        { dof: 'deep focus, full environment sharp',                                   focal: '24mm wide angle lens' },
  'medium-shot':      { dof: 'moderate depth of field',                                              focal: '35mm lens' },
  'over-shoulder':    { dof: 'moderate depth of field, foreground shoulder slightly soft',           focal: '50mm lens' },
  'two-shot':         { dof: 'moderate depth of field, both subjects sharp',                         focal: '35mm lens' },
  'tracking':         { dof: 'moderate depth of field',                                              focal: '35mm lens' },
  'cutaway':          { dof: 'moderate to shallow depth of field',                                   focal: '50mm lens' },
  'high-angle':       { dof: 'deep focus',                                                           focal: '24mm wide angle lens' },
  'low-angle':        { dof: 'moderate depth of field',                                              focal: '35mm lens' },
  'bird-eye':         { dof: 'deep focus, everything sharp',                                         focal: '24mm wide angle lens' },
  'point-of-view':    { dof: 'moderate depth of field',                                              focal: '35mm lens' },
  'close-up':         { dof: 'shallow depth of field, background beautifully blurred (bokeh)',       focal: '85mm portrait lens' },
  'extreme-close-up': { dof: 'extremely shallow depth of field, razor-thin focus plane',             focal: '100mm macro lens' },
  'insert':           { dof: 'very shallow depth of field, subject isolated from background',        focal: '100mm macro lens' },
};

// Lighting mood descriptors
export const LIGHTING_STYLES: Record<string, string> = {
  'natural':        'natural available light, soft and realistic',
  'golden-hour':    'warm golden hour light, long shadows, romantic glow',
  'blue-hour':      'cool blue twilight, soft diffused ambient light',
  'night':          'night exterior, dark atmosphere with practical light sources',
  'overcast':       'overcast day, soft flat diffused light, no harsh shadows',
  'high-key':       'high-key lighting, bright, low contrast, minimal shadows',
  'low-key':        'low-key lighting, deep shadows, high contrast, dark and moody',
  'backlit':        'strong backlight, subject silhouetted or rim-lit against bright source',
  'side-lit':       'dramatic side lighting, strong shadows sculpting the face and scene',
  'top-lit':        'overhead light, harsh top-down illumination, deep under-eye shadows',
  'practical':      'warm practical lights in frame, lamps and interior fixtures visible',
  'neon':           'neon light, saturated colored light sources, urban nighttime feel',
  'candlelight':    'warm flickering candlelight, intimate and dramatic',
  'interrogation':  'single hard source from above, harsh interrogation-style lighting',
};

// Visual mood descriptors
export const MOOD_STYLES: Record<string, string> = {
  'tense':      'tense, suspenseful atmosphere, tight composition',
  'romantic':   'romantic, warm and soft, intimate',
  'melancholic':'melancholic, quiet and reflective, subdued',
  'chaotic':    'chaotic, energetic, sense of urgency and disorder',
  'serene':     'peaceful and serene, calm and composed',
  'ominous':    'ominous and foreboding, dark undercurrent',
  'joyful':     'joyful, bright and celebratory',
  'mysterious': 'mysterious, unknown, sense of intrigue',
  'epic':       'epic and grand, sweeping and cinematic',
  'intimate':   'intimate, close and personal, quiet emotion',
  'gritty':     'gritty, raw and realistic, unglamorous',
  'dreamlike':  'dreamlike, surreal, slightly unreal quality',
};

// =============================================================================
// SCENE-TO-STORYBOARD PROMPT (text AI)
// =============================================================================

interface SceneToStoryboardParams {
  sceneNumber: number;
  sceneHeading: string;
  sceneContent: string;
  panelCount: number;
  languageInstructions: string;
  videoFormat?: string; // '16:9' | '9:16' | '1:1' | '4:5'
}

export function buildSceneToStoryboardPrompt(params: SceneToStoryboardParams): string {
  const isVerticalFormat = params.videoFormat === '9:16' || params.videoFormat === '4:5';
  const verticalGuidance = isVerticalFormat
    ? `

VERTICAL FORMAT (${params.videoFormat}) — frame for a tall mobile screen:
- Favor close-ups, medium close-ups, and single-subject framing over wide ensemble shots.
- Compose vertically: stack action top-to-bottom, keep the key subject centered.
- Keep panels punchy and fast — short durations (2-4s) suit vertical short-form pacing.
- Prefer static, push-in, or handheld moves; avoid wide horizontal pans that fight the frame.`
    : '';
  return `
Analyze this single scene and create a detailed storyboard breakdown for it.

SCENE ${params.sceneNumber}: ${params.sceneHeading}

Scene Content:
${params.sceneContent}

Create a storyboard with ${params.panelCount} panels for this scene. For each panel, provide:
- Panel number (sequential, starting from 1)
- Scene description (2-3 sentences describing what happens visually in this specific panel)
- Shot type (choose from: extreme-wide, wide-shot, medium-shot, close-up, extreme-close-up, over-shoulder, point-of-view, two-shot, insert, cutaway, tracking, bird-eye, low-angle, high-angle)
- Camera movement (choose from: static, pan, pan-left, pan-right, tilt, tilt-up, tilt-down, zoom, zoom-in, zoom-out, dolly, dolly-in, dolly-out, tracking, handheld, steadicam, crane)
- Camera direction (one explicit, concrete sentence describing how the camera actually moves in THIS shot: where it starts, how it moves, the speed, and where it ends — e.g. "Slow dolly-in from a medium framing to a tight close-up on her eyes as the realization lands, easing to a stop." For a locked-off shot, say so explicitly: "Static lock-off, no camera movement." This drives the video animation, so be specific about the motion and avoid vague wording.)
- Duration in seconds (typically 3-8 seconds per panel)
- Notes (key dialogue line, character emotion, or important prop/action detail — 1 sentence max)
- Lighting (choose from: natural, golden-hour, blue-hour, night, overcast, high-key, low-key, backlit, side-lit, top-lit, practical, neon, candlelight, interrogation — pick the one that best fits the scene's tone and time of day)
- Mood (choose from: tense, romantic, melancholic, chaotic, serene, ominous, joyful, mysterious, epic, intimate, gritty, dreamlike — pick the dominant emotional atmosphere)

CINEMATOGRAPHY GUIDELINES:
- Vary shot types to create visual rhythm — avoid repeating the same shot consecutively
- Match lighting to the scene heading time-of-day (DAY → natural or high-key, NIGHT → low-key or practical, etc.)
- Close-ups and extreme close-ups work best for emotional beats and reactions
- Wide shots establish space; use them at scene start or for big reveals
- Use insert or cutaway shots for key props or reaction beats
- The "camera_direction" must agree with "camera_movement": describe the same move in plain, concrete cinematographer's language. Keep moves grounded and motivated by the action — no gratuitous or chaotic camera work.${verticalGuidance}

IMPORTANT: Focus only on THIS scene (${params.sceneHeading}). Break down the action within this scene into ${params.panelCount} clear visual moments.

Return as JSON array:
[
  {
    "panel_number": 1,
    "scene_description": "Description of what happens in this shot",
    "shot_type": "medium-shot",
    "camera_movement": "dolly-in",
    "camera_direction": "Slow dolly-in from a medium framing to a tight close-up as the realization lands, easing to a stop on the character's eyes.",
    "duration": "5",
    "notes": "Character slams the folder on the desk — anger breaking through",
    "lighting": "low-key",
    "mood": "tense"
  }
]

Only return the JSON array, no other text.${params.languageInstructions}`;
}

// =============================================================================
// STORYBOARD IMAGE PROMPT (image AI)
// =============================================================================

const NO_TEXT_INSTRUCTION = `No text, no words, no letters, no signs, no captions, no watermarks in the image.`;

// Sketch is a fidelity (quick B&W draft), not a project visual style — its negative
// list is kept local. The color visual-style negatives live in VISUAL_STYLE_PRESETS.
const NEGATIVE_PROMPT_CINEMATIC = VISUAL_STYLE_PRESETS.cinematic.negative;

export type StoryboardFidelity = 'sketch' | 'cinematic';
export type StoryboardVisualStyle = VisualStyleId;

export interface StoryboardImagePromptParams {
  sceneDescription: string;
  shotType?: string;
  cameraMovement?: string;
  /**
   * Explicit per-shot camera move. Intentionally NOT injected into the still
   * prompt (movement text causes motion blur / ghosting in a single frame) — it
   * flows to the video motion prompt instead. Accepted here for API symmetry.
   */
  cameraDirection?: string;
  fidelity: StoryboardFidelity;
  lighting?: string;
  mood?: string;
  notes?: string;
  sceneHeading?: string; // e.g. "INT. COFFEE SHOP - DAY" or "EXT. PLAYA - DÍA" — included as-is for context
  aspectRatio?: string; // '16:9' | '9:16' | '1:1' | '4:5' — drives vertical composition guidance
  visualStyle?: StoryboardVisualStyle | string;
}

/** Composition guidance injected when the panel is framed vertically (9:16 / 4:5). */
function verticalFramingHint(aspectRatio?: string): string | null {
  if (aspectRatio === '9:16' || aspectRatio === '4:5') {
    return `Vertical ${aspectRatio} composition, mobile-first framing: tall portrait orientation, subject centered and stacked vertically, foreground/background layered top-to-bottom, headroom above and negative space below.`;
  }
  return null;
}

export function buildStoryboardImagePrompt(params: StoryboardImagePromptParams): string {
  const shotDesc = params.shotType ? (SHOT_COMPOSITION[params.shotType] || 'medium shot') : 'medium shot';
  const cameraDesc = params.cameraMovement ? (CAMERA_STYLE[params.cameraMovement] || 'static camera') : 'static camera';
  const optics = params.shotType ? (SHOT_OPTICS[params.shotType] || null) : null;
  const lightingDesc = params.lighting ? (LIGHTING_STYLES[params.lighting] || null) : null;
  const moodDesc = params.mood ? (MOOD_STYLES[params.mood] || null) : null;
  const verticalHint = verticalFramingHint(params.aspectRatio);
  const visualStyle = params.visualStyle || params.fidelity;
  const styleId = resolveVisualStyleId(visualStyle);
  const stylePreset = VISUAL_STYLE_PRESETS[styleId];

  // Include scene heading as-is — works in any language, image models understand screenplay notation
  const headingPrefix = params.sceneHeading ? `[${params.sceneHeading}] ` : '';

  if (params.fidelity === 'sketch') {
    // "Sketch" is rendered as a grayscale cinematic still — FLUX fights any "drawing/sketch/illustration"
    // instruction and reverts to anime/cartoon. Anchoring with photorealistic + monochrome gives a clean
    // black-and-white film look that reads as a proper storyboard panel without the stylization problem.
    const lines: string[] = [];
    lines.push(`RAW photo, black and white, monochrome, ${shotDesc}: ${headingPrefix}${params.sceneDescription}. ${cameraDesc}.`);
    if (optics) lines.push(`${optics.focal}, ${optics.dof}.`);
    if (lightingDesc) lines.push(`${lightingDesc}.`);
    if (moodDesc) lines.push(`${moodDesc}.`);
    if (params.notes?.trim()) lines.push(`${params.notes.trim()}.`);
    if (verticalHint) lines.push(`${verticalHint}`);
    lines.push(VISUAL_CONTINUITY_REQUIREMENTS);
    lines.push(`\nFilm noir, high contrast black and white photography. Shot on ARRI Alexa, real actors, real location. Photorealistic. No color. No stylization.`);
    lines.push(`\nNegative: ${NEGATIVE_PROMPT_CINEMATIC}`);
    lines.push(`${NO_TEXT_INSTRUCTION}`);
    return lines.join('\n');
  }

  // Experiment: short prompt — style anchor + shot + scene + lighting/mood only.
  if (SIMPLE_IMAGE_PROMPTS) {
    const parts = [`${stylePreset.anchor}, ${shotDesc}: ${headingPrefix}${params.sceneDescription}. ${cameraDesc}.`];
    if (lightingDesc) parts.push(`${lightingDesc}.`);
    if (moodDesc) parts.push(`${moodDesc}.`);
    if (params.notes?.trim()) parts.push(`${params.notes.trim()}.`);
    if (verticalHint) parts.push(verticalHint);
    parts.push(NO_TEXT_INSTRUCTION);
    return parts.join(' ');
  }

  // Color render in the project's visual style (cinematic, 3D, anime, noir, …)
  const lines: string[] = [];

  // Open with the style anchor — placing it first steers the model into the look
  lines.push(`${stylePreset.anchor}, ${shotDesc}: ${headingPrefix}${params.sceneDescription}. ${cameraDesc}.`);

  // Optics
  if (optics) {
    lines.push(`${optics.focal}, ${optics.dof}.`);
  }

  // Lighting
  if (lightingDesc) {
    lines.push(`${lightingDesc}.`);
  }

  // Mood
  if (moodDesc) {
    lines.push(`${moodDesc}.`);
  }

  // Notes
  if (params.notes?.trim()) {
    lines.push(`${params.notes.trim()}.`);
  }

  // Vertical composition (9:16 / 4:5)
  if (verticalHint) {
    lines.push(`${verticalHint}`);
  }

  // Style reinforcement — repeated late in the prompt to override any drift
  lines.push(VISUAL_CONTINUITY_REQUIREMENTS);
  lines.push(`\n${buildStyleEnforcement(styleId).trim()}`);
  lines.push(`${NO_TEXT_INSTRUCTION}`);

  return lines.join('\n');
}

// =============================================================================
// VIDEO MOTION PROMPT (image-to-video)
// =============================================================================

export interface VideoMotionPromptParams {
  sceneDescription: string;
  shotType?: string;
  cameraMovement?: string;
  /** Explicit per-shot camera move written during the breakdown — preferred over the enum lookup. */
  cameraDirection?: string;
  mood?: string;
  notes?: string;
  sceneHeading?: string;
  previousShotContext?: string;
}

/**
 * Build a motion-focused prompt for image-to-video generation.
 *
 * The panel's still already fixes composition, lighting, characters and setting
 * (it is passed as the first frame), so this prompt steers what MOVES: the
 * action in the scene and the camera move. We deliberately keep it short and
 * action-led — verbose restatement of the static frame tends to make I2V models
 * morph the image instead of animating it.
 */
export function buildVideoMotionPrompt(params: VideoMotionPromptParams): string {
  const enumCameraDesc = params.cameraMovement ? (CAMERA_STYLE[params.cameraMovement] || null) : null;
  const moodDesc = params.mood ? (MOOD_STYLES[params.mood] || null) : null;
  const headingPrefix = params.sceneHeading ? `[${params.sceneHeading}] ` : '';

  // Prefer the explicit per-shot camera direction written during the breakdown;
  // fall back to the enum lookup, then to a safe default. This is what makes the
  // generated clip actually follow the intended camera move.
  const cameraText = params.cameraDirection?.trim()
    || enumCameraDesc
    || 'subtle, stable camera with gentle natural movement';

  const lines: string[] = [];
  lines.push(`${headingPrefix}${params.sceneDescription}`.trim());
  if (params.notes?.trim()) lines.push(params.notes.trim());
  if (params.previousShotContext?.trim()) {
    lines.push(`Continuity from previous shot: ${params.previousShotContext.trim()}. First follow the current shot. If this shot continues the same moment/place, keep screen direction, character positions, wardrobe, props, lighting, location, and visual style consistent as it begins. If this shot jumps to a new time, location, angle, subject, or story beat, do not force the old staging; carry forward only relevant identity, wardrobe/prop, and visual-style continuity.`);
  }
  lines.push(`Camera move (follow exactly): ${cameraText}.`);
  if (moodDesc) lines.push(`Mood: ${moodDesc}.`);
  lines.push('Animate ONLY the natural motion of the existing subjects and the camera move described above. Do not invent new actions, characters, props, or scene changes. Motion must match the first frame exactly: same visual style, characters, faces, wardrobe, props, location, lighting, and aspect ratio. Natural believable movement, no morphing, no identity drift, no flicker, no text overlays.');

  return lines.join(' ');
}

// =============================================================================
// ENHANCED DESCRIPTION ASSEMBLY
// =============================================================================

interface CharacterDescriptionData {
  name: string;
  appearance?: string | null;
  elements?: { element_type: string; name?: string; description?: string }[];
}

interface LocationDescriptionData {
  description?: string | null;
  atmosphere?: string | null;
  visual_notes?: string | null;
}

interface CharacterDescriptionConfig {
  include_appearance: boolean;
  include_elements: boolean;
}

interface LocationDescriptionConfig {
  include_description: boolean;
  include_atmosphere: boolean;
  include_visual_notes: boolean;
}

/**
 * Build a single character's text description for an image prompt.
 * Avoids uppercase names and metadata-style labels that image models render as text.
 */
export function buildCharacterPromptDescription(
  character: CharacterDescriptionData,
  config: CharacterDescriptionConfig
): string {
  let charDesc = character.name;
  const details: string[] = [];

  if (config.include_appearance && character.appearance) {
    details.push(`appearance: ${character.appearance}`);
  }

  if (details.length > 0) {
    charDesc += ` (${details.join('. ')})`;
  }

  if (config.include_elements && character.elements && character.elements.length > 0) {
    const elementDescs = character.elements.map(el => {
      let elementDesc = el.element_type;
      if (el.name) elementDesc += ` "${el.name}"`;
      if (el.description) elementDesc += `: ${el.description}`;
      return elementDesc;
    });
    charDesc += `. Wearing/carrying: ${elementDescs.join(', ')}`;
  }

  return charDesc;
}

/**
 * Build location text description for an image prompt.
 * Uses "Setting:" prefix instead of location name to avoid text rendering.
 */
export function buildLocationPromptDescription(
  location: LocationDescriptionData,
  config: LocationDescriptionConfig
): string {
  const details: string[] = [];

  if (config.include_description && location.description) {
    details.push(location.description);
  }

  if (config.include_atmosphere && location.atmosphere) {
    details.push(`atmosphere: ${location.atmosphere}`);
  }

  if (config.include_visual_notes && location.visual_notes) {
    details.push(`visual details: ${location.visual_notes}`);
  }

  if (details.length === 0) return '';
  return `Setting: ${details.join('. ')}`;
}

/**
 * Assemble the final enhanced description from scene description,
 * character descriptions, location description, and custom instructions.
 */
export function buildEnhancedSceneDescription(params: {
  sceneDescription: string;
  characterDescriptions?: string[];
  locationDescription?: string;
  customInstructions?: string;
}): string {
  let description = params.sceneDescription;

  // Add character details after scene action
  if (params.characterDescriptions && params.characterDescriptions.length > 0) {
    description = `${description}. The people in the scene: ${params.characterDescriptions.join('; ')}`;
  }

  // Prepend location context
  if (params.locationDescription) {
    description = `${params.locationDescription}. ${description}`;
  }

  // Append custom instructions
  if (params.customInstructions?.trim()) {
    description += ` Additional details: ${params.customInstructions.trim()}.`;
  }

  return description;
}
