import { createClient } from "@supabase/supabase-js";
import { normalizeCharacterCuesInDocument } from "./characterIdentity";
import { normalizeSceneHeadingsInDocument } from "./locationIdentity";

const DEBUG_AI = process.env.DEBUG_AI === 'true';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Get user ID from request object
 */
export function getUserId(req: any): string | null {
  return req.user?.sub || req.user?.id || null;
}

/**
 * Load project language settings from database
 * Falls back to user's UI language if project language not set
 */
export async function loadProjectLanguageSettings(projectId: string, userId: string) {
  try {
    // First get project settings
    const { data: projectData } = await supabase
      .from('projects')
      .select('language, content_language')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    // Also get user's UI language as fallback
    const { data: userData } = await supabase
      .from('users')
      .select('ui_language')
      .eq('id', userId)
      .single();

    const userLanguage = userData?.ui_language || 'en';

    return {
      language: projectData?.language || userLanguage,
      // Use project content_language, then project language, then user UI language
      content_language: projectData?.content_language || projectData?.language || userLanguage
    };
  } catch (error) {
    console.error('Failed to load project language settings:', error);
    return { language: 'en', content_language: 'en' };
  }
}

/**
 * Build language instructions for AI prompts
 */
export function buildLanguageInstructions(
  language: string,
  contentLanguage: string,
  requestType: 'generation' | 'chat' = 'generation'
) {
  const languageMap: Record<string, string> = {
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'ja': 'Japanese',
    'zh': 'Chinese',
    'hi': 'Hindi',
    'ar': 'Arabic',
    'ko': 'Korean'
  };

  const targetLanguage = requestType === 'generation' ? contentLanguage : language;
  const targetLangName = languageMap[targetLanguage] || 'English';

  return `

CRITICAL LANGUAGE REQUIREMENT:
- Generate ALL output text in ${targetLangName}
- Regardless of the input language or conversation language, ALWAYS generate content in ${targetLangName}
- Character names should be culturally appropriate for ${targetLangName}
- Dialogue and scene descriptions must be in ${targetLangName}
- If the input conversation is in a different language, translate/adapt the concepts to ${targetLangName}
- Maintain cultural context appropriate for ${targetLangName} content
- Use proper grammar and syntax for ${targetLangName}

IMPORTANT: Write the entire response in ${targetLangName}.`;
}

/**
 * Check if ProseMirror editor content is empty
 */
export function isEditorContentEmpty(content: any): boolean {
  if (!content || typeof content !== "object") return true;
  if (!Array.isArray(content.content) || content.content.length === 0) return true;

  const hasMeaningfulText = (nodes: any[]): boolean => {
    for (const node of nodes) {
      if (node.text?.trim()) return true;
      if (Array.isArray(node.content) && hasMeaningfulText(node.content)) return true;
    }
    return false;
  };

  return !hasMeaningfulText(content.content);
}

/**
 * Unified ProseMirror JSON text extraction for all AI endpoints.
 *
 * Formats:
 * - 'labeled' (default): Prefixes each line with element type labels
 *   e.g. [ACTION] The night is alive.\n[CHARACTER] EDWARD\n[DIALOGUE] Hello!
 *   Best for AI comprehension — prevents misclassifying element types.
 *
 * - 'plain': Simple text concatenation with newlines, no formatting.
 *   For token counting, content hashing, and non-AI uses.
 */
export type ScriptTextFormat = 'labeled' | 'plain';

const ELEMENT_LABEL_MAP: Record<string, string> = {
  'sceneHeading': 'SCENE HEADING',
  'action': 'ACTION',
  'character': 'CHARACTER',
  'dialogue': 'DIALOGUE',
  'parenthetical': 'PARENTHETICAL',
  'transition': 'TRANSITION',
};

export function extractTextFromTipTapJSON(
  content: any,
  format: ScriptTextFormat = 'labeled'
): string {
  if (!content?.content) return "";

  // Handle string input (some callers pass stringified JSON)
  const parsed = typeof content === 'string' ? (() => { try { return JSON.parse(content); } catch { return null; } })() : content;
  if (!parsed?.content) return "";

  const extractText = (node: any): string => {
    if (node.type === "text") return node.text || "";
    if (node.type === "hardBreak") return "\n";
    if (node.content && Array.isArray(node.content)) {
      return node.content.map(extractText).join("");
    }
    return "";
  };

  if (format === 'plain') {
    return parsed.content.map((block: any) => extractText(block)).join('\n').trim();
  }

  // Labeled format: [ELEMENT TYPE] text (ProseMirror node types)
  return parsed.content.map((block: any) => {
    const text = extractText(block);
    if (!text.trim()) return '';
    const label = ELEMENT_LABEL_MAP[block.type] || 'ACTION';
    return `[${label}] ${text}`;
  }).filter(Boolean).join('\n').trim();
}

/**
 * Convert raw text to ProseMirror JSON format
 */
export function convertTextToTipTapJSON(text: string): any {
  if (!text || typeof text !== 'string') {
    return {
      type: "doc",
      content: []
    };
  }

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(text);
    if (parsed.type === "doc" && Array.isArray(parsed.content)) {
      return validateTipTapStructure(parsed);
    }
  } catch (e) {
    // Not JSON, continue with text conversion
  }

  // Split into lines and classify as screenplay elements
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const content = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    let nodeType = "action"; // default

    // Classify screenplay elements
    if (trimmedLine.match(/^(INT|EXT)\./i)) {
      nodeType = "sceneHeading";
    } else if (trimmedLine === trimmedLine.toUpperCase() &&
               !trimmedLine.includes('.') &&
               trimmedLine.length < 50 &&
               trimmedLine.length > 2 &&
               !trimmedLine.startsWith('(')) {
      nodeType = "character";
    } else if (trimmedLine.startsWith("(") && trimmedLine.endsWith(")")) {
      nodeType = "parenthetical";
    } else if (trimmedLine.match(/^(FADE IN|FADE OUT|CUT TO|DISSOLVE TO)/i)) {
      nodeType = "transition";
    } else if (trimmedLine.match(/^(ACT|SCENE|SEQUENCE)/i)) {
      nodeType = "sceneHeading";
    }

    content.push({
      type: nodeType,
      content: [{ type: "text", text: trimmedLine }]
    });
  }

  return {
    type: "doc",
    content: content
  };
}

/**
 * Validate and fix ProseMirror document structure
 */
const VALID_NODE_TYPES = new Set(['sceneHeading', 'action', 'character', 'dialogue', 'parenthetical', 'transition']);

export function validateTipTapStructure(json: any): any {
  if (!json || typeof json !== 'object') {
    return convertTextToTipTapJSON("");
  }

  if (json.type !== "doc") {
    json.type = "doc";
  }

  if (!Array.isArray(json.content)) {
    json.content = [];
  }

  // Validate each content block
  json.content = json.content.map((block: any) => {
    if (!block || typeof block !== 'object') {
      return {
        type: "action",
        content: [{ type: "text", text: "" }]
      };
    }

    // Ensure block type is a valid ProseMirror node type
    if (!block.type || !VALID_NODE_TYPES.has(block.type)) {
      block.type = "action";
    }
    if (!Array.isArray(block.content)) block.content = [];

    // Validate text nodes within block
    block.content = block.content.map((textNode: any) => {
      if (!textNode || typeof textNode !== 'object') {
        return { type: "text", text: "" };
      }
      if (!textNode.type) textNode.type = "text";
      if (typeof textNode.text !== 'string') textNode.text = "";
      return textNode;
    });

    return block;
  });

  return json;
}

/**
 * Remove empty text nodes from ProseMirror document
 */
export function removeEmptyTextNodes(doc: any): any {
  const processContent = (content: any): any => {
    if (Array.isArray(content)) {
      return content
        .map(processContent)
        .filter(item => {
          if (item && item.type === 'text' && (!item.text || item.text.length === 0)) {
            return false;
          }
          return true;
        });
    }

    if (typeof content === 'object' && content !== null) {
      const result = { ...content };
      for (const [key, value] of Object.entries(content)) {
        if (key === 'content' && Array.isArray(value)) {
          result[key] = processContent(value);
        } else if (typeof value === 'object') {
          result[key] = processContent(value);
        }
      }
      return result;
    }

    return content;
  };

  return processContent(doc);
}

/**
 * Clean forbidden patterns from treatment text
 * Removes structural labels, meta-commentary, and fixes formatting issues
 */
export function cleanTreatmentText(doc: any): any {
  const forbiddenPatterns = [
    // Structural labels
    /^Flashback:\s*/i,
    /^Flash back:\s*/i,
    /^Flashback a[:\s]/i,
    /^Act\s*\d+[:\s]/i,
    /^Acto\s*\d+[:\s]/i,
    /^Opening:\s*/i,
    /^Midpoint:\s*/i,
    /^Climax:\s*/i,
    /^Resolution:\s*/i,
    /^End of Act\s*/i,
    /^Fin de Acto\s*/i,
    /^Plot Point[:\s]/i,
    /^Beat[:\s]/i,
    // Meta-commentary
    /^\[Nota:.*?\]/i,
    /^\[Note:.*?\]/i,
    /^Pero esto es solo esbozo.*/i,
    /^Expando más.*/i,
    /^Continúo detallando.*/i,
    // Subtitle patterns in title
    /\s*-\s*Tratamiento\s*(Cinematográfico)?$/i,
    /\s*-\s*Film Treatment$/i,
    /\s*-\s*Treatment$/i,
  ];

  const processTextNode = (text: string): string => {
    let cleaned = text;
    for (const pattern of forbiddenPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    return cleaned.trim();
  };

  const shouldRemoveParagraph = (text: string): boolean => {
    // Remove paragraphs that are just meta-commentary
    const metaPatterns = [
      /^\[Nota:/i,
      /^Pero esto es solo esbozo/i,
      /^Expando más para alcanzar/i,
      /^Continúo detallando/i,
      /^Nota:/i,
    ];
    return metaPatterns.some(p => p.test(text.trim()));
  };

  const processContent = (content: any): any => {
    if (Array.isArray(content)) {
      return content
        .map(processContent)
        .filter(item => {
          // Remove paragraphs that are pure meta-commentary
          if (item?.type === 'paragraph' && item?.content) {
            const fullText = item.content
              .filter((n: any) => n.type === 'text')
              .map((n: any) => n.text || '')
              .join('');
            if (shouldRemoveParagraph(fullText)) {
              return false;
            }
          }
          return true;
        });
    }

    if (typeof content === 'object' && content !== null) {
      const result = { ...content };

      // Clean text nodes
      if (result.type === 'text' && result.text) {
        result.text = processTextNode(result.text);
      }

      // Process nested content
      for (const [key, value] of Object.entries(content)) {
        if (key === 'content' && Array.isArray(value)) {
          result[key] = processContent(value);
        } else if (typeof value === 'object') {
          result[key] = processContent(value);
        }
      }
      return result;
    }

    return content;
  };

  return processContent(doc);
}

/**
 * Convert markdown **bold** syntax in ProseMirror text nodes to proper bold marks
 * This handles cases where AI outputs markdown instead of ProseMirror marks structure
 */
export function convertMarkdownBoldToTipTapMarks(doc: any): any {
  const processTextContent = (textNode: any): any[] => {
    if (textNode.type !== 'text' || !textNode.text) {
      return [textNode];
    }

    const text = textNode.text;
    // Match **text** pattern (markdown bold)
    const boldRegex = /\*\*([^*]+)\*\*/g;

    // If no markdown bold found, return as-is
    if (!boldRegex.test(text)) {
      return [textNode];
    }

    // Reset regex
    boldRegex.lastIndex = 0;

    const result: any[] = [];
    let lastIndex = 0;
    let match;

    while ((match = boldRegex.exec(text)) !== null) {
      // Add text before the bold part
      if (match.index > lastIndex) {
        const beforeText = text.slice(lastIndex, match.index);
        if (beforeText) {
          result.push({
            type: 'text',
            text: beforeText,
            ...(textNode.marks ? { marks: textNode.marks } : {})
          });
        }
      }

      // Add the bold text with bold mark
      const boldText = match[1]; // The text between **
      const existingMarks = textNode.marks || [];
      const hasBoldMark = existingMarks.some((m: any) => m.type === 'bold');

      result.push({
        type: 'text',
        text: boldText,
        marks: hasBoldMark ? existingMarks : [...existingMarks, { type: 'bold' }]
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text after last match
    if (lastIndex < text.length) {
      const afterText = text.slice(lastIndex);
      if (afterText) {
        result.push({
          type: 'text',
          text: afterText,
          ...(textNode.marks ? { marks: textNode.marks } : {})
        });
      }
    }

    return result;
  };

  const processContent = (content: any): any => {
    if (Array.isArray(content)) {
      const processed: any[] = [];
      for (const item of content) {
        if (item && item.type === 'text') {
          // Process text node and potentially expand into multiple nodes
          processed.push(...processTextContent(item));
        } else {
          processed.push(processContent(item));
        }
      }
      return processed;
    }

    if (typeof content === 'object' && content !== null) {
      const result = { ...content };
      for (const [key, value] of Object.entries(content)) {
        if (key === 'content' && Array.isArray(value)) {
          result[key] = processContent(value);
        } else if (typeof value === 'object') {
          result[key] = processContent(value);
        }
      }
      return result;
    }

    return content;
  };

  return processContent(doc);
}

/**
 * Result of JSON extraction attempt
 */
export interface JsonExtractionResult {
  success: boolean;
  json: any | null;
  error?: string;
  extractedContent?: string;
  debugInfo?: {
    originalLength: number;
    extractedLength: number;
    hadMarkdownWrapper: boolean;
    hadTextBeforeJson: boolean;
    hadTextAfterJson: boolean;
    wasRepaired?: boolean;
    repairs?: string[];
  };
}

/**
 * Extract JSON from AI response with balanced brace counting
 * This is more robust than indexOf/lastIndexOf as it handles:
 * - Markdown code blocks
 * - Text before/after JSON
 * - Nested braces in strings
 * - Incomplete JSON detection
 */
export function extractJsonFromAIResponse(content: string): JsonExtractionResult {
  if (!content || typeof content !== 'string') {
    return {
      success: false,
      json: null,
      error: 'Empty or invalid content provided'
    };
  }

  const originalLength = content.length;
  let processedContent = content.trim();
  let hadMarkdownWrapper = false;
  let hadTextBeforeJson = false;
  let hadTextAfterJson = false;

  // Step 1: Remove markdown code blocks if present
  const codeBlockMatch = processedContent.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    processedContent = codeBlockMatch[1].trim();
    hadMarkdownWrapper = true;
  } else if (processedContent.startsWith('```')) {
    // Handle case where closing ``` might be missing
    processedContent = processedContent.replace(/^```(?:json)?\s*/, '').trim();
    hadMarkdownWrapper = true;
  }

  // Step 2: Find the start of JSON object
  const jsonStartIndex = processedContent.indexOf('{');
  if (jsonStartIndex === -1) {
    return {
      success: false,
      json: null,
      error: 'No JSON object start found in content',
      extractedContent: processedContent.substring(0, 200)
    };
  }

  if (jsonStartIndex > 0) {
    hadTextBeforeJson = true;
  }

  // Step 3: Use balanced brace counting to find the correct end
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  let jsonEndIndex = -1;

  for (let i = jsonStartIndex; i < processedContent.length; i++) {
    const char = processedContent[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          jsonEndIndex = i;
          break;
        }
      }
    }
  }

  // Step 4: Check if we found a complete JSON object
  if (jsonEndIndex === -1 || braceCount !== 0) {
    return {
      success: false,
      json: null,
      error: `Incomplete JSON: ${braceCount > 0 ? `missing ${braceCount} closing brace(s)` : 'no matching closing brace found'}`,
      extractedContent: processedContent.substring(jsonStartIndex, Math.min(jsonStartIndex + 500, processedContent.length)),
      debugInfo: {
        originalLength,
        extractedLength: processedContent.length - jsonStartIndex,
        hadMarkdownWrapper,
        hadTextBeforeJson,
        hadTextAfterJson: false
      }
    };
  }

  // Check if there's text after the JSON
  if (jsonEndIndex < processedContent.length - 1) {
    const afterJson = processedContent.substring(jsonEndIndex + 1).trim();
    if (afterJson.length > 0) {
      hadTextAfterJson = true;
    }
  }

  // Step 5: Extract the JSON substring
  const jsonString = processedContent.substring(jsonStartIndex, jsonEndIndex + 1);

  // Step 6: Parse the JSON
  try {
    const parsed = JSON.parse(jsonString);
    return {
      success: true,
      json: parsed,
      extractedContent: jsonString,
      debugInfo: {
        originalLength,
        extractedLength: jsonString.length,
        hadMarkdownWrapper,
        hadTextBeforeJson,
        hadTextAfterJson
      }
    };
  } catch (parseError) {
    // JSON.parse failed even with balanced braces - likely encoding issue
    return {
      success: false,
      json: null,
      error: `JSON parse error: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
      extractedContent: jsonString.substring(0, 500),
      debugInfo: {
        originalLength,
        extractedLength: jsonString.length,
        hadMarkdownWrapper,
        hadTextBeforeJson,
        hadTextAfterJson
      }
    };
  }
}

/**
 * Attempt to repair truncated/incomplete JSON
 * Handles common AI truncation issues:
 * - Missing closing brackets/braces
 * - Truncated strings
 * - Incomplete array elements
 */
export function repairIncompleteJson(jsonString: string): { repaired: string; wasRepaired: boolean; repairs: string[] } {
  const repairs: string[] = [];
  let repaired = jsonString.trim();

  // Track state while scanning
  let inString = false;
  let escapeNext = false;
  const stack: string[] = []; // Track open brackets/braces

  for (let i = 0; i < repaired.length; i++) {
    const char = repaired[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }
  }

  // If we ended inside a string, close it
  if (inString) {
    // Check if the last non-whitespace before end is a valid string end position
    // Try to find a good cutoff point (last complete word/sentence)
    const lastGoodCutoff = findLastCompleteSentence(repaired);
    if (lastGoodCutoff > repaired.length * 0.7) {
      repaired = repaired.substring(0, lastGoodCutoff);
      repairs.push('Truncated incomplete string at sentence boundary');
    }
    repaired += '"';
    repairs.push('Closed unclosed string');
    inString = false;
  }

  // Check for incomplete object/array elements (trailing comma or colon)
  const trimmedEnd = repaired.trimEnd();
  if (trimmedEnd.endsWith(',')) {
    // Remove trailing comma before closing
    repaired = trimmedEnd.slice(0, -1);
    repairs.push('Removed trailing comma');
  } else if (trimmedEnd.endsWith(':')) {
    // Incomplete key-value pair, add null value
    repaired = trimmedEnd + 'null';
    repairs.push('Added null for incomplete key-value pair');
  }

  // Add missing closing brackets/braces in reverse order (LIFO)
  while (stack.length > 0) {
    const closer = stack.pop()!;
    repaired += closer;
    repairs.push(`Added missing '${closer}'`);
  }

  return {
    repaired,
    wasRepaired: repairs.length > 0,
    repairs
  };
}

/**
 * Find the last complete sentence/phrase boundary in a string
 * Used for truncating incomplete strings at a sensible point
 */
function findLastCompleteSentence(str: string): number {
  // Look for sentence-ending punctuation followed by a quote
  const sentenceEnders = ['.', '!', '?', ')', '"', "'"];
  let lastGoodPosition = -1;

  for (let i = str.length - 1; i >= Math.floor(str.length * 0.5); i--) {
    const char = str[i];
    if (sentenceEnders.includes(char)) {
      // Check if this looks like a sentence end (not a decimal, abbreviation, etc.)
      const nextChar = str[i + 1];
      if (!nextChar || nextChar === ' ' || nextChar === '"' || nextChar === '}' || nextChar === ']') {
        lastGoodPosition = i + 1;
        break;
      }
    }
  }

  return lastGoodPosition;
}

/**
 * Extract JSON from AI response with balanced brace counting and repair capability
 */
export function extractJsonFromAIResponseWithRepair(content: string): JsonExtractionResult {
  // First try standard extraction
  const result = extractJsonFromAIResponse(content);

  // If successful, return as-is
  if (result.success) {
    return result;
  }

  // If incomplete JSON detected, try to repair
  if (result.error?.includes('Incomplete JSON') || result.error?.includes('missing') && result.error?.includes('brace')) {
    const jsonStart = content.indexOf('{');
    if (jsonStart === -1) {
      return result; // Can't repair if no JSON found
    }

    const partialJson = content.substring(jsonStart);
    const { repaired, wasRepaired, repairs } = repairIncompleteJson(partialJson);

    if (wasRepaired) {
      try {
        const parsed = JSON.parse(repaired);
        // Always log repair success - important for monitoring truncation issues
        if (DEBUG_AI) console.log('🔧 JSON Repair Successful:', repairs.join(', '));
        return {
          success: true,
          json: parsed,
          extractedContent: repaired,
          debugInfo: {
            ...result.debugInfo!,
            extractedLength: repaired.length,
            hadTextAfterJson: false,
            wasRepaired: true,
            repairs
          },
          error: undefined // Clear error since repair succeeded
        };
      } catch (parseError) {
        // Repair didn't work - log details only in debug mode
        if (DEBUG_AI) {
          console.log('🔧 JSON Repair Failed:', repairs.join(', '), parseError);
        }
        return {
          ...result,
          error: `${result.error}. Repair attempted (${repairs.join(', ')}) but failed: ${parseError instanceof Error ? parseError.message : 'Unknown'}`,
          debugInfo: {
            ...result.debugInfo!,
            wasRepaired: false,
            repairs
          }
        };
      }
    }
  }

  return result;
}

/**
 * Extract and validate ProseMirror JSON from AI response
 * Combines extraction with structure validation and repair
 */
export function extractTipTapJsonFromAIResponse(content: string): JsonExtractionResult {
  // Use the repair-capable extractor
  const result = extractJsonFromAIResponseWithRepair(content);

  if (!result.success || !result.json) {
    return result;
  }

  // Validate ProseMirror document structure
  const json = result.json;

  // Check for ProseMirror document structure
  if (json.type !== 'doc') {
    // Try to wrap in doc structure if it looks like content array
    if (Array.isArray(json.content)) {
      result.json = { type: 'doc', content: json.content };
    } else if (Array.isArray(json)) {
      // Maybe it's just the content array
      result.json = { type: 'doc', content: json };
    } else {
      return {
        ...result,
        success: false,
        error: `Invalid ProseMirror structure: expected type "doc", got "${json.type || 'undefined'}"`
      };
    }
  }

  // Ensure content is an array
  if (!Array.isArray(result.json.content)) {
    return {
      ...result,
      success: false,
      error: 'Invalid ProseMirror structure: content is not an array'
    };
  }

  // Validate and fix the structure (checks for valid ProseMirror node types)
  result.json = normalizeCharacterCuesInDocument(
    normalizeSceneHeadingsInDocument(validateTipTapStructure(result.json))
  );

  return result;
}

/**
 * Get screenplay title from project
 */
export async function getScreenplayTitle(projectId: string, isEpic: boolean = false): Promise<string> {
  try {
    const { data } = await supabase
      .from('projects')
      .select('title')
      .eq('id', projectId)
      .single();

    const baseTitle = data?.title || 'Untitled Project';
    return isEpic ? `${baseTitle} - Epic Screenplay` : baseTitle;
  } catch (error) {
    console.error('Error getting screenplay title:', error);
    return isEpic ? 'Untitled Project - Epic Screenplay' : 'Untitled Project';
  }
}
