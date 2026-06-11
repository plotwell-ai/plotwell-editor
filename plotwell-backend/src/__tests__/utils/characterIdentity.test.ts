import {
  canonicalizeCharacterName,
  dedupeCharacterCandidates,
  getCharacterIdentityKey,
  normalizeCharacterCuesInDocument,
} from '../../utils/characterIdentity';

describe('character identity', () => {
  it('removes only technical screenplay cue extensions', () => {
    expect(canonicalizeCharacterName(" Edward (V.O.) (CONT'D) ")).toBe('EDWARD');
    expect(canonicalizeCharacterName('MARÍA (JOVEN)')).toBe('MARÍA (JOVEN)');
    expect(canonicalizeCharacterName('@EDWARD^')).toBe('EDWARD');
  });

  it('matches accents and punctuation consistently', () => {
    expect(getCharacterIdentityKey("José O'Neil")).toBe(
      getCharacterIdentityKey('JOSE O NEIL')
    );
  });

  it('deduplicates one AI batch and preserves richer metadata', () => {
    const result = dedupeCharacterCandidates([
      {
        name: 'EDWARD',
        description: 'Detective.',
        character_type: 'minor',
        importance_level: 2,
      },
      {
        name: "EDWARD (V.O.)",
        description: 'Detective leading the investigation.',
        character_type: 'main',
        importance_level: 5,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'EDWARD',
      description: 'Detective leading the investigation.',
      character_type: 'main',
      importance_level: 5,
    });
  });

  it('keeps narrative qualifiers as separate identities', () => {
    const result = dedupeCharacterCandidates([
      { name: 'EDWARD' },
      { name: 'EDWARD (JOVEN)' },
    ]);
    expect(result).toHaveLength(2);
  });

  it('normalizes generated character cue nodes before persistence', () => {
    const document = normalizeCharacterCuesInDocument({
      type: 'doc',
      content: [{
        type: 'character',
        content: [{ type: 'text', text: "edward (v.o.) (cont'd)" }],
      }],
    });

    expect(document.content[0].content[0].text).toBe("EDWARD (V.O.) (CONT'D)");
  });
});
