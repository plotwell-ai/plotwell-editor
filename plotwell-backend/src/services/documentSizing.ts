/**
 * Document Sizing
 *
 * Single source of truth for how long a generated document should be and how
 * many tokens to allocate for it. Length is driven by FORMAT and SCOPE, not by
 * raw runtime alone, because the "1 page per minute" rule is for screenplays,
 * not treatments.
 *
 * Scope by project type:
 *   - film            -> one project-level treatment for the whole feature
 *   - series          -> one treatment per EPISODE (sized to episode runtime)
 *   - vertical_series -> one treatment per SEASON (a short arc, not per episode)
 *
 * Why this matters: the duration field is only captured for films. Series and
 * vertical projects have no project-level duration, so naive duration-based
 * sizing collapses to a default and produces a 10-page treatment for a 90-second
 * micro-drama. Episode runtimes live on `episodes.runtime`.
 */

import { SupabaseClient } from "@supabase/supabase-js";

export type TreatmentScope = "project" | "episode" | "season";

export interface DocumentSizingInput {
  documentType: string;
  projectType: string;
  /** Project-level runtime in minutes (films). 0 or undefined for episodic projects. */
  durationMinutes?: number;
  /** Representative (median) episode runtime in minutes, for series. */
  episodeRuntime?: number;
  /** Number of episodes in the season, for vertical series. */
  seasonEpisodeCount?: number;
}

export interface DocumentSizing {
  estimatedPages: number;
  maxTokens: number;
  scope: TreatmentScope;
  /** Human phrasing of the treatment scope, injected into prompts. */
  scopeNote: string;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, n));

/** Default per-episode runtime (minutes) when a series has no runtimes set yet. */
const DEFAULT_EPISODE_RUNTIME = 45;

export function resolveTreatmentScope(projectType?: string | null): TreatmentScope {
  if (projectType === "vertical_series") return "season";
  if (projectType === "series") return "episode";
  return "project";
}

function scopeNoteFor(scope: TreatmentScope): string {
  switch (scope) {
    case "season":
      return "Treat this as a SEASON treatment for a vertical micro-drama: cover the through-line and the episode-by-episode arc of a single season, fast and hook-driven, ending on a cliffhanger. Do NOT write a separate full treatment for every micro-episode.";
    case "episode":
      return "Treat this as a treatment for a SINGLE EPISODE of this series, not the whole series. Tell this episode's self-contained story while honoring the season's ongoing threads.";
    case "project":
    default:
      return "Treat this as a complete feature treatment covering the entire film from beginning to end.";
  }
}

/**
 * Compute page count and token budget for a generated document.
 * Treatment length is scope-aware; other document types keep their existing
 * runtime-based heuristics.
 */
export function computeDocumentSizing(input: DocumentSizingInput): DocumentSizing {
  const { documentType, projectType } = input;
  const duration = input.durationMinutes ?? 0;
  const scope = resolveTreatmentScope(projectType);
  const scopeNote = scopeNoteFor(scope);

  let estimatedPages: number;
  let tokensPerPage: number;

  switch (documentType) {
    case "treatment": {
      if (scope === "season") {
        // Vertical micro-drama: a season arc, not per-episode, not duration-scaled.
        // 3 pages baseline, nudged up slightly for longer seasons, capped at 5.
        const eps = input.seasonEpisodeCount ?? 0;
        estimatedPages = clamp(3 + Math.floor(eps / 30), 3, 5);
      } else if (scope === "episode") {
        // Series: one treatment per episode, sized to the episode runtime.
        // 30 min -> 4 pages, 45 min -> 5, 60 min -> 7.
        const epRuntime =
          input.episodeRuntime && input.episodeRuntime > 0
            ? input.episodeRuntime
            : DEFAULT_EPISODE_RUNTIME;
        estimatedPages = clamp(Math.round(epRuntime / 9), 4, 8);
      } else {
        // Feature film: 90 min -> ~11 pages, 120 min -> 15 pages.
        estimatedPages = duration > 0 ? clamp(Math.round(duration / 8), 8, 20) : 12;
      }
      tokensPerPage = 7000;
      break;
    }

    case "logline":
      return { estimatedPages: 1, maxTokens: 2000, scope, scopeNote };

    case "synopsis":
      estimatedPages = duration > 60 ? 2 : 1;
      tokensPerPage = 5000;
      break;

    case "character_breakdown":
      estimatedPages = duration > 60 ? 8 : 4;
      tokensPerPage = 5000;
      break;

    case "pitch_deck":
      estimatedPages = 5;
      tokensPerPage = 5000;
      break;

    default:
      estimatedPages = 3;
      tokensPerPage = 5000;
  }

  const maxTokens = clamp(estimatedPages * tokensPerPage, 8192, 100000);
  return { estimatedPages, maxTokens, scope, scopeNote };
}

/**
 * Fetch the episodic sizing signals (median episode runtime + episode count) for
 * a project. Returns an empty object for non-episodic projects or on error, so
 * sizing falls back to sensible defaults.
 */
export async function getEpisodicSizingContext(
  supabase: SupabaseClient,
  projectId: string,
  projectType: string | null | undefined
): Promise<{ episodeRuntime?: number; seasonEpisodeCount?: number }> {
  if (projectType !== "series" && projectType !== "vertical_series") return {};

  try {
    const { data: episodes } = await supabase
      .from("episodes")
      .select("runtime")
      .eq("project_id", projectId);

    const seasonEpisodeCount = episodes?.length ?? 0;
    const runtimes = (episodes || [])
      .map((e: { runtime: number | null }) => e.runtime)
      .filter((r): r is number => typeof r === "number" && r > 0)
      .sort((a, b) => a - b);

    const episodeRuntime = runtimes.length
      ? runtimes[Math.floor(runtimes.length / 2)] // median
      : undefined;

    return { episodeRuntime, seasonEpisodeCount };
  } catch {
    return {};
  }
}
