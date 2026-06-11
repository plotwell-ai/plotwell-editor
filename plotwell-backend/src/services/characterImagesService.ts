import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const MAX_IMAGES_PER_CHARACTER = 3;

export interface CharacterImage {
  id: string;
  character_id: string;
  image_url: string;
  description?: string;
  image_type: 'portrait' | 'full_body' | 'action' | 'costume' | 'reference';
  is_primary: boolean;
  is_ai_generated: boolean;
  generation_metadata?: Record<string, unknown>;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCharacterImageData {
  character_id: string;
  image_url: string;
  description?: string;
  image_type?: CharacterImage['image_type'];
  is_primary?: boolean;
  is_ai_generated?: boolean;
  generation_metadata?: Record<string, unknown>;
}

export async function getCharacterImages(character_id: string) {
  return await supabase
    .from("character_images")
    .select("*")
    .eq("character_id", character_id)
    .order("position", { ascending: true });
}

export async function getCharacterImageById(id: string) {
  return await supabase
    .from("character_images")
    .select("*")
    .eq("id", id)
    .single();
}

export async function getPrimaryImage(character_id: string) {
  return await supabase
    .from("character_images")
    .select("*")
    .eq("character_id", character_id)
    .eq("is_primary", true)
    .single();
}

export async function getImageCount(character_id: string): Promise<number> {
  const { count, error } = await supabase
    .from("character_images")
    .select("*", { count: 'exact', head: true })
    .eq("character_id", character_id);

  if (error) {
    console.error('Error getting image count:', error);
    return 0;
  }
  return count || 0;
}

export async function createCharacterImage(data: CreateCharacterImageData) {
  // Check if character already has max images
  let currentCount = await getImageCount(data.character_id);
  if (currentCount >= MAX_IMAGES_PER_CHARACTER) {
    // Replace the oldest non-primary image to make room for the new one
    const { data: existingImages } = await supabase
      .from("character_images")
      .select("id, is_primary, position, image_url")
      .eq("character_id", data.character_id)
      .order("position", { ascending: false }); // Oldest last by position, newest first

    if (existingImages && existingImages.length > 0) {
      // Prefer replacing non-primary images; fall back to oldest image
      const imageToReplace = existingImages.find(img => !img.is_primary) || existingImages[existingImages.length - 1];

      // Delete the old image from storage
      if (imageToReplace.image_url) {
        try {
          await supabase.storage
            .from('character-images')
            .remove([imageToReplace.image_url]);
        } catch (storageErr) {
          console.warn('⚠️ Failed to delete old image from storage:', storageErr);
        }
      }

      // Delete the record
      await supabase
        .from("character_images")
        .delete()
        .eq("id", imageToReplace.id);

      currentCount = await getImageCount(data.character_id);
    }
  }

  // Get next available position
  const position = currentCount;

  // If this is the first image, make it primary
  const is_primary = currentCount === 0 ? true : (data.is_primary ?? false);

  // If setting as primary, unset any existing primary
  if (is_primary && currentCount > 0) {
    await supabase
      .from("character_images")
      .update({ is_primary: false })
      .eq("character_id", data.character_id)
      .eq("is_primary", true);
  }

  return await supabase
    .from("character_images")
    .insert([{
      character_id: data.character_id,
      image_url: data.image_url,
      description: data.description,
      image_type: data.image_type || 'portrait',
      is_primary,
      is_ai_generated: data.is_ai_generated ?? false,
      generation_metadata: data.generation_metadata || {},
      position
    }])
    .select()
    .single();
}

export async function updateCharacterImage(id: string, updates: Partial<CharacterImage>) {
  // Remove fields that shouldn't be updated
  const { id: _id, character_id: _cid, created_at: _cat, ...validUpdates } = updates as Record<string, unknown>;

  // If setting as primary, unset any existing primary for this character
  if (validUpdates.is_primary) {
    // First get the character_id for this image
    const { data: image } = await getCharacterImageById(id);
    if (image) {
      await supabase
        .from("character_images")
        .update({ is_primary: false })
        .eq("character_id", image.character_id)
        .eq("is_primary", true)
        .neq("id", id);
    }
  }

  return await supabase
    .from("character_images")
    .update({ ...validUpdates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
}

export async function setPrimaryImage(id: string) {
  // Get the character_id for this image
  const { data: image, error: fetchError } = await getCharacterImageById(id);
  if (fetchError || !image) {
    return { data: null, error: fetchError || { message: 'Image not found' } };
  }

  // Unset any existing primary for this character
  await supabase
    .from("character_images")
    .update({ is_primary: false })
    .eq("character_id", image.character_id)
    .eq("is_primary", true);

  // Set this image as primary
  const result = await supabase
    .from("character_images")
    .update({ is_primary: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  // Sync legacy image_url on the character record
  if (result.data) {
    await supabase
      .from("characters")
      .update({ image_url: result.data.image_url })
      .eq("id", image.character_id);
  }

  return result;
}

export async function deleteCharacterImage(id: string) {
  // Get image details before deletion (for returning and potential cleanup)
  const { data: image } = await getCharacterImageById(id);

  const { error } = await supabase
    .from("character_images")
    .delete()
    .eq("id", id);

  if (error) {
    return { data: null, error };
  }

  // If this was the primary image, set the first remaining image as primary and update character
  if (image?.is_primary && image.character_id) {
    const { data: remainingImages } = await supabase
      .from("character_images")
      .select("id, image_url")
      .eq("character_id", image.character_id)
      .order("position", { ascending: true })
      .limit(1);

    if (remainingImages && remainingImages.length > 0) {
      // Set new primary image
      await supabase
        .from("character_images")
        .update({ is_primary: true })
        .eq("id", remainingImages[0].id);

      // Update character's main image_url to the new primary
      await supabase
        .from("characters")
        .update({ image_url: remainingImages[0].image_url })
        .eq("id", image.character_id);
    } else {
      // No remaining images - clear character's image_url
      await supabase
        .from("characters")
        .update({ image_url: null })
        .eq("id", image.character_id);
    }
  }

  // Reorder remaining images to fill the gap
  if (image) {
    const { data: remainingImages } = await supabase
      .from("character_images")
      .select("id, position")
      .eq("character_id", image.character_id)
      .order("position", { ascending: true });

    if (remainingImages) {
      for (let i = 0; i < remainingImages.length; i++) {
        if (remainingImages[i].position !== i) {
          await supabase
            .from("character_images")
            .update({ position: i })
            .eq("id", remainingImages[i].id);
        }
      }
    }
  }

  return { data: image, error: null };
}

export async function reorderImages(character_id: string, imageIds: string[]) {
  // Validate that we're not exceeding max images
  if (imageIds.length > MAX_IMAGES_PER_CHARACTER) {
    return { error: { message: `Cannot have more than ${MAX_IMAGES_PER_CHARACTER} images` } };
  }

  // Update each image's position
  const updates = imageIds.map((id, index) =>
    supabase
      .from("character_images")
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("character_id", character_id)
  );

  await Promise.all(updates);

  return await getCharacterImages(character_id);
}
