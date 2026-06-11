import { createClient } from "@supabase/supabase-js";
import { canonicalizeCharacterName } from "../utils/characterIdentity";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function getCharacters(project_id: string, sortBy?: string, sortOrder?: 'asc' | 'desc') {
  let query = supabase
    .from("characters")
    .select("*")
    .eq("project_id", project_id);

  // Apply custom sorting if provided
  if (sortBy) {
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });
  } else {
    // Default: sort by importance_level (5=main protagonist first), then alphabetically by name
    // importance_level: 1=background, 2=minor, 3=supporting, 4=major, 5=main protagonist
    query = query
      .order("importance_level", { ascending: false })  // 5 first (most important)
      .order("name", { ascending: true });
  }

  return await query;
}

/**
 * Get characters with image/element counts in a SINGLE query.
 * This avoids the N+1 problem where we previously made 2 queries per character.
 *
 * Uses Supabase's ability to select related data with aggregation.
 */
export async function getCharactersWithCounts(
  project_id: string,
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
  filters?: { scope?: string; episodeId?: string; seasonId?: string }
) {
  let query = supabase
    .from("characters")
    .select(`
      *,
      character_images(id, is_primary, image_url),
      character_elements(id)
    `)
    .eq("project_id", project_id);

  // Scope filtering for series projects
  if (filters?.scope) {
    query = query.eq("scope", filters.scope);
  }
  if (filters?.episodeId) {
    query = query.eq("episode_id", filters.episodeId);
  }
  if (filters?.seasonId) {
    query = query.eq("season_id", filters.seasonId);
  }

  // Apply custom sorting if provided
  if (sortBy) {
    query = query.order(sortBy, { ascending: sortOrder === 'asc' });
  } else {
    // Default: sort by importance_level (5=main protagonist first), then alphabetically by name
    query = query
      .order("importance_level", { ascending: false })
      .order("name", { ascending: true });
  }

  const { data, error } = await query;

  if (error) {
    return { data: null, error };
  }

  // Transform the nested data into the flat format the frontend expects
  const transformedData = (data || []).map((char: any) => {
    const images = char.character_images || [];
    const elements = char.character_elements || [];
    const primaryImage = images.find((img: any) => img.is_primary);

    // Remove the nested arrays from the response
    const { character_images, character_elements, ...characterData } = char;

    return {
      ...characterData,
      // Override image_url with primary image from character_images if exists
      image_url: primaryImage?.image_url || char.image_url,
      images_count: images.length,
      elements_count: elements.length,
      has_primary_image: !!primaryImage
    };
  });

  return { data: transformedData, error: null };
}

export async function getCharacterById(id: string) {
  return await supabase
    .from("characters")
    .select("*")
    .eq("id", id)
    .single();
}

export async function createCharacter(characterData: any) {
  const {
    name,
    description,
    project_id,
    character_type,
    primary_role,
    importance_level,
    status,
    story_arc,
    motivations,
    fears,
    goals
  } = characterData;

  return await supabase
    .from("characters")
    .insert([{
      name: canonicalizeCharacterName(name),
      description,
      project_id,
      character_type,
      primary_role,
      importance_level,
      status,
      story_arc,
      motivations,
      fears,
      goals
    }])
    .select()
    .single();
}

export async function updateCharacter(id: string, updates: any) {
  // Convert name to uppercase if present in updates
  const updatesToApply = {
    ...updates,
    ...(updates.name && { name: canonicalizeCharacterName(updates.name) })
  };

  return await supabase
    .from("characters")
    .update(updatesToApply)
    .eq("id", id)
    .select()
    .single();
}

export async function deleteCharacter(id: string) {
  return await supabase
    .from("characters")
    .delete()
    .eq("id", id);
}
