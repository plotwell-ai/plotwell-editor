import {
  canonicalizeLocationName,
  dedupeLocationCandidates,
  getLocationIdentityKey,
  getLocationNameFromSceneHeading,
  normalizeSceneHeadingsInDocument,
  parseSceneHeadingIdentity,
} from '../../utils/locationIdentity';

describe('location identity', () => {
  it('extracts a canonical location name from scene headings', () => {
    expect(canonicalizeLocationName('INT. Piso de Madrid - NOCHE')).toBe('PISO DE MADRID');
    expect(canonicalizeLocationName('EXT./INT. Azotea - MÁS TARDE')).toBe('AZOTEA');
    expect(canonicalizeLocationName('INT. PISO DE MADRID - COCINA - ATARDECER'))
      .toBe('PISO DE MADRID - COCINA');
    expect(getLocationNameFromSceneHeading('INT. Piso de Madrid - NOCHE'))
      .toBe('PISO DE MADRID');
    expect(getLocationNameFromSceneHeading('Piso de Madrid')).toBeNull();
  });

  it('matches case, accents, spacing, and punctuation consistently', () => {
    expect(getLocationIdentityKey('  Ático-de Madrid ')).toBe(
      getLocationIdentityKey('atico de madrid')
    );
  });

  it('parses time only from the trailing screenplay suffix', () => {
    expect(parseSceneHeadingIdentity('EXT. DAYTONA BEACH - NIGHT')).toMatchObject({
      heading: 'EXT. DAYTONA BEACH - NIGHT',
      location: 'DAYTONA BEACH',
      intExt: 'EXT',
      locationType: 'exterior',
      timeOfDay: 'night',
    });

    expect(parseSceneHeadingIdentity('INT./EXT. PISO DE MADRID - ATARDECER')).toMatchObject({
      location: 'PISO DE MADRID',
      locationType: 'both',
      timeOfDay: 'dusk',
    });
  });

  it('deduplicates one AI batch and merges useful metadata', () => {
    const result = dedupeLocationCandidates([
      {
        name: 'Piso de Madrid',
        description: 'Piso.',
        location_type: 'interior',
        story_importance: 'supporting',
      },
      {
        name: 'INT. PISO DE MADRID - NOCHE',
        description: 'Un piso amplio y antiguo en el centro de Madrid.',
        location_type: 'exterior',
        story_importance: 'major',
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'PISO DE MADRID',
      description: 'Un piso amplio y antiguo en el centro de Madrid.',
      location_type: 'both',
      story_importance: 'major',
    });
  });

  it('normalizes generated scene heading nodes before persistence', () => {
    const document = normalizeSceneHeadingsInDocument({
      type: 'doc',
      content: [{
        type: 'sceneHeading',
        content: [{ type: 'text', text: 'int. piso de madrid – noche' }],
      }],
    });

    expect(document.content[0].content[0].text).toBe('INT. PISO DE MADRID - NOCHE');
  });
});
