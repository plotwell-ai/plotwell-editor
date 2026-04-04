import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { Node } from "prosemirror-model";

import { schema } from "./schema";
import { screenplayKeymap } from "./keymaps";
import { screenplayInputRules } from "./plugins/inputRules";
import { paginationPlugin } from "./plugins/pagination";
import { createBubbleMenuPlugin } from "./plugins/bubbleMenu";
import { createTypeBadgePlugin } from "./plugins/typeBadge";
import { sceneNumbersPlugin } from "./plugins/sceneNumbers";
import { createFadeInAlignPlugin } from "./plugins/fadeInAlign";
import { fountainToDoc } from "./importers/fountain";
import { fdxToDoc } from "./importers/fdx";
import { scenesToDoc } from "./importers/scenes";
import { tiptapToDoc, docToTiptap } from "./importers/tiptap";
import type { SceneData } from "./importers/scenes";
import { docToFountain } from "./exporters/fountain";
import { docToFDX } from "./exporters/fdx";
import { exportToPDF, toPrintHTML } from "./exporters/pdf";
import type { PDFExportOptions, CoverPageOptions } from "./exporters/pdf";

export interface PlotwellEditorOptions {
  container: HTMLElement;
  content?: string;       // Fountain text
  doc?: object;           // ProseMirror JSON document
  onChange?: (doc: Node) => void;
  attribution?: boolean;  // defaults to true
  bubbleMenu?: boolean;   // defaults to true
  typeBadge?: boolean;    // defaults to true
  darkMode?: boolean;     // defaults to false
  /** Disable built-in undo/redo (set false when using collaborative undo like yUndoPlugin) */
  history?: boolean;      // defaults to true
  /** Additional ProseMirror plugins (e.g. y-prosemirror for collaboration) */
  extraPlugins?: any[];
}

export interface WritingStats {
  sceneCount: number;
  wordCount: number;
  characterCount: number;
  pageCount: number;
  dialoguePercentage: number;
}

export class PlotwellEditor {
  view: EditorView;
  private options: PlotwellEditorOptions;
  private _readingMode = false;

  constructor(options: PlotwellEditorOptions) {
    this.options = options;

    const doc = options.doc
      ? Node.fromJSON(schema, options.doc)
      : options.content
        ? fountainToDoc(options.content)
        : schema.nodes.doc.create({}, [
            schema.nodes.sceneHeading.create(),
          ]);

    const plugins = [
      screenplayInputRules,
      screenplayKeymap,
      ...(options.history !== false ? [keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Shift-Mod-z": redo,
      })] : []),
      keymap(baseKeymap),
      ...(options.history !== false ? [history()] : []),
      paginationPlugin,
      sceneNumbersPlugin,
      createFadeInAlignPlugin(),
    ];

    if (options.bubbleMenu !== false) {
      plugins.push(createBubbleMenuPlugin());
    }
    if (options.typeBadge !== false) {
      plugins.push(createTypeBadgePlugin());
    }

    // Append any extra plugins (e.g. y-prosemirror for collaboration)
    if (options.extraPlugins?.length) {
      plugins.push(...options.extraPlugins);
    }

    const state = EditorState.create({ doc, plugins });

    options.container.style.position = "relative";

    this.view = new EditorView(options.container, {
      state,
      editable: () => !this._readingMode,
      // Disable drag-and-drop
      handleDOMEvents: {
        dragstart: (_, e) => { e.preventDefault(); return true; },
        dragover: (_, e) => { e.preventDefault(); return true; },
        drop: (_, e) => { e.preventDefault(); return true; },
      },
      handleDrop: () => true,
      dispatchTransaction: (tr) => {
        const newState = this.view.state.apply(tr);
        this.view.updateState(newState);
        if (tr.docChanged && options.onChange) {
          options.onChange(newState.doc);
        }
      },
    });

    if (options.attribution !== false) {
      this.renderAttribution(options.container);
    }

    if (options.darkMode) {
      this.setDarkMode(true);
    }
  }

  private renderAttribution(container: HTMLElement) {
    const attr = document.createElement("a");
    attr.href = "https://plotwell.co";
    attr.target = "_blank";
    attr.rel = "noopener";
    attr.className = "plotwell-attribution";
    attr.textContent = "Powered by plotwell";
    container.appendChild(attr);
  }

  // --- Import methods ---

  private replaceDoc(doc: Node) {
    const tr = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, doc.content);
    this.view.dispatch(tr);
  }

  importFountain(text: string) {
    this.replaceDoc(fountainToDoc(text));
  }

  importFDX(xml: string) {
    this.replaceDoc(fdxToDoc(xml));
  }

  importScenes(scenes: SceneData[]) {
    this.replaceDoc(scenesToDoc(scenes));
  }

  importJSON(json: object) {
    this.replaceDoc(Node.fromJSON(schema, json));
  }

  importTiptap(json: object) {
    this.replaceDoc(tiptapToDoc(json));
  }

  // --- Export methods ---

  toFountain(): string {
    return docToFountain(this.view.state.doc);
  }

  toFDX(): string {
    return docToFDX(this.view.state.doc);
  }

  toPDF(options?: PDFExportOptions) {
    exportToPDF(this.view.state.doc, options);
  }

  toPrintHTML(title?: string): string {
    return toPrintHTML(this.view.state.doc, title);
  }

  toJSON() {
    return this.view.state.doc.toJSON();
  }

  // --- Reading mode ---

  get readingMode(): boolean {
    return this._readingMode;
  }

  setReadingMode(enabled: boolean) {
    this._readingMode = enabled;
    this.view.dom.classList.toggle("pw-reading-mode", enabled);
    // Force ProseMirror to re-evaluate editable()
    this.view.setProps({ editable: () => !this._readingMode });
  }

  // --- Dark mode ---

  setDarkMode(enabled: boolean) {
    const wrap = this.view.dom.closest(".plotwell-editor-wrap");
    if (wrap) {
      wrap.classList.toggle("pw-dark", enabled);
    }
  }

  // --- Writing stats ---

  getStats(): WritingStats {
    const doc = this.view.state.doc;
    let sceneCount = 0;
    let wordCount = 0;
    let characterCount = 0;
    let dialogueWords = 0;

    doc.forEach((node) => {
      const text = node.textContent;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;

      switch (node.type.name) {
        case "sceneHeading":
          sceneCount++;
          wordCount += words;
          characterCount += text.length;
          break;
        case "dialogue":
        case "parenthetical":
          dialogueWords += words;
          wordCount += words;
          characterCount += text.length;
          break;
        default:
          wordCount += words;
          characterCount += text.length;
          break;
      }
    });

    // Page count: count page separators + 1
    const separators = this.view.dom.querySelectorAll(".pw-page-separator");
    const pageCount = separators.length + 1;

    const dialoguePercentage = wordCount > 0
      ? Math.round((dialogueWords / wordCount) * 100)
      : 0;

    return { sceneCount, wordCount, characterCount, pageCount, dialoguePercentage };
  }

  // --- Lifecycle ---

  destroy() {
    this.view.destroy();
  }
}

export { schema, fountainToDoc, fdxToDoc, scenesToDoc, tiptapToDoc, docToTiptap, docToFountain, docToFDX, exportToPDF, toPrintHTML };
export type { SceneData, PDFExportOptions, CoverPageOptions };
export type { NodeTypeName } from "./schema";
