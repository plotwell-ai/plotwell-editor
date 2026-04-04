import { schema } from "../schema";
import { Node, Mark } from "prosemirror-model";

// Map Final Draft paragraph types to our schema node types
const FDX_TYPE_MAP: Record<string, string> = {
  "Scene Heading": "sceneHeading",
  "Action": "action",
  "Character": "character",
  "Dialogue": "dialogue",
  "Parenthetical": "parenthetical",
  "Transition": "transition",
  // Aliases used in some FDX versions
  "General": "action",
  "Shot": "sceneHeading",
};

// Parse FDX style attributes into ProseMirror marks
function parseTextStyles(textEl: Element): Mark[] {
  const marks: Mark[] = [];
  const style = textEl.getAttribute("Style") || "";

  if (style.includes("Bold")) marks.push(schema.marks.bold.create());
  if (style.includes("Italic")) marks.push(schema.marks.italic.create());
  if (style.includes("Underline")) marks.push(schema.marks.underline.create());

  return marks;
}

// Extract inline content from a Paragraph element (handles multiple Text children with styles)
function parseParagraphContent(paraEl: Element): Node[] {
  const textEls = paraEl.querySelectorAll("Text");
  const inlineNodes: Node[] = [];

  textEls.forEach((textEl) => {
    const content = textEl.textContent || "";
    if (!content) return;

    const marks = parseTextStyles(textEl);
    inlineNodes.push(schema.text(content, marks));
  });

  return inlineNodes;
}

// Parse an FDX XML string into a ProseMirror document
export function fdxToDoc(xml: string): Node {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");

  const parserError = doc.querySelector("parsererror");
  if (parserError) {
    throw new Error(`Invalid FDX file: ${parserError.textContent}`);
  }

  const paragraphs = doc.querySelectorAll("Content > Paragraph");
  const nodes: Node[] = [];

  paragraphs.forEach((para) => {
    const fdxType = para.getAttribute("Type") || "Action";
    const nodeTypeName = FDX_TYPE_MAP[fdxType] || "action";
    const nodeType = schema.nodes[nodeTypeName];

    if (!nodeType) return;

    const inline = parseParagraphContent(para);

    // Parenthetical: strip outer parens if present (CSS adds them)
    if (nodeTypeName === "parenthetical" && inline.length === 1) {
      const text = inline[0].text || "";
      if (text.startsWith("(") && text.endsWith(")")) {
        const stripped = text.slice(1, -1);
        if (stripped) {
          nodes.push(nodeType.create({}, schema.text(stripped)));
        } else {
          nodes.push(nodeType.create());
        }
        return;
      }
    }

    if (inline.length > 0) {
      nodes.push(nodeType.create({}, inline));
    } else {
      nodes.push(nodeType.create());
    }
  });

  if (nodes.length === 0) {
    nodes.push(schema.nodes.action.create());
  }

  return schema.nodes.doc.create({}, nodes);
}
