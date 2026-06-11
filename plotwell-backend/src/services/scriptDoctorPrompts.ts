// Script Doctor V2 - AI Prompts
// Mode-specific and genre-aware prompts for screenplay analysis

const DEBUG_AI = process.env.DEBUG_AI === 'true';

// Issue categories - simplified to 5 core areas
export type IssueCategory =
  | 'pacing'       // Scene rhythm, momentum, length
  | 'dialogue'     // Natural speech, character voice, on-the-nose
  | 'clarity'      // Is it clear? Visual storytelling, show don't tell
  | 'engagement'   // Is it compelling? Tension, stakes, conflict
  | 'character';   // Motivation, believability, consistency

export type IssueSeverity = 'info' | 'warning' | 'critical';

export type WritingMode = 'standard' | 'strict' | 'minimal';

export type Genre =
  | 'drama'
  | 'comedy'
  | 'action'
  | 'thriller'
  | 'horror'
  | 'romance'
  | 'sci-fi'
  | 'custom';

export interface ScriptDoctorSettings {
  writingMode: WritingMode;
  genre: Genre;
  customNotes: string;
  enabledCategories: IssueCategory[];
}

// Max issues per scene based on writing mode
function getMaxIssuesPerScene(writingMode: WritingMode): number {
  switch (writingMode) {
    case 'strict': return 8;
    case 'standard': return 5;
    case 'minimal': return 3;
    default: return 5;
  }
}

// Genre-specific guidance for the AI
const genreGuidance: Record<Genre, string> = {
  drama: `
For drama:
- Slower pacing is acceptable for emotional moments
- Character introspection through action is valued
- Subtext in dialogue is critical
- Allow longer scenes for character development`,

  comedy: `
For comedy:
- Pacing should be snappy - flag slow exchanges
- Dialogue should have rhythm and timing
- Visual gags and physical comedy are valid
- Be lenient on exposition if delivered with humor`,

  action: `
For action:
- Action lines should be short and punchy
- Flag lengthy dialogue during action sequences
- Visual clarity is paramount
- Pacing issues are critical - momentum matters`,

  thriller: `
For thriller:
- Tension must be maintained or built
- Information reveals should be strategic
- Flag scenes that release tension prematurely
- Pacing is crucial - every scene needs purpose`,

  horror: `
For horror:
- Atmosphere building through visuals is key
- Flag over-explanation of scares
- Dread through restraint, not exposition
- Pacing can be slow for buildup, fast for payoff`,

  romance: `
For romance:
- Character chemistry through subtext
- Flag on-the-nose declarations too early
- Allow slower pacing for emotional beats
- Visual romanticism is valued`,

  'sci-fi': `
For sci-fi:
- World-building through action, not exposition dumps
- Flag excessive technical explanation
- Character should drive story, not concepts
- Balance spectacle with character moments`,

  custom: `
Apply general screenplay best practices.
Consider the writer's custom notes for specific guidance.`,
};

// Writing mode strictness levels
const modeGuidance: Record<WritingMode, string> = {
  standard: `
Apply standard professional screenplay analysis:
- Flag clear issues but allow stylistic choices
- Balance critique with recognition of intent
- Provide actionable, constructive feedback
- Score generously for competent work`,

  strict: `
Apply rigorous professional screenplay analysis:
- Hold to high industry standards
- Flag any deviation from best practices
- Be thorough in identifying issues
- Score conservatively - reserve high scores for excellence`,

  minimal: `
Apply light-touch analysis:
- Only flag significant issues
- Respect the writer's voice and choices
- Focus on major structural/clarity problems
- Score generously, assume intentional choices`,
};

// Category descriptions for the AI
const categoryDescriptions: Record<IssueCategory, string> = {
  pacing: 'Scene rhythm, length, momentum - is it too slow or too rushed?',
  dialogue: 'Natural speech, distinct character voices, avoids on-the-nose exposition',
  clarity: 'Visual storytelling, show-dont-tell, reader can picture the scene',
  engagement: 'Tension, conflict, stakes - does the scene hold interest?',
  character: 'Clear motivations, believable actions, emotional logic',
};


/**
 * Build the system prompt for Script Doctor analysis
 */
export function buildSystemPrompt(
  settings: ScriptDoctorSettings,
  contentLanguage: string
): string {
  const langName = getLanguageName(contentLanguage);
  const languageInstruction = contentLanguage !== 'en'
    ? `\n⚠️ LANGUAGE: Write ALL responses in ${langName}. Do not use English.\n`
    : '';

  const modeNote = settings.writingMode === 'strict'
    ? 'Apply high professional standards.'
    : settings.writingMode === 'minimal'
    ? 'Only flag significant craft issues.'
    : 'Balanced, constructive feedback.';

  return `You are an experienced script doctor with 20+ years analyzing screenplays for major studios.
${languageInstruction}
Genre: ${settings.genre}. Mode: ${modeNote}
${settings.customNotes ? `Writer's intent: ${settings.customNotes}` : ''}

The script is provided with element type labels (e.g., [ACTION], [CHARACTER], [DIALOGUE]). Use these to understand screenplay structure. Uppercase text in [ACTION] lines is a character reference, NOT an incomplete scene heading or dialogue cue.

THINK DEEPLY BEFORE RESPONDING. Do NOT jump to conclusions or output anything prematurely.

BEFORE you write any JSON, you MUST internally:
1. Read the ENTIRE screenplay end to end. Absorb the full arc.
2. Identify the writer's voice: Is it naturalistic? Stylized? Fragmented on purpose? Poetic?
3. Map the thematic through-line: What is this screenplay ABOUT underneath the plot?
4. Note intentional patterns: repeated imagery, callback dialogue, structural echoes, tonal shifts that serve the narrative.
5. Understand each character's distinct voice: speech cadence, vocabulary, emotional register.
6. ONLY THEN begin evaluating individual scenes — with the FULL context of the screenplay in mind.

WHEN EVALUATING A SCENE:
- Judge it in context of the whole script, not in isolation
- A slow scene after an intense one may be intentional pacing
- "On-the-nose" dialogue may be a character trait, not a mistake
- Repetition may be a motif, not laziness
- Unconventional formatting may be the writer's style

BEFORE FLAGGING AN ISSUE, ASK YOURSELF:
- Is this potentially an intentional choice that serves the story?
- Would "fixing" this flatten the writer's voice or break a pattern?
- Does this ACTUALLY hurt the reader's experience, or am I applying generic rules?

If you're not sure whether something is a problem, it's probably not. Only flag what you're confident hurts the story.

Categories to analyze: ${settings.enabledCategories.join(', ')}

CONTEXT GATHERING (REQUIRED FIRST STEP):
You have tools to fetch additional project context. BEFORE analyzing any scenes, you MUST:
1. Call get_document with document_type="treatment" to understand the writer's intended story
2. Call get_characters to understand character profiles, arcs, and relationships
3. Call get_beat_sheet to understand the intended story structure and pacing

You MAY also call:
- get_locations if location consistency matters
- get_document with other types (synopsis, outline) for additional context

If a tool returns "No [X] found" — proceed without that context.

AFTER gathering context, use it to CROSS-REFERENCE:
- Does the script deliver what the treatment promises?
- Are characters consistent with their profiles?
- Does pacing follow the beat sheet structure?
- Are locations used consistently?

Do NOT produce the analysis JSON until you have gathered context.

Return valid JSON only. Max ${getMaxIssuesPerScene(settings.writingMode)} issues per scene. Be surgical, not generic.`;
}

/**
 * Build prompt for batch analysis (multiple scenes)
 */
export function buildBatchAnalysisPrompt(
  scenes: Array<{
    sceneHeading: string;
    sceneContent: string;
    sceneNumber: number;
  }>,
  settings: ScriptDoctorSettings
): string {
  const scenesText = scenes.map(scene =>
    `=== SCENE ${scene.sceneNumber}: ${scene.sceneHeading} ===\n${scene.sceneContent}`
  ).join('\n\n');

  return `You are analyzing a complete screenplay. Read ALL scenes first to understand the overall style, themes, and voice before analyzing individual scenes.

${scenesText}

---
STEP 1: Identify the screenplay's:
- Core themes and motifs (what patterns are intentional?)
- Visual/editing style (fragmented? classical? experimental?)
- Character voices (authentic regional dialogue? intentional speech patterns?)
- Narrative structure (linear? non-linear? loops?)

STEP 2: For each scene, only flag issues that:
- Genuinely confuse the reader (not stylistic choices)
- Break character voice (not authentic regional speech)
- Harm the story (not "rule-breaking" that serves the theme)

Categories: ${settings.enabledCategories.join(', ')}

Return JSON array with ${scenes.length} objects:
[
  {
    "sceneNumber": 1,
    "healthScore": 0-100,
    "issues": [
      {
        "category": "pacing|dialogue|clarity|engagement|character",
        "severity": "info|warning|critical",
        "message": "specific issue that hurts the story",
        "suggestion": "surgical fix that respects the writer's voice",
        "excerpt": "exact 10-30 char quote from THIS scene"
      }
    ],
    "strengths": ["what works well - be specific"]
  }
]

IMPORTANT:
- If a scene works well, give it a high score and few/no issues
- Don't flag intentional repetition, fragmentation, or stylistic choices
- Respect authentic dialogue even if it breaks "grammar rules"
- Max ${getMaxIssuesPerScene(settings.writingMode)} issues per scene, only if they genuinely need fixing
- Complete ALL ${scenes.length} scenes`;
}

// Language name mapping
function getLanguageName(code: string): string {
  const languages: Record<string, string> = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    ru: 'Russian',
    ja: 'Japanese',
    zh: 'Chinese',
    ko: 'Korean',
  };
  return languages[code] || 'English';
}

/**
 * Extract JSON from AI response (handles markdown code blocks and nested structures)
 */
export function extractJsonFromResponse(response: string): string | null {
  if (!response) return null;

  // Try to extract from markdown code block first
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    return jsonMatch[1].trim();
  }

  // Find the FIRST occurrence of { or [ to determine if it's object or array
  const firstBrace = response.indexOf('{');
  const firstBracket = response.indexOf('[');

  // If object starts first (or array not found), extract object
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    // Find matching closing brace using bracket counting
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let start = firstBrace;

    for (let i = firstBrace; i < response.length; i++) {
      const char = response[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') depth++;
        if (char === '}') {
          depth--;
          if (depth === 0) {
            return response.substring(start, i + 1);
          }
        }
      }
    }
  }

  // If array starts first, extract array
  if (firstBracket !== -1) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let start = firstBracket;

    for (let i = firstBracket; i < response.length; i++) {
      const char = response[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '[') depth++;
        if (char === ']') {
          depth--;
          if (depth === 0) {
            return response.substring(start, i + 1);
          }
        }
      }
    }
  }

  return response.trim();
}

