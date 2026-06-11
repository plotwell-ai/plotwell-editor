/**
 * Format detection and conversion utilities for script content.
 *
 * Handles migration from TipTap format (paragraph + attrs.class) to
 * ProseMirror format (direct node types like sceneHeading, action, etc.)
 */

// TipTap class -> ProseMirror node type mapping
const CLASS_TO_NODE: Record<string, string> = {
  "scene-heading": "sceneHeading",
  "action": "action",
  "character-name": "character",
  "dialogue": "dialogue",
  "parenthetical": "parenthetical",
  "transition": "transition",
  "transition aligned": "transition",
  // Deprecated reel types -> action
  "hook": "action",
  "voiceover": "action",
  "shot-description": "action",
  "cta": "action",
  "music-cue": "action",
  "text-overlay": "action",
  "timing-note": "action",
};

const PROSEMIRROR_NODE_TYPES = new Set([
  "sceneHeading", "action", "character", "dialogue",
  "parenthetical", "transition", "pageBreak",
]);

const VALID_MARKS = new Set(["bold", "italic", "underline"]);

/**
 * Detect whether a document is in TipTap or ProseMirror format.
 */
export function detectFormat(doc: any): "tiptap" | "prosemirror" | "unknown" {
  if (!doc || typeof doc !== "object" || doc.type !== "doc" || !Array.isArray(doc.content)) {
    return "unknown";
  }

  for (const node of doc.content) {
    if (!node || typeof node !== "object") continue;

    // TipTap: uses "paragraph" with attrs.class for screenplay elements
    if (node.type === "paragraph" && node.attrs?.class) {
      return "tiptap";
    }

    // ProseMirror: uses direct node types
    if (PROSEMIRROR_NODE_TYPES.has(node.type)) {
      return "prosemirror";
    }
  }

  return "unknown";
}

function filterMarks(marks?: any[]): any[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  const filtered = marks.filter((m: any) => VALID_MARKS.has(m.type));
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Convert a TipTap JSON document to ProseMirror format.
 * Pure JSON-to-JSON transform, no ProseMirror dependency needed.
 */
export function convertTiptapToProsemirror(doc: any): any {
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) {
    return { type: "doc", content: [{ type: "action" }] };
  }

  const content: any[] = [];

  for (const block of doc.content) {
    if (!block || typeof block !== "object") continue;

    // Already in ProseMirror format
    if (block.type !== "paragraph" && block.type !== "heading" && PROSEMIRROR_NODE_TYPES.has(block.type)) {
      content.push(block);
      continue;
    }

    // TipTap paragraph -> ProseMirror node
    if (block.type === "paragraph") {
      const className = block.attrs?.class || "action";
      const nodeType = CLASS_TO_NODE[className] || "action";

      const newBlock: any = { type: nodeType };

      // sceneHeading gets an id attr
      if (nodeType === "sceneHeading") {
        newBlock.attrs = { id: block.attrs?.sceneId || null };
      }

      // Convert text content, filtering marks
      if (Array.isArray(block.content) && block.content.length > 0) {
        newBlock.content = block.content
          .filter((n: any) => n.type === "text" && n.text)
          .map((n: any) => {
            const textNode: any = { type: "text", text: n.text };
            const marks = filterMarks(n.marks);
            if (marks) textNode.marks = marks;
            return textNode;
          });

        if (newBlock.content.length === 0) {
          delete newBlock.content;
        }
      }

      content.push(newBlock);
      continue;
    }

    // Skip headings and other non-screenplay nodes
  }

  if (content.length === 0) {
    content.push({ type: "action" });
  }

  return { type: "doc", content };
}

/**
 * Ensure a document is in ProseMirror format.
 * Auto-converts TipTap format if detected. Pass-through if already ProseMirror.
 */
export function ensureProsemirrorFormat(doc: any): any {
  if (!doc) return { type: "doc", content: [{ type: "action" }] };

  const format = detectFormat(doc);
  if (format === "tiptap") {
    return convertTiptapToProsemirror(doc);
  }
  return doc;
}
