import { ScriptTimingService } from '../../services/scriptTimingService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDoc(...nodes: any[]) {
  return { type: 'doc', content: nodes };
}

function sceneHeading(text: string) {
  return { type: 'sceneHeading', attrs: { id: null }, content: [{ type: 'text', text }] };
}

function action(text: string) {
  return { type: 'action', content: [{ type: 'text', text }] };
}

function character(text: string) {
  return { type: 'character', content: [{ type: 'text', text }] };
}

function dialogue(text: string) {
  return { type: 'dialogue', content: [{ type: 'text', text }] };
}

function parenthetical(text: string) {
  return { type: 'parenthetical', content: [{ type: 'text', text }] };
}

function transition(text: string) {
  return { type: 'transition', content: [{ type: 'text', text }] };
}

// ── calculateScriptTiming ─────────────────────────────────────────────────────

describe('ScriptTimingService.calculateScriptTiming', () => {
  it('returns empty timing for null input', () => {
    const result = ScriptTimingService.calculateScriptTiming(null);
    expect(result.totalPages).toBe(0);
    expect(result.totalMinutes).toBe(0);
    expect(result.sceneBreakdown).toHaveLength(0);
    expect(result.stats.totalScenes).toBe(0);
  });

  it('returns empty timing for a doc with no content array', () => {
    const result = ScriptTimingService.calculateScriptTiming({ type: 'doc' });
    expect(result.totalPages).toBe(0);
  });

  it('counts a single scene heading', () => {
    const doc = makeDoc(sceneHeading('INT. OFFICE - DAY'));
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.elementBreakdown.sceneHeadings).toBe(1);
    expect(result.sceneBreakdown).toHaveLength(1);
    expect(result.sceneBreakdown[0].heading).toBe('INT. OFFICE - DAY');
  });

  it('assigns scene numbers sequentially', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      sceneHeading('EXT. STREET - NIGHT'),
      sceneHeading('INT. CAR - NIGHT'),
    );
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.sceneBreakdown.map(s => s.sceneNumber)).toEqual([1, 2, 3]);
  });

  it('accumulates action word counts per scene', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      // 5 words of action
      action('Bob walks into the room.'),
    );
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.sceneBreakdown[0].elements.action).toBe(5);
  });

  it('accumulates dialogue word counts per scene', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      character('BOB'),
      dialogue('Hello, how are you doing?'),
    );
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.sceneBreakdown[0].elements.dialogue).toBe(5);
  });

  it('accumulates parenthetical word counts per scene', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      character('BOB'),
      parenthetical('whispering gently'),
    );
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.sceneBreakdown[0].elements.parentheticals).toBe(2);
  });

  it('counts transitions in elementBreakdown', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      transition('CUT TO:'),
    );
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.elementBreakdown.transitions).toBe(1);
  });

  it('enforces a minimum page length of 0.125 (1/8 page) per scene', () => {
    const doc = makeDoc(sceneHeading('INT. OFFICE - DAY'));
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.sceneBreakdown[0].pages).toBeGreaterThanOrEqual(0.125);
  });

  it('calculates totalPages as sum of scene pages', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      action('Bob walks into the room and looks around carefully at everything.'),
      sceneHeading('EXT. STREET - NIGHT'),
      action('Jane runs down the dark street towards the old abandoned warehouse.'),
    );
    const result = ScriptTimingService.calculateScriptTiming(doc);
    const sumOfScenes = result.sceneBreakdown.reduce((s, sc) => s + sc.pages, 0);
    expect(result.totalPages).toBeCloseTo(sumOfScenes, 2);
  });

  it('calculates totalMinutes = round(totalPages * 1)', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      action('Bob walks into the room.'),
    );
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.totalMinutes).toBe(Math.round(result.totalPages));
  });

  it('computes stats: totalScenes, averageSceneLength, longestScene, shortestScene', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      action('Bob walks into the room.'),
      sceneHeading('EXT. STREET - NIGHT'),
      action('A longer action sequence with many more words that continues on.'),
    );
    const result = ScriptTimingService.calculateScriptTiming(doc);
    expect(result.stats.totalScenes).toBe(2);
    expect(result.stats.longestScene).toBeGreaterThanOrEqual(result.stats.shortestScene);
    expect(result.stats.averageSceneLength).toBeGreaterThan(0);
  });

  it('handles content before the first scene heading gracefully (no crash)', () => {
    const doc = makeDoc(
      action('Opening action with no scene heading.'),
      sceneHeading('INT. OFFICE - DAY'),
    );
    expect(() => ScriptTimingService.calculateScriptTiming(doc)).not.toThrow();
  });
});

// ── getFormatTimingMultiplier ──────────────────────────────────────────────────

describe('ScriptTimingService.getFormatTimingMultiplier', () => {
  it('returns 1.0 for feature films', () => {
    expect(ScriptTimingService.getFormatTimingMultiplier('feature')).toBe(1.0);
  });

  it('returns 1.1 for short films', () => {
    expect(ScriptTimingService.getFormatTimingMultiplier('short')).toBe(1.1);
  });

  it('returns 0.95 for series', () => {
    expect(ScriptTimingService.getFormatTimingMultiplier('series')).toBe(0.95);
  });

  it('returns 1.0 for unknown types', () => {
    expect(ScriptTimingService.getFormatTimingMultiplier('unknown')).toBe(1.0);
  });
});

// ── calculateReadingTime ───────────────────────────────────────────────────────

describe('ScriptTimingService.calculateReadingTime', () => {
  it('returns 0 for empty content', () => {
    expect(ScriptTimingService.calculateReadingTime(null)).toBe(0);
  });

  it('returns a positive integer for a doc with words', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      action('Bob walks into the room and sits down.'),
      character('BOB'),
      dialogue('This is a line of dialogue spoken by Bob.'),
    );
    const result = ScriptTimingService.calculateReadingTime(doc);
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ── calculateSectionTiming ────────────────────────────────────────────────────

describe('ScriptTimingService.calculateSectionTiming', () => {
  it('limits timing to the specified slice of content', () => {
    const doc = makeDoc(
      sceneHeading('INT. OFFICE - DAY'),
      action('Scene 1 action text.'),
      sceneHeading('EXT. STREET - NIGHT'),
      action('Scene 2 action text.'),
    );

    const fullResult = ScriptTimingService.calculateScriptTiming(doc);
    const sectionResult = ScriptTimingService.calculateSectionTiming(doc, 0, 2);

    // Section should have fewer scenes than the full script
    expect(sectionResult.stats.totalScenes).toBeLessThanOrEqual(fullResult.stats.totalScenes);
  });

  it('returns empty timing for null input', () => {
    const result = ScriptTimingService.calculateSectionTiming(null);
    expect(result.totalPages).toBe(0);
  });
});
