/**
 * Location Extraction & Image Generation Prompts
 * Source: routes/ai/locations.ts
 */

import { PromptConfig } from './types';
import {
  LOCATION_JSON_FORMAT,
  LOCATION_TYPE_OPTIONS,
  STORY_IMPORTANCE_OPTIONS,
  VISUAL_CONTINUITY_REQUIREMENTS,
  VISUAL_STYLE_PRESETS,
  resolveVisualStyleId,
  buildStyleEnforcement,
  SIMPLE_IMAGE_PROMPTS,
} from './shared';

// =============================================================================
// CONFIGS
// =============================================================================

export const LOCATION_EXTRACTION_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 16384,
  requestType: 'extraction',
};

export const LOCATION_IMAGE_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'flux.2-pro',
  temperature: 0,
  maxTokens: 0,
  requestType: 'generation',
};

// =============================================================================
// SYSTEM MESSAGES
// =============================================================================

export const DOCUMENTS_TO_LOCATIONS_SYSTEM = "You are a professional location scout and production designer. Analyze scripts, concepts, and brainstorming content to extract all filming locations with comprehensive details. IMPORTANT: Use the SAME LANGUAGE as the source material - if the script is in Spanish, respond in Spanish. If it's in English, respond in English. Always output valid JSON.";

export const SCRIPT_TO_LOCATIONS_SYSTEM = "You are a professional location scout and production designer specializing in script analysis. IMPORTANT: Use the SAME LANGUAGE as the script - if the script is in Spanish, respond in Spanish. If it's in English, respond in English. Always output valid JSON.";

// =============================================================================
// DOCUMENTS-TO-LOCATIONS PROMPT
// =============================================================================

interface DocumentsToLocationsParams {
  projectType: string;
  scriptText: string;
  conceptText: string;
  fullConversation: string;
  existingLocationsList: string | null;
  languageInstructions: string;
}

export function buildDocumentsToLocationsPrompt(params: DocumentsToLocationsParams): string {
  return `
COMPREHENSIVE LOCATION EXTRACTION AND ANALYSIS

You have access to multiple sources of information about this ${params.projectType === "film" ? "film" : "video"} project. Extract and analyze ALL locations mentioned across ALL sources:

${params.existingLocationsList ? `
EXISTING LOCATIONS (DO NOT EXTRACT THESE AGAIN):
${params.existingLocationsList}

CRITICAL: Only extract NEW locations that are NOT in the existing list above. If a location already exists, skip it completely.

` : ""}

${params.scriptText ? `
=== PRODUCTION SCRIPT (PRIMARY SOURCE) ===
${params.scriptText}
` : ""}

${params.conceptText ? `
=== PROJECT CONCEPT/TREATMENT ===
${params.conceptText}
` : ""}

=== BRAINSTORMING CONVERSATION ===
${params.fullConversation}

COMPREHENSIVE INSTRUCTIONS:
${params.scriptText ?
  `- THE SCRIPT IS THE PRIMARY SOURCE: Extract ALL locations from the script
  - Look for scene headings like "INT. SCHOOL - DAY", "EXT. HOUSE - NIGHT"
  - Also find locations mentioned in action descriptions and dialogue
  - Extract both main filming locations and mentioned places`
  :
  `- Extract locations discussed in brainstorming conversation and concept content`
}
- ${params.existingLocationsList ? 'ONLY extract NEW locations not in the existing list above' : 'Extract all locations found'}
- Cross-reference information from ALL sources for complete location profiles
- Use script content for definitive location analysis when available
- Complement with brainstorming insights for atmosphere and location purpose
- Include concept treatment details for context and visual style of locations
- Include both primary and important secondary locations

For each location found across ALL sources, provide comprehensive analysis:
- Name (clean location name without INT./EXT./TIME formatting)
- Description (comprehensive description including atmosphere, visual style, narrative purpose)
- Location type (interior, exterior, or both if applicable)
- Narrative importance (how crucial this location is to the narrative)
- Atmosphere/mood (tone and feeling of this location)
- Visual characteristics (key visual elements, lighting, set design notes)

Return as a JSON array in this format:
${LOCATION_JSON_FORMAT}

CRITICAL RULES:
- Only return valid JSON, no markdown or extra text
- Extract locations from ANY of the provided sources (script, concept, brainstorming)
- If script exists, prioritize script-based analysis (more accurate)
- Combine information from all sources for complete location profiles
- Remove script formatting (INT., EXT., - DAY, - NIGHT) from location names
- Use simple, clean location names (e.g. "School", "Sarah's House", "Downtown Street")
- Set fields based on information available from any source
- Be thorough - extract ALL mentioned locations, but don't invent locations that aren't present
- If no locations are found in any source, return an empty array: []
- IMPORTANT: location_type MUST be exactly one of: ${LOCATION_TYPE_OPTIONS} (English only!)
- IMPORTANT: story_importance MUST be exactly one of: ${STORY_IMPORTANCE_OPTIONS} (English only!)${params.languageInstructions}`;
}

// =============================================================================
// SCRIPT-TO-LOCATIONS PROMPT
// =============================================================================

interface ScriptToLocationsParams {
  projectType: string;
  scriptText: string;
  existingLocationsList: string | null;
  languageInstructions: string;
}

export function buildScriptToLocationsPrompt(params: ScriptToLocationsParams): string {
  return `
Analyze this ${params.projectType === "film" ? "film script" : "video script"} and extract ALL locations that appear in the script.

Script:
${params.scriptText}

${params.existingLocationsList ? `
EXISTING LOCATIONS (DO NOT EXTRACT THESE AGAIN):
${params.existingLocationsList}

CRITICAL: Only extract NEW locations that are NOT in the existing list above. If a location already exists, skip it completely.
` : ''}

INSTRUCTIONS:
- Find ALL locations mentioned in the script (main locations and mentioned places)
- ${params.existingLocationsList ? 'SKIP any locations that appear in the existing list above' : 'Extract all locations found'}
- Look for scene headings like "INT. SCHOOL - DAY", "EXT. HOUSE - NIGHT"
- Extract locations mentioned in action descriptions and dialogue
- Analyze location usage frequency and narrative importance
- Determine visual characteristics and atmosphere from script context

For each location found, provide detailed analysis:
- Name (clean location name without formatting)
- Description (comprehensive description including atmosphere and narrative purpose)
- Location type (interior, exterior, or both if used in multiple ways)
- Narrative importance (critical/major/supporting/background) based on scene count and narrative impact
- Atmosphere and mood (based on how it's described and used in the script)
- Visual characteristics (lighting, set design, mood from script descriptions)

Return as a JSON array:
${LOCATION_JSON_FORMAT}

ANALYSIS GUIDELINES:
- CRITICAL locations: Central to plot, multiple important scenes
- MAJOR: Important scenes, significant narrative moments
- SUPPORTING: Multiple scenes but not central to plot
- MINOR: Mentioned or brief scenes, minimal narrative impact

IMPORTANT: location_type MUST be exactly one of: ${LOCATION_TYPE_OPTIONS} (English values only!)
IMPORTANT: story_importance MUST be exactly one of: ${STORY_IMPORTANCE_OPTIONS} (English values only!)

Return only valid JSON, no markdown or explanations.${params.languageInstructions}`;
}

// =============================================================================
// LOCATION IMAGE PROMPTS
// =============================================================================

interface LocationImageParams {
  locationName: string;
  locationType: string;
  locationContext: string;
  imageStyle: string;
  includePeople: boolean;
  hasReference: boolean;
  similarityPercent?: number;
  typeGuidance?: string;
}

export function buildLocationImagePrompt(params: LocationImageParams): string {
  const peopleInstruction = params.includePeople
    ? 'The scene may include people or animals naturally present in the environment.'
    : 'Empty location with no people, no characters, no figures, no crowds, no animals, no creatures.';

  // Resolve the project style to its full preset. The anchor alone isn't enough —
  // without the reinforcement + negative the photoreal-leaning location boilerplate
  // overrides a stylized look (e.g. 3D/anime renders as a real photo). Enforcement
  // is applied for every style (cinematic included) so the look is consistent.
  const styleId = resolveVisualStyleId(params.imageStyle);
  const styleAnchor = VISUAL_STYLE_PRESETS[styleId].anchor;
  const styleEnforcement = buildStyleEnforcement(styleId);

  // Experiment: short prompt — anchor + people instruction + name/context only.
  if (SIMPLE_IMAGE_PROMPTS) {
    return `${styleAnchor}. ${peopleInstruction} ${params.locationType || 'Location'}: ${params.locationName}. ${params.locationContext}. No text, no watermarks.`;
  }

  if (params.hasReference) {
    return `A single location reference image. ${styleAnchor}. ${peopleInstruction} Professional ${params.locationType || 'location'} reference image. Location: ${params.locationName}. ${params.locationContext}. Reference similarity: ${params.similarityPercent || 70}%. Establishing composition for a reusable production location. Focus on architecture, terrain, lighting, atmosphere, and spatial layout. ${VISUAL_CONTINUITY_REQUIREMENTS}${styleEnforcement} No text, no labels, no watermarks.`;
  }

  const typeGuidance = params.locationType === 'interior'
    ? 'Interior view showing spatial layout, furnishings, lighting fixtures.'
    : params.locationType === 'exterior'
    ? 'Exterior view showing architectural features, terrain, atmospheric conditions.'
    : 'Establishing shot showing the location.';

  return `A single location reference image. ${styleAnchor}. ${peopleInstruction} Professional ${params.locationType || 'location'} reference image of ${params.locationName}. ${params.locationContext}. ${typeGuidance} Establishing composition for a reusable production location. ${VISUAL_CONTINUITY_REQUIREMENTS}${styleEnforcement} No text, no labels, no watermarks.`;
}
