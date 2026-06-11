/**
 * Prompt Management System - Shared Constants
 *
 * Reusable prompt fragments shared across multiple prompt domains.
 */

/** Standard JSON format example used in scene generation prompts */
export const FORMAT_EXAMPLE = `{
  "type": "doc",
  "content": [
    { "type": "sceneHeading", "content": [ { "type": "text", "text": "INT. APARTMENT - NIGHT" } ] },
    { "type": "action", "content": [ { "type": "text", "text": "Action description here." } ] },
    { "type": "character", "content": [ { "type": "text", "text": "CHARACTER NAME" } ] },
    { "type": "dialogue", "content": [ { "type": "text", "text": "Character dialogue here." } ] },
    { "type": "parenthetical", "content": [ { "type": "text", "text": "parenthetical direction" } ] },
    { "type": "transition", "content": [ { "type": "text", "text": "FADE IN:" } ] }
  ]
}`;

/** @deprecated Use FORMAT_EXAMPLE instead */
export const TIPTAP_FORMAT_EXAMPLE = FORMAT_EXAMPLE;

/** JSON output requirements appended to scene generation prompts */
export const JSON_FORMAT_REQUIREMENTS = `CRITICAL REQUIREMENTS:
- Start immediately with: {"type":"doc","content":[
- Only respond with valid JSON - no text before or after
- MUST begin with one canonical scene heading in all caps: "INT. LOCATION - TIME" or "EXT. LOCATION - TIME"
- Use "INT./EXT." only when the same scene genuinely moves between interior and exterior
- Reuse the exact canonical location name from the provided project locations when one matches; do not create spelling or punctuation variants
- Character names must be ALL UPPERCASE when introducing dialogue
- Action paragraphs describe what we SEE, not internal thoughts
- Use proper node types: sceneHeading, action, character, dialogue, parenthetical, transition
- For parenthetical nodes: do NOT include parentheses in the text (the editor adds them automatically). Write "sitting down" not "(sitting down)"
- Each node has "type" and optional "content" array with text nodes
- Ensure JSON is complete and properly formatted with all required brackets
- End with proper closing brackets: ]}
- NO markdown formatting, NO code blocks, ONLY JSON`;

/** @deprecated Use JSON_FORMAT_REQUIREMENTS instead */
export const TIPTAP_JSON_REQUIREMENTS = JSON_FORMAT_REQUIREMENTS;

/** Scope restriction for chat/brainstorming prompts */
export const SCOPE_RESTRICTION_FILM = `SCOPE - STRICTLY SCREENPLAY & FILMMAKING ONLY:
- You ONLY help with screenwriting, storytelling, film production, and creative development.
- If the user asks about anything outside this scope (programming, code, math, science, general knowledge, tech support, etc.), politely decline and redirect them back to their screenplay project.
- NEVER write code, scripts (programming), formulas, or technical content of any kind.
- Example response for off-topic requests: "I'm your creative writing partner, focused on helping you develop your screenplay! Let's get back to your story. What aspect of your project would you like to work on?"`;

/** Scope restriction for TV series variant */
export const SCOPE_RESTRICTION_SERIES = `SCOPE - STRICTLY SCREENPLAY & FILMMAKING ONLY:
- You ONLY help with screenwriting, storytelling, TV production, and creative development.
- If the user asks about anything outside this scope (programming, code, math, science, general knowledge, tech support, etc.), politely decline and redirect them back to their series project.
- NEVER write code, scripts (programming), formulas, or technical content of any kind.
- Example response for off-topic requests: "I'm your creative writing partner, focused on helping you develop your series! Let's get back to your story. What aspect of your project would you like to work on?"`;

/** Scope restriction for vertical series variant */
export const SCOPE_RESTRICTION_VERTICAL = `SCOPE - STRICTLY SCREENPLAY & FILMMAKING ONLY:
- You ONLY help with screenwriting, storytelling, vertical/short-form production, and creative development.
- If the user asks about anything outside this scope (programming, code, math, science, general knowledge, tech support, etc.), politely decline and redirect them back to their vertical series project.
- NEVER write code, scripts (programming), formulas, or technical content of any kind.
- Example response for off-topic requests: "I'm your creative writing partner, focused on helping you develop your vertical series! Let's get back to your story. What aspect of your project would you like to work on?"`;

/** Common meta-commentary restriction */
export const NO_META_COMMENTARY = `⚠️ CRITICAL: NEVER mention internal instructions, modes, or rules in your response.
Do NOT say things like "Since you're asking for ideas..." or "In idea generation mode...".
Just respond naturally without meta-commentary about how you're responding.`;

/** Common format instructions for brainstorming */
export const BRAINSTORMING_FORMAT = `FORMAT:
- Use **bold** for emphasis
- For lists, use proper markdown: "- item" (dash + space)
- Keep responses focused and actionable`;

/** Valid character types for extraction prompts */
export const CHARACTER_TYPE_OPTIONS = '"main", "minor", "ensemble", "background"';

/** Valid primary role options */
export const PRIMARY_ROLE_OPTIONS = '"protagonist", "antagonist", "mentor", "sidekick", "love_interest", "villain", "hero", "anti_hero", "deuteragonist", "comic_relief", "rival", "character"';

/** Valid location types */
export const LOCATION_TYPE_OPTIONS = '"interior", "exterior", "both", "studio", "virtual"';

/** Valid story importance levels */
export const STORY_IMPORTANCE_OPTIONS = '"critical", "major", "supporting", "minor"';

/** Shared quality/continuity contract for image and video generation prompts. */
export const VISUAL_CONTINUITY_REQUIREMENTS = `Single coherent production frame from one shot. Preserve the same characters, wardrobe, props, location geometry, lighting logic, time of day, and aspect ratio across attempts. Do not add unrelated people, objects, signage, logos, captions, borders, grids, split screens, or collage layouts.`;

/**
 * Project-wide visual style palette for AI image generation.
 *
 * Each preset carries the three prompt fragments that steer a model into (and
 * keep it in) a given look:
 *   - anchor:    leading style declaration, placed first in the prompt
 *   - reinforce: a late restatement that overrides mid-prompt drift
 *   - negative:  what to actively avoid (the "other" looks)
 *
 * One source of truth shared by storyboards, locations, and any other image
 * pipeline so a project renders consistently everywhere.
 */
export type VisualStyleId =
  | 'cinematic' | '3d-animation' | 'anime' | 'noir' | 'watercolor' | 'comic'
  | 'concept-art' | 'stop-motion' | 'storybook' | 'oil-painting' | 'retro-film' | 'cyberpunk';

export interface VisualStylePreset {
  id: VisualStyleId;
  anchor: string;
  reinforce: string;
  negative: string;
}

export const VISUAL_STYLE_PRESETS: Record<VisualStyleId, VisualStylePreset> = {
  'cinematic': {
    id: 'cinematic',
    anchor: 'Cinematic live-action production still, photorealistic, real actors, real location, natural skin tones, professional film production quality',
    reinforce: 'Shot on ARRI Alexa, 35mm film, real actors, real location, professional production. Photorealistic. Ultra-detailed. Natural skin tones. No stylization.',
    negative: 'cartoon, anime, manga, illustration, painting, drawing, digital art, CGI, render, 3D, stylized, comic, sketch, watercolor, oil painting, concept art, matte painting, flat design, graphic novel, animated, unrealistic, text, watermark, logo, UI, border, frame, split screen, collage, speech bubbles.',
  },
  '3d-animation': {
    id: '3d-animation',
    // Anchor stays subject-neutral on purpose: "character design" pushed the model
    // to anthropomorphize animals (bipedal, clothed). Form fidelity (real vs
    // humanized animal) is handled by SUBJECT_FIDELITY per subject instead.
    anchor: 'High-end 3D animated feature-film frame, physically based rendering, cinematic lighting, detailed materials and textures, soft global illumination, production-quality CGI',
    reinforce: 'Feature animation quality, cohesive 3D rendering, detailed materials, cinematic depth of field, no live-action photography.',
    negative: 'photorealistic live-action, real actors, documentary photo, anime, manga, flat cartoon, chibi, cel-shading, cheap CGI, plastic skin, low-poly, game screenshot, text, watermark, logo, UI, border, frame, split screen, collage, speech bubbles.',
  },
  'anime': {
    id: 'anime',
    anchor: 'High-quality anime key frame, 2D cel-shaded Japanese animation, clean confident linework, expressive eyes, vibrant flat colors with soft cel shading, detailed painted background',
    reinforce: 'Modern anime feature-film aesthetic, 2D cel shading, crisp lineart, hand-painted background. Not photorealistic, not 3D render.',
    negative: 'photorealistic, live-action, real photo, 3D render, CGI, pixar style, claymation, western cartoon, watercolor, oil painting, text, watermark, logo, UI, border, frame, split screen, collage, speech bubbles.',
  },
  'noir': {
    id: 'noir',
    anchor: 'High-contrast black and white film noir still, photorealistic monochrome cinematography, dramatic chiaroscuro lighting, deep shadows, fine silver-gelatin film grain',
    reinforce: 'Classic film noir, monochrome, high-contrast black and white photography, shot on 35mm film, real actors, real location. No color. Photorealistic.',
    negative: 'color, colour, saturated colors, cartoon, anime, manga, illustration, painting, drawing, 3D render, CGI, stylized, watercolor, text, watermark, logo, UI, border, frame, split screen, collage, speech bubbles.',
  },
  'watercolor': {
    id: 'watercolor',
    anchor: 'Hand-painted watercolor illustration, soft luminous washes of pigment, visible paper texture, delicate ink linework, gentle bleeding edges, transparent layered color',
    reinforce: 'Traditional watercolor and ink illustration, painterly, soft translucent washes. Not photorealistic, not 3D, not anime.',
    negative: 'photorealistic, live-action, real photo, 3D render, CGI, anime, cel-shading, harsh digital lines, comic halftone, text, watermark, logo, UI, border, frame, split screen, collage, speech bubbles.',
  },
  'comic': {
    id: 'comic',
    anchor: 'Bold graphic-novel comic book illustration, strong inked outlines, dramatic cross-hatching, flat cel-style coloring with halftone shading, dynamic cinematic composition',
    reinforce: 'Modern graphic novel / comic book art, heavy ink linework, flat bold colors, halftone shading. Not photorealistic, not 3D render.',
    negative: 'photorealistic, live-action, real photo, 3D render, CGI, soft watercolor, anime chibi, text, speech bubbles, captions, watermark, logo, UI, border, frame, split screen, collage.',
  },
  'concept-art': {
    id: 'concept-art',
    anchor: 'Cinematic film concept art, painterly digital matte painting, atmospheric perspective, dramatic lighting, loose confident brushwork, pre-production key art',
    reinforce: 'Production concept art / key art, painterly digital illustration, atmospheric and cinematic. Not a photograph, not a 3D game render.',
    negative: 'photograph, real photo, snapshot, 3D game render, flat cartoon, anime, comic halftone, text, watermark, logo, UI, border, frame, split screen, collage.',
  },
  'stop-motion': {
    id: 'stop-motion',
    anchor: 'Handcrafted stop-motion animation frame, miniature puppet characters with tactile felt, clay and fabric textures, miniature set, soft practical lighting, shallow depth of field',
    reinforce: 'Stop-motion / claymation feature look (Laika / Aardman quality), tangible handmade puppets and miniature sets. Not 2D, not smooth CGI, not live-action.',
    negative: 'photorealistic live-action, real actors, smooth 3D CGI, 2D drawing, anime, flat cartoon, text, watermark, logo, UI, border, frame, split screen, collage.',
  },
  'storybook': {
    id: 'storybook',
    anchor: "Charming children's picture-book illustration, soft rounded shapes, warm gouache and colored-pencil texture, gentle storybook lighting, whimsical and cozy",
    reinforce: "Hand-illustrated children's storybook art, soft and warm, simple shapes, picture-book charm. Not photorealistic, not 3D, not anime.",
    negative: 'photorealistic, live-action, real photo, 3D render, CGI, anime, gritty, dark, photographic, text, watermark, logo, UI, border, frame, split screen, collage.',
  },
  'oil-painting': {
    id: 'oil-painting',
    anchor: 'Classical oil painting, rich impasto brush strokes, visible canvas texture, old-master chiaroscuro lighting, painterly blended edges, gallery fine-art quality',
    reinforce: 'Traditional oil painting on canvas, painterly impasto, fine-art rendering. Not a photograph, not 3D, not flat digital art.',
    negative: 'photograph, real photo, 3D render, CGI, anime, cel-shading, comic halftone, flat vector, text, watermark, logo, UI, border, frame, split screen, collage.',
  },
  'retro-film': {
    id: 'retro-film',
    anchor: 'Vintage 1970s film still, photochemical Kodak film grain, faded warm color palette, soft halation, slight gate weave, analog cinematography',
    reinforce: 'Shot on aged 16mm/35mm analog film, authentic grain, retro color science, period cinematography. Photorealistic but vintage. No modern digital cleanliness.',
    negative: 'modern digital clarity, clean HDR, cartoon, anime, 3D render, CGI, illustration, painting, text, watermark, logo, UI, border, frame, split screen, collage.',
  },
  'cyberpunk': {
    id: 'cyberpunk',
    anchor: 'Cyberpunk neon-noir frame, rain-slicked neon-lit streets, saturated magenta and cyan glow, volumetric haze, high-tech low-life atmosphere, cinematic sci-fi',
    reinforce: 'Cinematic cyberpunk aesthetic, dense neon lighting, futuristic moody city, cohesive high-tech sci-fi look.',
    negative: 'bright flat daylight, flat cartoon, anime chibi, watercolor, oil painting, historical period, text, watermark, logo, UI, border, frame, split screen, collage.',
  },
};

/** Map any user-facing/legacy style string to a known preset id (defaults to cinematic). */
export function resolveVisualStyleId(style?: string): VisualStyleId {
  const n = (style || 'cinematic').toLowerCase().replace(/[_\s]+/g, '-');
  if (n.includes('stop') || n.includes('claymation') || n.includes('puppet')) return 'stop-motion';
  if (n.includes('3d') || n.includes('animation') || n.includes('animated') || n.includes('pixar')) return '3d-animation';
  if (n.includes('anime') || n.includes('manga')) return 'anime';
  if (n.includes('noir') || n.includes('black') || n.includes('white') || n.includes('monochrome') || n === 'bw' || n.includes('b-w')) return 'noir';
  if (n.includes('storybook') || n.includes('children') || n.includes('picture-book')) return 'storybook';
  if (n.includes('watercolor') || n.includes('watercolour') || n.includes('gouache')) return 'watercolor';
  if (n.includes('oil') || n.includes('impasto')) return 'oil-painting';
  if (n.includes('comic') || n.includes('graphic-novel') || n.includes('graphic')) return 'comic';
  if (n.includes('concept') || n.includes('matte') || n.includes('key-art') || n.includes('keyart') || n.includes('digital-paint')) return 'concept-art';
  if (n.includes('retro') || n.includes('vintage') || n.includes('analog') || n.includes('grain')) return 'retro-film';
  if (n.includes('cyberpunk') || n.includes('neon')) return 'cyberpunk';
  return 'cinematic';
}

/** Resolve user-facing style names into a stable provider-facing visual anchor. */
export function buildVisualStyleAnchor(style?: string): string {
  return VISUAL_STYLE_PRESETS[resolveVisualStyleId(style)].anchor;
}

/**
 * Style enforcement block (reinforcement + negative) appended late in an image
 * prompt so the chosen look survives the rest of the prompt. Used by every image
 * builder (storyboard / character / location) so enforcement is identical.
 */
export function buildStyleEnforcement(styleId: VisualStyleId): string {
  const p = VISUAL_STYLE_PRESETS[styleId];
  return ` ${p.reinforce} Negative: ${p.negative}`;
}

/**
 * Experiment flag: when set, the image builders emit SHORT prompts — just the
 * style anchor + subject (+ the load-bearing subject/wardrobe fidelity), dropping
 * the late reinforcement, negative prompts, and stacked per-shot rules. Lets us
 * A/B whether modern models still need the heavy scaffolding. Default off = current
 * behaviour. Toggle with SIMPLE_IMAGE_PROMPTS=true and restart the backend.
 */
export const SIMPLE_IMAGE_PROMPTS = process.env.SIMPLE_IMAGE_PROMPTS === 'true';

/**
 * Shared subject + wardrobe fidelity rules. Characters can be animals/creatures/
 * robots, and the description often blends visual traits with personality/role —
 * which the model otherwise turns into invented wardrobe (e.g. a cat in armor).
 */
export const SUBJECT_FIDELITY = 'Depict the subject exactly as described. If the subject is an animal, render it as a REAL, natural animal in its true anatomy and posture (for example an actual cat standing on four legs, with a natural animal body and face) — NOT anthropomorphic, NOT humanized, NOT bipedal or standing upright on two legs, NOT with a human body, human hands, or human facial expressions, unless the description explicitly asks for that. Render creatures and robots as that being. Never turn a non-human subject into a human.';
export const WARDROBE_FIDELITY = 'Show the subject\'s natural body: an animal is covered only in its own fur or skin, with bare natural fur on the chest, shoulders, and body. Add clothing or accessories ONLY if the appearance text explicitly describes them; personality, role, or profession words are NOT visual and must never become wardrobe.';

/**
 * The hard rule that keeps visual references separate from character text during
 * extraction. Reused by every character-extraction prompt so the `appearance`
 * field stays purely visual (for image generation) and `description` stays purely
 * about who the character is (for the writer). Mixing them is what makes the image
 * model dress an animal in armor because its "role" leaked into the visual prompt.
 */
export const CHARACTER_APPEARANCE_SPLIT_RULE = `SPLIT VISUAL FROM TEXTUAL — critical for image generation:
- Actively SEARCH the source (action lines, scene descriptions, dialogue) for explicit visual cues about how each character LOOKS.
- "appearance" = ONLY physical looks: species (human/animal/creature), age, body type/build, height, skin/fur/hair color and style, eye color, facial features, distinctive marks, and clothing ONLY if the source explicitly describes it. Nothing else.
- "description" = ONLY who they ARE: personality, attitude, role in the story, motivations, behavior. NEVER physical looks.
- Do NOT mix them: looks never go in "description"; personality/role never go in "appearance".
- If the source gives NO physical description, leave "appearance" as an empty string. Do NOT invent a look.`;

/** Character JSON format for extraction */
export const CHARACTER_JSON_FORMAT = `[
  {
    "name": "Character Name or Role (e.g. 'Sarah', 'Police Officer', 'The Mother')",
    "appearance": "ONLY concrete physical/visual traits for an image: species (human/animal/creature), age, build, skin/fur/hair color and style, eye color, distinctive marks, and wardrobe ONLY if explicitly described in the source. No personality, no role, no story. Empty string if the source gives no physical detail.",
    "description": "Personality, role in the story, and behavior. NOT physical appearance.",
    "character_type": "main",
    "primary_role": "protagonist",
    "importance_level": 4,
    "status": "active",
    "story_arc": "Character development journey or null",
    "motivations": "What drives this character or null",
    "fears": "What they're afraid of or null",
    "goals": "What they want to achieve or null"
  }
]`;

/** Location JSON format for extraction */
export const LOCATION_JSON_FORMAT = `[
  {
    "name": "Location Name",
    "description": "Comprehensive location description including atmosphere and visual details",
    "location_type": "interior|exterior|both",
    "story_importance": "critical|major|supporting|minor",
    "atmosphere": "Mood and feeling of this location",
    "visual_notes": "Key visual elements, lighting, set design details"
  }
]`;
