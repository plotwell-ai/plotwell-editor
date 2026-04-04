import { Node } from "prosemirror-model";

// Serialize a ProseMirror document to Fountain format
export function docToFountain(doc: Node): string {
  const lines: string[] = [];

  doc.forEach((node) => {
    const typeName = node.type.name;
    const text = node.textContent;

    switch (typeName) {
      case "sceneHeading":
        // Blank line before scene heading (unless first element)
        if (lines.length > 0) lines.push("");
        lines.push(text.toUpperCase());
        break;

      case "action":
        if (lines.length > 0) lines.push("");
        lines.push(text);
        break;

      case "character":
        // Blank line before character cue
        if (lines.length > 0) lines.push("");
        lines.push(text.toUpperCase());
        break;

      case "dialogue":
        // Dialogue follows character or parenthetical directly (no blank line)
        lines.push(text);
        break;

      case "parenthetical":
        // Wrap in parens — the editor stores without parens (CSS adds them)
        lines.push(`(${text})`);
        break;

      case "transition":
        if (lines.length > 0) lines.push("");
        lines.push(text.toUpperCase());
        break;

      case "pageBreak":
        lines.push("");
        lines.push("===");
        break;

      default:
        if (text) lines.push(text);
        break;
    }

  });

  // Fountain files end with a newline
  return lines.join("\n") + "\n";
}
