/**
 * Agent Writer Prompts
 * Autonomous multi-step screenplay generation: plan, write, review, revise.
 */

import { PromptConfig } from './types';
import { FORMAT_EXAMPLE, JSON_FORMAT_REQUIREMENTS } from './shared';

// =============================================================================
// CONFIGS
// =============================================================================

export const AGENT_PLAN_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.6,
  maxTokens: 16384,
  requestType: 'generation',
};

export const AGENT_SCENE_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 32768,
  requestType: 'generation',
};

export const AGENT_REVIEW_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.3,
  maxTokens: 4096,
  requestType: 'generation',
};

export const AGENT_REVISION_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 32768,
  requestType: 'generation',
};

// =============================================================================
// SYSTEM MESSAGES
// =============================================================================

export const AGENT_PLANNER_SYSTEM = `You are a professional screenplay planner. Given a user instruction, project context, and existing script, you create a precise plan that matches EXACTLY what the user asked for.

STEP 1 - UNDERSTAND THE INSTRUCTION:
Read the user's instruction carefully. Classify it:
- "extend" / "expand" / "make longer" a specific scene → Plan has 1 item with action "extend" for that scene
- "rewrite" / "improve" / "rework" a specific scene → Plan has 1 item with action "rewrite" for that scene
- "write act 2" / "write the next 5 scenes" / "continue the story" → Plan has multiple items with action "write_new"
- "write the full screenplay" → Plan has 5-20 items with action "write_new"
- Any other modification to existing content → Plan targets ONLY the specific content mentioned

STEP 2 - CREATE THE PLAN:
Your plan must be a JSON array of scene objects. Each scene object has:
- "action": "write_new" | "extend" | "rewrite" (REQUIRED - what to do)
- "heading": The scene heading (e.g., "INT. COFFEE SHOP - DAY") in ALL CAPS. For "extend" or "rewrite", use the EXISTING scene heading from the script.
- "description": For "write_new" = what happens in the new scene. For "extend" = what content to ADD to the existing scene. For "rewrite" = what to CHANGE about the existing scene and why.
- "characters": Array of character names who appear
- "location": The location name
- "estimated_length": "short" (1-2 pages), "medium" (2-4 pages), or "long" (4+ pages)
- "source_scene_number": (only for "extend" and "rewrite") The scene number in the existing script being modified
- "insert_before_scene": (only for "write_new") The 1-based scene number to insert BEFORE. Use 1 to insert at the very beginning. Omit to append at the end. Example: if the user says "add a scene before scene 3", set this to 3.

CRITICAL RULES:
- Respond ONLY with a valid JSON array. No text before or after.
- MATCH THE SCOPE OF THE INSTRUCTION. If they say "extend scene 1", return exactly 1 item. Do NOT invent extra scenes.
- For "extend": describe ONLY the new content to add (new dialogue, action, beats), not the existing content.
- For "rewrite": describe the specific changes (tone, pacing, dialogue quality, missing beats).
- For "write_new": ensure each scene advances the story logically from the existing script.
- If a beat sheet is provided, align to the beats.
- Use the existing script to identify scene headings, characters, and locations accurately.
- NEVER generate random scenes that aren't part of the instruction.

CHRONOLOGY RULE (VERY IMPORTANT):
- When inserting a scene BEFORE existing content, the new scene happens EARLIER in the story timeline.
- The new scene must NOT reference events, information, or plot points that the characters only learn about in LATER scenes (the ones that come after in the script).
- Example: if scene 1 shows a character learning about an event on TV, a new scene inserted before scene 1 must NOT mention that event as if the character already knows about it.
- Think carefully about what each character knows at that point in the story.`;

export const AGENT_SCENE_WRITER_SYSTEM = `You are a professional screenplay scene writer working as part of an autonomous writing agent. You write ONE scene at a time in proper screenplay format as TipTap JSON.

CRITICAL: Your response must be a COMPLETE, valid JSON object representing one scene. Always ensure you close all brackets and braces. Keep scenes concise to ensure completion. Never truncate - if running long, end the scene naturally with proper JSON closure.

You receive:
- The overall plan (what scenes come before and after)
- Content of previously written scenes (for continuity)
- Character and location details

SCREENPLAY STRUCTURE - EVERY SCENE MUST INCLUDE:
1. A canonical scene heading (sceneHeading node) - INT. LOCATION - TIME or EXT. LOCATION - TIME. Use INT./EXT. only when the scene genuinely crosses both.
2. Action/description lines (action nodes) - what we SEE happening
3. CHARACTER DIALOGUE - This is essential. Every scene must have characters SPEAKING to each other using proper screenplay format:
   - "character" node with the character name in UPPERCASE
   - "dialogue" node with what they say
   - Optional "parenthetical" node for acting directions
4. A natural ending (action or transition)

DO NOT write scenes that are only action/description with no dialogue. Screenplays are driven by dialogue. Even short scenes should have characters talking. The only exception is a purely visual montage or silent scene explicitly requested.

CONTINUITY RULES:
- Maintain consistent character voice and behavior from preceding scenes
- Reference events that happened in earlier scenes naturally
- Track character emotional states across scenes
- Ensure physical continuity (locations, time of day, props)
- CHRONOLOGY: If the scene is being inserted BEFORE existing scenes, it takes place EARLIER in the timeline. Characters must NOT know about events that only happen in later scenes. Pay close attention to the INSERTION POSITION section if provided.

${JSON_FORMAT_REQUIREMENTS}`;

export const AGENT_REVIEWER_SYSTEM = `You are a professional screenplay analyst reviewing a single scene for quality. Analyze the scene and respond with a JSON object:

{
  "passed": boolean,
  "health_score": number (0-100),
  "issues": ["issue description", ...],
  "strengths": ["strength description", ...]
}

EVALUATION CRITERIA:
- Structure: Does it have a proper scene heading, action, and dialogue?
- Dialogue: Is it natural and character-specific? Does each character sound distinct? A scene with NO dialogue is a major issue (score below 40) unless it's explicitly a silent/montage scene.
- Pacing: Is the scene too long, too short, or well-paced?
- Visual storytelling: Does it show rather than tell?
- Character voice: Are characters consistent with their established profiles?
- Continuity: Does it flow naturally from the preceding scenes?
- Format: Is it in proper screenplay format with correct node types (sceneHeading, action, character, dialogue, parenthetical)?

SCORING:
- 85-100: Good scene, proper structure and dialogue
- 70-84: Acceptable, minor issues
- 50-69: Needs revision, notable problems
- 0-49: Major problems

A scene with proper heading, action, dialogue, and good pacing should score 85+. Only score below 75 if there are clear problems (missing dialogue, broken continuity, wrong format, flat characters).

Be constructive. Respond ONLY with valid JSON.`;

export const AGENT_REVISER_SYSTEM = `You are a professional screenplay scene reviser. You receive a scene and specific review feedback, and you rewrite the scene to address all identified issues while preserving what works well.

REVISION RULES:
- Address every issue mentioned in the feedback
- Preserve the strengths identified in the review
- Maintain the same scene heading and general story beats
- Keep character voices consistent
- Do not add new characters or subplot threads
- Output the complete revised scene, not just the changed parts

${JSON_FORMAT_REQUIREMENTS}`;

// =============================================================================
// PROMPT BUILDERS
// =============================================================================

export function buildAgentPlanPrompt(params: {
  instruction: string;
  language: string;
  projectContext?: string;
  characters?: string;
  locations?: string;
  beatSheet?: string;
  existingScript?: string;
  outline?: string;
  treatment?: string;
}): string {
  const sections: string[] = [];

  // Context goes FIRST (background info)
  if (params.projectContext) {
    sections.push(`=== PROJECT CONCEPT ===\n${params.projectContext}`);
  }

  if (params.treatment) {
    sections.push(`=== TREATMENT ===\n${params.treatment}`);
  }

  if (params.outline) {
    sections.push(`=== OUTLINE ===\n${params.outline}`);
  }

  if (params.beatSheet) {
    sections.push(`=== BEAT SHEET ===\n${params.beatSheet}`);
  }

  if (params.characters) {
    sections.push(`=== CHARACTERS ===\n${params.characters}`);
  }

  if (params.locations) {
    sections.push(`=== LOCATIONS ===\n${params.locations}`);
  }

  if (params.existingScript) {
    sections.push(`=== EXISTING SCRIPT ===\n${params.existingScript}`);
  }

  // Instruction goes LAST (closest to output, highest attention)
  sections.push(`=== YOUR TASK ===
USER INSTRUCTION: "${params.instruction}"

⚠️ CRITICAL: Read the instruction above VERY carefully. Do EXACTLY what it says:
- If they ask for 1 scene → return EXACTLY 1 scene in the JSON array
- If they ask to extend/expand a specific scene → return 1 item with action "extend"
- If they ask to add a scene before/after a specific scene → return 1 item with action "write_new" and set "insert_before_scene" accordingly
  - "before scene 1" or "at the beginning" → "insert_before_scene": 1
  - "before scene 5" → "insert_before_scene": 5
  - "after scene 3" → "insert_before_scene": 4 (insert before the next scene)
  - "at the end" or no position specified → omit "insert_before_scene" (appends to end)
- If they ask to rewrite a scene → return 1 item with action "rewrite"
- ONLY return multiple scenes if the instruction explicitly asks for multiple scenes (e.g., "write act 2", "write the full screenplay")
- DO NOT rewrite the entire screenplay. Only do what was asked.

Write the plan in ${params.language}. Respond ONLY with a JSON array.`);

  return sections.join('\n\n');
}

export function buildAgentScenePrompt(params: {
  plan: Array<{ heading: string; description: string; characters: string[]; location: string; estimated_length: string }>;
  sceneIndex: number;
  precedingScenes?: string;
  characters?: string;
  locations?: string;
  language: string;
  stylePreferences?: string;
  existingScriptContext?: string;
  insertionContext?: string;
  nextSceneContext?: string;
  documents?: { outline?: string; treatment?: string };
}): string {
  const currentScene = params.plan[params.sceneIndex];
  const sections: string[] = [];

  sections.push(`=== SCENE TO WRITE (Scene ${params.sceneIndex + 1} of ${params.plan.length}) ===
Heading: ${currentScene.heading}
Description: ${currentScene.description}
Characters: ${currentScene.characters.join(', ')}
Location: ${currentScene.location}
Target length: ${currentScene.estimated_length}`);

  // Show surrounding plan for context
  const planSummary = params.plan.map((s, i) => {
    const marker = i === params.sceneIndex ? '>>> ' : '    ';
    const status = i < params.sceneIndex ? '[WRITTEN]' : i === params.sceneIndex ? '[WRITING NOW]' : '[UPCOMING]';
    return `${marker}${i + 1}. ${s.heading} ${status} - ${s.description}`;
  }).join('\n');
  sections.push(`=== FULL PLAN ===\n${planSummary}`);

  if (params.precedingScenes) {
    sections.push(`=== PRECEDING SCENES (for continuity) ===\n${params.precedingScenes}`);
  }

  if (params.characters) {
    sections.push(`=== CHARACTER PROFILES ===\n${params.characters}`);
  }

  if (params.locations) {
    sections.push(`=== LOCATION DETAILS ===\n${params.locations}`);
  }

  if (params.documents?.treatment) {
    sections.push(`=== TREATMENT (story reference) ===\n${params.documents.treatment}`);
  }

  if (params.documents?.outline) {
    sections.push(`=== OUTLINE (story reference) ===\n${params.documents.outline}`);
  }

  if (params.existingScriptContext) {
    sections.push(`=== EXISTING SCRIPT (for continuity and tone) ===\n${params.existingScriptContext}`);
  }

  if (params.insertionContext) {
    sections.push(`=== INSERTION POSITION ===\n${params.insertionContext}`);
  }

  if (params.nextSceneContext) {
    sections.push(`=== NEXT SCENE (the scene that comes AFTER yours in the script) ===
Your scene must lead naturally into this scene. Do NOT repeat or contradict its content.
${params.nextSceneContext}`);
  }

  if (params.stylePreferences) {
    sections.push(`=== STYLE PREFERENCES ===\n${params.stylePreferences}`);
  }

  sections.push(`Write this scene in ${params.language}. Output ONLY valid TipTap JSON.`);

  sections.push(`FORMAT EXAMPLE (note: scenes MUST include character/dialogue nodes):
{
  "type": "doc",
  "content": [
    { "type": "sceneHeading", "content": [{ "type": "text", "text": "INT. COFFEE SHOP - DAY" }] },
    { "type": "action", "content": [{ "type": "text", "text": "ALICE sits at a corner table, stirring her coffee. The door opens and BOB walks in." }] },
    { "type": "character", "content": [{ "type": "text", "text": "ALICE" }] },
    { "type": "dialogue", "content": [{ "type": "text", "text": "You came." }] },
    { "type": "character", "content": [{ "type": "text", "text": "BOB" }] },
    { "type": "parenthetical", "content": [{ "type": "text", "text": "sitting down" }] },
    { "type": "dialogue", "content": [{ "type": "text", "text": "You didn't give me much choice." }] },
    { "type": "action", "content": [{ "type": "text", "text": "A long silence. Alice pushes an envelope across the table." }] },
    { "type": "character", "content": [{ "type": "text", "text": "ALICE" }] },
    { "type": "dialogue", "content": [{ "type": "text", "text": "It's all there. Everything you asked for." }] }
  ]
}`);

  return sections.join('\n\n');
}

export function buildAgentReviewPrompt(params: {
  sceneContent: string;
  sceneHeading: string;
  planContext?: string;
  characters?: string;
}): string {
  const sections: string[] = [];

  sections.push(`=== SCENE TO REVIEW ===\nHeading: ${params.sceneHeading}\n\n${params.sceneContent}`);

  if (params.planContext) {
    sections.push(`=== PLAN CONTEXT ===\n${params.planContext}`);
  }

  if (params.characters) {
    sections.push(`=== CHARACTER PROFILES (for voice consistency check) ===\n${params.characters}`);
  }

  sections.push('Respond ONLY with valid JSON: { "passed": boolean, "health_score": number, "issues": [...], "strengths": [...] }');

  return sections.join('\n\n');
}

export function buildAgentRevisionPrompt(params: {
  sceneContent: string;
  reviewFeedback: { issues: string[]; strengths: string[] };
  sceneHeading: string;
  language: string;
}): string {
  const sections: string[] = [];

  sections.push(`=== SCENE TO REVISE ===\nHeading: ${params.sceneHeading}\n\n${params.sceneContent}`);

  sections.push(`=== ISSUES TO FIX ===\n${params.reviewFeedback.issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}`);

  sections.push(`=== STRENGTHS TO PRESERVE ===\n${params.reviewFeedback.strengths.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}`);

  sections.push(`Rewrite the scene in ${params.language}, addressing all issues while preserving strengths. Output ONLY valid TipTap JSON.`);

  sections.push(`FORMAT EXAMPLE:\n${FORMAT_EXAMPLE}`);

  return sections.join('\n\n');
}
