import { Plugin, PluginKey } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema, NodeTypeName } from "../schema";

export const typeBadgeKey = new PluginKey("typeBadge");

interface TypeOption {
  type: NodeTypeName;
  label: string;
  shortcut: string;
}

const TYPE_OPTIONS: TypeOption[] = [
  { type: "sceneHeading", label: "Scene Heading", shortcut: "\u2318 1" },
  { type: "action", label: "Action", shortcut: "\u2318 2" },
  { type: "character", label: "Character", shortcut: "\u2318 3" },
  { type: "dialogue", label: "Dialogue", shortcut: "\u2318 4" },
  { type: "parenthetical", label: "Parenthetical", shortcut: "\u2318 5" },
  { type: "transition", label: "Transition", shortcut: "\u2318 6" },
];

function getCurrentNodeType(view: EditorView): string {
  return view.state.selection.$from.parent.type.name;
}

function setNodeType(view: EditorView, typeName: NodeTypeName) {
  const type = schema.nodes[typeName];
  if (!type) return;
  const { from, to } = view.state.selection;
  view.dispatch(view.state.tr.setBlockType(from, to, type));
  view.focus();
}

export function createTypeBadgePlugin(): Plugin {
  let badge: HTMLDivElement | null = null;
  let dropdown: HTMLDivElement | null = null;
  let isOpen = false;

  function buildBadge(view: EditorView): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "pw-type-badge";

    const labelBtn = document.createElement("button");
    labelBtn.className = "pw-type-badge-label";
    labelBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleDropdown(view);
    });
    el.appendChild(labelBtn);

    return el;
  }

  function buildDropdown(view: EditorView): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "pw-type-dropdown";

    TYPE_OPTIONS.forEach((opt) => {
      const btn = document.createElement("button");
      btn.setAttribute("data-type", opt.type);

      const label = document.createElement("span");
      label.textContent = opt.label;

      const shortcut = document.createElement("span");
      shortcut.className = "pw-shortcut";
      shortcut.textContent = opt.shortcut;

      btn.appendChild(label);
      btn.appendChild(shortcut);

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setNodeType(view, opt.type);
        closeDropdown();
      });

      el.appendChild(btn);
    });

    return el;
  }

  function toggleDropdown(view: EditorView) {
    if (isOpen) {
      closeDropdown();
    } else {
      openDropdown(view);
    }
  }

  function openDropdown(view: EditorView) {
    if (!badge) return;

    if (dropdown) dropdown.remove();
    dropdown = buildDropdown(view);
    badge.appendChild(dropdown);
    isOpen = true;

    updateDropdownActive();

    // Close on outside click (cleanup previous listener if any)
    if (outsideClickHandler) document.removeEventListener("mousedown", outsideClickHandler);
    outsideClickHandler = (e: MouseEvent) => {
      if (!badge?.contains(e.target as Node)) {
        closeDropdown();
      }
    };
    setTimeout(() => document.addEventListener("mousedown", outsideClickHandler!), 0);
  }

  let outsideClickHandler: ((e: MouseEvent) => void) | null = null;

  function closeDropdown() {
    dropdown?.remove();
    dropdown = null;
    isOpen = false;
    if (outsideClickHandler) {
      document.removeEventListener("mousedown", outsideClickHandler);
      outsideClickHandler = null;
    }
  }

  function updateDropdownActive() {
    if (!dropdown || !badge) return;
    const current = badge.getAttribute("data-current-type");
    dropdown.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-type") === current);
    });
  }

  function positionBadge(view: EditorView) {
    if (!badge) return;

    const { $from } = view.state.selection;
    const pos = $from.before($from.depth);
    const coords = view.coordsAtPos(pos + 1);
    const editorRect = view.dom.getBoundingClientRect();

    // Position to the left of the page
    const top = coords.top - editorRect.top;
    const left = -120; // To the left of the editor

    badge.style.left = `${left}px`;
    badge.style.top = `${top}px`;
  }

  function updateBadge(view: EditorView) {
    if (!badge) return;

    const current = getCurrentNodeType(view);
    const opt = TYPE_OPTIONS.find((o) => o.type === current);

    if (!opt) {
      badge.style.display = "none";
      return;
    }

    badge.style.display = "flex";
    badge.setAttribute("data-current-type", current);

    const labelBtn = badge.querySelector(".pw-type-badge-label") as HTMLButtonElement;
    if (labelBtn) {
      labelBtn.textContent = opt.label;
    }

    positionBadge(view);

    if (isOpen) {
      updateDropdownActive();
    }
  }

  return new Plugin({
    key: typeBadgeKey,

    view(editorView) {
      badge = buildBadge(editorView);
      badge.style.display = "none";
      editorView.dom.parentElement!.appendChild(badge);

      // Initial update
      requestAnimationFrame(() => updateBadge(editorView));

      return {
        update(view) {
          requestAnimationFrame(() => updateBadge(view));
        },

        destroy() {
          closeDropdown();
          badge?.remove();
          badge = null;
        },
      };
    },
  });
}
