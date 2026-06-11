// filepath: src/routes/ai/documents.ts
import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { requireAuth } from "../../middleware/auth";
import { extractUserId, addPricingService, checkAIGenerationLimit, trackAIUsage, checkImageCredits, trackImageUsage, PricingRequest } from "../../middleware/pricingMiddleware";
import { addAIUsageTracker, extractProjectId, trackOpenAIUsageInRoute, trackImageUsageInRoute, AITrackingRequest } from "../../middleware/aiUsageMiddleware";
import { preventDuplicateTreatmentGeneration, preventDuplicateStoryboardImageGeneration } from "../../middleware/requestDeduplication";
import { OpenAI } from "openai";
import { getUserId, loadProjectLanguageSettings, buildLanguageInstructions, removeEmptyTextNodes, convertMarkdownBoldToTipTapMarks, extractTextFromTipTapJSON } from '../../utils/aiHelpers';
import { aiTaskEvents } from '../../services/aiTaskEventService';
import { aiRouter, AIModelRouter, StructuredOutputFormat } from '../../services/aiModelRouter';
import { getImageRouter } from '../../services/imageModelRouter';
import { computeDocumentSizing, getEpisodicSizingContext } from '../../services/documentSizing';

dotenv.config();

// Only log verbose AI details when explicitly enabled (local dev only)
const DEBUG_AI = process.env.DEBUG_AI === 'true';

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Helper: verify user has access to a project (owner or active collaborator)
async function checkProjectAccessForUser(projectId: string, userId: string): Promise<{
  hasAccess: boolean;
  canEdit: boolean;
}> {
  const { data: project } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();

  if (!project) return { hasAccess: false, canEdit: false };
  if (project.user_id === userId) return { hasAccess: true, canEdit: true };

  const { data: collaborator } = await supabase
    .from('project_collaborators')
    .select('role, status')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (!collaborator) return { hasAccess: false, canEdit: false };
  return { hasAccess: true, canEdit: ['owner', 'admin', 'editor'].includes(collaborator.role) };
}

/**
 * Create a TipTap document JSON schema for structured outputs
 * This ensures the AI returns valid TipTap JSON that can be directly used in the editor
 * Note: OpenAI strict mode requires additionalProperties: false at ALL nested levels
 */
function createTipTapDocumentSchema(): StructuredOutputFormat {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'tiptap_document',
      schema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Must be "doc"'
          },
          content: {
            type: 'array',
            description: 'Array of block nodes (headings, paragraphs)',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  description: 'Block type: "heading" or "paragraph"'
                },
                attrs: {
                  type: 'object',
                  description: 'Optional attributes like level for headings',
                  properties: {
                    level: {
                      type: 'number',
                      description: 'Heading level (1-6)'
                    }
                  },
                  required: [],
                  additionalProperties: false
                },
                content: {
                  type: 'array',
                  description: 'Array of inline text nodes',
                  items: {
                    type: 'object',
                    properties: {
                      type: {
                        type: 'string',
                        description: 'Must be "text"'
                      },
                      text: {
                        type: 'string',
                        description: 'The actual text content'
                      },
                      marks: {
                        type: 'array',
                        description: 'Text formatting marks like bold, italic',
                        items: {
                          type: 'object',
                          properties: {
                            type: {
                              type: 'string',
                              description: 'Mark type: "bold", "italic", "underline"'
                            }
                          },
                          required: ['type'],
                          additionalProperties: false
                        }
                      }
                    },
                    required: ['type', 'text'],
                    additionalProperties: false
                  }
                }
              },
              required: ['type'],
              additionalProperties: false
            }
          }
        },
        required: ['type', 'content'],
        additionalProperties: false
      },
      strict: true
    }
  };
}

// Brainstorming to Document endpoint (replaces brainstorming-to-concept)
router.post("/brainstorming-to-document", requireAuth, extractUserId, preventDuplicateTreatmentGeneration, addPricingService, checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, extractProjectId, async (req: AITrackingRequest, res) => {
  const { conversation, projectId, projectType, documentType, history, includeScript } = req.body;

  // Allow generation with either conversation OR includeScript (script as source)
  if ((!conversation && !includeScript) || !projectId || !documentType) {
    return res.status(400).json({ error: "Missing conversation, projectId, or documentType" });
  }

  // Load language settings for the project
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Verify project access (write required for document generation)
  const access = await checkProjectAccessForUser(projectId, userId);
  if (!access.hasAccess) {
    return res.status(403).json({ error: 'Access denied - not authorized for this project' });
  }
  if (!access.canEdit) {
    return res.status(403).json({ error: 'Read-only access - viewers cannot generate documents', role: 'viewer' });
  }

  const languageSettings = await loadProjectLanguageSettings(projectId, userId);
  const languageInstructions = buildLanguageInstructions(languageSettings.language, languageSettings.content_language, 'generation');

  // Fetch existing documents for context (extract plain text to save tokens)
  let existingDocumentsContext = '';
  try {
    const { data: existingDocs, error: docsError } = await supabase
      .from('documents')
      .select('title, type, content')
      .eq('project_id', projectId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true });

    if (!docsError && existingDocs && existingDocs.length > 0) {

      // Helper function to recursively extract plain text from TipTap JSON
      const extractPlainText = (node: any): string => {
        if (!node) return '';

        // Base case: text node
        if (node.type === 'text') {
          return node.text || '';
        }

        // Handle hardBreak (line breaks)
        if (node.type === 'hardBreak') {
          return '\n';
        }

        // Recursive case: node with content
        if (node.content && Array.isArray(node.content)) {
          const text = node.content.map(extractPlainText).join('');

          // Add spacing after block-level elements (headings, paragraphs)
          if (node.type === 'heading' || node.type === 'paragraph') {
            return text + '\n\n';
          }

          return text;
        }

        return '';
      };

      existingDocumentsContext = '\n\nEXISTING PROJECT DOCUMENTS (use as additional context):\n' +
        existingDocs.map((doc: any) => {
          // Extract plain text content from TipTap JSON (no formatting, just text)
          let plainText = '';
          if (doc.content && typeof doc.content === 'object') {
            plainText = extractPlainText(doc.content).trim();
          } else if (typeof doc.content === 'string') {
            plainText = doc.content;
          }

          // Limit each document to 3000 characters to provide good context without overwhelming
          const truncatedContent = plainText.length > 3000
            ? plainText.substring(0, 3000) + '... (truncated)'
            : plainText;

          return `\n━━━ ${doc.type.toUpperCase()}: ${doc.title} ━━━\n${truncatedContent}\n`;
        }).join('\n');
    }
  } catch (err) {
    console.warn('Could not fetch existing documents for context:', err);
  }

  // Fetch production script for context (ONLY if explicitly requested via includeScript: true)
  // Typical workflow: Treatment comes BEFORE script, so script is not included by default
  // Use includeScript: true when converting an existing script to treatment/synopsis
  let scriptContext = '';
  if (includeScript === true) {
    try {
      // First get the project's prod_script_id
      const { data: projectData, error: projectError } = await supabase
        .from('projects')
        .select('prod_script_id')
        .eq('id', projectId)
        .single();

      if (!projectError && projectData?.prod_script_id) {
      // Fetch the production script content
      const { data: scriptData, error: scriptError } = await supabase
        .from('scripts')
        .select('title, content')
        .eq('id', projectData.prod_script_id)
        .single();

      if (!scriptError && scriptData?.content) {
        const scriptText = extractTextFromTipTapJSON(scriptData.content);

        // Only include if script has meaningful content (more than just a few characters)
        if (scriptText.length > 100) {
          // Include FULL script - Grok has 2M token context, no need to truncate
          scriptContext = `\n\n═══════════════════════════════════════════════════════════════
PRODUCTION SCRIPT: ${scriptData.title || 'Untitled'}
═══════════════════════════════════════════════════════════════
This is the COMPLETE screenplay. Use it as the PRIMARY source for the treatment.
The treatment MUST follow this script's narrative from beginning to end.

CRITICAL INSTRUCTION FOR SCRIPT-TO-TREATMENT CONVERSION:
A treatment is NOT a scene-by-scene summary. Do NOT try to cover every single scene individually.
Instead, GROUP related scenes into flowing narrative sequences. A sequence of 5-10 short scenes in the script might become 2-3 rich paragraphs in the treatment.
Focus on the STORY ARC: major plot points, character development, emotional turning points, and key dramatic moments.
Minor transitional scenes, brief establishing shots, and repetitive beats should be woven naturally into the broader narrative or omitted entirely.
Do NOT compress scenes into single-line summaries or telegraphic sensory lists.
Write like a novelist retelling the story, not like someone cataloging every scene.
Every paragraph must contain 2-3+ complete sentences of flowing, immersive prose with character emotions, visual descriptions, and natural dialogue.

${scriptText}

═══════════════════════════════════════════════════════════════
END OF SCRIPT
═══════════════════════════════════════════════════════════════\n`;

          if (DEBUG_AI) console.log(`📜 Including FULL production script in context (${scriptText.length} chars)`);
        }
      }
    }
    } catch (err) {
      console.warn('Could not fetch production script for context:', err);
    }
  } else {
    if (DEBUG_AI) console.log('📜 Script not included (includeScript not set)');
  }

  // Format the full conversation history for better context
  // Include: conversation history + existing documents + production script
  const fullConversation = (history && history.length > 0
    ? history.map((msg: any) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n\n')
    : conversation) + existingDocumentsContext + scriptContext;

  // Fetch project settings to get duration/runtime
  let projectSettings: any = {};
  let estimatedDuration = 0;

  try {
    const { data: projectData, error: projectError } = await supabase
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .single();

    if (!projectError && projectData?.settings) {
      projectSettings = projectData.settings;
      estimatedDuration = projectSettings.duration || projectSettings.runtime || 0;
    }
  } catch (err) {
    console.warn('Could not fetch project settings for duration:', err);
  }

  // Format/scope-aware sizing: films by duration, series per episode, vertical
  // series per season. See services/documentSizing.ts.
  const episodicContext = await getEpisodicSizingContext(supabase, projectId, projectType);
  const sizing = computeDocumentSizing({
    documentType,
    projectType,
    durationMinutes: estimatedDuration,
    episodeRuntime: episodicContext.episodeRuntime,
    seasonEpisodeCount: episodicContext.seasonEpisodeCount,
  });

  // Get document-specific instructions based on type and project duration
  const getDocumentInstructions = (docType: string, projType: string, durationMinutes: number) => {
    // Determine expected length based on project duration and type
    let lengthGuidance = '';
    let pageCount = '';

    // Calculate page count based on duration (rough guide: 1 page per 5-10 minutes of content)
    if (durationMinutes > 0) {
      const minPages = Math.ceil(durationMinutes / 10);
      const maxPages = Math.ceil(durationMinutes / 5);
      pageCount = `${minPages}-${maxPages} pages`;
      lengthGuidance = `Project duration: ${durationMinutes} minutes. Generate ${pageCount} of comprehensive, detailed content.`;
    } else {
      // Fallback to project type defaults if no duration specified
      if (projType === 'short' || projType === 'short_film') {
        lengthGuidance = 'Short film (5-15 min): 2-3 pages of detailed narrative.';
      } else if (projType === 'documentary') {
        lengthGuidance = 'Documentary (30-60 min): 5-8 pages covering all major story beats, interviews, locations, and narrative arc in detail.';
      } else if (projType === 'film' || projType === 'movie' || projType === 'feature_film') {
        lengthGuidance = 'Feature film (90-120 min): 8-12 pages with comprehensive three-act structure, character arcs, and key scenes.';
      } else if (projType === 'vertical_series') {
        lengthGuidance = 'Vertical episode (1-3 min): 1-2 pages of fast, hook-driven micro-drama beats with a cliffhanger.';
      } else if (projType === 'series' || projType === 'tv_episode') {
        lengthGuidance = 'TV episode (30-60 min): 4-6 pages covering act breaks, plot threads, and character development.';
      } else if (projType === 'web_series') {
        lengthGuidance = 'Web series episode (5-15 min): 2-3 pages with focused narrative and key moments.';
      } else {
        lengthGuidance = 'Standard project: 3-5 pages of detailed content.';
      }
    }

    switch (docType) {
      case 'treatment':
        // Scope-aware page count (film by duration, series per episode, vertical per season)
        const estimatedPages = sizing.estimatedPages;
        const paragraphsPerPage = 10; // Industry standard
        const minParagraphs = estimatedPages * paragraphsPerPage;

        return `
        Write a professional film treatment. A treatment is a narrative prose document that tells the complete story like a short novel.

        ═══════════════════════════════════════════════════════════════
        🚫🚫🚫 ABSOLUTELY FORBIDDEN - NEVER DO THESE 🚫🚫🚫
        ═══════════════════════════════════════════════════════════════

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
        ❌ Structural headers or section breaks
        ❌ Any text about paragraph counts or length requirements
        ❌ One sentence per paragraph (EVERY paragraph needs 2-3+ sentences minimum)

        ═══════════════════════════════════════════════════════════════
        ✅ HOW TO WRITE CORRECTLY
        ═══════════════════════════════════════════════════════════════

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

        ═══════════════════════════════════════════════════════════════

        ${sizing.scopeNote}

        LENGTH: ${lengthGuidance}
        Target: ${estimatedPages} pages of detailed narrative prose.

        Begin with the title, then drop us directly into the opening scene.
        Tell the complete story from beginning to end.
        Write like a novelist - immersive, visual, emotional.
        `;
      case 'logline':
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

        Write the logline for THIS project using the information provided. Make it specific, compelling, and true to the story.
        `;
      case 'synopsis':
        return `
        Write the actual synopsis for this specific project.

        LENGTH REQUIREMENT: ${lengthGuidance}

        Provide a comprehensive story overview covering main plot points, character arcs, themes, and resolution. Include enough detail that someone can understand the complete narrative arc. Bold character names and key plot events. Use italic for genre and tone descriptions.
        `;
      case 'character_breakdown':
        return `
        Write the actual character breakdown for the specific characters in this project.

        For each main character, provide detailed sections: physical description, personality traits, background/history, goals/motivations, character arc, relationships with other characters, key scenes/moments.

        Each character should have multiple paragraphs. Bold character names and key traits. Use italic for emotional states and motivations.
        `;
      case 'pitch_deck':
        return `
        Write the actual pitch deck content for this specific project.

        Include comprehensive sections: Logline, Project Overview, Target Audience (demographics + psychographics), Comparable Projects, Unique Selling Points, Creative Vision, Market Opportunity, Production Approach, Distribution Strategy, Team/Talent, Budget Overview.

        Each section should be detailed with specific examples and data. Bold statistics and unique selling points. Use italic for creative vision and market insights.
        `;
      default:
        return `
        Write the actual content for this specific project. Create relevant, detailed content based on the conversation.

        LENGTH REQUIREMENT: ${lengthGuidance}

        Provide substantial detail and comprehensive coverage of the topic. Bold key concepts and important terms. Use italic for descriptions and context.
        `;
    }
  };

  const prompt = `
${languageInstructions}

TASK: Generate a ${documentType} document based on the brainstorming conversation below.

PROJECT TYPE: ${projectType}

CONVERSATION:
${fullConversation}

CONTENT REQUIREMENTS:
${getDocumentInstructions(documentType, projectType, estimatedDuration)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL OUTPUT FORMAT - READ CAREFULLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOU MUST RETURN **ONLY** A VALID TIPTAP JSON OBJECT. NO OTHER TEXT.

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

🚨🚨🚨 FINAL LENGTH ENFORCEMENT REMINDER 🚨🚨🚨
[DYNAMIC REQUIREMENTS WILL BE INSERTED HERE]

RETURN ONLY THE JSON OBJECT. START NOW.
`;

  try {
    // Dynamic token allocation from the shared, scope-aware sizing helper.
    const estimatedPages = sizing.estimatedPages;
    const maxTokens = sizing.maxTokens;

    if (DEBUG_AI) console.log(`📊 Token allocation for ${documentType} (${sizing.scope} scope): ${estimatedPages} pages = ${maxTokens} tokens (duration: ${estimatedDuration}min)`);

    const tokenLimits = {
      maxTokens: maxTokens,
      reasoning: `Grok ${documentType} generation for ${projectType} (${estimatedDuration}min) - ${estimatedPages} pages`
    };

    // Calculate dynamic paragraph requirements based on document type and pages
    let lengthGuidance = '';

    switch (documentType) {
      case 'treatment':
        const minParagraphsRequired = estimatedPages * 10; // 10 paragraphs per page
        // Flexible act distribution based on duration
        const act1Pct = estimatedDuration > 90 ? 25 : 30; // Longer films have proportionally shorter setups
        const act2Pct = estimatedDuration > 90 ? 50 : 40;
        const act3Pct = 100 - act1Pct - act2Pct;
        const act1Paragraphs = Math.ceil(minParagraphsRequired * act1Pct / 100);
        const act2Paragraphs = Math.ceil(minParagraphsRequired * act2Pct / 100);
        const act3Paragraphs = Math.ceil(minParagraphsRequired * act3Pct / 100);
        lengthGuidance = `YOU MUST GENERATE AT LEAST ${minParagraphsRequired} PARAGRAPHS FOR THIS TREATMENT.
This is a ${estimatedDuration > 0 ? estimatedDuration + '-minute' : ''} ${projectType} which requires ${estimatedPages} pages of detailed narrative prose, totaling at least ${minParagraphsRequired} paragraphs.
Distribute paragraphs across the story structure (do NOT write act labels in the output, this is just for your internal pacing):
  Setup/first quarter: ~${act1Paragraphs} paragraphs
  Middle/confrontation: ~${act2Paragraphs} paragraphs
  Resolution/climax: ~${act3Paragraphs} paragraphs
Group related scenes into flowing narrative sequences. Do NOT write one paragraph per scene. Instead, weave multiple scenes into rich narrative passages.
Every paragraph must contain 2-3 complete sentences of flowing, novel-like prose. Never compress a scene into a single line or a comma-separated sensory list.
DO NOT STOP until you have written ${minParagraphsRequired}+ paragraphs. STOPPING BEFORE ${minParagraphsRequired} PARAGRAPHS = FAILURE.`;
        break;

      case 'logline':
        lengthGuidance = `- TARGET LENGTH: ONE SENTENCE ONLY (30-50 words)
- Use the logline formula provided
- Be specific to THIS story
- Include protagonist, goal, conflict, and stakes
- DO NOT write multiple sentences or paragraphs`;
        break;

      case 'synopsis':
        const synopsisParagraphs = estimatedPages * 6; // Fewer paragraphs per page for synopsis
        lengthGuidance = `- TARGET LENGTH: ${estimatedPages} pages (approximately ${synopsisParagraphs} paragraphs)
- Brief but comprehensive overview of the complete story
- Cover beginning, middle, and end
- Include main character arcs and key plot points
- This is a SUMMARY, not a full narrative - be concise but complete`;
        break;

      case 'character_breakdown':
        lengthGuidance = `- TARGET LENGTH: ${estimatedPages} pages
- Detail each main character (3-5 characters for this ${estimatedDuration}min ${projectType})
- Each character needs multiple paragraphs covering: description, personality, background, goals, arc, relationships
- Be thorough and specific`;
        break;

      case 'pitch_deck':
        lengthGuidance = `- TARGET LENGTH: ${estimatedPages} pages
- Include all sections: Logline, Overview, Target Audience, Comparables, USPs, Vision, Market, Production, Distribution, Team, Budget
- Each section should be detailed with specific examples
- Professional business presentation format`;
        break;

      default:
        lengthGuidance = `- TARGET LENGTH: ${estimatedPages} pages
- Provide comprehensive, detailed content
- Be thorough and professional`;
    }

    // Insert dynamic length requirements into the prompt
    const finalPrompt = prompt.replace(
      '[DYNAMIC REQUIREMENTS WILL BE INSERTED HERE]',
      lengthGuidance
    );

    if (DEBUG_AI) console.log(`📊 Calling AI Router with ${maxTokens} max tokens for ${documentType} (${estimatedPages} pages)`);

    const docContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: finalPrompt,
      expectedOutputTokens: tokenLimits.maxTokens,
      metadata: { forceModel: 'gpt-5-mini', contentScale: 'feature' }
    });

    const systemPrompt = `You are a JSON document generator. Your ONLY job is to return valid TipTap JSON structures.

ABSOLUTE RULES:
1. Return ONLY JSON - no markdown, no code blocks, no explanations
2. Start your response with: { "type": "doc",
3. End your response with: }

🚨🚨🚨 CRITICAL - BOLD FORMATTING (NEVER USE MARKDOWN) 🚨🚨🚨
- NEVER use markdown like **text** or __text__
- Character names MUST be bold using TipTap marks structure
- For bold text, use: { "type": "text", "marks": [{ "type": "bold" }], "text": "Name" }

CORRECT BOLD EXAMPLE:
{"type":"paragraph","content":[{"type":"text","text":"She meets "},{"type":"text","marks":[{"type":"bold"}],"text":"Clara"},{"type":"text","text":" at the café."}]}

WRONG (NEVER DO THIS):
{"type":"paragraph","content":[{"type":"text","text":"She meets **Clara** at the café."}]}

4. DO NOT wrap JSON inside text nodes
5. DO NOT add any text before or after the JSON object
6. CRITICAL: VALID JSON SYNTAX:
   - NO TRAILING COMMAS: { "a": 1, } is INVALID
   - ALL PROPERTIES NEED VALUES: { "text": "value" } NOT { "text", "marks": [] }
   - EVERY property must have a colon (:) followed by a value
   - Empty text nodes must be: { "type": "text", "text": "" } NOT { "type": "text", "text" }
7. CRITICAL: ESCAPE ALL QUOTES - Use \\" for quotes inside "text" values

═══════════════════════════════════════════════════════════════
🚨🚨🚨 CRITICAL LENGTH ENFORCEMENT - DO NOT STOP EARLY 🚨🚨🚨
═══════════════════════════════════════════════════════════════
- You have ${maxTokens} TOKENS allocated - USE THEM ALL
- Target: ${estimatedPages} pages of content
- MINIMUM: ${Math.floor(maxTokens * 0.7)} tokens of output
- Each paragraph = one { "type": "paragraph", "content": [...] } block

YOUR OUTPUT WILL BE REJECTED IF:
- You use less than 70% of allocated tokens
- You summarize instead of writing detailed prose
- You stop before telling the complete story

KEEP WRITING until you have:
- Described EVERY scene in detail (2-3 paragraphs each)
- Shown EVERY character's emotional journey
- Included visual descriptions of EVERY location
- Written natural dialogue exchanges
- Told the COMPLETE story from beginning to end

DO NOT output meta-commentary about length. Just WRITE THE CONTENT.
═══════════════════════════════════════════════════════════════

${languageInstructions}`;

    // For treatments, DON'T use structured outputs - they constrain verbosity
    // Instead rely on post-processing to fix any JSON issues
    // For shorter docs (logline, synopsis), structured outputs help ensure valid JSON
    const isLongFormContent = documentType === 'treatment';

    const completionOptions: any = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: finalPrompt },
      ],
      maxTokens: tokenLimits.maxTokens,
    };

    // Use simple JSON mode (not strict schema) - GPT-5-mini has good JSON adherence
    // Strict schema mode doesn't work well with TipTap's flexible structure (optional attrs, marks)
    completionOptions.responseFormat = { type: 'json_object' };
    if (DEBUG_AI) console.log('📋 Using JSON object mode for guaranteed JSON format');

    const docResult = await aiRouter.executeCompletion(docContext, completionOptions);

    let rawResponse = docResult.content?.trim() || "";

    const tokensUsed = docResult.usage?.completion_tokens || 0;
    const tokenUtilization = Math.round((tokensUsed / tokenLimits.maxTokens) * 100);

    if (DEBUG_AI) console.log(`✅ AI Router Response: ${rawResponse.length} characters, ${tokensUsed} tokens used (${tokenUtilization}% of ${tokenLimits.maxTokens} allocated)`);

    // Warn if token usage is very low (model stopped early)
    if (DEBUG_AI && tokenUtilization < 30 && isLongFormContent) {
      console.warn('⚠️ LOW TOKEN UTILIZATION:', {
        used: tokensUsed,
        allocated: tokenLimits.maxTokens,
        utilization: `${tokenUtilization}%`,
        documentType,
        hint: 'Model stopped early - consider adjusting prompt to encourage longer output'
      });
    }

    // Enhanced error handling for empty responses
    if (!rawResponse || rawResponse.length < 50) {
      console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.error("❌ AI RETURNED EMPTY OR VERY SHORT RESPONSE");
      console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.error("Response length:", rawResponse.length);
      console.error("Response content:", rawResponse);
      console.error("Requested tokens:", tokenLimits.maxTokens);
      console.error("Actual tokens used:", docResult.usage?.completion_tokens || 0);
      console.error("Document type:", documentType);
      console.error("Estimated duration:", estimatedDuration);
      console.error("Model used:", docResult.model);

      return res.status(500).json({
        error: "AI model returned an empty or incomplete response. Please try again.",
        details: {
          responseLength: rawResponse.length,
          requestedTokens: tokenLimits.maxTokens,
          actualTokens: docResult.usage?.completion_tokens || 0,
          model: docResult.model,
          documentType
        }
      });
    }

    // Track token usage
    if (docResult.usage && req.userId) {
      await trackOpenAIUsageInRoute(req, 'document_generation', docResult.model, {
        prompt_tokens: docResult.usage.prompt_tokens,
        completion_tokens: docResult.usage.completion_tokens,
        total_tokens: docResult.usage.total_tokens
      }, {
        metadata: {
          projectType,
          documentType,
          conversationLength: fullConversation.length,
          hasHistory: !!(history && history.length > 0),
          requestedTokens: tokenLimits.maxTokens,
          estimatedDuration: estimatedDuration,
          estimatedPages: estimatedPages,
          provider: docResult.provider
        }
      });
    }

    let cleanedResponse = rawResponse;

    // Remove markdown code blocks
    if (cleanedResponse.includes('```')) {
      cleanedResponse = cleanedResponse
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
    }

    // Remove any leading/trailing text before/after JSON
    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedResponse = jsonMatch[0];
    }

    // Fix common JSON errors:
    const originalLength = cleanedResponse.length;
    let fixCount = 0;

    // 1. Trailing commas in arrays/objects
    const trailingCommasBefore = cleanedResponse;
    cleanedResponse = cleanedResponse.replace(/,(\s*[}\]])/g, '$1');
    if (cleanedResponse !== trailingCommasBefore) {
      fixCount++;
      if (DEBUG_AI) console.log('🔧 Fixed trailing commas');
    }

    // 2. Missing value after "text" property (but only as a property name, not value)
    // Match: { "text", "marks" but NOT { "type": "text", "marks"
    // Look for "text" NOT preceded by : (negative lookbehind)
    const textMarksBefore = cleanedResponse;
    cleanedResponse = cleanedResponse.replace(/(?<!:\s*)"text"\s*,\s*"marks"/g, '"text":"","marks"');
    if (cleanedResponse !== textMarksBefore) {
      fixCount++;
      if (DEBUG_AI) console.log('🔧 Fixed missing text values before marks');
    }

    // 3. Missing value after "text" property at end: "text"} -> "text":""}
    // But NOT { "type": "text" }
    const textEndBefore = cleanedResponse;
    cleanedResponse = cleanedResponse.replace(/(?<!:\s*)"text"\s*}/g, '"text":""}');
    if (cleanedResponse !== textEndBefore) {
      fixCount++;
      if (DEBUG_AI) console.log('🔧 Fixed missing text values at end of objects');
    }

    // 4. Double commas
    const doubleCommasBefore = cleanedResponse;
    cleanedResponse = cleanedResponse.replace(/,,+/g, ',');
    if (cleanedResponse !== doubleCommasBefore) {
      fixCount++;
      if (DEBUG_AI) console.log('🔧 Fixed double commas');
    }

    // 5. Missing colon after "text": "text" "value" -> "text":"value"
    // But only when "text" is a property name, not a value
    const missingColonBefore = cleanedResponse;
    cleanedResponse = cleanedResponse.replace(/(?<!:\s*)"text"\s+"([^"]*?)"/g, '"text":"$1"');
    if (cleanedResponse !== missingColonBefore) {
      fixCount++;
      if (DEBUG_AI) console.log('🔧 Fixed missing colons after text property');
    }

    // 6. Missing comma between array elements: }] { -> }], { or } { -> }, {
    // This happens when AI forgets commas between objects/arrays in an array
    const missingArrayCommaBefore = cleanedResponse;
    // Handle }] { pattern (end of nested structure, start of new object)
    cleanedResponse = cleanedResponse.replace(/\}(\s*)\](\s+)\{/g, '}$1],$2{');
    // Handle } { pattern (between objects in an array)
    cleanedResponse = cleanedResponse.replace(/\}(\s+)\{(?="type")/g, '},$1{');
    if (cleanedResponse !== missingArrayCommaBefore) {
      fixCount++;
      if (DEBUG_AI) console.log('🔧 Fixed missing commas between array elements');
    }

    // 7. Missing ] to close content array before closing paragraph
    // Pattern: } } , { should be } ] } , { (close text, close content array, close paragraph)
    const missingContentCloseBefore = cleanedResponse;
    // Fix: }(whitespace)}(whitespace), -> }](whitespace)}(whitespace),
    cleanedResponse = cleanedResponse.replace(/\}(\s*)\}(\s*),(\s*)\{(\s*)"type":\s*"paragraph"/g, '}]$1}$2,$3{$4"type": "paragraph"');
    if (cleanedResponse !== missingContentCloseBefore) {
      fixCount++;
      if (DEBUG_AI) console.log('🔧 Fixed missing ] to close content arrays');
    }

    // 8. Missing ] at end of content arrays (more general fix)
    // Pattern: "text": "value" } } -> "text": "value" } ] }
    const missingBracketBefore = cleanedResponse;
    cleanedResponse = cleanedResponse.replace(/"text":\s*"[^"]*"\s*\}(\s*)\}(\s*),/g, (match, ws1, ws2) => {
      // Check if there's already a ] - if not, add one
      if (!match.includes(']')) {
        return match.replace(/\}(\s*)\}(\s*),/, '}]$1}$2,');
      }
      return match;
    });
    if (cleanedResponse !== missingBracketBefore) {
      fixCount++;
      if (DEBUG_AI) console.log('🔧 Fixed missing ] after text nodes');
    }

    if (fixCount > 0) {
      if (DEBUG_AI) console.log(`✅ Applied ${fixCount} JSON fixes`);
    }

    let documentJson: any;

    try {
      documentJson = JSON.parse(cleanedResponse);
      if (!documentJson.type || documentJson.type !== "doc") {
        throw new Error('Missing or invalid "type" field - must be "doc"');
      }

      if (!Array.isArray(documentJson.content)) {
        throw new Error('Missing or invalid "content" field - must be an array');
      }

      if (documentJson.content.length === 0) {
        throw new Error('Content array is empty');
      }

      // === STEP 5: Check for double-encoding (AI wrapped JSON in text node) ===
      if (documentJson.content.length === 1 &&
          documentJson.content[0].type === "paragraph" &&
          documentJson.content[0].content?.[0]?.type === "text") {

        const innerText = documentJson.content[0].content[0].text;

        // Check if the text looks like JSON
        if (innerText.trim().startsWith('{') && innerText.trim().endsWith('}')) {

          try {
            const unwrapped = JSON.parse(innerText);

            if (unwrapped.type === "doc" && Array.isArray(unwrapped.content)) {
              documentJson = unwrapped;
            }
          } catch (unwrapError) {
            if (DEBUG_AI) console.log('⚠️  Could not unwrap - keeping original structure');
          }
        }
      }

      // === STEP 6: Clean up empty nodes ===
      documentJson = removeEmptyTextNodes(documentJson);
      if (DEBUG_AI) console.log('🧹 Removed empty text nodes');

      // === STEP 7: Convert markdown **bold** to TipTap marks ===
      documentJson = convertMarkdownBoldToTipTapMarks(documentJson);
      if (DEBUG_AI) console.log('🔧 Converted markdown bold to TipTap marks');

    } catch (parseError: any) {
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('❌ JSON PARSING FAILED');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('❌ Error message:', parseError.message);
      console.error('❌ Error stack:', parseError.stack);

      // Show context around the error position if available
      const posMatch = parseError.message.match(/position (\d+)/);
      if (posMatch) {
        const errorPos = parseInt(posMatch[1]);
        const contextStart = Math.max(0, errorPos - 100);
        const contextEnd = Math.min(cleanedResponse.length, errorPos + 100);
        console.error('📍 Error context (position', errorPos, '):');
        console.error('   ...', cleanedResponse.substring(contextStart, contextEnd), '...');
        console.error('   ', ' '.repeat(errorPos - contextStart), '^ ERROR HERE');
      }

      const lines = cleanedResponse.split('\n').filter(line => line.trim().length > 0);

      documentJson = {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: `Generated ${documentType}` }]
          },
          ...lines.map(line => ({
            type: "paragraph",
            content: [{ type: "text", text: line.trim() }]
          }))
        ]
      };
    }

    if (projectId) {
      try {
        // Create a new document record
        const { data: documentData, error: documentError } = await supabase
          .from("project_documents")
          .insert([{
            project_id: projectId,
            document_type: documentType,
            title: `Generated ${documentType.charAt(0).toUpperCase() + documentType.slice(1)}`,
            content: documentJson,
            is_ai_generated: true
          }])
          .select()
          .single();

        if (documentError) {
          console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.error("❌ DATABASE SAVE FAILED");
          console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.error("❌ Error:", documentError);
          return res.status(500).json({ error: "Failed to save document to database" });
        }

        aiTaskEvents.emit('task', {
          type: 'document:completed',
          projectId,
          userId,
          payload: { documentId: documentData.id, documentType },
        });

        res.json({
          success: true,
          documentId: documentData.id,
          id: documentData.id, // Also include 'id' for backwards compatibility
          documentType: documentType,
          title: documentData.title,
          content: documentJson
        });

      } catch (saveError) {
        console.error("Error saving document:", saveError);
        res.status(500).json({ error: "Failed to save document" });
      }
    } else {
      aiTaskEvents.emit('task', {
        type: 'document:completed',
        projectId,
        userId,
        payload: { documentType },
      });

      res.json({
        success: true,
        content: documentJson,
        documentType: documentType
      });
    }
  } catch (error) {
    console.error("Document generation error:", error);
    aiTaskEvents.emit('task', {
      type: 'document:failed',
      projectId,
      userId,
      payload: { error: error instanceof Error ? error.message : 'Unknown error' },
    });
    res.status(500).json({ error: "Document generation failed" });
  }
});

// POST /enrich-document - Enrich an existing document with project data (script or conversation)
router.post("/enrich-document", requireAuth, extractUserId, addPricingService, checkAIGenerationLimit, trackAIUsage, addAIUsageTracker, extractProjectId, async (req: AITrackingRequest, res) => {
  const { documentId, projectId, enrichSource, conversationId, documentType } = req.body;

  if (!documentId || !projectId || !enrichSource || !documentType) {
    return res.status(400).json({ error: "Missing documentId, projectId, enrichSource, or documentType" });
  }

  if (!['script', 'conversation'].includes(enrichSource)) {
    return res.status(400).json({ error: "enrichSource must be 'script' or 'conversation'" });
  }

  if (enrichSource === 'conversation' && !conversationId) {
    return res.status(400).json({ error: "conversationId is required when enrichSource is 'conversation'" });
  }

  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Verify project access (write required for enrichment)
  const enrichAccess = await checkProjectAccessForUser(projectId, userId);
  if (!enrichAccess.hasAccess) {
    return res.status(403).json({ error: 'Access denied - not authorized for this project' });
  }
  if (!enrichAccess.canEdit) {
    return res.status(403).json({ error: 'Read-only access - viewers cannot enrich documents', role: 'viewer' });
  }

  const languageSettings = await loadProjectLanguageSettings(projectId, userId);
  const languageInstructions = buildLanguageInstructions(languageSettings.language, languageSettings.content_language, 'generation');

  // Fetch the existing document content
  let existingDocumentText = '';
  let existingDocumentTitle = '';
  try {
    const { data: docData, error: docError } = await supabase
      .from('project_documents')
      .select('title, content, document_type')
      .eq('id', documentId)
      .eq('project_id', projectId)
      .single();

    if (docError || !docData) {
      return res.status(404).json({ error: "Document not found" });
    }

    existingDocumentTitle = docData.title || '';
    existingDocumentText = extractTextFromTipTapJSON(docData.content) || '';
  } catch (err) {
    console.error('Error fetching document:', err);
    return res.status(500).json({ error: "Failed to fetch document" });
  }

  // Fetch source data based on enrichSource
  let sourceContext = '';
  let sourceLabel = '';

  if (enrichSource === 'script') {
    sourceLabel = 'Production Script';
    try {
      const { data: projectData, error: projectError } = await supabase
        .from('projects')
        .select('prod_script_id')
        .eq('id', projectId)
        .single();

      if (projectError || !projectData?.prod_script_id) {
        return res.status(404).json({ error: "No production script found for this project" });
      }

      const { data: scriptData, error: scriptError } = await supabase
        .from('scripts')
        .select('title, content')
        .eq('id', projectData.prod_script_id)
        .single();

      if (scriptError || !scriptData?.content) {
        return res.status(404).json({ error: "Script content not found" });
      }

      const scriptText = extractTextFromTipTapJSON(scriptData.content);
      if (scriptText.length < 100) {
        return res.status(400).json({ error: "Script has insufficient content to enrich from" });
      }

      sourceContext = `PRODUCTION SCRIPT: ${scriptData.title || 'Untitled'}\n\n${scriptText}`;
    } catch (err) {
      console.error('Error fetching script:', err);
      return res.status(500).json({ error: "Failed to fetch script data" });
    }
  } else if (enrichSource === 'conversation') {
    sourceLabel = 'Brainstorming Conversation';
    try {
      const { data: convData, error: convError } = await supabase
        .from('conversations')
        .select('title')
        .eq('id', conversationId)
        .eq('project_id', projectId)
        .single();

      if (convError || !convData) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { data: messages, error: msgError } = await supabase
        .from('conversation_messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (msgError || !messages || messages.length === 0) {
        return res.status(400).json({ error: "Conversation has no messages" });
      }

      sourceContext = `CONVERSATION: ${convData.title || 'Untitled'}\n\n` +
        messages.map((msg: any) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`).join('\n\n');
    } catch (err) {
      console.error('Error fetching conversation:', err);
      return res.status(500).json({ error: "Failed to fetch conversation data" });
    }
  }

  // Fetch project settings for duration
  let estimatedDuration = 0;
  let projectType = 'film';
  try {
    const { data: projectData } = await supabase
      .from('projects')
      .select('settings, project_type')
      .eq('id', projectId)
      .single();

    if (projectData?.settings) {
      estimatedDuration = projectData.settings.duration || projectData.settings.runtime || 0;
    }
    if (projectData?.project_type) {
      projectType = projectData.project_type;
    }
  } catch (err) {
    console.warn('Could not fetch project settings:', err);
  }

  // Format/scope-aware sizing: films are sized by duration, series per episode,
  // vertical series per season. See services/documentSizing.ts.
  const episodicContext = await getEpisodicSizingContext(supabase, projectId, projectType);
  const sizing = computeDocumentSizing({
    documentType,
    projectType,
    durationMinutes: estimatedDuration,
    episodeRuntime: episodicContext.episodeRuntime,
    seasonEpisodeCount: episodicContext.seasonEpisodeCount,
  });
  const estimatedPages = sizing.estimatedPages;

  // Calculate length guidance based on document type and project duration
  let lengthGuidance = '';

  switch (documentType) {
    case 'treatment':
      const minParagraphs = estimatedPages * 10;
      lengthGuidance = `Write a professional treatment as narrative prose.

${sizing.scopeNote}

LENGTH: ${estimatedPages} pages, ${minParagraphs}+ paragraphs MINIMUM.${estimatedDuration > 0 ? ` Project duration: ${estimatedDuration} minutes.` : ''}

ABSOLUTELY FORBIDDEN:
- NO bullet points or lists of ANY kind
- NO shorthand notes like "Clara: goes to office" or "Flashback: beach"
- NO act labels ("Act 1", "Act 2")
- NO structural headers or section breaks
- NO one-line telegraphic scene summaries like "Kitchen fridge hums, sandwich crunch, pool water laps."
- NO comma-separated sensory word lists instead of real sentences
- NO one sentence per paragraph. EVERY paragraph needs 2-3+ full sentences.
- NO meta-commentary about the story

EVERY paragraph MUST be:
- At least 2-3 complete sentences of flowing prose
- Descriptive and immersive, like reading a novel
- Include sensory details woven into complete sentences (not comma-separated lists)
- Include dialogue in quotation marks woven naturally into the prose

CORRECT EXAMPLE: "The newsroom hums with the glow of fluorescent lights as phones trill without pause. Edward shuffles through a stack of papers on his cluttered desk, the envelope crinkling open to reveal a photograph he hasn't seen in years. He stares at it for a long moment, the noise around him fading to nothing."

WRONG EXAMPLE: "Newsroom fluorescents hum, phones trill incessantly, envelope paper crinkling open."

Write like a novelist. Tell the COMPLETE story from beginning to end with FULL detail.
DO NOT summarize scenes. DESCRIBE them in vivid narrative prose.
DO NOT compress or abbreviate ANY part of the story.`;
      break;
    case 'logline':
      lengthGuidance = `Write EXACTLY ONE SENTENCE (30-50 words). Include protagonist, goal, conflict, and stakes.`;
      break;
    case 'synopsis':
      lengthGuidance = `Write a synopsis of ${estimatedPages} pages. Brief but comprehensive overview covering beginning, middle, and end.${estimatedDuration > 0 ? ` Project duration: ${estimatedDuration} minutes.` : ''}`;
      break;
    case 'character_breakdown':
      lengthGuidance = `Write ${estimatedPages} pages of character breakdowns. For each main character: physical description, personality, background, goals, arc, relationships.`;
      break;
    case 'pitch_deck':
      lengthGuidance = `Write ${estimatedPages} pages covering: Logline, Overview, Target Audience, Comparables, USPs, Vision, Market, Production, Distribution.`;
      break;
    default:
      lengthGuidance = `Write ${estimatedPages} pages of detailed, comprehensive content.${estimatedDuration > 0 ? ` Project duration: ${estimatedDuration} minutes.` : ''}`;
  }

  // Build enrichment prompt
  const prompt = `
${languageInstructions}

TASK: Enrich and rewrite the existing ${documentType} document using the ${sourceLabel} provided below as the PRIMARY source of truth.

PROJECT TYPE: ${projectType}${estimatedDuration > 0 ? `\nPROJECT DURATION: ${estimatedDuration} minutes` : ''}

EXISTING DOCUMENT (to be enriched):
Title: ${existingDocumentTitle}
Content:
${existingDocumentText || '(empty document)'}

SOURCE DATA (${sourceLabel}):
${sourceContext}

CONTENT REQUIREMENTS:
${lengthGuidance}

INSTRUCTIONS:
- Use the source data to fill in, expand, and enrich the existing document
- If the existing document is empty, create the full document from the source data
- If the existing document has content, preserve its structure and style while adding detail from the source
- The source data is the PRIMARY reference - ensure all key information from it is reflected in the document
- Maintain the document type conventions for a "${documentType}"
- Bold character names and key concepts
- Use italic for tone, mood, and genre references
- DO NOT STOP EARLY - Generate the FULL document length specified above

CRITICAL OUTPUT FORMAT:
Return ONLY a valid TipTap JSON object. No markdown, no code blocks, no explanations.

Start with: { "type": "doc",
End with: }

Use this structure:
{
  "type": "doc",
  "content": [
    { "type": "heading", "attrs": { "level": 1 }, "content": [{ "type": "text", "text": "Title" }] },
    { "type": "paragraph", "content": [{ "type": "text", "text": "Content..." }] }
  ]
}

For bold: { "type": "text", "marks": [{ "type": "bold" }], "text": "Name" }
For italic: { "type": "text", "marks": [{ "type": "italic" }], "text": "mood" }

RETURN ONLY THE JSON OBJECT. START NOW.
`;

  try {
    // Token allocation from the shared, scope-aware sizing helper.
    const maxTokens = sizing.maxTokens;

    if (DEBUG_AI) console.log(`📊 Enrich document: ${documentType} (${sizing.scope} scope) from ${enrichSource}, ${estimatedPages} pages, ${maxTokens} max tokens`);

    const docContext = AIModelRouter.createContext({
      requestType: 'generation',
      inputText: prompt,
      expectedOutputTokens: maxTokens,
      metadata: { forceModel: 'grok', contentScale: 'feature' }
    });

    const systemPrompt = `You are a JSON document generator. Your ONLY job is to return valid TipTap JSON structures.

ABSOLUTE RULES:
1. Return ONLY JSON - no markdown, no code blocks, no explanations
2. Start your response with: { "type": "doc",
3. End your response with: }

CRITICAL - BOLD FORMATTING (NEVER USE MARKDOWN):
- NEVER use markdown like **text** or __text__
- Character names MUST be bold using TipTap marks structure
- For bold text, use: { "type": "text", "marks": [{ "type": "bold" }], "text": "Name" }

CORRECT BOLD EXAMPLE:
{"type":"paragraph","content":[{"type":"text","text":"She meets "},{"type":"text","marks":[{"type":"bold"}],"text":"Clara"},{"type":"text","text":" at the cafe."}]}

4. DO NOT wrap JSON inside text nodes
5. DO NOT add any text before or after the JSON object
6. CRITICAL: VALID JSON SYNTAX:
   - NO TRAILING COMMAS: { "a": 1, } is INVALID
   - EVERY property must have a colon (:) followed by a value
7. CRITICAL: ESCAPE ALL QUOTES - Use \\" for quotes inside "text" values

CRITICAL LENGTH ENFORCEMENT - DO NOT STOP EARLY:
- You have ${maxTokens} TOKENS allocated - USE THEM ALL
- Target: ${estimatedPages} pages of content
- MINIMUM: ${Math.floor(maxTokens * 0.7)} tokens of output
- Each paragraph = one { "type": "paragraph", "content": [...] } block

YOUR OUTPUT WILL BE REJECTED IF:
- You use less than 70% of allocated tokens
- You summarize instead of writing detailed prose
- You stop before telling the complete story
- You use bullet points or shorthand notes instead of flowing paragraphs

KEEP WRITING until you have:
- Described EVERY scene in detail (2-3 paragraphs each)
- Shown EVERY character's emotional journey
- Included visual descriptions of EVERY location
- Written natural dialogue exchanges
- Told the COMPLETE story from beginning to end

DO NOT output meta-commentary about length. Just WRITE THE CONTENT.

${languageInstructions}`;

    const completionOptions: any = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      maxTokens,
      // Use json_object mode to ensure Grok returns valid JSON
      responseFormat: { type: 'json_object' },
    };

    const docResult = await aiRouter.executeCompletion(docContext, completionOptions);

    let rawResponse = docResult.content?.trim() || "";

    if (!rawResponse || rawResponse.length < 50) {
      console.error("❌ AI returned empty response for enrich-document");
      return res.status(500).json({ error: "AI returned an empty response. Please try again." });
    }

    // Track usage
    if (docResult.usage && req.userId) {
      await trackOpenAIUsageInRoute(req, 'document_generation', docResult.model, {
        prompt_tokens: docResult.usage.prompt_tokens,
        completion_tokens: docResult.usage.completion_tokens,
        total_tokens: docResult.usage.total_tokens
      }, {
        metadata: {
          documentType,
          enrichSource,
          provider: docResult.provider
        }
      });
    }

    // Clean response (same logic as brainstorming-to-document)
    let cleanedResponse = rawResponse;

    if (cleanedResponse.includes('```')) {
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    }

    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedResponse = jsonMatch[0];
    }

    // Fix common JSON errors
    cleanedResponse = cleanedResponse.replace(/,(\s*[}\]])/g, '$1');
    cleanedResponse = cleanedResponse.replace(/,,+/g, ',');
    cleanedResponse = cleanedResponse.replace(/\}(\s+)\{(?="type")/g, '},$1{');

    let documentJson: any;

    // Helper: attempt to repair truncated JSON by closing open brackets/braces
    const repairTruncatedJson = (json: string): string => {
      let repaired = json.trim();
      // Remove trailing comma if present
      repaired = repaired.replace(/,\s*$/, '');
      // Count open/close brackets and braces
      let openBraces = 0, openBrackets = 0;
      let inString = false, escaped = false;
      for (const ch of repaired) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        else if (ch === '}') openBraces--;
        else if (ch === '[') openBrackets++;
        else if (ch === ']') openBrackets--;
      }
      // If we're inside a string, close it
      if (inString) repaired += '"';
      // Close any unclosed brackets/braces
      for (let i = 0; i < openBrackets; i++) repaired += ']';
      for (let i = 0; i < openBraces; i++) repaired += '}';
      return repaired;
    };

    try {
      documentJson = JSON.parse(cleanedResponse);
      if (!documentJson.type || documentJson.type !== "doc" || !Array.isArray(documentJson.content)) {
        throw new Error('Invalid TipTap document structure');
      }

      // Check for double-encoding
      if (documentJson.content.length === 1 &&
          documentJson.content[0].type === "paragraph" &&
          documentJson.content[0].content?.[0]?.type === "text") {
        const innerText = documentJson.content[0].content[0].text;
        if (innerText.trim().startsWith('{') && innerText.trim().endsWith('}')) {
          try {
            const unwrapped = JSON.parse(innerText);
            if (unwrapped.type === "doc" && Array.isArray(unwrapped.content)) {
              documentJson = unwrapped;
            }
          } catch { /* keep original */ }
        }
      }

      documentJson = removeEmptyTextNodes(documentJson);
      documentJson = convertMarkdownBoldToTipTapMarks(documentJson);

    } catch (parseError: any) {
      console.error('❌ JSON parsing failed for enrich-document:', parseError.message);

      // Attempt to repair truncated JSON (common with long AI responses)
      try {
        const repaired = repairTruncatedJson(cleanedResponse);
        documentJson = JSON.parse(repaired);
        if (documentJson.type === "doc" && Array.isArray(documentJson.content)) {
          if (DEBUG_AI) console.log('✅ JSON repaired successfully (truncated response recovered)');
          documentJson = removeEmptyTextNodes(documentJson);
          documentJson = convertMarkdownBoldToTipTapMarks(documentJson);
        } else {
          throw new Error('Repaired JSON is not a valid TipTap document');
        }
      } catch (repairError) {
        console.error('❌ JSON repair also failed, using text fallback');

        // Extract readable text from the malformed JSON
        const textContent = cleanedResponse
          .replace(/\{"type":"text","marks":\[.*?\],"text":"(.*?)"\}/g, '$1')
          .replace(/\{"type":"text","text":"(.*?)"\}/g, '$1')
          .replace(/\{"type":"(heading|paragraph)","(attrs|content)".*?\[/g, '')
          .replace(/[{}\[\]]/g, '')
          .replace(/"type":"(doc|heading|paragraph|text|bold|italic)"/g, '')
          .replace(/"(attrs|content|marks|level|text)":/g, '')
          .replace(/"/g, '')
          .replace(/,\s*,/g, '')
          .replace(/\s+/g, ' ');

        const lines = textContent.split(/[.!?]\s+/).filter(line => line.trim().length > 10);
        documentJson = {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: existingDocumentTitle || `Enriched ${documentType}` }] },
            ...lines.map(line => ({ type: "paragraph", content: [{ type: "text", text: line.trim() + '.' }] }))
          ]
        };
      }
    }

    aiTaskEvents.emit('task', {
      type: 'document:completed',
      projectId,
      userId,
      payload: { documentId, documentType, operation: 'enrich' },
    });

    res.json({
      success: true,
      content: documentJson,
      enrichSource,
      documentType
    });

  } catch (error) {
    console.error("Document enrichment error:", error);
    aiTaskEvents.emit('task', {
      type: 'document:failed',
      projectId,
      userId,
      payload: { error: error instanceof Error ? error.message : 'Unknown error', operation: 'enrich' },
    });
    res.status(500).json({ error: "Document enrichment failed" });
  }
});

// POST /generate-presentation-image - Generate simple presentation image
router.post("/generate-presentation-image", requireAuth, extractUserId, preventDuplicateStoryboardImageGeneration, addPricingService, checkImageCredits, trackImageUsage, addAIUsageTracker, extractProjectId, async (req: AITrackingRequest & PricingRequest, res) => {
  const { description, project_id } = req.body;

  if (!description) {
    return res.status(400).json({ error: "Missing description" });
  }

  if (!project_id) {
    return res.status(400).json({ error: "Missing project_id" });
  }

  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Build simple professional prompt for presentation images
    const prompt = `${description}. Professional, high-quality, suitable for business presentation, 16:9 aspect ratio, clean composition.`;

    if (DEBUG_AI) console.log("🎨 Generating presentation image with model router...");

    // Use the image model router - flux.2-klein-4b via OpenRouter (fast + cheap), falls back to flux.2-pro
    const router = getImageRouter({
      preferredModel: 'flux.2-klein-4b',
      preferredProvider: 'openrouter',
      fallbackEnabled: true
    });

    const result = await router.generate({
      prompt,
      aspectRatio: '16:9',
      outputFormat: 'png'
    });

    if (DEBUG_AI) console.log(`✅ Image generated with ${result.model} in ${result.generationTimeMs}ms`);

    // Download the image
    const imageResponse = await fetch(result.imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download image: ${imageResponse.statusText}`);
    }

    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');

    // Upload to Supabase storage (presentation-images bucket)
    const fileName = `ai-generated/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('presentation-images')
      .upload(fileName, Buffer.from(base64Image, 'base64'), {
        contentType: 'image/png',
        upsert: true
      });

    if (uploadError) {
      console.error('[Presentation Image] Upload error:', uploadError);
      throw new Error(`Failed to upload image: ${uploadError.message}`);
    }

    // Generate signed URL for the response (store path for DB if needed)
    const { getSignedUrl: getSignedUrlFn, BUCKETS: B } = await import('../../services/storageService');
    const finalImageUrl = await getSignedUrlFn(B.PRESENTATION_IMAGES, fileName);

    // Track image usage for analytics/logging (credits are consumed by trackImageUsage middleware)
    await trackImageUsageInRoute(
      req,
      'presentation_image',
      'openrouter',
      result.model,
      {
        imageDimensions: '16:9',
        imageFormat: 'png',
        imageQuality: 90,
        imageUrl: finalImageUrl,
        promptText: description,
        metadata: {
          project_id: project_id,
          generationTimeMs: result.generationTimeMs
        }
      }
    );

    // Note: Credit consumption is handled by trackImageUsage middleware in the route chain
    aiTaskEvents.emit('task', {
      type: 'document:completed',
      projectId: project_id,
      userId,
      payload: { operation: 'presentation-image' },
    });

    return res.json({ imageUrl: finalImageUrl });

  } catch (error: any) {
    console.error('[Presentation Image] Generation failed:', error);
    aiTaskEvents.emit('task', {
      type: 'document:failed',
      projectId: project_id,
      userId,
      payload: { error: error.message || 'Unknown error', operation: 'presentation-image' },
    });

    if (error?.code === 'CONTENT_MODERATED') {
      return res.status(422).json({
        error: "content_moderated",
        message: error.message
      });
    }

    return res.status(500).json({
      error: "AI presentation image generation failed",
      details: error.message || "Unknown error occurred"
    });
  }
});

export default router;
