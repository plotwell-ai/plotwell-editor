-- Structured visual identity used by character/location image generation.
-- Narrative role, personality, story importance, and mood remain in their
-- existing fields and must not be stored in these profiles.

ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS visual_profile JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS visual_profile JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.characters.visual_profile IS
  'Stable visual identity: body, face, styling, and distinctive_features.';

COMMENT ON COLUMN public.locations.visual_profile IS
  'Stable visual identity: structure, surfaces, lighting, and distinctive_features.';
