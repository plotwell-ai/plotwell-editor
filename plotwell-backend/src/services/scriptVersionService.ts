import { SupabaseClient } from '@supabase/supabase-js';

interface CreateScriptVersionOptions {
  scriptId: string;
  userId?: string | null;
  changeSummary?: string;
  title?: string;
  content?: any;
  skipIfUnchanged?: boolean;
}

function isUniqueViolation(error: any): boolean {
  return error?.code === '23505' || String(error?.message || '').toLowerCase().includes('duplicate key');
}

async function createScriptVersionDirect(
  supabase: SupabaseClient,
  { scriptId, userId, changeSummary = 'Auto-save', title, content, skipIfUnchanged = false }: CreateScriptVersionOptions
): Promise<number> {
  let snapshotContent = content;
  let snapshotTitle = title;

  if (snapshotContent === undefined || snapshotTitle === undefined) {
    const { data: script, error } = await supabase
      .from('scripts')
      .select('content, title')
      .eq('id', scriptId)
      .single();

    if (error || !script) throw new Error(error?.message || 'Script not found');
    snapshotContent = snapshotContent ?? script.content;
    snapshotTitle = snapshotTitle ?? script.title;
  }

  snapshotTitle = snapshotTitle || 'Script';

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: lastVersion, error: versionError } = await supabase
      .from('script_versions')
      .select('version_number, content')
      .eq('script_id', scriptId)
      .order('version_number', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (versionError) throw new Error(versionError.message);

    if (
      skipIfUnchanged &&
      lastVersion &&
      JSON.stringify(lastVersion.content) === JSON.stringify(snapshotContent)
    ) {
      return lastVersion.version_number;
    }

    const nextVersion = (lastVersion?.version_number || 0) + 1;
    const { error: insertError } = await supabase
      .from('script_versions')
      .insert({
        script_id: scriptId,
        version_number: nextVersion,
        title: snapshotTitle,
        content: snapshotContent,
        change_summary: changeSummary,
        created_by: userId || null,
      });

    if (!insertError) return nextVersion;
    if (!isUniqueViolation(insertError) || attempt === 2) {
      throw new Error(insertError.message || 'Failed to create script version');
    }
  }

  throw new Error('Failed to create script version');
}

export async function createScriptVersionSnapshot(
  supabase: SupabaseClient,
  options: CreateScriptVersionOptions
): Promise<number> {
  const rpcParams: Record<string, any> = {
    p_script_id: options.scriptId,
    p_user_id: options.userId || null,
    p_change_summary: options.changeSummary || 'Auto-save',
  };

  if (options.skipIfUnchanged) {
    rpcParams.p_skip_if_unchanged = true;
  }

  const { data, error } = await supabase.rpc('create_script_version_snapshot', {
    ...rpcParams,
  });

  if (!error && typeof data === 'number') {
    return data;
  }

  // Older databases may not have the RPC yet. Fall back to direct insert with
  // retry so local/dev installs still work until the schema is applied.
  return createScriptVersionDirect(supabase, options);
}
