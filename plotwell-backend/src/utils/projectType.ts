// =============================================================================
// Project type helpers — keep the film / series / vertical_series distinction
// in one place so branch points don't drift.
// =============================================================================

export type ProjectType = 'film' | 'series' | 'vertical_series';

/** Episodic project types use the seasons → episodes → scripts hierarchy. */
export function isEpisodic(type: string | null | undefined): boolean {
  return type === 'series' || type === 'vertical_series';
}

/** Vertical project types default to 9:16 and unlock vertical-only features. */
export function isVertical(type: string | null | undefined): boolean {
  return type === 'vertical_series';
}

/** Default aspect ratio for a project type when none is supplied. */
export function defaultVideoFormat(type: string | null | undefined): '16:9' | '9:16' {
  return isVertical(type) ? '9:16' : '16:9';
}
