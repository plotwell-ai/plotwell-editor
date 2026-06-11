import { createClient } from "@supabase/supabase-js";
import { extractStoragePath, BUCKETS } from "./storageService";
import { sanitizeFileName } from "./imageService";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Extract file path from Supabase storage URL or return path as-is
function extractFilePathFromUrl(url: string, bucketName: string): string | null {
  if (!url) return null;
  if (!url.startsWith('http')) return url;
  const path = extractStoragePath(url, bucketName);
  if (path === url) return null;
  return path;
}

// Delete file from Supabase storage
export async function deleteLocationImage(imageUrl: string): Promise<boolean> {
  if (!imageUrl) return true;

  const filePath = extractFilePathFromUrl(imageUrl, 'location-images');
  if (!filePath) {
    console.warn('Could not extract file path from URL, skipping deletion:', imageUrl);
    return false;
  }

  const { data, error } = await supabase.storage
    .from('location-images')
    .remove([filePath]);

  if (error) {
    console.error('Storage delete error:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
    // Don't throw error - we still want to update the database even if file deletion fails
    return false;
  }

  return true;
}

export async function uploadLocationImage(file: Express.Multer.File, locationId: string): Promise<string> {
  const fileName = `locations/${locationId}/${sanitizeFileName(file.originalname)}`;

  // Check if the bucket exists and get bucket details
  const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();

  if (bucketError) {
    console.error('Error listing buckets:', bucketError);
  }

  // Check if location-images bucket specifically exists
  const locationBucket = buckets?.find(b => b.name === 'location-images');
  if (!locationBucket) {
    console.error('ERROR: location-images bucket not found!');
    throw new Error('location-images storage bucket does not exist in Supabase');
  }

  // Try to list files in the bucket to test permissions
  const { data: listData, error: listError } = await supabase.storage
    .from('location-images')
    .list('locations', { limit: 1 });

  if (listError) {
    console.error('Bucket list error (permissions issue?):', listError);
  }

  // Attempt upload
  const { data, error } = await supabase.storage
    .from('location-images')
    .upload(fileName, file.buffer, {
      contentType: file.mimetype,
      upsert: true
    });

  if (error) {
    console.error('=== STORAGE UPLOAD ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error details:', JSON.stringify(error, null, 2));
    console.error('===========================');

    // Enhanced error message with troubleshooting info
    let errorMessage = `Upload failed: ${error.message}`;
    if (error.message?.includes('policies')) {
      errorMessage += '\n\nThis appears to be a Row Level Security (RLS) policy issue. Please check:';
      errorMessage += '\n1. The location-images bucket exists in Supabase Storage';
      errorMessage += '\n2. Storage policies are configured to allow uploads';
      errorMessage += '\n3. The service role key has the correct permissions';
    }

    throw new Error(errorMessage);
  }

  // Return the storage path (NOT a public URL)
  // Signed URLs are generated on read via storageService
  return fileName;
}
