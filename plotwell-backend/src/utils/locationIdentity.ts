import { mergeLocationVisualProfiles } from './visualProfiles';

const TIME_OF_DAY_SUFFIX =
  'AL MISMO TIEMPO|MISMO TIEMPO|MOMENTOS? DESPU[ÉE]S|INSTANTES DESPU[ÉE]S|M[ÁA]S TARDE|MOMENTS? LATER|SAME TIME|MAGIC HOUR|DE D[ÍI]A|DE NOCHE|' +
  'DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|NOON|MIDNIGHT|SUNRISE|SUNSET|CONTINUOUS|LATER|FLASHBACK|DREAM|FANTASY|' +
  'D[ÍI]A|NOCHE|AMANECER|ALBA|MADRUGADA|ATARDECER|ANOCHECER|CREP[ÚU]SCULO|OCASO|MA[ÑN]ANA|TARDE|MEDIOD[ÍI]A|MEDIANOCHE|' +
  'CONTINU[OA]|CONTINUACI[ÓO]N|RETROSPECTIVA|SUE[ÑN]O|FANTAS[ÍI]A';

const SCENE_PREFIX = /^(?:INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|INTERIOR|EXTERIOR|INT\.?|EXT\.?|I\s*\/\s*E\.?)\s+/i;
const SCENE_PREFIX_CAPTURE = /^(INT\.?\s*\/\s*EXT\.?|EXT\.?\s*\/\s*INT\.?|INTERIOR|EXTERIOR|INT\.?|EXT\.?|I\s*\/\s*E\.?)\s+/i;
const TRAILING_TIME = new RegExp(`\\s*[-–—,]\\s*(?:${TIME_OF_DAY_SUFFIX})\\s*$`, 'i');
const TRAILING_TIME_CAPTURE = new RegExp(`\\s*[-–—,]\\s*(${TIME_OF_DAY_SUFFIX})\\s*$`, 'i');

export type LocationType = 'interior' | 'exterior' | 'both' | 'studio' | 'virtual';
export type SceneTimeOfDay = 'day' | 'night' | 'dawn' | 'dusk';

export interface LocationCandidate {
  name?: unknown;
  description?: unknown;
  location_type?: unknown;
  story_importance?: unknown;
  atmosphere?: unknown;
  visual_notes?: unknown;
  visual_profile?: unknown;
  [key: string]: unknown;
}

export function canonicalizeLocationName(value: unknown): string {
  if (typeof value !== 'string') return '';

  return value
    .trim()
    .replace(SCENE_PREFIX, '')
    .replace(TRAILING_TIME, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`.,:;()[\]{}]+|[\s"'`.,:;()[\]{}]+$/g, '')
    .trim()
    .toUpperCase();
}

export function getLocationNameFromSceneHeading(value: unknown): string | null {
  if (typeof value !== 'string' || !SCENE_PREFIX.test(value.trim())) return null;
  return canonicalizeLocationName(value) || null;
}

export function isSceneHeadingText(value: unknown): boolean {
  return typeof value === 'string' && SCENE_PREFIX.test(value.trim());
}

function normalizeScenePrefix(prefix: string): string {
  const compact = prefix.toUpperCase().replace(/\s+/g, '');
  if (compact.startsWith('I/E')) return 'INT./EXT.';
  if (compact.startsWith('EXT') && compact.includes('INT')) return 'EXT./INT.';
  if (compact.startsWith('INT') && compact.includes('EXT')) {
    return 'INT./EXT.';
  }
  return compact.startsWith('EXT') ? 'EXT.' : 'INT.';
}

function classifyTimeOfDay(value: string | undefined): SceneTimeOfDay {
  const normalized = (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  if (/NIGHT|EVENING|NOCHE|MEDIANOCHE/.test(normalized)) return 'night';
  if (/DAWN|SUNRISE|AMANECER|ALBA|MADRUGADA|MORNING|MANANA/.test(normalized)) return 'dawn';
  if (/DUSK|SUNSET|ATARDECER|ANOCHECER|CREPUSCULO|OCASO/.test(normalized)) return 'dusk';
  return 'day';
}

export function parseSceneHeadingIdentity(value: unknown): {
  heading: string;
  location: string;
  intExt: 'INT' | 'EXT';
  locationType: 'interior' | 'exterior' | 'both';
  timeOfDay: SceneTimeOfDay;
} | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const prefixMatch = trimmed.match(SCENE_PREFIX_CAPTURE);
  if (!prefixMatch) return null;

  const timeMatch = trimmed.match(TRAILING_TIME_CAPTURE);
  const location = canonicalizeLocationName(trimmed);
  if (!location) return null;

  const prefix = normalizeScenePrefix(prefixMatch[1]);
  const both = prefix.includes('/');
  const intExt = prefix.startsWith('EXT') ? 'EXT' : 'INT';
  const timeLabel = timeMatch?.[1]?.trim().toUpperCase();

  return {
    heading: `${prefix} ${location}${timeLabel ? ` - ${timeLabel}` : ''}`,
    location,
    intExt,
    locationType: both ? 'both' : intExt === 'INT' ? 'interior' : 'exterior',
    timeOfDay: classifyTimeOfDay(timeLabel),
  };
}

export function normalizeSceneHeadingsInDocument<T>(document: T): T {
  if (!document || typeof document !== 'object') return document;
  const content = (document as { content?: unknown }).content;
  if (!Array.isArray(content)) return document;

  return {
    ...document,
    content: content.map((node: any) => {
      if (node?.type !== 'sceneHeading' || !Array.isArray(node.content)) return node;
      const headingText = node.content
        .filter((child: any) => child?.type === 'text')
        .map((child: any) => child.text || '')
        .join('');
      const parsed = parseSceneHeadingIdentity(headingText);
      if (!parsed) return node;

      return {
        ...node,
        content: [{ type: 'text', text: parsed.heading }],
      };
    }),
  };
}

export function getLocationIdentityKey(value: unknown): string {
  return canonicalizeLocationName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeLocationType(current: unknown, incoming: unknown): LocationType {
  const currentType = typeof current === 'string' ? current.toLowerCase() : '';
  const incomingType = typeof incoming === 'string' ? incoming.toLowerCase() : '';
  const validTypes = new Set<LocationType>(['interior', 'exterior', 'both', 'studio', 'virtual']);

  const first = validTypes.has(currentType as LocationType) ? currentType as LocationType : null;
  const second = validTypes.has(incomingType as LocationType) ? incomingType as LocationType : null;

  if (!first) return second || 'both';
  if (!second || first === second) return first;
  if (first === 'both' || second === 'both') return 'both';
  if (
    (first === 'interior' && second === 'exterior') ||
    (first === 'exterior' && second === 'interior')
  ) {
    return 'both';
  }
  return first;
}

function preferRicherText(current: unknown, incoming: unknown): unknown {
  if (typeof incoming !== 'string' || !incoming.trim()) return current;
  if (typeof current !== 'string' || incoming.trim().length > current.trim().length) {
    return incoming.trim();
  }
  return current;
}

function mergeStoryImportance(current: unknown, incoming: unknown): unknown {
  const rank: Record<string, number> = {
    minor: 0,
    supporting: 1,
    major: 2,
    critical: 3,
  };
  const currentRank = typeof current === 'string' ? rank[current.toLowerCase()] ?? -1 : -1;
  const incomingRank = typeof incoming === 'string' ? rank[incoming.toLowerCase()] ?? -1 : -1;
  return incomingRank > currentRank ? incoming : current;
}

export function dedupeLocationCandidates<T extends LocationCandidate>(candidates: T[]): T[] {
  const byKey = new Map<string, T>();

  for (const candidate of candidates) {
    const name = canonicalizeLocationName(candidate.name);
    const key = getLocationIdentityKey(name);
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...candidate,
        name,
        location_type: mergeLocationType(undefined, candidate.location_type),
      });
      continue;
    }

    byKey.set(key, {
      ...existing,
      description: preferRicherText(existing.description, candidate.description),
      location_type: mergeLocationType(existing.location_type, candidate.location_type),
      story_importance: mergeStoryImportance(existing.story_importance, candidate.story_importance),
      atmosphere: preferRicherText(existing.atmosphere, candidate.atmosphere),
      visual_notes: preferRicherText(existing.visual_notes, candidate.visual_notes),
      visual_profile: mergeLocationVisualProfiles(existing.visual_profile, candidate.visual_profile),
    });
  }

  return Array.from(byKey.values());
}
