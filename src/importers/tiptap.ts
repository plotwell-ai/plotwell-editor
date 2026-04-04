import { schema } from "../schema";
import { Node } from "prosemirror-model";

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

// ProseMirror node type -> TipTap class mapping (inverse)
const NODE_TO_CLASS: Record<string, string> = {
  sceneHeading: "scene-heading",
  action: "action",
  character: "character-name",
  dialogue: "dialogue",
  parenthetical: "parenthetical",
  transition: "transition",
};

// Marks that exist in the new schema
const VALID_MARKS = new Set(["bold", "italic", "underline"]);

function filterMarks(marks?: any[]): any[] | undefined {
  if (!marks || marks.length === 0) return undefined;
  const filtered = marks.filter((m: any) => VALID_MARKS.has(m.type));
  return filtered.length > 0 ? filtered : undefined;
}

function convertTextNodes(content?: any[]): Node[] {
  if (!content || !Array.isArray(content)) return [];
  const nodes: Node[] = [];

  for (const textNode of content) {
    if (textNode.type === "text" && textNode.text) {
      const marks = filterMarks(textNode.marks);
      const pmMarks = marks
        ? marks.map((m: any) => schema.marks[m.type].create(m.attrs))
        : undefined;
      nodes.push(schema.text(textNode.text, pmMarks));
    } else if (textNode.type === "hardBreak") {
      // Drop hard breaks (no equivalent in screenplay schema)
    }
  }

  return nodes;
}

/**
 * Convert a TipTap JSON document to a ProseMirror document.
 *
 * TipTap format: { type: "paragraph", attrs: { class: "scene-heading" }, content: [...] }
 * ProseMirror format: { type: "sceneHeading", attrs: { id: null }, content: [...] }
 */
export function tiptapToDoc(json: any): Node {
  if (!json || json.type !== "doc" || !Array.isArray(json.content)) {
    return schema.nodes.doc.create({}, [schema.nodes.action.create()]);
  }

  const nodes: Node[] = [];

  for (const block of json.content) {
    if (!block || typeof block !== "object") continue;

    // Already in ProseMirror format (has a direct node type)
    if (block.type !== "paragraph" && block.type !== "heading" && schema.nodes[block.type]) {
      try {
        nodes.push(Node.fromJSON(schema, block));
      } catch {
        // Skip invalid nodes
      }
      continue;
    }

    // TipTap paragraph with class attribute
    if (block.type === "paragraph") {
      const className = block.attrs?.class || "action";
      const nodeTypeName = CLASS_TO_NODE[className] || "action";
      const nodeType = schema.nodes[nodeTypeName];

      if (!nodeType) continue;

      const textNodes = convertTextNodes(block.content);
      const attrs = nodeTypeName === "sceneHeading"
        ? { id: block.attrs?.sceneId || null }
        : {};

      nodes.push(nodeType.create(attrs, textNodes.length > 0 ? textNodes : undefined));
      continue;
    }

    // Skip headings and other non-screenplay nodes (from document editor)
  }

  if (nodes.length === 0) {
    nodes.push(schema.nodes.action.create());
  }

  return schema.nodes.doc.create({}, nodes);
}

/**
 * Convert a ProseMirror document back to TipTap JSON format.
 * Useful as a rollback path.
 */
export function docToTiptap(doc: Node): any {
  const content: any[] = [];

  doc.forEach((node) => {
    const className = NODE_TO_CLASS[node.type.name];
    if (!className) return; // Skip pageBreak etc.

    const textContent: any[] = [];
    node.forEach((child) => {
      if (child.isText) {
        const textNode: any = { type: "text", text: child.text };
        if (child.marks.length > 0) {
          textNode.marks = child.marks.map((m) => {
            const markJson: any = { type: m.type.name };
            if (Object.keys(m.attrs).length > 0) {
              markJson.attrs = m.attrs;
            }
            return markJson;
          });
        }
        textContent.push(textNode);
      }
    });

    const block: any = {
      type: "paragraph",
      attrs: { class: className },
    };

    if (textContent.length > 0) {
      block.content = textContent;
    }

    content.push(block);
  });

  return { type: "doc", content };
}
