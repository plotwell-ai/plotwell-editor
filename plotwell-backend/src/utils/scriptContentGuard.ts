type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sortJson(value: any): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortJson);

  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      const next = value[key];
      if (next !== undefined) acc[key] = sortJson(next);
      return acc;
    }, {} as { [key: string]: JsonValue });
}

function stableStringify(value: any): string {
  return JSON.stringify(sortJson(value));
}

function getDocBlocks(content: any): any[] | null {
  if (!content || content.type !== 'doc' || !Array.isArray(content.content)) {
    return null;
  }
  return content.content;
}

function blocksEqual(a: any[], b: any[]): boolean {
  if (a.length !== b.length) return false;
  return stableStringify(a) === stableStringify(b);
}

export function detectWholeDocumentDuplication(
  previousContent: any,
  candidateContent: any
): { duplicated: boolean; repeatCount: number } {
  const previousBlocks = getDocBlocks(previousContent);
  const candidateBlocks = getDocBlocks(candidateContent);

  if (!previousBlocks || !candidateBlocks || previousBlocks.length === 0) {
    return { duplicated: false, repeatCount: 0 };
  }

  if (candidateBlocks.length <= previousBlocks.length) {
    return { duplicated: false, repeatCount: 0 };
  }

  if (candidateBlocks.length % previousBlocks.length !== 0) {
    return { duplicated: false, repeatCount: 0 };
  }

  const repeatCount = candidateBlocks.length / previousBlocks.length;
  if (repeatCount < 2) {
    return { duplicated: false, repeatCount: 0 };
  }

  for (let index = 0; index < repeatCount; index += 1) {
    const start = index * previousBlocks.length;
    const chunk = candidateBlocks.slice(start, start + previousBlocks.length);
    if (!blocksEqual(previousBlocks, chunk)) {
      return { duplicated: false, repeatCount: 0 };
    }
  }

  return { duplicated: true, repeatCount };
}
