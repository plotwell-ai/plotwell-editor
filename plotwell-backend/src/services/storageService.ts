/**
 * Storage Service - Centralized Supabase Storage utilities
 *
 * Handles signed URL generation for private buckets.
 * All buckets should be set to PRIVATE in Supabase Dashboard.
 *
 * Storage pattern:
 * - Upload → store file PATH in database (not full URL)
 * - Read → resolve paths to signed URLs before returning to frontend
 * - AI references → resolve paths to signed URLs for model access
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Default signed URL expiry: 1 hour
const DEFAULT_EXPIRY_SECONDS = 3600;

// Bucket names used across the app
export const BUCKETS = {
  CHARACTER_IMAGES: 'character-images',
  LOCATION_IMAGES: 'location-images',
  STORYBOARD_IMAGES: 'storyboard-images',
  PRESENTATION_IMAGES: 'presentation-images',
  PROJECT_ASSETS: 'project-assets',
  GENERATED_VIDEO: 'generated-video',
} as const;

export type BucketName = typeof BUCKETS[keyof typeof BUCKETS];

/**
 * Extract the storage path from a value that could be:
 * - A full public URL: https://xyz.supabase.co/storage/v1/object/public/bucket/path
 * - A signed URL: https://xyz.supabase.co/storage/v1/object/sign/bucket/path?token=...
 * - Already a plain path: path/to/file.png
 *
 * Returns the plain path suitable for createSignedUrl().
 */
export function extractStoragePath(value: string, bucket: string): string {
  if (!value) return value;

  // Already a plain path (doesn't start with http)
  if (!value.startsWith('http')) return value;

  try {
    const url = new URL(value);
    const pathname = url.pathname;
    // Find bucket name in path (e.g., /storage/v1/object/public/character-images/characters/abc/img.png)
    const bucketSegment = `/${bucket}/`;
    const bucketIndex = pathname.indexOf(bucketSegment);
    if (bucketIndex === -1) return value; // Can't parse, return as-is
    return pathname.substring(bucketIndex + bucketSegment.length);
  } catch {
    return value;
  }
}

/**
 * Detect which bucket a stored URL belongs to.
 * Returns null if it can't be determined.
 */
export function detectBucket(value: string): BucketName | null {
  if (!value) return null;
  for (const bucket of Object.values(BUCKETS)) {
    if (value.includes(`/${bucket}/`) || value.startsWith(`${bucket}/`)) {
      return bucket;
    }
  }
  return null;
}

/**
 * Generate a signed URL for a single file.
 * Handles both plain paths and existing URLs (extracts path first).
 */
export async function getSignedUrl(
  bucket: BucketName,
  pathOrUrl: string,
  expiresIn: number = DEFAULT_EXPIRY_SECONDS
): Promise<string> {
  if (!pathOrUrl) return pathOrUrl;

  const path = extractStoragePath(pathOrUrl, bucket);

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);

  if (error) {
    console.error(`❌ Failed to create signed URL for ${bucket}/${path}:`, error.message);
    return pathOrUrl; // Fallback to original value
  }

  return data.signedUrl;
}

/**
 * Generate signed URLs for multiple files in the same bucket (batch).
 * More efficient than calling getSignedUrl() in a loop.
 */
export async function getSignedUrls(
  bucket: BucketName,
  pathsOrUrls: string[],
  expiresIn: number = DEFAULT_EXPIRY_SECONDS
): Promise<string[]> {
  if (!pathsOrUrls.length) return [];

  const paths = pathsOrUrls.map(p => extractStoragePath(p, bucket));

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrls(paths, expiresIn);

  if (error) {
    console.error(`❌ Failed to create signed URLs for ${bucket}:`, error.message);
    return pathsOrUrls; // Fallback to originals
  }

  return data.map((item, i) => item.signedUrl || pathsOrUrls[i]);
}

/**
 * Field-to-bucket mapping for resolveImageUrls
 */
interface FieldMapping {
  field: string;
  bucket: BucketName;
}

/**
 * Transform records' image fields from stored paths/URLs to signed URLs.
 * Works with arrays of records. Handles nested fields with dot notation (e.g., "character_images.image_url").
 *
 * @example
 * const characters = await resolveImageUrls(data, [
 *   { field: 'image_url', bucket: BUCKETS.CHARACTER_IMAGES }
 * ]);
 */
export async function resolveImageUrls<T extends Record<string, any>>(
  records: T[],
  mappings: FieldMapping[]
): Promise<T[]> {
  if (!records.length || !mappings.length) return records;

  // Collect all paths grouped by bucket
  const byBucket = new Map<BucketName, { recordIdx: number; field: string; path: string }[]>();

  for (let i = 0; i < records.length; i++) {
    for (const { field, bucket } of mappings) {
      const value = getNestedValue(records[i], field);
      if (value && typeof value === 'string') {
        if (!byBucket.has(bucket)) byBucket.set(bucket, []);
        byBucket.get(bucket)!.push({ recordIdx: i, field, path: value });
      }
    }
  }

  if (byBucket.size === 0) return records;

  // Clone records for mutation
  const result = records.map(r => ({ ...r }));

  // Batch sign per bucket
  for (const [bucket, items] of byBucket) {
    const paths = items.map(item => extractStoragePath(item.path, bucket));

    const { data: signedData, error } = await supabase.storage
      .from(bucket)
      .createSignedUrls(paths, DEFAULT_EXPIRY_SECONDS);

    if (error) {
      console.error(`❌ Batch signed URL error for ${bucket}:`, error.message);
      continue;
    }

    for (let j = 0; j < items.length; j++) {
      if (signedData?.[j]?.signedUrl) {
        setNestedValue(result[items[j].recordIdx], items[j].field, signedData[j].signedUrl);
      }
    }
  }

  return result;
}

/**
 * Resolve image URLs for nested arrays within records.
 * E.g., characters with character_images[] sub-arrays.
 */
export async function resolveNestedImageUrls<T extends Record<string, any>>(
  records: T[],
  nestedField: string,
  mappings: FieldMapping[]
): Promise<T[]> {
  if (!records.length) return records;

  const result = records.map(r => ({ ...r }));

  for (let i = 0; i < result.length; i++) {
    const nested = result[i][nestedField];
    if (Array.isArray(nested) && nested.length > 0) {
      result[i] = { ...result[i], [nestedField]: await resolveImageUrls(nested, mappings) };
    }
  }

  return result;
}

/**
 * Upload a file and return the storage path (NOT a URL).
 */
export async function uploadAndGetPath(
  bucket: BucketName,
  path: string,
  buffer: Buffer,
  options?: { contentType?: string; upsert?: boolean }
): Promise<string> {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, {
      contentType: options?.contentType || 'image/png',
      upsert: options?.upsert ?? true
    });

  if (error) {
    throw new Error(`Upload failed to ${bucket}/${path}: ${error.message}`);
  }

  return path; // Return path, not URL
}

/**
 * Delete a file from storage.
 * Accepts either a path or a full URL (extracts path automatically).
 */
export async function deleteFile(bucket: BucketName, pathOrUrl: string): Promise<boolean> {
  if (!pathOrUrl) return true;

  const path = extractStoragePath(pathOrUrl, bucket);

  const { error } = await supabase.storage
    .from(bucket)
    .remove([path]);

  if (error) {
    console.error(`❌ Failed to delete ${bucket}/${path}:`, error.message);
    return false;
  }

  return true;
}

// --- Helpers ---

function getNestedValue(obj: Record<string, any>, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, any>, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) return;
    // Clone nested objects to avoid mutating the original
    current[parts[i]] = { ...current[parts[i]] };
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}
