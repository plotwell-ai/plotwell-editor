import {
  inputRules,
  InputRule,
} from "prosemirror-inputrules";
import { schema } from "../schema";

// Scene heading: INT. / EXT. at start of line
// Custom rule that changes block type but KEEPS the matched text
const sceneHeadingRule = new InputRule(
  /^(INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s$/,
  (state, match, start, end) => {
    const $from = state.doc.resolve(start);
    if ($from.parent.type === schema.nodes.sceneHeading) return null; // already a heading

    const tr = state.tr.setBlockType(start, end, schema.nodes.sceneHeading);
    return tr;
  }
);

// Transition: CUT TO: / FADE OUT. / SMASH CUT TO: / DISSOLVE TO:
// Same approach — keep the text
const transitionRule = new InputRule(
  /^(FADE OUT\.|FADE IN:|CUT TO:|SMASH CUT TO:|DISSOLVE TO:)\s$/,
  (state, match, start, end) => {
    const $from = state.doc.resolve(start);
    if ($from.parent.type === schema.nodes.transition) return null;

    const tr = state.tr.setBlockType(start, end, schema.nodes.transition);
    return tr;
  }
);

export const screenplayInputRules = inputRules({
  rules: [sceneHeadingRule, transitionRule],
});
