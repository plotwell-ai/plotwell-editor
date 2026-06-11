import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const MAX_IMAGES_PER_LOCATION = 3;

export interface LocationImage {
  id: string;
  location_id: string;
  image_url: string;
  description?: string;
  image_type: 'exterior' | 'interior' | 'aerial' | 'detail' | 'reference';
  is_primary: boolean;
  is_ai_generated: boolean;
  generation_metadata?: Record<string, unknown>;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CreateLocationImageData {
  location_id: string;
  image_url: string;
  description?: string;
  image_type?: LocationImage['image_type'];
  is_primary?: boolean;
  is_ai_generated?: boolean;
  generation_metadata?: Record<string, unknown>;
}

export async function getLocationImages(location_id: string) {
  return await supabase
    .from("location_images")
    .select("*")
    .eq("location_id", location_id)
    .order("position", { ascending: true });
}

export async function getLocationImageById(id: string) {
  return await supabase
    .from("location_images")
    .select("*")
    .eq("id", id)
    .single();
}

export async function getPrimaryImage(location_id: string) {
  return await supabase
    .from("location_images")
    .select("*")
    .eq("location_id", location_id)
    .eq("is_primary", true)
    .single();
}

export async function getImageCount(location_id: string): Promise<number> {
  const { count, error } = await supabase
    .from("location_images")
    .select("*", { count: 'exact', head: true })
    .eq("location_id", location_id);

  if (error) {
    console.error('Error getting location image count:', error);
    return 0;
  }
  return count || 0;
}

export async function createLocationImage(data: CreateLocationImageData) {
  let currentCount = await getImageCount(data.location_id);
  if (currentCount >= MAX_IMAGES_PER_LOCATION) {
    const { data: existingImages } = await supabase
      .from("location_images")
      .select("id, is_primary, position, image_url")
      .eq("location_id", data.location_id)
      .order("position", { ascending: false });

    if (existingImages && existingImages.length > 0) {
      const imageToReplace = existingImages.find(img => !img.is_primary) || existingImages[existingImages.length - 1];

      if (imageToReplace.image_url) {
        try {
          await supabase.storage
            .from('location-images')
            .remove([imageToReplace.image_url]);
        } catch (storageErr) {
          console.warn('⚠️ Failed to delete old location image from storage:', storageErr);
        }
      }

      await supabase
        .from("location_images")
        .delete()
        .eq("id", imageToReplace.id);

      currentCount = await getImageCount(data.location_id);
    }
  }

  const position = currentCount;
  const is_primary = currentCount === 0 ? true : (data.is_primary ?? false);

  if (is_primary && currentCount > 0) {
    await supabase
      .from("location_images")
      .update({ is_primary: false })
      .eq("location_id", data.location_id)
      .eq("is_primary", true);
  }

  return await supabase
    .from("location_images")
    .insert([{
      location_id: data.location_id,
      image_url: data.image_url,
      description: data.description,
      image_type: data.image_type || 'exterior',
      is_primary,
      is_ai_generated: data.is_ai_generated ?? false,
      generation_metadata: data.generation_metadata || {},
      position
    }])
    .select()
    .single();
}

export async function updateLocationImage(id: string, updates: Partial<LocationImage>) {
  const { id: _id, location_id: _lid, created_at: _cat, ...validUpdates } = updates as Record<string, unknown>;

  if (validUpdates.is_primary) {
    const { data: image } = await getLocationImageById(id);
    if (image) {
      await supabase
        .from("location_images")
        .update({ is_primary: false })
        .eq("location_id", image.location_id)
        .eq("is_primary", true)
        .neq("id", id);
    }
  }

  return await supabase
    .from("location_images")
    .update({ ...validUpdates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
}

export async function setPrimaryImage(id: string) {
  const { data: image, error: fetchError } = await getLocationImageById(id);
  if (fetchError || !image) {
    return { data: null, error: fetchError || { message: 'Image not found' } };
  }

  await supabase
    .from("location_images")
    .update({ is_primary: false })
    .eq("location_id", image.location_id)
    .eq("is_primary", true);

  const result = await supabase
    .from("location_images")
    .update({ is_primary: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  // Sync legacy image_url on the location record
  if (result.data) {
    await supabase
      .from("locations")
      .update({ image_url: result.data.image_url })
      .eq("id", image.location_id);
  }

  return result;
}

export async function deleteLocationImage(id: string) {
  const { data: image } = await getLocationImageById(id);

  const { error } = await supabase
    .from("location_images")
    .delete()
    .eq("id", id);

  if (error) {
    return { data: null, error };
  }

  if (image?.is_primary && image.location_id) {
    const { data: remainingImages } = await supabase
      .from("location_images")
      .select("id, image_url")
      .eq("location_id", image.location_id)
      .order("position", { ascending: true })
      .limit(1);

    if (remainingImages && remainingImages.length > 0) {
      await supabase
        .from("location_images")
        .update({ is_primary: true })
        .eq("id", remainingImages[0].id);

      await supabase
        .from("locations")
        .update({ image_url: remainingImages[0].image_url })
        .eq("id", image.location_id);
    } else {
      await supabase
        .from("locations")
        .update({ image_url: null })
        .eq("id", image.location_id);
    }
  }

  if (image) {
    const { data: remainingImages } = await supabase
      .from("location_images")
      .select("id, position")
      .eq("location_id", image.location_id)
      .order("position", { ascending: true });

    if (remainingImages) {
      for (let i = 0; i < remainingImages.length; i++) {
        if (remainingImages[i].position !== i) {
          await supabase
            .from("location_images")
            .update({ position: i })
            .eq("id", remainingImages[i].id);
        }
      }
    }
  }

  return { data: image, error: null };
}

export async function reorderImages(location_id: string, imageIds: string[]) {
  if (imageIds.length > MAX_IMAGES_PER_LOCATION) {
    return { error: { message: `Cannot have more than ${MAX_IMAGES_PER_LOCATION} images` } };
  }

  const updates = imageIds.map((id, index) =>
    supabase
      .from("location_images")
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("location_id", location_id)
  );

  await Promise.all(updates);

  return await getLocationImages(location_id);
}
