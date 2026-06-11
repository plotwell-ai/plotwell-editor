import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const MAX_ELEMENTS_PER_CHARACTER = 3;

export type ElementType = 'costume' | 'prop' | 'accessory' | 'makeup' | 'hairstyle' | 'other';

export interface CharacterElement {
  id: string;
  character_id: string;
  name: string;
  element_type: ElementType;
  description?: string;
  reference_image_url?: string;
  is_active: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CreateCharacterElementData {
  character_id: string;
  name: string;
  element_type: ElementType;
  description?: string;
  reference_image_url?: string;
  is_active?: boolean;
}

export interface UpdateCharacterElementData {
  name?: string;
  element_type?: ElementType;
  description?: string;
  reference_image_url?: string | null;
  is_active?: boolean;
  position?: number;
}

export async function getCharacterElements(character_id: string) {
  return await supabase
    .from("character_elements")
    .select("*")
    .eq("character_id", character_id)
    .order("position", { ascending: true });
}

export async function getActiveElements(character_id: string) {
  return await supabase
    .from("character_elements")
    .select("*")
    .eq("character_id", character_id)
    .eq("is_active", true)
    .order("position", { ascending: true });
}

export async function getCharacterElementById(id: string) {
  return await supabase
    .from("character_elements")
    .select("*")
    .eq("id", id)
    .single();
}

export async function getElementCount(character_id: string): Promise<number> {
  const { count, error } = await supabase
    .from("character_elements")
    .select("*", { count: 'exact', head: true })
    .eq("character_id", character_id);

  if (error) {
    console.error('Error getting element count:', error);
    return 0;
  }
  return count || 0;
}

export async function createCharacterElement(data: CreateCharacterElementData) {
  // Check if character already has max elements
  const currentCount = await getElementCount(data.character_id);
  if (currentCount >= MAX_ELEMENTS_PER_CHARACTER) {
    return {
      data: null,
      error: { message: `Character already has ${MAX_ELEMENTS_PER_CHARACTER} elements (maximum allowed)` }
    };
  }

  // Get next available position
  const position = currentCount;

  return await supabase
    .from("character_elements")
    .insert([{
      character_id: data.character_id,
      name: data.name,
      element_type: data.element_type,
      description: data.description,
      reference_image_url: data.reference_image_url,
      is_active: data.is_active ?? true,
      position
    }])
    .select()
    .single();
}

export async function updateCharacterElement(id: string, updates: UpdateCharacterElementData) {
  // Handle explicit null for reference_image_url (to remove reference image)
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString()
  };

  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.element_type !== undefined) updateData.element_type = updates.element_type;
  if (updates.description !== undefined) updateData.description = updates.description;
  if (updates.is_active !== undefined) updateData.is_active = updates.is_active;
  if (updates.position !== undefined) updateData.position = updates.position;

  // Allow setting reference_image_url to null to remove it
  if ('reference_image_url' in updates) {
    updateData.reference_image_url = updates.reference_image_url;
  }

  return await supabase
    .from("character_elements")
    .update(updateData)
    .eq("id", id)
    .select()
    .single();
}

export async function deleteCharacterElement(id: string) {
  // Get element details before deletion (for cleanup and reordering)
  const { data: element } = await getCharacterElementById(id);

  const { error } = await supabase
    .from("character_elements")
    .delete()
    .eq("id", id);

  if (error) {
    return { data: null, error };
  }

  // Reorder remaining elements to fill the gap
  if (element) {
    const { data: remainingElements } = await supabase
      .from("character_elements")
      .select("id, position")
      .eq("character_id", element.character_id)
      .order("position", { ascending: true });

    if (remainingElements) {
      for (let i = 0; i < remainingElements.length; i++) {
        if (remainingElements[i].position !== i) {
          await supabase
            .from("character_elements")
            .update({ position: i })
            .eq("id", remainingElements[i].id);
        }
      }
    }
  }

  return { data: element, error: null };
}

export async function toggleElementActive(id: string) {
  const { data: element, error: fetchError } = await getCharacterElementById(id);
  if (fetchError || !element) {
    return { data: null, error: fetchError || { message: 'Element not found' } };
  }

  return await supabase
    .from("character_elements")
    .update({ is_active: !element.is_active, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
}

export async function reorderElements(character_id: string, elementIds: string[]) {
  // Validate that we're not exceeding max elements
  if (elementIds.length > MAX_ELEMENTS_PER_CHARACTER) {
    return { error: { message: `Cannot have more than ${MAX_ELEMENTS_PER_CHARACTER} elements` } };
  }

  // Update each element's position
  const updates = elementIds.map((id, index) =>
    supabase
      .from("character_elements")
      .update({ position: index, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("character_id", character_id)
  );

  await Promise.all(updates);

  return await getCharacterElements(character_id);
}

export async function getElementsByIds(elementIds: string[]) {
  if (elementIds.length === 0) {
    return { data: [], error: null };
  }

  return await supabase
    .from("character_elements")
    .select("*")
    .in("id", elementIds);
}
