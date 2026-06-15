import {
  buildCharacterVisualProfilePrompt,
  buildLocationVisualProfilePrompt,
  mergeCharacterVisualProfiles,
  sanitizeCharacterVisualProfile,
} from '../../utils/visualProfiles';

describe('visual profiles', () => {
  it('keeps only supported character visual fields', () => {
    expect(sanitizeCharacterVisualProfile({
      body: 'Tall, lean man in his 30s',
      role: 'protagonist',
      face: 'Angular face and short black hair',
    })).toEqual({
      body: 'Tall, lean man in his 30s',
      face: 'Angular face and short black hair',
    });
  });

  it('preserves existing profile values while filling missing fields', () => {
    expect(mergeCharacterVisualProfiles(
      { body: 'Short woman in her 60s' },
      { body: 'Different body', styling: 'Red wool coat' }
    )).toEqual({
      body: 'Short woman in her 60s',
      styling: 'Red wool coat',
    });
  });

  it('places character identity under an explicit locked priority', () => {
    expect(buildCharacterVisualProfilePrompt({
      face: 'Freckled face, green eyes, copper curls',
    })).toContain('LOCKED VISUAL IDENTITY');
  });

  it('places location identity under an explicit locked priority', () => {
    expect(buildLocationVisualProfilePrompt({
      structure: 'Narrow two-story courtyard house',
      surfaces: 'Cracked ochre plaster and dark timber',
    })).toContain('LOCKED LOCATION IDENTITY');
  });
});
