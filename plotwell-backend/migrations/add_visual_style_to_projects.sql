-- Project-level visual style for AI image/video generation.
--
-- Controls the rendering look of generated storyboard panels (and downstream
-- character/location/video generation): a photorealistic cinematic look vs a
-- 3D-animated feature-film look. Picked once per project; the per-image
-- generation modal can still override it for a single shot.
--
-- The image pipeline (buildStoryboardImagePrompt / buildVisualStyleAnchor) already
-- understands these values — this column is what finally feeds them.
--
-- Values (project visual-style palette): 'cinematic' | '3d-animation' | 'anime' |
-- 'noir' | 'watercolor' | 'comic' | 'concept-art' | 'stop-motion' | 'storybook' |
-- 'oil-painting' | 'retro-film' | 'cyberpunk'.
-- Defaults to 'cinematic' so existing projects keep their photorealistic behaviour.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS visual_style TEXT NOT NULL DEFAULT 'cinematic';

ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_visual_style_check;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_visual_style_check
  CHECK (visual_style IN (
    'cinematic', '3d-animation', 'anime', 'noir', 'watercolor', 'comic',
    'concept-art', 'stop-motion', 'storybook', 'oil-painting', 'retro-film', 'cyberpunk'
  ));
