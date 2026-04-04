import { schema } from "../schema";
import { Node } from "prosemirror-model";

type FountainElement =
  | { type: "sceneHeading"; text: string }
  | { type: "action"; text: string }
  | { type: "character"; text: string }
  | { type: "dialogue"; text: string }
  | { type: "parenthetical"; text: string }
  | { type: "transition"; text: string };

// Known transitions (exact match)
const TRANSITIONS = new Set([
  "FADE OUT.", "FADE IN:", "FADE TO BLACK.",
  "CUT TO:", "SMASH CUT TO:", "MATCH CUT TO:",
  "DISSOLVE TO:", "JUMP CUT TO:", "WIPE TO:",
  "TIME CUT:", "IRIS IN:", "IRIS OUT.",
]);

function isTransition(line: string): boolean {
  const trimmed = line.trim().toUpperCase();
  if (TRANSITIONS.has(trimmed)) return true;
  // Ends with TO: (e.g., "INTERCUT TO:", custom transitions)
  if (/^[A-Z\s]+TO:$/.test(trimmed)) return true;
  return false;
}

function isSceneHeading(line: string): boolean {
  const trimmed = line.trim();
  // Standard: INT. / EXT. / INT./EXT. / I/E.
  if (/^(INT\.|EXT\.|INT\.\/EXT\.|INT\/EXT\.|I\/E\.)\s/i.test(trimmed)) return true;
  // Forced with . prefix
  if (/^\.[A-Z]/.test(trimmed)) return true;
  return false;
}

function isCharacterCue(line: string, nextLine: string | undefined): boolean {
  const trimmed = line.trim();
  // Must be all uppercase (letters, spaces, dots, hyphens, apostrophes)
  // May end with (V.O.) (O.S.) (O.C.) (CONT'D) etc.
  if (!/^[A-Z][A-Z\s\.\-']+(\s*\([\w\s\.\']+\))?$/.test(trimmed)) return false;
  // Must NOT be a transition
  if (isTransition(line)) return false;
  // Must NOT be a scene heading keyword alone
  if (/^(INT|EXT|FADE|CUT|DISSOLVE|SMASH|MATCH|WIPE|JUMP|IRIS|TIME)$/.test(trimmed)) return false;
  // Must be followed by non-blank line (dialogue)
  if (!nextLine || nextLine.trim() === "") return false;
  // Minimum 2 characters
  if (trimmed.length < 2) return false;
  return true;
}

// Parse raw Fountain text into an array of elements
export function parseFountain(fountain: string): FountainElement[] {
  const lines = fountain.split("\n");
  const elements: FountainElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Skip blank lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Scene heading
    if (isSceneHeading(line)) {
      const text = line.trim().replace(/^\./, "").toUpperCase();
      elements.push({ type: "sceneHeading", text });
      i++;
      continue;
    }

    // Transition (exact or TO: pattern)
    if (isTransition(line)) {
      elements.push({ type: "transition", text: line.trim().toUpperCase() });
      i++;
      continue;
    }

    // Forced transition with >
    if (line.startsWith(">") && !line.endsWith("<")) {
      elements.push({ type: "transition", text: line.slice(1).trim() });
      i++;
      continue;
    }

    // Character + dialogue block
    if (isCharacterCue(line, lines[i + 1])) {
      elements.push({ type: "character", text: line.trim() });
      i++;

      // Read following dialogue/parentheticals until blank line
      while (i < lines.length && lines[i].trim() !== "") {
        const dLine = lines[i].trimEnd();

        if (/^\s*\(.*\)\s*$/.test(dLine)) {
          // Parenthetical: strip outer parens (CSS adds them)
          const inner = dLine.trim().replace(/^\(/, "").replace(/\)$/, "");
          elements.push({ type: "parenthetical", text: inner });
        } else {
          elements.push({ type: "dialogue", text: dLine.trim() });
        }
        i++;
      }
      continue;
    }

    // Action: each line becomes a separate action node
    // Collect contiguous non-blank lines as one block, then split
    while (i < lines.length && lines[i].trim() !== "") {
      elements.push({ type: "action", text: lines[i].trimEnd() });
      i++;
    }
  }

  return elements;
}

// Convert parsed elements to a ProseMirror document
export function fountainToDoc(fountain: string): Node {
  const elements = parseFountain(fountain);

  const nodes = elements.map((el) => {
    const nodeType = schema.nodes[el.type];
    const content = el.text ? schema.text(el.text) : undefined;
    return nodeType.create({}, content);
  });

  if (nodes.length === 0) {
    nodes.push(schema.nodes.action.create());
  }

  return schema.nodes.doc.create({}, nodes);
}
