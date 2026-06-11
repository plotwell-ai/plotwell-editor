import {
  detectFormat,
  convertTiptapToProsemirror,
  ensureProsemirrorFormat,
} from '../../utils/formatDetection';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TIPTAP_DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { class: 'scene-heading' }, content: [{ type: 'text', text: 'INT. OFFICE - DAY' }] },
    { type: 'paragraph', attrs: { class: 'action' }, content: [{ type: 'text', text: 'Bob enters.' }] },
    { type: 'paragraph', attrs: { class: 'character-name' }, content: [{ type: 'text', text: 'BOB' }] },
    { type: 'paragraph', attrs: { class: 'dialogue' }, content: [{ type: 'text', text: 'Hello.' }] },
    { type: 'paragraph', attrs: { class: 'parenthetical' }, content: [{ type: 'text', text: '(whispering)' }] },
    { type: 'paragraph', attrs: { class: 'transition aligned' }, content: [{ type: 'text', text: 'CUT TO:' }] },
  ],
};

const PROSEMIRROR_DOC = {
  type: 'doc',
  content: [
    { type: 'sceneHeading', attrs: { id: null }, content: [{ type: 'text', text: 'INT. OFFICE - DAY' }] },
    { type: 'action', content: [{ type: 'text', text: 'Bob enters.' }] },
    { type: 'character', content: [{ type: 'text', text: 'BOB' }] },
    { type: 'dialogue', content: [{ type: 'text', text: 'Hello.' }] },
  ],
};

// ── detectFormat ──────────────────────────────────────────────────────────────

describe('detectFormat', () => {
  it('identifies TipTap format', () => {
    expect(detectFormat(TIPTAP_DOC)).toBe('tiptap');
  });

  it('identifies ProseMirror format', () => {
    expect(detectFormat(PROSEMIRROR_DOC)).toBe('prosemirror');
  });

  it('returns unknown for null input', () => {
    expect(detectFormat(null)).toBe('unknown');
  });

  it('returns unknown for non-object', () => {
    expect(detectFormat('string')).toBe('unknown');
  });

  it('returns unknown for doc with empty content', () => {
    expect(detectFormat({ type: 'doc', content: [] })).toBe('unknown');
  });

  it('returns unknown when doc.type is not "doc"', () => {
    expect(detectFormat({ type: 'other', content: [{ type: 'sceneHeading' }] })).toBe('unknown');
  });
});

// ── convertTiptapToProsemirror ─────────────────────────────────────────────────

describe('convertTiptapToProsemirror', () => {
  it('converts scene-heading paragraphs to sceneHeading nodes', () => {
    const result = convertTiptapToProsemirror(TIPTAP_DOC);
    expect(result.content[0].type).toBe('sceneHeading');
    expect(result.content[0].attrs).toEqual({ id: null });
  });

  it('converts action paragraphs to action nodes', () => {
    const result = convertTiptapToProsemirror(TIPTAP_DOC);
    expect(result.content[1].type).toBe('action');
  });

  it('converts character-name paragraphs to character nodes', () => {
    const result = convertTiptapToProsemirror(TIPTAP_DOC);
    expect(result.content[2].type).toBe('character');
  });

  it('converts dialogue paragraphs to dialogue nodes', () => {
    const result = convertTiptapToProsemirror(TIPTAP_DOC);
    expect(result.content[3].type).toBe('dialogue');
  });

  it('converts parenthetical paragraphs to parenthetical nodes', () => {
    const result = convertTiptapToProsemirror(TIPTAP_DOC);
    expect(result.content[4].type).toBe('parenthetical');
  });

  it('converts "transition aligned" to transition node', () => {
    const result = convertTiptapToProsemirror(TIPTAP_DOC);
    expect(result.content[5].type).toBe('transition');
  });

  it('preserves text content', () => {
    const result = convertTiptapToProsemirror(TIPTAP_DOC);
    expect(result.content[0].content[0].text).toBe('INT. OFFICE - DAY');
    expect(result.content[1].content[0].text).toBe('Bob enters.');
  });

  it('filters out invalid marks, keeps valid ones', () => {
    const docWithMarks = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { class: 'action' },
        content: [{
          type: 'text',
          text: 'Bold text',
          marks: [{ type: 'bold' }, { type: 'unknownMark' }],
        }],
      }],
    };
    const result = convertTiptapToProsemirror(docWithMarks);
    expect(result.content[0].content[0].marks).toEqual([{ type: 'bold' }]);
  });

  it('returns a fallback action node for invalid input', () => {
    const result = convertTiptapToProsemirror(null);
    expect(result).toEqual({ type: 'doc', content: [{ type: 'action' }] });
  });

  it('returns fallback action node when content array is empty', () => {
    const result = convertTiptapToProsemirror({ type: 'doc', content: [] });
    expect(result.content).toEqual([{ type: 'action' }]);
  });

  it('passes through nodes already in ProseMirror format', () => {
    const mixed = {
      type: 'doc',
      content: [
        { type: 'sceneHeading', attrs: { id: 'x' }, content: [{ type: 'text', text: 'EXT. PARK - DAY' }] },
      ],
    };
    const result = convertTiptapToProsemirror(mixed);
    expect(result.content[0].type).toBe('sceneHeading');
    expect(result.content[0].attrs).toEqual({ id: 'x' });
  });

  it('maps deprecated reel types to action', () => {
    const reelDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { class: 'hook' }, content: [{ type: 'text', text: 'Hook text' }] },
        { type: 'paragraph', attrs: { class: 'voiceover' }, content: [{ type: 'text', text: 'VO text' }] },
      ],
    };
    const result = convertTiptapToProsemirror(reelDoc);
    expect(result.content[0].type).toBe('action');
    expect(result.content[1].type).toBe('action');
  });
});

// ── ensureProsemirrorFormat ────────────────────────────────────────────────────

describe('ensureProsemirrorFormat', () => {
  it('converts TipTap docs', () => {
    const result = ensureProsemirrorFormat(TIPTAP_DOC);
    expect(result.content[0].type).toBe('sceneHeading');
  });

  it('passes through ProseMirror docs unchanged', () => {
    const result = ensureProsemirrorFormat(PROSEMIRROR_DOC);
    expect(result).toBe(PROSEMIRROR_DOC); // same reference — no copy
  });

  it('returns a fallback doc for null', () => {
    const result = ensureProsemirrorFormat(null);
    expect(result).toEqual({ type: 'doc', content: [{ type: 'action' }] });
  });
});
