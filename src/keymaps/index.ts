import { keymap } from "prosemirror-keymap";
import { Command, EditorState } from "prosemirror-state";
import { toggleMark } from "prosemirror-commands";
import { schema, NodeTypeName } from "../schema";

// What node type comes after Enter on each element
const enterTransitions: Record<string, NodeTypeName> = {
  sceneHeading: "action",
  action: "action",
  character: "dialogue",
  dialogue: "action",
  parenthetical: "dialogue",
  transition: "sceneHeading",
};

// Tab cycles through these types
const tabCycle: NodeTypeName[] = [
  "action",
  "character",
  "sceneHeading",
  "transition",
  "parenthetical",
];

function currentNodeType(state: EditorState): string | null {
  const { $from } = state.selection;
  return $from.parent.type.name;
}

function isCurrentNodeEmpty(state: EditorState): boolean {
  const { $from } = state.selection;
  return $from.parent.content.size === 0;
}

const handleEnter: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to)) return false;

  const nodeType = currentNodeType(state);
  if (!nodeType) return false;

  const nextType = enterTransitions[nodeType] ?? "action";
  const type = schema.nodes[nextType];
  if (!type) return false;

  const parent = $from.parent;
  const hasContent = parent.content.size > 0;
  const cursorAtStart = $from.parentOffset === 0;
  const cursorAtEnd = $from.parentOffset === parent.content.size;

  // Empty non-action block: revert to action instead of creating next type
  if (!hasContent && nodeType !== "action") {
    if (dispatch) {
      const pos = $from.before();
      dispatch(state.tr.setNodeMarkup(pos, schema.nodes.action).scrollIntoView());
    }
    return true;
  }

  // Empty action block: create another action
  if (!hasContent) {
    if (dispatch) {
      const tr = state.tr.split($from.pos, 1, [{ type: schema.nodes.action }]);
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  // Cursor at start of non-empty block: insert empty action BEFORE
  if (cursorAtStart && hasContent) {
    if (dispatch) {
      const pos = $from.before();
      const newNode = schema.nodes.action.create();
      let tr = state.tr.insert(pos, newNode);
      // Keep cursor on the original node (which shifted down)
      const sel = state.selection.constructor as any;
      tr = tr.setSelection(sel.near(tr.doc.resolve(pos + newNode.nodeSize + 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  // Cursor at end: create new block of the next type
  if (cursorAtEnd) {
    if (dispatch) {
      const tr = state.tr.split($from.pos, 1, [{ type }]);
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  // Cursor in middle: split the block, second part becomes next type
  if (dispatch) {
    const tr = state.tr.split($from.pos, 1, [{ type }]);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

const handleTab: Command = (state, dispatch) => {
  const nodeType = currentNodeType(state);
  if (!nodeType) return false;

  const currentIdx = tabCycle.indexOf(nodeType as NodeTypeName);
  const nextIdx = (currentIdx + 1) % tabCycle.length;
  const nextType = tabCycle[nextIdx];
  const type = schema.nodes[nextType];
  if (!type) return false;

  if (dispatch) {
    const { from, to } = state.selection;
    dispatch(state.tr.setBlockType(from, to, type));
  }
  return true;
};

const handleShiftTab: Command = (state, dispatch) => {
  const nodeType = currentNodeType(state);
  if (!nodeType) return false;

  const currentIdx = tabCycle.indexOf(nodeType as NodeTypeName);
  const prevIdx = (currentIdx - 1 + tabCycle.length) % tabCycle.length;
  const prevType = tabCycle[prevIdx];
  const type = schema.nodes[prevType];
  if (!type) return false;

  if (dispatch) {
    const { from, to } = state.selection;
    dispatch(state.tr.setBlockType(from, to, type));
  }
  return true;
};

// Backspace at start of non-action block → preserve type, delete empty previous block
const handleBackspace: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false; // let default handle range deletions

  // Only intercept at the very start of the textblock
  if ($from.parentOffset !== 0) return false;

  const nodeType = currentNodeType(state);
  if (!nodeType || nodeType === "action") return false; // action blocks: let default handle

  const currentBlock = $from.parent;
  const nodePos = $from.before();
  const $pos = state.doc.resolve(nodePos);
  const prevNode = $pos.nodeBefore;

  // No previous node (first block in doc): do nothing
  if (!prevNode) return true;

  // Previous block is empty: delete it, preserving current block type
  if (prevNode.content.size === 0) {
    if (dispatch) {
      dispatch(state.tr.delete(nodePos - prevNode.nodeSize, nodePos).scrollIntoView());
    }
    return true;
  }

  // Current block is empty: delete it and move cursor to end of previous block
  if (currentBlock.content.size === 0) {
    if (dispatch) {
      const nodeEnd = nodePos + currentBlock.nodeSize;
      const tr = state.tr.delete(nodePos, nodeEnd);
      const sel = (state.selection.constructor as any).near(tr.doc.resolve(nodePos - 1), -1);
      dispatch(tr.setSelection(sel).scrollIntoView());
    }
    return true;
  }

  // Both blocks have content: move cursor to end of previous block
  // (don't merge/join, which would lose the current block's type)
  if (dispatch) {
    const endOfPrev = nodePos - 1;
    const sel = (state.selection.constructor as any).near(state.tr.doc.resolve(endOfPrev), -1);
    dispatch(state.tr.setSelection(sel).scrollIntoView());
  }
  return true;
};

// Force node types with keyboard shortcuts
function forceNodeType(typeName: NodeTypeName): Command {
  return (state, dispatch) => {
    const type = schema.nodes[typeName];
    if (!type) return false;
    if (dispatch) {
      const { from, to } = state.selection;
      dispatch(state.tr.setBlockType(from, to, type));
    }
    return true;
  };
}

export const screenplayKeymap = keymap({
  Enter: handleEnter,
  Tab: handleTab,
  "Shift-Tab": handleShiftTab,
  Backspace: handleBackspace,

  // Formatting
  "Mod-b": toggleMark(schema.marks.bold),
  "Mod-i": toggleMark(schema.marks.italic),
  "Mod-u": toggleMark(schema.marks.underline),

  // Ctrl/Cmd + number to force type
  "Mod-1": forceNodeType("sceneHeading"),
  "Mod-2": forceNodeType("action"),
  "Mod-3": forceNodeType("character"),
  "Mod-4": forceNodeType("dialogue"),
  "Mod-5": forceNodeType("parenthetical"),
  "Mod-6": forceNodeType("transition"),
});
