# @plotwell/editor

**The open-source screenplay editor for the web.**

A full-featured, embeddable ProseMirror-based editor with WGA-standard formatting, live pagination, and Final Draft interop. Drop it into any web app; no backend, no accounts, no lock-in.

![license](https://img.shields.io/badge/license-MIT-green)
![status](https://img.shields.io/badge/status-beta-orange)
![built with](https://img.shields.io/badge/built%20with-ProseMirror-blue)

**[Live Demo](https://editor.plotwell.co)** · **[Report a bug](https://github.com/plotwell-ai/plotwell-editor/issues)**

---

## Why this exists

Every serious screenplay tool is either a paid desktop app, a closed SaaS platform, or a generic rich-text editor bolted onto a formatting plugin. None of them are embeddable.

If you're building anything that involves scripts — an AI writing assistant, a production management tool, a collaborative platform, a game narrative editor — you've had no good drop-in option. Until now.

`@plotwell/editor` gives you proper screenplay editing as a component: industry-standard formatting out of the box, Final Draft and Fountain interop, PDF export, and a clean API to build on top of.

---

## Features

### Writing
- All standard screenplay elements: Scene Heading, Action, Character, Dialogue, Parenthetical, Transition
- Smart `Enter` key — context-aware element transitions (Character → Dialogue → Action, etc.)
- `Tab` / `Shift+Tab` to cycle element types
- `Cmd+1–6` to force any element type
- `Backspace` at start of block reverts to Action
- Bold, Italic, Underline (`Cmd+B/I/U`)
- Input rules: type `INT.` or `EXT.` to auto-create a Scene Heading

### Layout
- WGA industry-standard page format (8.5" × 11", Courier Prime 12pt, correct margins)
- Live pagination with Google Docs–style page gaps
- Scene numbers on both left and right margins
- Page numbers in header
- Full first-page height, padded last page

### Import / Export
- **Fountain** (`.fountain`) import and export
- **Final Draft** (`.fdx`) import and export
- **PDF** export with optional cover page (title, author, contact, copyright)
- **Scene JSON** import for integration with other tools or AI pipelines

### UI
- Bubble menu on text selection (B / I / U)
- Floating element-type badge with dropdown selector
- Reading mode (toggle read-only)
- Dark mode
- Writing stats: scenes, pages, words, dialogue %

---

## Install

```bash
npm install @plotwell/editor
```

---

## Quick Start

```typescript
import { PlotwellEditor } from "@plotwell/editor";
import "@plotwell/editor/styles.css";

const editor = new PlotwellEditor({
  container: document.getElementById("editor"),
  content: "INT. COFFEE SHOP - DAY\n\nA crowded cafe.\n\nMARIO\nHello.",
});
```

---

## API

### Constructor Options

```typescript
const editor = new PlotwellEditor({
  container: HTMLElement,       // required
  content?: string,             // Fountain text to preload
  onChange?: (doc: Node) => void,
  attribution?: boolean,        // "Powered by plotwell" backlink (default: true)
  bubbleMenu?: boolean,         // floating B/I/U toolbar (default: true)
  typeBadge?: boolean,          // element-type badge (default: true)
  darkMode?: boolean,           // dark theme (default: false)
});
```

### Import

```typescript
editor.importFountain(text: string)      // .fountain string
editor.importFDX(xml: string)            // Final Draft XML string
editor.importScenes(scenes: SceneData[]) // scene JSON array
```

### Export

```typescript
editor.toFountain()   // returns .fountain string
editor.toFDX()        // returns .fdx XML string
editor.toJSON()       // returns ProseMirror doc JSON

editor.toPDF({
  title?: string,
  coverPage?: {
    title?: string,
    author?: string,
    basedOn?: string,
    draftDate?: string,
    contactInfo?: string,
    copyright?: string,
  }
})
```

### Editor State

```typescript
editor.getStats()
// → { sceneCount, wordCount, characterCount, pageCount, dialoguePercentage }

editor.setReadingMode(true)   // toggle read-only
editor.readingMode             // current state

editor.setDarkMode(true)      // toggle dark theme
```

### Standalone Functions

If you only need parsing or conversion utilities without mounting a full editor:

```typescript
import {
  fountainToDoc,
  fdxToDoc,
  scenesToDoc,
  docToFountain,
  docToFDX,
  exportToPDF,
  toPrintHTML,
} from "@plotwell/editor";
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+1` | Scene Heading |
| `Cmd+2` | Action |
| `Cmd+3` | Character |
| `Cmd+4` | Dialogue |
| `Cmd+5` | Parenthetical |
| `Cmd+6` | Transition |
| `Tab` | Next element type |
| `Shift+Tab` | Previous element type |
| `Enter` | Smart split (context-aware) |
| `Backspace` | Revert empty block to Action |
| `Cmd+B` | Bold |
| `Cmd+I` | Italic |
| `Cmd+U` | Underline |
| `Cmd+Z` | Undo |
| `Cmd+Shift+Z` | Redo |

---

## vs. other tools

|  | `@plotwell/editor` | Quill / TipTap | Final Draft | Arc Studio | Celtx |
|---|---|---|---|---|---|
| Open source | ✅ | ✅ | ❌ | ❌ | ❌ |
| Screenplay formatting | ✅ | ❌ | ✅ | ✅ | ✅ |
| Embeddable component | ✅ | ✅ | ❌ | ❌ | ❌ |
| FDX import/export | ✅ | ❌ | ✅ | ✅ | ✅ |
| Fountain import/export | ✅ | ❌ | ❌ | ✅ | ❌ |
| PDF export | ✅ | ❌ | ✅ | ✅ | ✅ |
| Live pagination | ✅ | ❌ | ✅ | ✅ | ✅ |
| Free to embed | ✅ | ✅ | ❌ | ❌ | ❌ |
| No backend required | ✅ | ✅ | ✅ | ❌ | ❌ |

---

## Development

```bash
git clone https://github.com/nicosanc/plotwell-editor.git
cd plotwell-editor
npm install
npm run dev
```

### Stack

- [ProseMirror](https://prosemirror.net) — document model and editing engine
- TypeScript
- Vite
- Courier Prime (Google Fonts)

---

## Contributing

Contributions are welcome. Some areas where help would be valuable:

- Additional import/export formats (e.g. Celtx, Highland)
- Collaborative editing (Y.js integration)
- Accessibility improvements
- Mobile / touch support
- Localization

Please open an issue before starting significant work so we can align on direction. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

---

## Attribution

Free to use under MIT. Apps embedding `@plotwell/editor` must display the `"Powered by plotwell.co"` attribution link (enabled by default via the `attribution` option).

To remove attribution for commercial or white-label use, contact [info@plotwell.co](mailto:info@plotwell.co) for a commercial license.

---

## Built with @plotwell/editor

- [plotwell](https://plotwell.co) — AI screenwriting and production platform for film & TV series creators

Using it in your project? Open a PR to add it here.

---

## License

MIT with attribution requirement. See [LICENSE](./LICENSE).
