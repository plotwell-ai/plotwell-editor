import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

// Industry standard page dimensions at 96dpi
const MARGIN_BOTTOM = 96;   // 1"

// Usable content height per page: 11" - 1" - 1" = 9" = 864px
const CONTENT_H = 864;

export const paginationKey = new PluginKey<DecorationSet>("pagination");

// Node types that must not be orphaned at a page break
const KEEP_WITH_NEXT = new Set(["character"]);
const KEEP_WITH_PREV = new Set(["dialogue", "parenthetical"]);

interface BlockInfo {
  pos: number;
  height: number;
  typeName: string;
}

export const paginationPlugin = new Plugin<DecorationSet>({
  key: paginationKey,

  state: {
    init: () => DecorationSet.empty,
    apply(tr, old) {
      return tr.getMeta(paginationKey) ?? old.map(tr.mapping, tr.doc);
    },
  },

  props: {
    decorations(state) {
      return paginationKey.getState(state);
    },
  },

  view(editorView) {
    let animFrame: number | null = null;
    let lastJson = "";

    function measure() {
      // Guard against destroyed view (React strict mode double-mount)
      if (!editorView.dom || !editorView.dom.parentNode) return;

      const { state } = editorView;

      // Collect block positions and heights
      const blocks: BlockInfo[] = [];
      state.doc.forEach((node, offset) => {
        if (node.type.name === "pageBreak") return;

        let domNode: HTMLElement | null;
        try {
          domNode = editorView.nodeDOM(offset) as HTMLElement | null;
        } catch {
          return; // View may be in an inconsistent state
        }
        if (!domNode) return;

        const style = window.getComputedStyle(domNode);
        const marginTop = parseFloat(style.marginTop) || 0;
        const marginBottom = parseFloat(style.marginBottom) || 0;
        const height = domNode.offsetHeight + marginTop + marginBottom;

        blocks.push({ pos: offset, height, typeName: node.type.name });
      });

      // Determine where page breaks go
      const breakPositions: number[] = [];
      let pageNumber = 1;
      let accumulated = 0;

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const wouldOverflow = accumulated + block.height > CONTENT_H && accumulated > 0;

        if (wouldOverflow) {
          let breakIdx = i;

          // Don't break between character and its dialogue/parenthetical
          if (KEEP_WITH_PREV.has(block.typeName) && i > 0) {
            let j = i - 1;
            while (j >= 0 && KEEP_WITH_PREV.has(blocks[j].typeName)) j--;
            if (j >= 0 && blocks[j].typeName === "character") {
              breakIdx = j;
            }
          }

          // Don't orphan character at page bottom
          if (KEEP_WITH_NEXT.has(block.typeName)) {
            breakIdx = i;
          }

          if (breakIdx <= 0) breakIdx = i;

          pageNumber++;
          breakPositions.push(blocks[breakIdx].pos);

          // Reset accumulator from the break point
          accumulated = 0;
          for (let k = breakIdx; k <= i; k++) {
            accumulated += blocks[k].height;
          }
        } else {
          accumulated += block.height;
        }
      }

      // Check if decorations changed
      const json = JSON.stringify(breakPositions);
      if (json === lastJson) return;
      lastJson = json;

      // Build decoration widgets for page separators
      const decorations: Decoration[] = [];

      breakPositions.forEach((pos, idx) => {
        const num = idx + 2; // page 2, 3, 4...

        decorations.push(
          Decoration.widget(pos, () => {
            const wrapper = document.createElement("div");
            wrapper.className = "pw-page-separator";
            wrapper.contentEditable = "false";

            const bottomMargin = document.createElement("div");
            bottomMargin.className = "pw-page-margin-bottom";
            wrapper.appendChild(bottomMargin);

            const topMargin = document.createElement("div");
            topMargin.className = "pw-page-margin-top";

            const pageNumLabel = document.createElement("span");
            pageNumLabel.className = "pw-page-header-number";
            pageNumLabel.textContent = `${num}.`;
            topMargin.appendChild(pageNumLabel);

            wrapper.appendChild(topMargin);

            return wrapper;
          }, { side: -1, key: `page-${num}` })
        );
      });

      // Pad the last page to full height
      const remainingOnLastPage = CONTENT_H - accumulated;
      const extraPadding = Math.max(0, remainingOnLastPage);
      (editorView.dom as HTMLElement).style.paddingBottom = `${MARGIN_BOTTOM + extraPadding}px`;

      const decorationSet = DecorationSet.create(state.doc, decorations);
      const tr = state.tr.setMeta(paginationKey, decorationSet);
      tr.setMeta("addToHistory", false);
      editorView.dispatch(tr);
    }

    function scheduleMeasure() {
      if (animFrame !== null) cancelAnimationFrame(animFrame);
      animFrame = requestAnimationFrame(() => {
        animFrame = null;
        measure();
      });
    }

    // Double rAF for stable initial layout
    requestAnimationFrame(() => scheduleMeasure());

    return {
      update(view, prevState) {
        if (view.state.doc !== prevState.doc) {
          scheduleMeasure();
        }
      },
      destroy() {
        if (animFrame !== null) cancelAnimationFrame(animFrame);
      },
    };
  },
});
