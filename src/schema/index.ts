import { Schema, Node as PMNode } from "prosemirror-model";

export const schema = new Schema({
  nodes: {
    doc: {
      content: "block+",
    },

    // Scene Heading: INT. OFFICE - DAY
    sceneHeading: {
      group: "block",
      content: "text*",
      defining: true,
      attrs: { id: { default: null } },
      toDOM: () => ["p", { class: "pm-scene-heading", "data-type": "scene-heading", "data-placeholder": "INT. SCENE - DAY" }, 0],
      parseDOM: [{ tag: 'p[data-type="scene-heading"]' }],
    },

    // Action / description
    action: {
      group: "block",
      content: "text*",
      defining: true,
      toDOM: () => ["p", { class: "pm-action", "data-type": "action", "data-placeholder": "Action..." }, 0],
      parseDOM: [{ tag: 'p[data-type="action"]' }],
    },

    // Character name (before dialogue)
    character: {
      group: "block",
      content: "text*",
      defining: true,
      toDOM: () => ["p", { class: "pm-character", "data-type": "character", "data-placeholder": "CHARACTER" }, 0],
      parseDOM: [{ tag: 'p[data-type="character"]' }],
    },

    // Spoken dialogue
    dialogue: {
      group: "block",
      content: "text*",
      defining: true,
      toDOM: () => ["p", { class: "pm-dialogue", "data-type": "dialogue", "data-placeholder": "Dialogue..." }, 0],
      parseDOM: [{ tag: 'p[data-type="dialogue"]' }],
    },

    // (beat) / (pause) etc
    parenthetical: {
      group: "block",
      content: "text*",
      defining: true,
      toDOM: () => ["p", { class: "pm-parenthetical", "data-type": "parenthetical", "data-placeholder": "beat" }, 0],
      parseDOM: [{ tag: 'p[data-type="parenthetical"]' }],
    },

    // FADE OUT. / CUT TO: etc — detects FADE IN: for left-alignment
    transition: {
      group: "block",
      content: "text*",
      defining: true,
      toDOM: (node: PMNode) => {
        const text = node.textContent.toUpperCase();
        const isFadeIn = text.includes("FADE IN");
        const cls = "pm-transition" + (isFadeIn ? " pw-fade-in" : "");
        return ["p", { class: cls, "data-type": "transition", "data-placeholder": "CUT TO:" }, 0];
      },
      parseDOM: [{ tag: 'p[data-type="transition"]' }],
    },

    // Visual page break (atom)
    pageBreak: {
      group: "block",
      atom: true,
      toDOM: () => ["div", { class: "pm-page-break", "data-type": "page-break", contenteditable: "false" }],
      parseDOM: [{ tag: 'div[data-type="page-break"]' }],
    },

    text: {
      group: "inline",
    },
  },

  marks: {
    bold: {
      toDOM: () => ["strong", 0] as const,
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
    },
    italic: {
      toDOM: () => ["em", 0] as const,
      parseDOM: [{ tag: "em" }, { tag: "i" }],
    },
    underline: {
      toDOM: () => ["u", 0] as const,
      parseDOM: [{ tag: "u" }],
    },
  },
});

export type NodeTypeName =
  | "sceneHeading"
  | "action"
  | "character"
  | "dialogue"
  | "parenthetical"
  | "transition"
  | "pageBreak";
