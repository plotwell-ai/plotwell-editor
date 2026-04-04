import { Node } from "prosemirror-model";

// Map our schema types to Final Draft paragraph types
const NODE_TO_FDX: Record<string, string> = {
  sceneHeading: "Scene Heading",
  action: "Action",
  character: "Character",
  dialogue: "Dialogue",
  parenthetical: "Parenthetical",
  transition: "Transition",
};

function escapeXML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Render inline content with style attributes
function renderTextElements(node: Node): string {
  if (node.childCount === 0) {
    return '<Text></Text>';
  }

  const parts: string[] = [];

  node.forEach((child) => {
    const text = escapeXML(child.text || "");
    const styles: string[] = [];

    child.marks.forEach((mark) => {
      switch (mark.type.name) {
        case "bold": styles.push("Bold"); break;
        case "italic": styles.push("Italic"); break;
        case "underline": styles.push("Underline"); break;
      }
    });

    const styleAttr = styles.length > 0 ? ` Style="${styles.join("+")}"` : "";
    parts.push(`<Text${styleAttr}>${text}</Text>`);
  });

  return parts.join("");
}

// Export ProseMirror doc to Final Draft XML (.fdx)
export function docToFDX(doc: Node): string {
  const paragraphs: string[] = [];

  doc.forEach((node) => {
    const typeName = node.type.name;
    if (typeName === "pageBreak") return;

    const fdxType = NODE_TO_FDX[typeName];
    if (!fdxType) return;

    let textContent: string;
    if (typeName === "parenthetical") {
      // FDX stores parentheticals WITH parens (unlike our schema where CSS adds them)
      textContent = `<Text>(${escapeXML(node.textContent)})</Text>`;
    } else {
      textContent = renderTextElements(node);
    }

    paragraphs.push(`    <Paragraph Type="${fdxType}">\n      ${textContent}\n    </Paragraph>`);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<FinalDraft DocumentType="Script" Template="No" Version="4">
  <Content>
${paragraphs.join("\n")}
  </Content>
</FinalDraft>
`;
}
