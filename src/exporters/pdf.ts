import { Node } from "prosemirror-model";

// Render a ProseMirror doc node to HTML using the SAME classes as the editor
function renderToHTML(doc: Node): string {
  const blocks: string[] = [];
  let sceneCount = 0;

  doc.forEach((node) => {
    const typeName = node.type.name;
    if (typeName === "pageBreak") return;

    const inline = renderInlineContent(node);

    switch (typeName) {
      case "sceneHeading":
        sceneCount++;
        blocks.push(
          `<p class="pm-scene-heading" data-type="scene-heading">` +
          `<span class="pw-sn pw-sn-l">${sceneCount}</span>` +
          `${inline}` +
          `<span class="pw-sn pw-sn-r">${sceneCount}</span>` +
          `</p>`
        );
        break;
      case "action":
        blocks.push(`<p class="pm-action" data-type="action">${inline}</p>`);
        break;
      case "character":
        blocks.push(`<p class="pm-character" data-type="character">${inline}</p>`);
        break;
      case "dialogue":
        blocks.push(`<p class="pm-dialogue" data-type="dialogue">${inline}</p>`);
        break;
      case "parenthetical":
        blocks.push(`<p class="pm-parenthetical" data-type="parenthetical">${inline}</p>`);
        break;
      case "transition": {
        const text = node.textContent.toUpperCase();
        const fadeIn = text.includes("FADE IN") ? " pw-fade-in" : "";
        blocks.push(`<p class="pm-transition${fadeIn}" data-type="transition">${inline}</p>`);
        break;
      }
      default:
        if (inline) blocks.push(`<p class="pm-action" data-type="action">${inline}</p>`);
    }
  });

  return blocks.join("\n");
}

function renderInlineContent(node: Node): string {
  if (node.childCount === 0) return "";

  const parts: string[] = [];
  node.forEach((child) => {
    let html = escapeHTML(child.text || "");

    child.marks.forEach((mark) => {
      switch (mark.type.name) {
        case "bold":
          html = `<strong>${html}</strong>`;
          break;
        case "italic":
          html = `<em>${html}</em>`;
          break;
        case "underline":
          html = `<u>${html}</u>`;
          break;
      }
    });

    parts.push(html);
  });

  return parts.join("");
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPrintDocument(content: string, title?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHTML(title || "Screenplay")}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap');

/* ---- Page setup for print ---- */
@page {
  size: 8.5in 11in;
  margin: 1in 1in 1in 1in;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: "Courier Prime", "Courier New", Courier, monospace;
  font-size: 12pt;
  line-height: 16px;
  color: #000;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

p {
  margin: 0;
  padding: 0;
  line-height: 16px;
  orphans: 2;
  widows: 2;
  position: relative;
}

/* ---- Screenplay elements (identical to editor) ---- */

.pm-scene-heading {
  text-transform: uppercase;
  font-weight: bold;
  width: 6in;
  page-break-after: avoid;
  position: relative;
}

.page > p:first-child {
  margin-top: 0 !important;
}

.pm-action {
  width: 6in;
  margin-top: 16px;
}

.pm-character {
  margin-left: 2.2in;
  width: 3.8in;
  text-transform: uppercase;
  margin-top: 16px;
  page-break-after: avoid;
}

.pm-dialogue + .pm-character,
.pm-parenthetical + .pm-character {
  margin-top: 8px; /* tighter after dialogue - matches editor */
}

.pm-dialogue {
  margin-left: 1in;
  width: 3.5in;
  page-break-before: avoid;
}

.pm-parenthetical {
  margin-left: 1.6in;
  width: 2.3in;
  page-break-before: avoid;
  page-break-after: avoid;
}

.pm-parenthetical::before { content: "("; }
.pm-parenthetical::after  { content: ")"; }

.pm-transition {
  text-align: right;
  text-transform: uppercase;
  width: 6in;
  margin-top: 16px;
}

.pm-transition.pw-fade-in {
  text-align: left;
}

/* ---- Scene Numbers (print-safe) ---- */
.pm-scene-heading {
  margin-top: 48px;
  margin-bottom: 16px;
  overflow: visible !important;
}
.pm-scene-heading + .pm-action {
  margin-top: 0;
}
.pw-sn {
  position: absolute;
  top: 0;
  font-weight: bold;
  line-height: 16px;
}
.pw-sn-l {
  right: calc(100% + 12px);
}
.pw-sn-r {
  left: calc(100% + 12px);
}

/* ---- Page number (top-right header) ---- */
/* Page number: right-aligned line at top of each page */
.page-number {
  display: block;
  text-align: right;
  font-family: "Courier Prime", "Courier New", Courier, monospace;
  font-size: 12pt;
  line-height: 16px;
  margin-bottom: 16px; /* one blank line before content starts */
}

/* ---- Cover Page ---- */
.cover-page {
  position: relative;
  text-align: center;
}

.cover-title-block {
  padding-top: 3in;
}

.cover-title {
  font-size: 12pt;
  font-weight: bold;
  text-transform: uppercase;
  line-height: 16px;
  margin-bottom: 32px;
}

.cover-credit {
  font-size: 12pt;
  line-height: 16px;
  margin-bottom: 8px;
}

.cover-author {
  font-size: 12pt;
  line-height: 16px;
  margin-bottom: 16px;
}

.cover-based-on {
  font-size: 12pt;
  line-height: 16px;
  font-style: italic;
}

.cover-info-block {
  position: absolute;
  bottom: 1in;
  left: 1.5in;
  text-align: left;
}

.cover-info {
  font-size: 12pt;
  line-height: 16px;
}

/* ---- Screen preview: paginated like Google Docs ---- */
@media screen {
  html {
    background: #e8e8e8;
  }

  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 40px 0 80px;
  }

  .page {
    width: 8.5in;
    min-height: 11in;
    padding: 1in 1in 1in 1.5in;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    position: relative;
  }

  /* After pagination runs, fix page heights */
  .page.paginated {
    height: 11in;
    overflow: hidden;
  }
}

/* ---- Print: each .page is a printed page ---- */
@media print {
  body {
    display: block;
    padding: 0;
  }

  .page {
    page-break-after: always;
    position: relative;
    width: auto;
    height: auto;
    padding: 0 0 0 0.5in; /* extra left padding so text starts at 1.5in from page edge */
    box-shadow: none;
    overflow: visible;
  }

  /* Cover page needs fixed dimensions in print so absolute positioning works */
  .page.cover-page {
    height: 9in; /* content area after @page margins */
    padding: 0;
  }

  .page.cover-page .cover-info-block {
    bottom: 0;
    left: 0;
  }

  .page:last-child {
    page-break-after: auto;
  }

  .page-number {
    margin-bottom: 16px;
  }
}
</style>
</head>
<body>
${content}
<script>
// Paginate after fonts are ready
document.fonts.ready.then(function() {
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      paginate();
    });
  });
});

function paginate() {
  var body = document.body;
  var coverPage = body.querySelector('.cover-page');
  var allElements = Array.from(body.querySelectorAll('p[data-type]'));
  if (allElements.length === 0) return;

  // Remove all elements from DOM
  allElements.forEach(function(el) { el.remove(); });

  // Measure actual available content height using a test page
  var testPage = document.createElement('div');
  testPage.className = 'page';
  testPage.style.visibility = 'hidden';
  body.appendChild(testPage);
  var pageStyle = window.getComputedStyle(testPage);
  var CONTENT_H = testPage.clientHeight - parseFloat(pageStyle.paddingTop) - parseFloat(pageStyle.paddingBottom);
  if (CONTENT_H <= 0) CONTENT_H = 9 * 96; // fallback
  // Account for page number height
  var testNum = document.createElement('span');
  testNum.className = 'page-number';
  testNum.textContent = '1.';
  testPage.appendChild(testNum);
  var pageNumH = testNum.offsetHeight + parseFloat(window.getComputedStyle(testNum).marginBottom || '0');
  CONTENT_H -= pageNumH;
  testPage.remove();

  var pages = [];
  var startPageNum = coverPage ? 2 : 1;
  var currentPage = createPage(startPageNum);
  pages.push(currentPage);
  body.appendChild(currentPage);
  var accumulated = 0;

  function getType(el) {
    var cls = el.className || '';
    if (cls.includes('pm-character')) return 'pm-character';
    if (cls.includes('pm-dialogue')) return 'pm-dialogue';
    if (cls.includes('pm-parenthetical')) return 'pm-parenthetical';
    if (cls.includes('pm-scene-heading')) return 'pm-scene-heading';
    return '';
  }

  function newPage() {
    currentPage.classList.add('paginated');
    currentPage = createPage(pages.length + startPageNum);
    pages.push(currentPage);
    body.appendChild(currentPage);
    accumulated = 0;
  }

  var KEEP_WITH_PREV = ['pm-dialogue', 'pm-parenthetical'];

  for (var i = 0; i < allElements.length; i++) {
    var el = allElements[i];
    currentPage.appendChild(el);

    // Force layout then measure
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    var h = rect.height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);

    if (h <= 0) { accumulated += 16; continue; } // fallback for unmeasurable elements

    if (accumulated + h > CONTENT_H && accumulated > 0) {
      el.remove();

      var type = getType(el);
      if (KEEP_WITH_PREV.indexOf(type) !== -1) {
        var pulled = [el];
        while (currentPage.lastElementChild && currentPage.lastElementChild.tagName === 'P') {
          var prev = currentPage.lastElementChild;
          var prevType = getType(prev);
          prev.remove();
          pulled.unshift(prev);
          if (prevType === 'pm-character') break;
          if (KEEP_WITH_PREV.indexOf(prevType) === -1) break;
        }
        newPage();
        pulled.forEach(function(p) { currentPage.appendChild(p); });
        accumulated = 0;
        Array.from(currentPage.querySelectorAll('p')).forEach(function(p) {
          accumulated += p.getBoundingClientRect().height +
            (parseFloat(window.getComputedStyle(p).marginTop) || 0) +
            (parseFloat(window.getComputedStyle(p).marginBottom) || 0);
        });
      } else {
        newPage();
        currentPage.appendChild(el);
        accumulated = h;
      }
    } else {
      accumulated += h;
    }
  }

  // Mark last page and clean up first-child margins
  currentPage.classList.add('paginated');
  pages.forEach(function(page) {
    var first = page.querySelector('p');
    if (first) first.style.marginTop = '0';
  });
}

function createPage(num) {
  var page = document.createElement('div');
  page.className = 'page';
  if (num > 1) {
    var pageNum = document.createElement('span');
    pageNum.className = 'page-number';
    pageNum.textContent = num + '.';
    page.appendChild(pageNum);
  }
  return page;
}
</script>
</body>
</html>`;
}

export interface CoverPageOptions {
  title?: string;
  author?: string;
  basedOn?: string;
  draftDate?: string;
  contactInfo?: string;
  copyright?: string;
}

export interface PDFExportOptions {
  title?: string;
  filename?: string;
  coverPage?: CoverPageOptions;
}

function buildCoverPageHTML(cover: CoverPageOptions): string {
  const lines: string[] = [];
  lines.push('<div class="page cover-page">');

  // Title block: centered vertically (roughly 40% from top)
  lines.push('<div class="cover-title-block">');
  if (cover.title) {
    lines.push(`<p class="cover-title">${escapeHTML(cover.title)}</p>`);
  }
  if (cover.author) {
    lines.push(`<p class="cover-credit">Written by</p>`);
    lines.push(`<p class="cover-author">${escapeHTML(cover.author)}</p>`);
  }
  if (cover.basedOn) {
    lines.push(`<p class="cover-based-on">${escapeHTML(cover.basedOn)}</p>`);
  }
  lines.push('</div>');

  // Bottom-left info block
  lines.push('<div class="cover-info-block">');
  if (cover.draftDate) {
    lines.push(`<p class="cover-info">${escapeHTML(cover.draftDate)}</p>`);
  }
  if (cover.copyright) {
    lines.push(`<p class="cover-info">${escapeHTML(cover.copyright)}</p>`);
  }
  if (cover.contactInfo) {
    lines.push(`<p class="cover-info">${escapeHTML(cover.contactInfo)}</p>`);
  }
  lines.push('</div>');

  lines.push('</div>');
  return lines.join("\n");
}

export function exportToPDF(doc: Node, options: PDFExportOptions = {}): void {
  if (typeof window === "undefined") {
    throw new Error("exportToPDF requires a browser environment.");
  }

  const content = renderToHTML(doc);
  const coverHTML = options.coverPage ? buildCoverPageHTML(options.coverPage) : "";
  const html = buildPrintDocument(coverHTML + content, options.title || options.coverPage?.title);

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    throw new Error("Could not open print window. Please allow popups.");
  }

  printWindow.document.write(html);
  printWindow.document.close();

  // Trigger print from the opener side -- more reliable than inline script
  printWindow.onafterprint = () => {
    // Optional: close window after printing
  };

  // Poll until fonts + pagination are ready, then print
  const tryPrint = () => {
    if (!printWindow || printWindow.closed) return;
    const pages = printWindow.document.querySelectorAll(".page");
    if (pages.length > 0) {
      // Pages exist, pagination ran. Now wait for fonts.
      if (printWindow.document.fonts) {
        printWindow.document.fonts.ready.then(() => {
          setTimeout(() => printWindow.print(), 200);
        });
      } else {
        setTimeout(() => printWindow.print(), 500);
      }
    } else {
      // Pagination hasn't run yet, retry
      setTimeout(tryPrint, 100);
    }
  };

  // Start polling after a short delay for document.write to settle
  setTimeout(tryPrint, 300);
}

export function toPrintHTML(doc: Node, title?: string): string {
  const content = renderToHTML(doc);
  return buildPrintDocument(content, title);
}
