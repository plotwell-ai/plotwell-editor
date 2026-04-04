import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export const sceneNumbersKey = new PluginKey<DecorationSet>("sceneNumbers");

export const sceneNumbersPlugin = new Plugin<DecorationSet>({
  key: sceneNumbersKey,

  state: {
    init(_, state) {
      return buildDecorations(state.doc);
    },
    apply(tr, old) {
      if (tr.docChanged) {
        return buildDecorations(tr.doc);
      }
      return old.map(tr.mapping, tr.doc);
    },
  },

  props: {
    decorations(state) {
      return sceneNumbersKey.getState(state);
    },
  },
});

function buildDecorations(doc: import("prosemirror-model").Node): DecorationSet {
  const decorations: Decoration[] = [];
  let sceneCount = 0;

  doc.forEach((node, offset) => {
    if (node.type.name === "sceneHeading") {
      sceneCount++;
      const num = String(sceneCount);

      // Left scene number
      decorations.push(
        Decoration.widget(offset + 1, () => {
          const el = document.createElement("span");
          el.className = "pw-scene-number pw-scene-number-left";
          el.textContent = num;
          el.contentEditable = "false";
          return el;
        }, { side: -1, key: `sn-l-${offset}-${num}` })
      );

      // Right scene number
      decorations.push(
        Decoration.widget(offset + 1, () => {
          const el = document.createElement("span");
          el.className = "pw-scene-number pw-scene-number-right";
          el.textContent = num;
          el.contentEditable = "false";
          return el;
        }, { side: 1, key: `sn-r-${offset}-${num}` })
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}
