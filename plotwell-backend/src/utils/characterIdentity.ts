const TECHNICAL_CUE_EXTENSION =
  /\s*\(\s*(?:V\.?\s*O\.?|O\.?\s*S\.?|O\.?\s*C\.?|CONT(?:INUE)?D?'?\.?|CONT|MORE|SUPER|SUBTITLE|FILTER|PRE-?LAP)\s*\)\s*$/i;

export interface CharacterCandidate {
  name?: unknown;
  appearance?: unknown;
  description?: unknown;
  character_type?: unknown;
  primary_role?: unknown;
  importance_level?: unknown;
  status?: unknown;
  story_arc?: unknown;
  motivations?: unknown;
  fears?: unknown;
  goals?: unknown;
  [key: string]: unknown;
}

export function normalizeCharacterCue(value: unknown): string {
  if (typeof value !== 'string') return '';

  return value
    .trim()
    .replace(/^@/, '')
    .replace(/\^+\s*$/, '')
    .toUpperCase()
    .replace(/\(\s*V\.?\s*O\.?\s*\)/g, '(V.O.)')
    .replace(/\(\s*O\.?\s*S\.?\s*\)/g, '(O.S.)')
    .replace(/\(\s*O\.?\s*C\.?\s*\)/g, '(O.C.)')
    .replace(/\(\s*CONT(?:INUE)?D?'?\.?\s*\)/g, "(CONT'D)")
    .replace(/\(\s*PRE-?\s*LAP\s*\)/g, '(PRE-LAP)')
    .replace(/\s+/g, ' ')
    .replace(/([^\s])\(/g, '$1 (')
    .trim();
}

export function canonicalizeCharacterName(value: unknown): string {
  let name = normalizeCharacterCue(value);

  while (TECHNICAL_CUE_EXTENSION.test(name)) {
    name = name.replace(TECHNICAL_CUE_EXTENSION, '').trim();
  }

  return name
    .replace(/^[\s"'`.,:;[\]{}]+|[\s"'`.,:;[\]{}]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function getCharacterIdentityKey(value: unknown): string {
  return canonicalizeCharacterName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function preferRicherText(current: unknown, incoming: unknown): unknown {
  if (typeof incoming !== 'string' || !incoming.trim()) return current;
  if (typeof current !== 'string' || incoming.trim().length > current.trim().length) {
    return incoming.trim();
  }
  return current;
}

function preferHigherNumber(current: unknown, incoming: unknown): unknown {
  const currentNumber = Number(current);
  const incomingNumber = Number(incoming);
  if (!Number.isFinite(currentNumber)) return incoming;
  if (!Number.isFinite(incomingNumber)) return current;
  return Math.max(currentNumber, incomingNumber);
}

function mergeCharacterType(current: unknown, incoming: unknown): unknown {
  const rank: Record<string, number> = {
    background: 0,
    minor: 1,
    ensemble: 2,
    main: 3,
  };
  const currentRank = typeof current === 'string' ? rank[current.toLowerCase()] ?? -1 : -1;
  const incomingRank = typeof incoming === 'string' ? rank[incoming.toLowerCase()] ?? -1 : -1;
  return incomingRank > currentRank ? incoming : current;
}

export function dedupeCharacterCandidates<T extends CharacterCandidate>(candidates: T[]): T[] {
  const byKey = new Map<string, T>();

  for (const candidate of candidates) {
    const name = canonicalizeCharacterName(candidate.name);
    const key = getCharacterIdentityKey(name);
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...candidate, name });
      continue;
    }

    byKey.set(key, {
      ...existing,
      appearance: preferRicherText(existing.appearance, candidate.appearance),
      description: preferRicherText(existing.description, candidate.description),
      character_type: mergeCharacterType(existing.character_type, candidate.character_type),
      primary_role: preferRicherText(existing.primary_role, candidate.primary_role),
      importance_level: preferHigherNumber(existing.importance_level, candidate.importance_level),
      status: existing.status || candidate.status,
      story_arc: preferRicherText(existing.story_arc, candidate.story_arc),
      motivations: preferRicherText(existing.motivations, candidate.motivations),
      fears: preferRicherText(existing.fears, candidate.fears),
      goals: preferRicherText(existing.goals, candidate.goals),
    });
  }

  return Array.from(byKey.values());
}

export function normalizeCharacterCuesInDocument<T>(document: T): T {
  if (!document || typeof document !== 'object') return document;
  const content = (document as { content?: unknown }).content;
  if (!Array.isArray(content)) return document;

  return {
    ...document,
    content: content.map((node: any) => {
      if (node?.type !== 'character' || !Array.isArray(node.content)) return node;
      const cue = node.content
        .filter((child: any) => child?.type === 'text')
        .map((child: any) => child.text || '')
        .join('');
      const normalizedCue = normalizeCharacterCue(cue);
      return normalizedCue
        ? { ...node, content: [{ type: 'text', text: normalizedCue }] }
        : node;
    }),
  };
}
