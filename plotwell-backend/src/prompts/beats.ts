/**
 * Beat Sheet AI Prompts
 * Source: routes/ai/beats.ts
 */

import { PromptConfig } from './types';

// =============================================================================
// CONFIGS
// =============================================================================

export const BEAT_SUGGEST_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.8,
  maxTokens: 2000,
  requestType: 'generation',
};

export const BEAT_ANALYZE_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 2000,
  requestType: 'generation',
};

export const BEAT_EXPAND_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.75,
  maxTokens: 1500,
  requestType: 'generation',
};

export const BEAT_DESCRIPTION_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 1000,
  requestType: 'generation',
};

// =============================================================================
// SYSTEM MESSAGES
// =============================================================================

export const BEAT_SUGGEST_SYSTEM = "You are an expert story structure consultant. Always output valid JSON arrays.";

export const BEAT_ANALYZE_SYSTEM = "You are a story structure expert. Always output valid JSON objects.";

export const BEAT_EXPAND_SYSTEM = "You are a screenplay consultant. Always output valid JSON objects.";

export const BEAT_DESCRIPTION_SYSTEM = "You are a screenwriting assistant. Output only the beat description text, nothing else. Keep it concise: 2-4 sentences maximum.";

// =============================================================================
// SUGGEST NEXT BEAT
// =============================================================================

interface BeatSuggestParams {
  projectName: string;
  templateInfo: string;
  genre: string;
  beatsContext: string;
  templateName: string;
  languageInstructions: string;
}

export function buildBeatSuggestPrompt(params: BeatSuggestParams): string {
  return `You are an expert story structure consultant helping a screenwriter plan their story.

Project: ${params.projectName}
${params.templateInfo}
Genre: ${params.genre || 'Not specified'}

Current Beats:
${params.beatsContext}

Based on the ${params.templateName || 'standard screenplay'} structure and the writer's genre (${params.genre || 'general'}), suggest 3-5 possible next beats that would logically follow.

For each suggestion, provide:
1. Title (short, clear, 3-8 words)
2. Description (2-3 sentences explaining what happens)
3. Rationale (why this beat makes sense at this point)
4. Beat type (setup, inciting_incident, midpoint, climax, resolution, rising_action, turning_point, crisis, or custom)
5. Act (act1, act2a, act2b, act3, or custom)

${params.languageInstructions}

Respond ONLY with a JSON array in this exact format:
[
  {
    "title": "Beat title here",
    "description": "What happens in this beat",
    "rationale": "Why this beat makes sense",
    "beat_type": "rising_action",
    "act": "act2a",
    "confidence": 85
  }
]

Make suggestions creative but aligned with the established structure. Confidence should be 0-100.`;
}

// =============================================================================
// ANALYZE STRUCTURE
// =============================================================================

interface BeatAnalyzeParams {
  projectName: string;
  templateName: string;
  totalBeats: number;
  actCounts: string;
  beatsDetails: string;
  languageInstructions: string;
}

export function buildBeatAnalyzePrompt(params: BeatAnalyzeParams): string {
  return `You are a story structure expert analyzing a screenplay's beat sheet.

Project: ${params.projectName}
Structure Template: ${params.templateName || 'Custom'}
Total Beats: ${params.totalBeats}

Beats by Act:
${params.actCounts}

Beat Details:
${params.beatsDetails}

Analyze this structure and provide:
1. Strong Areas: What's working well (2-4 points)
2. Potential Issues: Structural problems, pacing issues, missing beats (2-5 points)
3. Suggestions: Specific, actionable improvements (3-5 points)
4. Overall Score: 0-100 rating

${params.languageInstructions}

Respond ONLY with JSON in this exact format:
{
  "strong_areas": ["Point 1", "Point 2", "Point 3"],
  "issues": [
    {"issue": "Description", "severity": "low|medium|high", "explanation": "Why this matters"}
  ],
  "suggestions": [
    {"suggestion": "What to do", "impact": "Expected result", "priority": 8}
  ],
  "overall_score": 75,
  "summary": "One paragraph overall assessment"
}`;
}

// =============================================================================
// EXPAND BEAT
// =============================================================================

interface BeatExpandParams {
  beatTitle: string;
  beatDescription: string;
  beatType: string;
  act: string;
  genre: string;
  tone: string;
  languageInstructions: string;
}

export function buildBeatExpandPrompt(params: BeatExpandParams): string {
  return `You are a screenplay consultant helping expand a story beat into a detailed scene outline.

Beat Title: ${params.beatTitle}
Beat Description: ${params.beatDescription || 'No additional description'}
Beat Type: ${params.beatType}
Act: ${params.act}
Genre: ${params.genre || 'Not specified'}
Tone: ${params.tone || 'Not specified'}

Expand this beat into a detailed scene outline that a screenwriter can use to write the actual screenplay. Include:

1. Opening: How the scene/sequence begins
2. Key Moments: 3-5 important story beats within this scene
3. Dialogue Suggestions: 2-3 sample dialogue snippets or conversation topics
4. Action: Physical actions and visual elements
5. Ending: How this scene transitions to the next
6. Estimated Pages: How many script pages this might be (1-10)

${params.languageInstructions}

Be specific and actionable. Help the writer visualize exactly what happens.

Respond in this JSON format:
{
  "outline": {
    "opening": "Description",
    "key_moments": ["Moment 1", "Moment 2", "Moment 3"],
    "dialogue_suggestions": ["Suggestion 1", "Suggestion 2"],
    "action": "Physical and visual description",
    "ending": "How scene ends",
    "estimated_pages": 4
  },
  "scene_suggestions": [
    {"heading": "INT. LOCATION - TIME", "description": "What happens here"}
  ],
  "tone_notes": "Recommended tone and pacing",
  "tips": ["Tip 1", "Tip 2"]
}`;
}

// =============================================================================
// GENERATE BEAT DESCRIPTION
// =============================================================================

interface BeatDescriptionParams {
  projectName: string;
  projectType: string;
  documentsContext: string;
  existingBeatsContext: string;
  title: string;
  actLabel: string;
  beatTypeLabel: string;
  languageInstructions: string;
}

export function buildBeatDescriptionPrompt(params: BeatDescriptionParams): string {
  return `You are a professional screenwriting assistant helping to write beat descriptions for a story outline.

PROJECT: ${params.projectName}
PROJECT TYPE: ${params.projectType || 'film'}
${params.projectType === 'vertical_series' ? 'FORMAT NOTE: This is a vertical short-form series (9:16 micro-drama). Keep the beat punchy, high-emotion, and hook/cliffhanger-driven — written for ~60-120 second episodes.\n' : ''}
${params.documentsContext ? `PROJECT DOCUMENTS:\n${params.documentsContext}\n` : 'No project documents available.'}
${params.existingBeatsContext ? `EXISTING BEATS IN THE STORY (in order):\n${params.existingBeatsContext}\n` : ''}
BEAT TO DESCRIBE:
- Title: ${params.title}
- Act: ${params.actLabel}
- Beat Type: ${params.beatTypeLabel}

Write a compelling 2-4 sentence description for this beat that:
1. Explains what happens at this story moment based on the beat title "${params.title}"
2. Is consistent with the overall project narrative from the documents (if available)
3. Matches the dramatic function of this beat type (${params.beatTypeLabel})
4. Fits the position in the story (${params.actLabel})
5. Is UNIQUE and DIFFERENT from the existing beats listed above - do NOT repeat or paraphrase their descriptions

${params.languageInstructions}

IMPORTANT: Respond with ONLY the beat description text - no formatting, no JSON, no explanations, no quotes around the text.`;
}
