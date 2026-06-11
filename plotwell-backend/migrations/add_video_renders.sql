-- Scene/episode video reels (MEGA beta assembly).
--
-- A "render" stitches a scene's shot clips (or a whole episode's clips) into a
-- single vertical video via ffmpeg. Clips are already paid for, so rendering
-- consumes no credits — it only concatenates existing clips.
--
-- scope = 'scene'   → scene_id set, the reel for one scene
-- scope = 'episode' → scene_id NULL, the full episode reel
-- status lifecycle: 'processing' → 'completed' | 'failed'

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.video_renders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,
  scene_id VARCHAR(64),                 -- NULL for episode-level reels
  scope TEXT NOT NULL CHECK (scope IN ('scene', 'episode')),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  video_url TEXT,                       -- storage path in the generated-video bucket
  clip_count INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Look up renders for a project/episode quickly (the Product view lists them).
CREATE INDEX IF NOT EXISTS idx_video_renders_project_episode
  ON public.video_renders (project_id, episode_id);

-- Generated clips and stitched reels are stored as private Supabase Storage
-- objects. The backend signs URLs with the service role key before returning
-- them to the frontend.
INSERT INTO storage.buckets (id, name, public)
VALUES ('generated-video', 'generated-video', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "Allow authenticated users to upload generated video" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload generated video"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'generated-video'
  AND auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "Allow public access to generated video" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated read access to generated video" ON storage.objects;
CREATE POLICY "Allow authenticated read access to generated video"
ON storage.objects FOR SELECT
USING (bucket_id = 'generated-video' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to update their generated video" ON storage.objects;
CREATE POLICY "Allow users to update their generated video"
ON storage.objects FOR UPDATE
USING (bucket_id = 'generated-video' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to delete their generated video" ON storage.objects;
CREATE POLICY "Allow users to delete their generated video"
ON storage.objects FOR DELETE
USING (bucket_id = 'generated-video' AND auth.role() = 'authenticated');

-- Supabase/PostgREST can keep a stale schema cache briefly after new tables.
-- Reload it so backend inserts into video_renders are visible immediately.
NOTIFY pgrst, 'reload schema';
