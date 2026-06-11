/**
 * Document Generation Prompts
 * Source: routes/ai/documents.ts
 */

import { PromptConfig } from './types';
import { computeDocumentSizing } from '../services/documentSizing';

// =============================================================================
// CONFIGS
// =============================================================================

export const DOCUMENT_GENERATION_CONFIG: PromptConfig = {
  version: 'v1',
  model: 'grok',
  temperature: 0.7,
  maxTokens: 8192, // Dynamic: scales with document type and duration
  requestType: 'generation',
};

// =============================================================================
// SYSTEM MESSAGES
// =============================================================================

export const DOCUMENT_GENERATION_SYSTEM = "You are an expert screenwriting consultant. Generate professional screenplay documents in JSON format. Always complete the full document without truncating.";

// =============================================================================
// DOCUMENT TYPE INSTRUCTIONS
// =============================================================================

interface DocumentInstructionParams {
  documentType: string;
  projectType: string;
  estimatedDuration: number;
}

export function getDocumentInstructions(params: DocumentInstructionParams): string {
  const { documentType, projectType, estimatedDuration } = params;

  // Determine expected length based on project duration and type
  let lengthGuidance = '';

  if (estimatedDuration > 0) {
    const minPages = Math.ceil(estimatedDuration / 10);
    const maxPages = Math.ceil(estimatedDuration / 5);
    lengthGuidance = `Project duration: ${estimatedDuration} minutes. Generate ${minPages}-${maxPages} pages of comprehensive, detailed content.`;
  } else {
    if (projectType === 'short' || projectType === 'short_film') {
      lengthGuidance = 'Short film (5-15 min): 2-3 pages of detailed narrative.';
    } else if (projectType === 'documentary') {
      lengthGuidance = 'Documentary (30-60 min): 5-8 pages covering all major story beats, interviews, locations, and narrative arc in detail.';
    } else if (projectType === 'film' || projectType === 'movie' || projectType === 'feature_film') {
      lengthGuidance = 'Feature film (90-120 min): 8-12 pages with comprehensive three-act structure, character arcs, and key scenes.';
    } else if (projectType === 'vertical_series') {
      lengthGuidance = 'Vertical episode (1-3 min): 1-2 pages of fast, hook-driven micro-drama beats with a cliffhanger.';
    } else if (projectType === 'series' || projectType === 'tv_episode') {
      lengthGuidance = 'TV episode (30-60 min): 4-6 pages covering act breaks, plot threads, and character development.';
    } else if (projectType === 'web_series') {
      lengthGuidance = 'Web series episode (5-15 min): 2-3 pages with focused narrative and key moments.';
    } else {
      lengthGuidance = 'Standard project: 3-5 pages of detailed content.';
    }
  }

  switch (documentType) {
    case 'treatment':
      return getTreatmentInstructions(lengthGuidance, estimatedDuration);
    case 'logline':
      return getLoglineInstructions();
    case 'synopsis':
      return getSynopsisInstructions(lengthGuidance);
    case 'character_breakdown':
      return getCharacterBreakdownInstructions();
    case 'pitch_deck':
      return getPitchDeckInstructions();
    default:
      return getDefaultInstructions(lengthGuidance);
  }
}

function getTreatmentInstructions(lengthGuidance: string, estimatedDuration: number): string {
  const estimatedPages = Math.ceil(estimatedDuration / 10) || 5;

  return `
Write a professional film treatment. A treatment is a narrative prose document that tells the complete story like a short novel.

${'═'.repeat(63)}
🚫🚫🚫 ABSOLUTELY FORBIDDEN - NEVER DO THESE 🚫🚫🚫
${'═'.repeat(63)}

FORBIDDEN LABELS (NEVER WRITE THESE):
❌ "Flashback:" or "Flashback a..." or "Flash back:"
❌ "Act 1", "Act 2", "Act 3", "Acto 1", "Acto 2"
❌ "Opening:", "Midpoint:", "Climax:", "Resolution:"
❌ "End of Act", "Fin de Acto", "Plot Point", "Beat"
❌ "[Nota:", "[Note:", or any bracketed comments
❌ Any meta-commentary about your writing process
❌ "Expando", "Continúo", "Esbozo", "Desarrollo"

FORBIDDEN FORMATS:
❌ Bullet points or lists
❌ Short label-style lines like "Yoga: posturas" or "Eco: Luna"
❌ One-line telegraphic scene summaries like "Kitchen fridge hums, sandwich crunch, pool water laps."
❌ Comma-separated sensory lists instead of proper prose paragraphs
❌ Subtitles after the main title
❌ Structural headers or section breaks (NO "Act 1 Analysis", "Themes Expanded", "Background Timeline", etc.)
❌ Sub-subsections that repeat the same ideas with different labels
❌ Any text about paragraph counts or length requirements
❌ One sentence per paragraph (EVERY paragraph needs 2-3+ sentences minimum)
❌ Padding — if you've said it, don't say it again under a new heading

${'═'.repeat(63)}
✅ HOW TO WRITE CORRECTLY
${'═'.repeat(63)}

STRUCTURE YOUR PROSE LIKE A NOVEL:

For time jumps, write naturally:
✅ "Years earlier, Clara danced freely at a Barcelona party..."
✅ "Her mind drifts to that summer night six months ago..."
✅ "She remembers the first time they met..."
❌ "Flashback: Clara en Barcelona..."

For scenes, write full paragraphs:
✅ "Clara walks through the busy market, the scent of fresh oranges mixing with sea salt. Vendors call out prices while tourists photograph the colorful stalls. She pauses at a flower stand, remembering how Nico used to bring her roses every Friday."
❌ "Mercado: Clara compra. Flores recuerdo."

TITLE FORMAT:
- Write ONLY the story title as a heading (e.g., "Shadows of Consent")
- NO subtitles like "- Film Treatment" or "- Tratamiento Cinematográfico"

EVERY PARAGRAPH must be:
- At least 2-3 complete sentences
- Descriptive prose, not shorthand notes
- Part of a flowing narrative

${'═'.repeat(63)}

LENGTH: ${lengthGuidance}
Target: ${estimatedPages} pages of detailed narrative prose.

Begin with the title, then drop us directly into the opening scene.
Tell the complete story from beginning to end.
Write like a novelist - immersive, visual, emotional.`;
}

function getLoglineInstructions(): string {
  return `
Write a compelling logline for this specific project. A logline is a ONE-SENTENCE pitch that captures the essence of the story.

LOGLINE FORMULA:
"When [INCITING INCIDENT], a [PROTAGONIST with ADJECTIVE] must [GOAL/ACTION] or else [STAKES]."

REQUIREMENTS:
- EXACTLY ONE SENTENCE (30-50 words max)
- Includes: protagonist, goal, conflict, and stakes
- Captures the unique hook of THIS story
- Genre-appropriate tone
- Compelling and marketable

EXAMPLES:
- "When a massive shark terrorizes a beach town, a local police chief, a marine biologist, and a grizzled shark hunter must track down and kill the beast before it claims more lives." (Jaws)
- "When an ambitious young executive is mistakenly presumed dead, he must navigate a twisted conspiracy and prove his identity before his family fortune is stolen." (North by Northwest)

Write the logline for THIS project using the information provided. Make it specific, compelling, and true to the story.`;
}

function getSynopsisInstructions(lengthGuidance: string): string {
  return `
Write the synopsis for this specific project.

LENGTH REQUIREMENT: ${lengthGuidance}

❌ NO bullet points, NO section headers, NO sub-subsections
Write continuous narrative prose — beginning, middle, end. Cover the main plot, key character decisions, and resolution. Bold character names. Use italic for tone and genre references. Do not pad or repeat.`;
}

function getCharacterBreakdownInstructions(): string {
  return `
Write a character breakdown for the main characters in this project.

CRITICAL RULES:
❌ NO bullet points or lists of any kind
❌ NO sub-subsections (no "In-Depth Goals Analysis", "Arc Breakdown with Beats", "Background Timeline", "Goal Hierarchy", "Arc Emotional Layers", etc.)
❌ NO more than 3 sections per character
❌ DO NOT invent redundant analysis sections - write prose, not outlines

FOR EACH CHARACTER write exactly 3 sections:
1. Who They Are — physical appearance and personality in 2-3 prose paragraphs
2. What They Want — goals, motivations, and background in 1-2 prose paragraphs
3. Their Arc — how they change through the story in 1-2 prose paragraphs

Write in flowing narrative prose. Bold character names and key traits. Use italic for emotional states.
Keep each character section concise and readable — no padding, no repetition.`;
}

function getPitchDeckInstructions(): string {
  return `
Write the actual pitch deck content for this specific project.

Include comprehensive sections: Logline, Project Overview, Target Audience (demographics + psychographics), Comparable Projects, Unique Selling Points, Creative Vision, Market Opportunity, Production Approach, Distribution Strategy, Team/Talent, Budget Overview.

Each section should be detailed with specific examples and data. Bold statistics and unique selling points. Use italic for creative vision and market insights.`;
}

function getDefaultInstructions(lengthGuidance: string): string {
  return `
Write the actual content for this specific project. Create relevant, detailed content based on the conversation.

LENGTH REQUIREMENT: ${lengthGuidance}

Provide substantial detail and comprehensive coverage of the topic. Bold key concepts and important terms. Use italic for descriptions and context.`;
}

// =============================================================================
// MAIN DOCUMENT GENERATION PROMPT
// =============================================================================

interface DocumentGenerationParams {
  languageInstructions: string;
  documentType: string;
  projectType: string;
  fullConversation: string;
  documentInstructions: string;
}

export function buildDocumentGenerationPrompt(params: DocumentGenerationParams): string {
  return `
${params.languageInstructions}

TASK: Generate a ${params.documentType} document based on the brainstorming conversation below.

PROJECT TYPE: ${params.projectType}

CONVERSATION:
${params.fullConversation}

CONTENT REQUIREMENTS:
${params.documentInstructions}

${'━'.repeat(61)}
CRITICAL OUTPUT FORMAT - READ CAREFULLY
${'━'.repeat(61)}

YOU MUST RETURN **ONLY** A VALID JSON OBJECT. NO OTHER TEXT.

EXACT STRUCTURE REQUIRED:
{
  "type": "doc",
  "content": [
    {
      "type": "heading",
      "attrs": { "level": 1 },
      "content": [
        { "type": "text", "marks": [{ "type": "bold" }], "text": "Your Title Here" }
      ]
    },
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Normal text " },
        { "type": "text", "marks": [{ "type": "bold" }], "text": "bold text" },
        { "type": "text", "text": " more text " },
        { "type": "text", "marks": [{ "type": "italic" }], "text": "italic text" }
      ]
    }
  ]
}

FORMATTING RULES - MANDATORY:
✓ Character names → BOLD: { "type": "text", "marks": [{ "type": "bold" }], "text": "Sarah" }
✓ Key concepts → BOLD: { "type": "text", "marks": [{ "type": "bold" }], "text": "redemption" }
✓ Tone/mood → ITALIC: { "type": "text", "marks": [{ "type": "italic" }], "text": "tense, atmospheric" }
✓ Genre references → ITALIC: { "type": "text", "marks": [{ "type": "italic" }], "text": "neo-noir thriller" }

CRITICAL - WHAT NOT TO DO:
✗ NO markdown code blocks (no \`\`\`json or \`\`\`)
✗ NO explanatory text before or after the JSON
✗ NO comments inside the JSON
✗ NO escaped quotes or extra formatting
✗ NO nested JSON strings - use the structure directly
✗ DO NOT wrap the JSON in text nodes
✗ DO NOT return { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "{...json here...}" }] }] }
✗ NO TRAILING COMMAS - { "a": 1, } is INVALID
✗ NO UNESCAPED QUOTES in text values - use \\" for quotes inside strings
✗ DO NOT STOP EARLY - Generate the FULL document length specified above
✗ DO NOT TRUNCATE - Write the complete story from beginning to end with all required detail

YOUR RESPONSE MUST START WITH:
{
  "type": "doc",

YOUR RESPONSE MUST END WITH:
}

RETURN ONLY THE JSON OBJECT. START NOW.`;
}

// =============================================================================
// TOKEN ALLOCATION HELPER
// =============================================================================

export function calculateDocumentTokens(documentType: string, projectType: string, estimatedDuration: number): { maxTokens: number; estimatedPages: number } {
  // Delegates to the single source of truth so token/page sizing can't drift
  // from the live document routes. See services/documentSizing.ts.
  const sizing = computeDocumentSizing({ documentType, projectType, durationMinutes: estimatedDuration });
  return { maxTokens: sizing.maxTokens, estimatedPages: sizing.estimatedPages };
}
