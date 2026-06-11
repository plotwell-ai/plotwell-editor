import * as charactersService from "../services/charactersService";
import * as imageService from "../services/imageService";
import { Request, Response } from "express";
import { resolveImageUrls, getSignedUrl, BUCKETS } from "../services/storageService";
import {
  canonicalizeCharacterName,
  getCharacterIdentityKey,
} from "../utils/characterIdentity";

export async function getAll(req: Request, res: Response) {
  const { project_id, sort_by, sort_order, scope, episode_id, season_id } = req.query;
  if (!project_id) return res.status(400).json({ error: "Missing project_id" });

  // Use optimized single-query function that includes image/element counts
  // This replaces the N+1 pattern that was making 2 queries per character
  const { data, error } = await charactersService.getCharactersWithCounts(
    project_id as string,
    sort_by as string | undefined,
    sort_order as 'asc' | 'desc' | undefined,
    {
      scope: scope as string | undefined,
      episodeId: episode_id as string | undefined,
      seasonId: season_id as string | undefined,
    }
  );

  if (error) return res.status(500).json({ error: error.message });

  // Resolve storage paths to signed URLs
  const resolved = await resolveImageUrls(data || [], [
    { field: 'image_url', bucket: BUCKETS.CHARACTER_IMAGES }
  ]);
  res.json(resolved);
}

export async function create(req: Request, res: Response) {
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
  } = req.body;
  
  if (!name || !project_id) return res.status(400).json({ error: "Missing name or project_id" });
  const canonicalName = canonicalizeCharacterName(name);
  if (!canonicalName) return res.status(400).json({ error: "Invalid character name" });

  const { data: existingCharacters, error: existingError } = await charactersService.getCharacters(project_id);
  if (existingError) return res.status(500).json({ error: existingError.message });
  const requestedKey = getCharacterIdentityKey(canonicalName);
  const existingCharacter = (existingCharacters || []).find(
    (character: any) => getCharacterIdentityKey(character.name) === requestedKey
  );
  if (existingCharacter) {
    return res.json({ ...existingCharacter, reused_existing: true });
  }
  
  const characterData = {
    name: canonicalName,
    description,
    project_id,
    character_type: character_type || 'minor',
    primary_role: primary_role || '',
    importance_level: importance_level || 3,
    status: status || 'active',
    story_arc,
    motivations,
    fears,
    goals
  };
  
  const { data, error } = await charactersService.createCharacter(characterData);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
}

export async function update(req: Request, res: Response) {
  const { id } = req.params;
  const { 
    name, 
    description, 
    image_url,
    character_type,
    primary_role,
    importance_level,
    status,
    story_arc,
    motivations,
    fears,
    goals
  } = req.body;
  
  
  if (!name) return res.status(400).json({ error: "Missing name" });
  const canonicalName = canonicalizeCharacterName(name);
  if (!canonicalName) return res.status(400).json({ error: "Invalid character name" });

  const { data: currentCharacter, error: currentError } = await charactersService.getCharacterById(id);
  if (currentError || !currentCharacter) {
    return res.status(404).json({ error: currentError?.message || "Character not found" });
  }

  const { data: projectCharacters, error: charactersError } =
    await charactersService.getCharacters(currentCharacter.project_id);
  if (charactersError) return res.status(500).json({ error: charactersError.message });

  const requestedKey = getCharacterIdentityKey(canonicalName);
  const duplicate = (projectCharacters || []).find(
    (character: any) =>
      character.id !== id && getCharacterIdentityKey(character.name) === requestedKey
  );
  if (duplicate) {
    return res.status(409).json({
      error: "A matching character already exists",
      existing_character_id: duplicate.id,
    });
  }

  // If we're removing the image (image_url is explicitly null), delete the old file first
  if ("image_url" in req.body && image_url === null) {
    
    // Get the current character to see if there's an existing image to delete
    const { data: currentChar, error: fetchError } = await charactersService.getCharacterById(id);
    if (fetchError) {
      console.error('Error fetching current character:', fetchError.message);
      return res.status(500).json({ error: fetchError.message });
    }
    
    if (currentChar && currentChar.image_url) {
      await imageService.deleteCharacterImage(currentChar.image_url);
    }
  }

  const updates: any = { 
    name: canonicalName,
    description,
    character_type,
    primary_role,
    importance_level,
    status,
    story_arc,
    motivations,
    fears,
    goals
  };
  
  // Include image_url even if it's null (to remove the image)
  if ("image_url" in req.body) {
    updates.image_url = image_url;
  } else {
  }

  // Remove undefined values to avoid overwriting with null
  Object.keys(updates).forEach(key => {
    if (updates[key] === undefined) {
      delete updates[key];
    }
  });


  const { data, error } = await charactersService.updateCharacter(id, updates);
  if (error) {
    console.error('Database update error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  
  res.json(data);
}

export async function remove(req: Request, res: Response) {
  const { id } = req.params;
  
  
  // First, get the character to check if it has an image that needs to be deleted
  const { data: character, error: fetchError } = await charactersService.getCharacterById(id);
  if (fetchError) {
    console.error('Error fetching character for deletion:', fetchError.message);
    return res.status(500).json({ error: fetchError.message });
  }
  
  if (character && character.image_url) {
    await imageService.deleteCharacterImage(character.image_url);
  } else {
  }
  
  // Now delete the character from database
  const { error } = await charactersService.deleteCharacter(id);
  if (error) {
    console.error('Database delete error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  
  res.json({ success: true });
}

export async function uploadImage(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const file = req.file;
    
    
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    
    
    // Before uploading new image, check if character has existing image to delete
    const { data: currentChar, error: fetchError } = await charactersService.getCharacterById(id);
    if (fetchError) {
      console.error('Error fetching current character:', fetchError.message);
      return res.status(500).json({ error: fetchError.message });
    }
    
    if (currentChar && currentChar.image_url) {
      await imageService.deleteCharacterImage(currentChar.image_url);
    }
    
    // Upload returns storage path (not URL)
    const storagePath = await imageService.uploadCharacterImage(file, id);

    const { data, error } = await charactersService.updateCharacter(id, { image_url: storagePath });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Resolve the path to a signed URL for immediate response
    if (data && data.image_url) {
      data.image_url = await getSignedUrl(BUCKETS.CHARACTER_IMAGES, data.image_url);
    }

    res.json(data);
  } catch (error) {
    console.error('Upload image error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
}
