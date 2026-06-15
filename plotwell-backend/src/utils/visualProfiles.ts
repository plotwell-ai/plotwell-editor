export interface CharacterVisualProfile {
  body?: string;
  face?: string;
  styling?: string;
  distinctive_features?: string;
}

export interface LocationVisualProfile {
  structure?: string;
  surfaces?: string;
  lighting?: string;
  distinctive_features?: string;
}

type VisualProfile = CharacterVisualProfile | LocationVisualProfile;

const CHARACTER_KEYS: Array<keyof CharacterVisualProfile> = [
  'body',
  'face',
  'styling',
  'distinctive_features',
];

const LOCATION_KEYS: Array<keyof LocationVisualProfile> = [
  'structure',
  'surfaces',
  'lighting',
  'distinctive_features',
];

function sanitizeProfile<T extends VisualProfile>(
  value: unknown,
  keys: Array<keyof T>
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as T;

  const source = value as Record<string, unknown>;
  const profile: Record<string, string> = {};
  for (const key of keys) {
    const candidate = source[String(key)];
    if (typeof candidate === 'string' && candidate.trim()) {
      profile[String(key)] = candidate.trim();
    }
  }
  return profile as T;
}

export function sanitizeCharacterVisualProfile(value: unknown): CharacterVisualProfile {
  return sanitizeProfile<CharacterVisualProfile>(value, CHARACTER_KEYS);
}

export function sanitizeLocationVisualProfile(value: unknown): LocationVisualProfile {
  return sanitizeProfile<LocationVisualProfile>(value, LOCATION_KEYS);
}

export function mergeCharacterVisualProfiles(
  current: unknown,
  incoming: unknown
): CharacterVisualProfile {
  return mergeProfiles(
    sanitizeCharacterVisualProfile(current),
    sanitizeCharacterVisualProfile(incoming),
    CHARACTER_KEYS
  );
}

export function mergeLocationVisualProfiles(
  current: unknown,
  incoming: unknown
): LocationVisualProfile {
  return mergeProfiles(
    sanitizeLocationVisualProfile(current),
    sanitizeLocationVisualProfile(incoming),
    LOCATION_KEYS
  );
}

function mergeProfiles<T extends VisualProfile>(
  current: T,
  incoming: T,
  keys: Array<keyof T>
): T {
  const merged: Record<string, string> = {};
  for (const key of keys) {
    const currentValue = current[key];
    const incomingValue = incoming[key];
    if (typeof currentValue === 'string' && currentValue.trim()) {
      merged[String(key)] = currentValue.trim();
    } else if (typeof incomingValue === 'string' && incomingValue.trim()) {
      merged[String(key)] = incomingValue.trim();
    }
  }
  return merged as T;
}

export function buildCharacterVisualProfilePrompt(value: unknown): string {
  const profile = sanitizeCharacterVisualProfile(value);
  const details = [
    profile.body && `Body, species, and apparent age: ${profile.body}`,
    profile.face && `Face, head, hair, and eyes: ${profile.face}`,
    profile.styling && `Wardrobe, grooming, and visual palette: ${profile.styling}`,
    profile.distinctive_features && `Identity-defining features: ${profile.distinctive_features}`,
  ].filter(Boolean);

  return details.length > 0
    ? `LOCKED VISUAL IDENTITY - highest priority, preserve every stated trait: ${details.join('. ')}.`
    : '';
}

export function buildLocationVisualProfilePrompt(value: unknown): string {
  const profile = sanitizeLocationVisualProfile(value);
  const details = [
    profile.structure && `Architecture, geography, and spatial layout: ${profile.structure}`,
    profile.surfaces && `Materials, surfaces, furnishings, and color palette: ${profile.surfaces}`,
    profile.lighting && `Physical light sources and baseline lighting: ${profile.lighting}`,
    profile.distinctive_features && `Identity-defining environmental features: ${profile.distinctive_features}`,
  ].filter(Boolean);

  return details.length > 0
    ? `LOCKED LOCATION IDENTITY - highest priority, preserve every stated feature: ${details.join('. ')}.`
    : '';
}
