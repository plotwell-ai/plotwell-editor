import { Plugin, PluginKey } from "prosemirror-state";

const fadeInAlignKey = new PluginKey("fadeInAlign");

/**
 * Toggles the `pw-fade-in` CSS class on transition paragraphs based on
 * whether the text content matches "FADE IN".
 *
 * ProseMirror's `toDOM` only runs on initial render — it does NOT re-run
 * when the user edits text inside the node. This plugin watches every
 * view update and synchronises the class so the CSS rule
 * `.pm-transition.pw-fade-in { text-align: left }` kicks in live.
 */
export function createFadeInAlignPlugin() {
  return new Plugin({
    key: fadeInAlignKey,
    view() {
      return {
        update(view) {
          const els = view.dom.querySelectorAll(".pm-transition");
          els.forEach((el) => {
            const text = (el.textContent || "").toUpperCase().trim();
            el.classList.toggle("pw-fade-in", /^FADE\s+IN[.:]?$/.test(text));
          });
        },
      };
    },
  });
}
