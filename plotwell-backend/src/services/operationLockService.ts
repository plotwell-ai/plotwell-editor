// Database-backed operation lock service
// Replaces in-memory Maps for idempotency, cooldowns, deduplication, and rate limiting
// Uses a single Supabase table with TTL-based cleanup

import { supabase } from '../config/database';

const TABLE = 'operation_locks';

/**
 * Try to acquire a lock. Returns true if acquired, false if already exists (not expired).
 */
export async function acquireLock(
  lockType: string,
  lockKey: string,
  ttlSeconds: number
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  // Delete expired lock first (if any)
  await supabase
    .from(TABLE)
    .delete()
    .eq('lock_type', lockType)
    .eq('lock_key', lockKey)
    .lt('expires_at', new Date().toISOString());

  // Try to insert — unique constraint on (lock_type, lock_key) prevents duplicates
  const { error } = await supabase
    .from(TABLE)
    .insert({
      lock_type: lockType,
      lock_key: lockKey,
      expires_at: expiresAt,
    });

  if (error) {
    // Duplicate key = lock already held
    if (error.code === '23505') return false;
    console.error('❌ acquireLock error:', error);
    // On unexpected error, allow the operation (fail-open for availability)
    return true;
  }

  return true;
}

/**
 * Release a lock before its TTL expires (e.g., when a request completes).
 */
export async function releaseLock(lockType: string, lockKey: string): Promise<void> {
  await supabase
    .from(TABLE)
    .delete()
    .eq('lock_type', lockType)
    .eq('lock_key', lockKey);
}

/**
 * Check if a lock exists (not expired). Does not acquire.
 */
export async function isLocked(lockType: string, lockKey: string): Promise<boolean> {
  const { data } = await supabase
    .from(TABLE)
    .select('id')
    .eq('lock_type', lockType)
    .eq('lock_key', lockKey)
    .gt('expires_at', new Date().toISOString())
    .limit(1);

  return (data?.length ?? 0) > 0;
}

/**
 * Store a result with a TTL (for idempotency — return cached result on duplicate).
 */
export async function acquireLockWithResult(
  lockType: string,
  lockKey: string,
  ttlSeconds: number,
  result: any
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  // Clean expired
  await supabase
    .from(TABLE)
    .delete()
    .eq('lock_type', lockType)
    .eq('lock_key', lockKey)
    .lt('expires_at', new Date().toISOString());

  const { error } = await supabase
    .from(TABLE)
    .insert({
      lock_type: lockType,
      lock_key: lockKey,
      expires_at: expiresAt,
      result_data: result,
    });

  if (error?.code === '23505') return false;
  if (error) {
    console.error('❌ acquireLockWithResult error:', error);
    return true;
  }
  return true;
}

/**
 * Get the cached result for an existing lock (idempotency).
 */
export async function getLockResult(lockType: string, lockKey: string): Promise<any | null> {
  const { data } = await supabase
    .from(TABLE)
    .select('result_data')
    .eq('lock_type', lockType)
    .eq('lock_key', lockKey)
    .gt('expires_at', new Date().toISOString())
    .single();

  return data?.result_data ?? null;
}

/**
 * Count active locks of a given type for a key prefix (for rate limiting).
 * E.g., count how many 'ai_chat_rate' locks exist for a userId in the current window.
 */
export async function countLocks(lockType: string, lockKeyPrefix: string): Promise<number> {
  const { count } = await supabase
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('lock_type', lockType)
    .like('lock_key', `${lockKeyPrefix}%`)
    .gt('expires_at', new Date().toISOString());

  return count ?? 0;
}

/**
 * Add a rate limit entry. Returns { allowed, count }.
 */
export async function checkRateLimit(
  lockType: string,
  userId: string,
  windowSeconds: number,
  maxRequests: number
): Promise<{ allowed: boolean; count: number }> {
  const now = Date.now();
  const lockKey = `${userId}:${now}`;
  const expiresAt = new Date(now + windowSeconds * 1000).toISOString();

  // Count existing entries in window
  const count = await countLocks(lockType, `${userId}:`);

  if (count >= maxRequests) {
    return { allowed: false, count };
  }

  // Add entry for this request
  await supabase
    .from(TABLE)
    .insert({
      lock_type: lockType,
      lock_key: lockKey,
      expires_at: expiresAt,
    });

  return { allowed: true, count: count + 1 };
}

/**
 * Cleanup all expired locks. Call periodically or via cron.
 */
export async function cleanupExpiredLocks(): Promise<number> {
  const { data } = await supabase
    .from(TABLE)
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('id');

  return data?.length ?? 0;
}
