import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import { extractStoragePath, BUCKETS } from "./storageService";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Configure multer for file uploads
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Extract file path from Supabase storage URL or return path as-is
function extractFilePathFromUrl(url: string, bucketName: string): string | null {
  if (!url) return null;
  // If it's already a plain path (not a URL), return it directly
  if (!url.startsWith('http')) return url;
  const path = extractStoragePath(url, bucketName);
  // If extractStoragePath returned the original URL (couldn't parse), return null
  if (path === url) return null;
  return path;
}

// Delete file from Supabase storage
export async function deleteCharacterImage(imageUrl: string): Promise<boolean> {
  if (!imageUrl) return true;
  
  
  const filePath = extractFilePathFromUrl(imageUrl, 'character-images');
  if (!filePath) {
    console.warn('Could not extract file path from URL, skipping deletion:', imageUrl);
    return false;
  }
  
  const { data, error } = await supabase.storage
    .from('character-images')
    .remove([filePath]);
  
  if (error) {
    console.error('Storage delete error:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
    // Don't throw error - we still want to update the database even if file deletion fails
    return false;
  }
  
  return true;
}

// Sanitize uploaded file names to prevent path traversal attacks
export function sanitizeFileName(originalName: string): string {
  // Extract extension from original name
  const ext = originalName.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  // Use only the extension, discard the original name entirely
  return `${Date.now()}.${ext}`;
}

export async function uploadCharacterImage(file: Express.Multer.File, characterId: string): Promise<string> {
  const fileName = `characters/${characterId}/${sanitizeFileName(file.originalname)}`;
  
  
  // Check if the bucket exists and get bucket details
  const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();
  
  if (bucketError) {
    console.error('Error listing buckets:', bucketError);
  }

  // Check if character-images bucket specifically exists
  const characterBucket = buckets?.find(b => b.name === 'character-images');
  if (!characterBucket) {
    console.error('ERROR: character-images bucket not found!');
    throw new Error('character-images storage bucket does not exist in Supabase');
  }

  // Try to list files in the bucket to test permissions
  const { data: listData, error: listError } = await supabase.storage
    .from('character-images')
    .list('characters', { limit: 1 });
  
  if (listError) {
    console.error('Bucket list error (permissions issue?):', listError);
  } else {
  }
  
  // Attempt upload
  const { data, error } = await supabase.storage
    .from('character-images')
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
      errorMessage += '\n1. The character-images bucket exists in Supabase Storage';
      errorMessage += '\n2. Storage policies are configured to allow uploads';
      errorMessage += '\n3. The service role key has the correct permissions';
    }
    
    throw new Error(errorMessage);
  }
  
  
  // Return the storage path (NOT a public URL)
  // Signed URLs are generated on read via storageService
  return fileName;
}