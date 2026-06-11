/**
 * Project Visual Style
 *
 * Single backend source of truth for a project's render look. Every image
 * pipeline (storyboard, character, location) resolves the effective style from
 * here so generation stays consistent even for flows that don't go through the
 * frontend modal. A per-request override still wins when provided.
 */
import { SupabaseClient } from '@supabase/supabase-js';
import { resolveVisualStyleId, type VisualStyleId } from '../prompts';

/** Fetch and normalize a project's saved visual style (defaults to 'cinematic'). */
export async function getProjectVisualStyle(
  supabase: SupabaseClient,
  projectId?: string | null
): Promise<VisualStyleId> {
  if (!projectId) return 'cinematic';
  const { data } = await supabase
    .from('projects')
    .select('visual_style')
    .eq('id', projectId)
    .single();
  return resolveVisualStyleId(data?.visual_style || undefined);
}

/**
 * Resolve the effective style for an image request: an explicit per-request
 * override wins, otherwise the project's saved style.
 */
export async function resolveEffectiveVisualStyle(
  supabase: SupabaseClient,
  projectId?: string | null,
  override?: string | null
): Promise<VisualStyleId> {
  if (override) return resolveVisualStyleId(override);
  return getProjectVisualStyle(supabase, projectId);
}
