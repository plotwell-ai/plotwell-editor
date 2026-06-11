-- Allow image generation usage tracking for OpenRouter-backed image models.
--
-- The backend image model router can generate images via OpenRouter, and
-- aiUsageTracker records that provider in image_usage_events.service_provider.
-- Existing databases need the check constraint updated to accept that value.

ALTER TABLE public.image_usage_events
  DROP CONSTRAINT IF EXISTS image_usage_events_service_provider_check;

ALTER TABLE public.image_usage_events
  ADD CONSTRAINT image_usage_events_service_provider_check
  CHECK (service_provider IN ('replicate', 'openai', 'stability_ai', 'openrouter'));
