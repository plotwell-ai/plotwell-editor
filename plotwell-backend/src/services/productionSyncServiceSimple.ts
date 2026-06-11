/**
 * Simplified Production Sync Service (Supabase-based)
 *
 * Simple 1:1 sync between script scenes and production data
 * Script is the source of truth
 */

import { supabase } from '../config/database';
import { parseScriptFromProject } from './scriptParsingService';
import { generateSceneId, generateSceneContentHash, detectChanges } from './sceneIdentityService';

export interface ResolveChangesRequest {
  approvedScenes: string[];
  rejectedScenes: string[];
  deletedScenes: string[];
  strategy: 'replace' | 'merge';
}

export interface SyncResult {
  success: boolean;
  hasChanges: boolean;
  newScenes: number;
  updatedScenes: number;
  deletedScenes: number;
  message: string;
}

/**
 * Sync production scenes with script scenes (1:1 relationship)
 * Script is always the source of truth
 */
export async function syncProductionWithScript(
  projectId: string,
  userId: string,
  episodeId?: string
): Promise<SyncResult> {
  try {
    // 1. Get current script scenes (pass episodeId for TV series)
    const scriptData = await parseScriptFromProject(projectId, userId, undefined, episodeId);
    if (!scriptData || !scriptData.scenes || scriptData.scenes.length === 0) {
      // No script or no scenes - this is a valid state, not an error
      return {
        success: true,
        hasChanges: false,
        newScenes: 0,
        updatedScenes: 0,
        deletedScenes: 0,
        message: 'No script scenes to sync'
      };
    }

    const scriptScenes = scriptData.scenes;
    const scriptId = scriptData.scriptId;

    // 2. Get existing production scenes (optionally filtered by episode)
    let prodQuery = supabase
      .from('production_scene_data')
      .select('*')
      .eq('project_id', projectId)
      .neq('status', 'archived');

    if (episodeId) {
      prodQuery = prodQuery.eq('episode_id', episodeId);
    }

    const { data: productionScenes, error: prodError } = await prodQuery;

    if (prodError) {
      throw new Error(`Failed to fetch production scenes: ${prodError.message}`);
    }

    const existingScenes = productionScenes || [];

    // 3. Create a map of existing scenes by scene_number
    const existingMap = new Map();
    for (const scene of existingScenes) {
      existingMap.set(scene.scene_number, scene);
    }

    // 4. Get all existing scenes by scene_id (content hash) in ONE query for dedup
    const sceneIds = scriptScenes.map(s => generateSceneId(s));
    const { data: existingBySceneIds } = await supabase
      .from('production_scene_data')
      .select('id, scene_id')
      .eq('project_id', projectId)
      .in('scene_id', sceneIds);

    const existingBySceneIdMap = new Map<string, string>();
    for (const row of existingBySceneIds || []) {
      existingBySceneIdMap.set(row.scene_id, row.id);
    }

    const now = new Date().toISOString();
    const toInsert: any[] = [];
    const toUpdateBySceneId: { id: string; scene_number: number }[] = [];
    const toUpdateExistingIds: string[] = [];

    // 4b. Categorize each script scene into insert vs update
    for (const scriptScene of scriptScenes) {
      const sceneNumber = scriptScene.scene_number;
      const existing = existingMap.get(sceneNumber);

      if (!existing) {
        const sceneId = generateSceneId(scriptScene);
        const existingId = existingBySceneIdMap.get(sceneId);

        if (existingId) {
          // Scene with same content hash exists — batch update
          toUpdateBySceneId.push({ id: existingId, scene_number: sceneNumber });
        } else {
          // New scene — batch insert
          const insertData: any = {
            project_id: projectId,
            user_id: userId,
            script_id: scriptId,
            scene_number: sceneNumber,
            scene_id: sceneId,
            complexity: 'medium',
            estimated_shoot_days: 1,
            budget_estimate: 0,
            actual_budget: null,
            shots: [],
            production_notes: '',
            status: 'planning',
            script_content_hash: sceneId,
            last_synced_at: now,
            sync_status: 'synced'
          };
          if (episodeId) insertData.episode_id = episodeId;
          toInsert.push(insertData);
        }
      } else {
        // Scene exists by number — mark for batch timestamp update
        toUpdateExistingIds.push(existing.id);
        existingMap.delete(sceneNumber);
      }
    }

    // 5. Execute batched operations (3 queries max instead of N)
    let newCount = 0;
    let updatedCount = 0;

    // Batch upsert new scenes
    // First, delete existing production data for scene_numbers that will be re-assigned
    // (happens when scenes are inserted in the middle, shifting all subsequent scene numbers)
    if (toInsert.length > 0) {
      const insertSceneNumbers = toInsert.map((s: any) => s.scene_number);
      const { error: cleanupError } = await supabase
        .from('production_scene_data')
        .delete()
        .eq('project_id', projectId)
        .eq('script_id', scriptId)
        .in('scene_number', insertSceneNumbers);
      if (cleanupError) {
        console.error('Error cleaning up conflicting scene numbers:', cleanupError);
      }

      const { error: insertError } = await supabase
        .from('production_scene_data')
        .upsert(toInsert, { onConflict: 'project_id,scene_id', ignoreDuplicates: true });
      if (insertError) {
        console.error('Error batch inserting scenes:', insertError);
      } else {
        newCount = toInsert.length;
      }
    }

    // Batch update scenes matched by content hash
    if (toUpdateBySceneId.length > 0) {
      const updatePromises = toUpdateBySceneId.map(({ id, scene_number }) =>
        supabase
          .from('production_scene_data')
          .update({ scene_number, script_id: scriptId, last_synced_at: now, sync_status: 'synced', status: 'planning' })
          .eq('id', id)
      );
      await Promise.all(updatePromises);
      updatedCount += toUpdateBySceneId.length;
    }

    // Batch update existing scenes (timestamp only)
    if (toUpdateExistingIds.length > 0) {
      const { error: updateError } = await supabase
        .from('production_scene_data')
        .update({ last_synced_at: now, sync_status: 'synced' })
        .in('id', toUpdateExistingIds);
      if (updateError) {
        console.error('Error batch updating scenes:', updateError);
      } else {
        updatedCount += toUpdateExistingIds.length;
      }
    }

    // 6. Archive scenes no longer in script (single batch query)
    let deletedCount = 0;
    const toArchiveIds = Array.from(existingMap.values()).map((s: any) => s.id);
    if (toArchiveIds.length > 0) {
      const { error: archiveError } = await supabase
        .from('production_scene_data')
        .update({ status: 'archived', last_synced_at: now })
        .in('id', toArchiveIds);
      if (archiveError) {
        console.error('Error batch archiving scenes:', archiveError);
      } else {
        deletedCount = toArchiveIds.length;
      }
    }

    const hasChanges = newCount > 0 || deletedCount > 0;

    return {
      success: true,
      hasChanges,
      newScenes: newCount,
      updatedScenes: updatedCount,
      deletedScenes: deletedCount,
      message: `Synced: ${newCount} new, ${updatedCount} updated, ${deletedCount} archived`
    };

  } catch (error: any) {
    console.error('Sync error:', error);
    return {
      success: false,
      hasChanges: false,
      newScenes: 0,
      updatedScenes: 0,
      deletedScenes: 0,
      message: error.message || 'Sync failed'
    };
  }
}

/**
 * Get sync status (what would change if we synced)
 */
export async function getSyncStatus(
  projectId: string,
  userId: string,
  episodeId?: string
): Promise<{
  success: boolean;
  hasChanges: boolean;
  scriptSceneCount: number;
  productionSceneCount: number;
  newScenes: number;
  deletedScenes: number;
}> {
  try {
    // Get script scenes (pass episodeId for TV series)
    const scriptData = await parseScriptFromProject(projectId, userId, undefined, episodeId);
    const scriptScenes = scriptData?.scenes || [];

    // Get production scenes (optionally filtered by episode)
    let prodQuery = supabase
      .from('production_scene_data')
      .select('scene_number')
      .eq('project_id', projectId)
      .neq('status', 'archived');

    if (episodeId) {
      prodQuery = prodQuery.eq('episode_id', episodeId);
    }

    const { data: productionScenes, error } = await prodQuery;

    if (error) {
      console.error('Error fetching production scenes:', error);
    }

    const prodScenes = productionScenes || [];

    const scriptNumbers = new Set(scriptScenes.map(s => s.scene_number));
    const prodNumbers = new Set(prodScenes.map(s => s.scene_number));

    // Count differences
    const newScenes = scriptScenes.filter(s => !prodNumbers.has(s.scene_number)).length;
    const deletedScenes = prodScenes.filter(s => !scriptNumbers.has(s.scene_number)).length;

    return {
      success: true,
      hasChanges: newScenes > 0 || deletedScenes > 0,
      scriptSceneCount: scriptScenes.length,
      productionSceneCount: prodScenes.length,
      newScenes,
      deletedScenes
    };
  } catch (error: any) {
    console.error('Error getting sync status:', error);
    return {
      success: false,
      hasChanges: false,
      scriptSceneCount: 0,
      productionSceneCount: 0,
      newScenes: 0,
      deletedScenes: 0
    };
  }
}

/**
 * Lock a scene to prevent accidental changes
 */
export async function lockScene(sceneId: string): Promise<{ success: boolean; message: string }> {
  try {
    const { error } = await supabase
      .from('production_scene_data')
      .update({
        status: 'locked',
        locked_at: new Date().toISOString()
      })
      .eq('id', sceneId);

    if (error) throw error;

    return { success: true, message: 'Scene locked' };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

/**
 * Unlock a scene
 */
export async function unlockScene(sceneId: string): Promise<{ success: boolean; message: string }> {
  try {
    const { error } = await supabase
      .from('production_scene_data')
      .update({
        status: 'planning',
        locked_at: null
      })
      .eq('id', sceneId);

    if (error) throw error;

    return { success: true, message: 'Scene unlocked' };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

/**
 * Apply user decisions from change review modal.
 * Approves, rejects, or deletes production scenes based on user choices.
 */
export async function resolveChanges(
  projectId: string,
  userId: string,
  request: ResolveChangesRequest
): Promise<{ success: boolean; updated: number; deleted: number }> {
  try {
    let updated = 0;
    let deleted = 0;

    // Get script data
    const scriptData = await parseScriptFromProject(projectId, userId);
    if (!scriptData) {
      throw new Error('No script found for this project');
    }
    const scriptScenes = scriptData.scenes;
    const scriptId = scriptData.scriptId;

    // 1. Handle approved scenes - batch fetch, then parallel updates
    if (request.approvedScenes.length > 0) {
      const { data: approvedProdScenes } = await supabase
        .from('production_scene_data')
        .select('*')
        .in('id', request.approvedScenes);

      if (approvedProdScenes && approvedProdScenes.length > 0) {
        const now = new Date().toISOString();
        const updatePromises: PromiseLike<any>[] = [];
        const changeLogInserts: any[] = [];
        const reviewedSceneIds: string[] = [];

        for (const prodScene of approvedProdScenes) {
          const matchingScriptScene = scriptScenes.find(
            s => generateSceneId(s) === prodScene.scene_id
          );
          if (!matchingScriptScene) continue;

          const contentHash = generateSceneContentHash(matchingScriptScene);
          const sceneId = generateSceneId(matchingScriptScene);

          // Queue scene update
          updatePromises.push(
            supabase
              .from('production_scene_data')
              .update({
                scene_number: matchingScriptScene.scene_number,
                scene_id: sceneId,
                script_id: scriptId,
                script_content_hash: contentHash,
                last_synced_at: now,
                sync_status: 'synced'
              })
              .eq('id', prodScene.id)
              .then()
          );

          // Collect change log entries for batch insert
          const changes = detectChanges(matchingScriptScene, prodScene);
          const changeType = changes.scene_number ? 'renumbered'
            : changes.heading ? 'heading_changed'
            : changes.characters?.added?.length ? 'characters_added'
            : 'minor_update';

          changeLogInserts.push({
            project_id: projectId,
            scene_id: prodScene.scene_id,
            scene_number_old: changes.scene_number?.old || null,
            scene_number_new: changes.scene_number?.new || null,
            change_type: changeType,
            fields_changed: changes,
            script_version_after: contentHash,
            auto_synced: false
          });

          reviewedSceneIds.push(prodScene.scene_id as string);
          updated++;
        }

        // Execute all updates in parallel + batch insert change logs
        await Promise.all([
          ...updatePromises,
          changeLogInserts.length > 0
            ? supabase.from('scene_change_log').insert(changeLogInserts)
            : Promise.resolve(),
          reviewedSceneIds.length > 0
            ? supabase
                .from('scene_change_log')
                .update({ user_reviewed: true, reviewed_at: now, reviewed_by: userId })
                .eq('project_id', projectId)
                .in('scene_id', reviewedSceneIds)
                .eq('user_reviewed', false)
            : Promise.resolve()
        ]);
      }
    }

    // 2. Handle rejected scenes (mark as manually managed)
    if (request.rejectedScenes.length > 0) {
      await supabase
        .from('production_scene_data')
        .update({ sync_status: 'manual' })
        .in('id', request.rejectedScenes);
    }

    // 3. Handle deleted scenes (archive)
    if (request.deletedScenes.length > 0) {
      await supabase
        .from('production_scene_data')
        .update({ status: 'archived', sync_status: 'manual' })
        .in('id', request.deletedScenes);
      deleted = request.deletedScenes.length;
    }

    // 4. Update project sync status
    const { count } = await supabase
      .from('production_scene_data')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .neq('sync_status', 'synced');

    const newStatus = (count && count > 0) ? 'needs_review' : 'synced';
    await supabase
      .from('projects')
      .update({ scene_sync_status: newStatus, last_scene_sync_at: new Date().toISOString() })
      .eq('id', projectId);

    return { success: true, updated, deleted };

  } catch (error) {
    console.error('Error resolving changes:', error);
    throw error;
  }
}
