-- MEGA beta: AI video generation from storyboard panels (shots).
--
-- Each storyboard panel is a shot. This adds the columns needed to animate a
-- panel's still image into a short video clip via the OpenRouter video API
-- (x-ai/grok-imagine-video, image-to-video).
--
-- Generation is asynchronous: we submit the job, store the provider job id, and
-- poll until it completes. Credits (10 per second) are consumed only once the
-- clip actually completes, so failed/cancelled jobs cost nothing.
--
-- video_status lifecycle: NULL → 'processing' → 'completed' | 'failed'

ALTER TABLE public.storyboard_panels
  ADD COLUMN IF NOT EXISTS video_url        TEXT,    -- storage path in generated-video bucket
  ADD COLUMN IF NOT EXISTS video_status     TEXT,    -- NULL | processing | completed | failed
  ADD COLUMN IF NOT EXISTS video_job_id     TEXT,    -- OpenRouter video generation job id
  ADD COLUMN IF NOT EXISTS video_duration   INTEGER, -- clip length in seconds
  ADD COLUMN IF NOT EXISTS video_model      TEXT,    -- provider model slug used
  ADD COLUMN IF NOT EXISTS video_error      TEXT,    -- last failure message, if any
  ADD COLUMN IF NOT EXISTS video_created_at TIMESTAMPTZ;

ALTER TABLE public.storyboard_panels
  DROP CONSTRAINT IF EXISTS storyboard_panels_video_status_check;

ALTER TABLE public.storyboard_panels
  ADD CONSTRAINT storyboard_panels_video_status_check
  CHECK (video_status IS NULL OR video_status IN ('processing', 'completed', 'failed'));

-- Lets the status poller find in-flight jobs quickly.
CREATE INDEX IF NOT EXISTS idx_storyboard_panels_video_job
  ON public.storyboard_panels (video_job_id)
  WHERE video_job_id IS NOT NULL;
