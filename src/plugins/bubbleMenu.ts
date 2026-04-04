import { Plugin, PluginKey } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { toggleMark } from "prosemirror-commands";
import { schema } from "../schema";

export const bubbleMenuKey = new PluginKey("bubbleMenu");

interface MarkButton {
  mark: string;
  label: string;
  icon: string;
}

const MARKS: MarkButton[] = [
  { mark: "bold", label: "Bold", icon: "<strong>B</strong>" },
  { mark: "italic", label: "Italic", icon: "<em>I</em>" },
  { mark: "underline", label: "Underline", icon: "<u>U</u>" },
];

function isMarkActive(view: EditorView, markName: string): boolean {
  const { from, $from, to, empty } = view.state.selection;
  const markType = schema.marks[markName];
  if (empty) {
    return !!markType.isInSet(view.state.storedMarks || $from.marks());
  }
  return view.state.doc.rangeHasMark(from, to, markType);
}

export function createBubbleMenuPlugin(): Plugin {
  let menu: HTMLDivElement | null = null;

  function buildMenu(view: EditorView): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "pw-bubble-menu";

    MARKS.forEach((m, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "pw-separator";
        el.appendChild(sep);
      }

      const btn = document.createElement("button");
      btn.innerHTML = m.icon;
      btn.title = m.label;
      btn.setAttribute("data-mark", m.mark);
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const markType = schema.marks[m.mark];
        toggleMark(markType)(view.state, view.dispatch);
        view.focus();
        updateButtonStates(view, el);
      });
      el.appendChild(btn);
    });

    return el;
  }

  function updateButtonStates(view: EditorView, el: HTMLElement) {
    el.querySelectorAll("button[data-mark]").forEach((btn) => {
      const markName = btn.getAttribute("data-mark")!;
      btn.classList.toggle("active", isMarkActive(view, markName));
    });
  }

  function positionMenu(view: EditorView, el: HTMLDivElement) {
    const { from, to } = view.state.selection;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);

    const editorRect = view.dom.getBoundingClientRect();
    const menuRect = el.getBoundingClientRect();

    // Center above selection
    const selCenterX = (start.left + end.right) / 2;
    let left = selCenterX - editorRect.left - menuRect.width / 2;
    const top = start.top - editorRect.top - menuRect.height - 8;

    // Clamp to editor bounds
    left = Math.max(4, Math.min(left, editorRect.width - menuRect.width - 4));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  return new Plugin({
    key: bubbleMenuKey,

    view(editorView) {
      menu = buildMenu(editorView);
      menu.style.display = "none";
      const parent = editorView.dom.parentElement;
      if (parent) parent.appendChild(menu);

      return {
        update(view) {
          const { empty, from, to } = view.state.selection;

          if (empty || from === to) {
            menu!.style.display = "none";
            return;
          }

          menu!.style.display = "flex";
          updateButtonStates(view, menu!);

          // Position after a frame so menu has dimensions
          requestAnimationFrame(() => {
            if (menu && menu.style.display !== "none") {
              positionMenu(view, menu);
            }
          });
        },

        destroy() {
          menu?.remove();
          menu = null;
        },
      };
    },
  });
}
