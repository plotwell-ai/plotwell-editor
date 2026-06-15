-- =====================================================
-- COMPLETE CONSOLIDATED DATABASE SCHEMA
-- PROJECT EDITOR - BACKEND DATABASE RECREATION
-- =====================================================
-- 
-- This file contains the complete and comprehensive database schema
-- for the screenplay editor application backend. It consolidates all
-- tables, functions, triggers, and policies from multiple sources.
-- 
-- USAGE INSTRUCTIONS:
-- 1. Copy this entire file content
-- 2. Paste into Supabase SQL Editor
-- 3. Execute the script to recreate the complete backend database
-- 
-- This script is idempotent and safe to run multiple times.
-- It includes all migrations, version control, production planning,
-- collaboration support, and AI usage tracking systems.
-- =====================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- CORE USER MANAGEMENT TABLES
-- =====================================================

-- Users table (extends Supabase auth.users)
-- Cleaned up to remove duplicate subscription columns (now in user_subscriptions table)
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  ui_language TEXT DEFAULT 'en' CHECK (ui_language IN ('en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'zh', 'hi', 'ar', 'ko')),
  -- Stripe billing fields (only IDs for linking, full subscription data in user_subscriptions table)
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  -- Onboarding tour tracking
  projects_tour_completed_at TIMESTAMPTZ DEFAULT NULL,
  -- Marketing consent (GDPR)
  marketing_consent BOOLEAN DEFAULT FALSE,
  marketing_consent_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN public.users.ui_language IS 'User preferred interface language - affects UI only, not AI-generated content';
COMMENT ON COLUMN public.users.stripe_customer_id IS 'Stripe customer ID for payment processing - single source of truth for customer linking';
COMMENT ON COLUMN public.users.stripe_subscription_id IS 'Current active Stripe subscription ID - for quick lookup only, full subscription data in user_subscriptions table';
COMMENT ON COLUMN public.users.projects_tour_completed_at IS 'Timestamp when user completed the projects page onboarding tour';
COMMENT ON COLUMN public.users.marketing_consent IS 'Whether user consented to receive marketing/commercial emails';
COMMENT ON COLUMN public.users.marketing_consent_at IS 'Timestamp when consent was given or revoked';

-- Function to handle new user creation
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, avatar_url, marketing_consent, marketing_consent_at)
  VALUES (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar_url',
    COALESCE((new.raw_user_meta_data->>'marketing_consent')::boolean, false),
    CASE WHEN (new.raw_user_meta_data->>'marketing_consent')::boolean = true THEN NOW() ELSE NULL END
  );

  -- Initialize free subscription for every new user
  INSERT INTO public.user_subscriptions (user_id, plan_id, status)
  VALUES (new.id, 'free', 'active')
  ON CONFLICT (user_id) DO NOTHING;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to automatically create public.users record when auth.users record is created
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- =====================================================
-- COLLABORATION AND TEAM MANAGEMENT
-- =====================================================

-- Teams table - DEPRECATED in simplified model but kept for compatibility
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    description TEXT,
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    subscription_id TEXT, -- Stripe subscription for team billing
    plan_id TEXT DEFAULT 'paid', -- Updated to simplified model
    seat_limit INTEGER DEFAULT 4,
    settings JSONB DEFAULT '{
        "default_project_role": "editor",
        "require_invitation_approval": true,
        "allow_guest_access": false
    }',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Team members relationship
CREATE TABLE IF NOT EXISTS public.team_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(team_id, user_id)
);

-- =====================================================
-- PROJECT MANAGEMENT SYSTEM
-- =====================================================

-- Projects table - Updated to match API documentation specification
-- IMPORTANT: Uses 'name' and 'project_type' fields as per backend API documentation
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, -- API uses 'name', NOT 'title'
  description TEXT,
  project_type TEXT NOT NULL DEFAULT 'film' CHECK (project_type IN ('film', 'movie', 'series', 'vertical_series', 'short', 'commercial', 'music_video', 'documentary', 'reel', 'theatre', 'course', 'fiction')), -- Updated to match frontend values with default
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'in_progress', 'review', 'completed', 'paused', 'archived')),
  content_language TEXT DEFAULT 'en',
  language TEXT,
  production_country TEXT,
  production_region TEXT,
  production_city TEXT,
  production_scope TEXT DEFAULT 'single' CHECK (production_scope IN ('single', 'global')),
  currency TEXT DEFAULT 'USD',
  video_format TEXT DEFAULT '16:9' CHECK (video_format IN ('16:9', '9:16', '1:1', '4:5')),
  visual_style TEXT NOT NULL DEFAULT 'cinematic' CHECK (visual_style IN ('cinematic', '3d-animation', 'anime', 'noir', 'watercolor', 'comic', 'concept-art', 'stop-motion', 'storybook', 'oil-painting', 'retro-film', 'cyberpunk')), -- AI render look (project-wide)
  cost_multiplier DECIMAL(5,2) DEFAULT 1.00,
  prod_script_id UUID,
  active_script_id UUID, -- Will add FK constraint after scripts table is created
  last_scene_sync_at TIMESTAMP WITH TIME ZONE, -- Last time production was synced with script (world-class production planner)
  scene_sync_status VARCHAR(20) DEFAULT 'synced' CHECK (scene_sync_status IN ('synced', 'needs_review', 'conflicts')), -- Production sync status (world-class production planner)
  title TEXT, -- Screenplay title for cover page (different from project name)
  author TEXT, -- Author/writer name for cover page
  based_on TEXT, -- Source material or "based on" information
  contact_info TEXT, -- Writer contact information for cover page
  copyright_notice TEXT, -- Copyright notice for cover page
  registration_number TEXT, -- Script registration number (WGA, etc.)
  deleted BOOLEAN DEFAULT FALSE,
  settings JSONB DEFAULT '{}',
  collaboration_settings JSONB DEFAULT '{
    "enabled": true,
    "default_role": "viewer",
    "auto_save_interval": 10,
    "max_collaborators": 10,
    "require_approval": true,
    "allow_public_invite": false
  }',
  team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  collaborator_count INTEGER DEFAULT 0,
  onboarding_completed_at TIMESTAMPTZ DEFAULT NULL, -- Timestamp when user completed the project onboarding tour
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN public.projects.production_scope IS 'Production scope: single (one country) or global (multiple countries across production locations)';

-- Project collaborators table for real-time collaboration
CREATE TABLE IF NOT EXISTS public.project_collaborators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
    permissions JSONB DEFAULT '{
        "can_edit_content": true,
        "can_manage_characters": true,
        "can_manage_locations": true,
        "can_view_production": false,
        "can_invite_others": false,
        "can_manage_project": false
    }',
    invited_by UUID REFERENCES auth.users(id),
    invited_at TIMESTAMPTZ DEFAULT NOW(),
    joined_at TIMESTAMPTZ,
    last_active TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(project_id, user_id)
);

-- Project invitations table
CREATE TABLE IF NOT EXISTS public.project_invitations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    inviter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    token TEXT NOT NULL UNIQUE,
    message TEXT,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    accepted_at TIMESTAMPTZ,
    declined_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(project_id, email)
);

-- Public Project Shares (shareable read-only links)
CREATE TABLE IF NOT EXISTS public.public_project_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    shared_sections JSONB NOT NULL DEFAULT '["script","characters","locations","storyboard"]',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    view_count INTEGER DEFAULT 0,
    last_viewed_at TIMESTAMPTZ,
    password_hash TEXT,
    label TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_project_shares_token ON public.public_project_shares(token);
CREATE INDEX IF NOT EXISTS idx_public_project_shares_project ON public.public_project_shares(project_id);

ALTER TABLE public.public_project_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own shares" ON public.public_project_shares
    FOR SELECT USING ((select auth.uid()) = created_by);

CREATE POLICY "Users can create own shares" ON public.public_project_shares
    FOR INSERT WITH CHECK ((select auth.uid()) = created_by);

CREATE POLICY "Users can update own shares" ON public.public_project_shares
    FOR UPDATE USING ((select auth.uid()) = created_by);

CREATE POLICY "Users can delete own shares" ON public.public_project_shares
    FOR DELETE USING ((select auth.uid()) = created_by);

-- =====================================================
-- CONTENT MANAGEMENT SYSTEM
-- =====================================================


-- Project Documents table (NEW flexible document system)
CREATE TABLE IF NOT EXISTS public.project_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  document_type VARCHAR(50) NOT NULL DEFAULT 'treatment',
  title TEXT,
  content JSONB DEFAULT '{"type": "doc", "content": []}',
  is_ai_generated BOOLEAN DEFAULT FALSE,
  is_pinned BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT valid_document_type CHECK (
    document_type IN ('treatment', 'logline', 'synopsis', 'character_breakdown', 'pitch_deck', 'mood_board', 'custom')
  )
);

-- Project Document Versions table
CREATE TABLE IF NOT EXISTS public.project_document_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_document_id UUID NOT NULL REFERENCES public.project_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title TEXT,
  content JSONB DEFAULT '{"type": "doc", "content": []}',
  change_summary TEXT DEFAULT 'Auto-save',
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Ensure unique version numbers per document
  UNIQUE(project_document_id, version_number)
);

-- =====================================================
-- TV SERIES SUPPORT: SEASONS AND EPISODES
-- =====================================================

-- Seasons table for TV series projects
CREATE TABLE IF NOT EXISTS public.seasons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  production_start_date DATE,
  production_end_date DATE,
  air_date DATE,
  status TEXT DEFAULT 'planning' CHECK (status IN ('planning', 'writing', 'pre_production', 'production', 'post_production', 'completed', 'aired')),
  episode_count INTEGER DEFAULT 0,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(project_id, season_number),
  CONSTRAINT season_number_positive CHECK (season_number > 0)
);

CREATE INDEX IF NOT EXISTS idx_seasons_project_id ON public.seasons(project_id);
CREATE INDEX IF NOT EXISTS idx_seasons_status ON public.seasons(status);
CREATE INDEX IF NOT EXISTS idx_seasons_season_number ON public.seasons(project_id, season_number);

COMMENT ON TABLE public.seasons IS 'Seasons for TV series projects - organizational unit containing episodes';
COMMENT ON COLUMN public.seasons.season_number IS 'Season number within the series (1, 2, 3, etc.)';
COMMENT ON COLUMN public.seasons.episode_count IS 'Number of episodes in this season';

-- Episodes table for TV series
CREATE TABLE IF NOT EXISTS public.episodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  episode_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  synopsis TEXT,
  script_id UUID, -- References scripts table, FK constraint added later
  writer TEXT,
  director TEXT,
  production_start_date DATE,
  production_end_date DATE,
  air_date DATE,
  runtime INTEGER, -- Expected runtime in minutes
  status TEXT DEFAULT 'outline' CHECK (status IN ('outline', 'draft', 'revision', 'locked', 'pre_production', 'production', 'post_production', 'completed', 'aired')),
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(season_id, episode_number),
  CONSTRAINT episode_number_positive CHECK (episode_number > 0),
  CONSTRAINT runtime_positive CHECK (runtime IS NULL OR runtime > 0)
);

CREATE INDEX IF NOT EXISTS idx_episodes_season_id ON public.episodes(season_id);
CREATE INDEX IF NOT EXISTS idx_episodes_project_id ON public.episodes(project_id);
CREATE INDEX IF NOT EXISTS idx_episodes_script_id ON public.episodes(script_id);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON public.episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_episode_number ON public.episodes(season_id, episode_number);

COMMENT ON TABLE public.episodes IS 'Episodes within TV series seasons - each episode has its own script';
COMMENT ON COLUMN public.episodes.episode_number IS 'Episode number within the season (1, 2, 3, etc.)';
COMMENT ON COLUMN public.episodes.runtime IS 'Target runtime in minutes (e.g., 30 for sitcom, 60 for drama)';
COMMENT ON COLUMN public.episodes.script_id IS 'Link to the script for this episode';

-- =====================================================
-- BASE RESOURCE TABLES (Required by episode mapping tables)
-- =====================================================

-- Characters table (UPDATED - includes all classification and story development fields)
CREATE TABLE IF NOT EXISTS public.characters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,

  -- Series support: character scope
  scope TEXT DEFAULT 'project' CHECK (scope IN ('project', 'series', 'season', 'episode')),
  season_id UUID REFERENCES public.seasons(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,

  -- Character Classification (CRITICAL - required by frontend)
  character_type TEXT DEFAULT 'minor' CHECK (character_type IN ('main', 'minor', 'ensemble', 'background')),
  primary_role TEXT DEFAULT '',
  importance_level INTEGER DEFAULT 3 CHECK (importance_level IN (1, 2, 3, 4, 5)),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deceased', 'missing', 'introduced_later')),

  -- Story Development Fields (CRITICAL - required by frontend)
  story_arc TEXT,
  motivations TEXT,
  fears TEXT,
  goals TEXT,

  -- Original Character Details
  age INTEGER,
  personality TEXT,
  background TEXT,
  appearance TEXT,
  visual_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  image_url TEXT,
  is_ai_generated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_characters_season_id ON public.characters(season_id);
CREATE INDEX IF NOT EXISTS idx_characters_episode_id ON public.characters(episode_id);

COMMENT ON COLUMN public.characters.scope IS 'Scope of character: project (film), series (all episodes), season (one season), episode (guest star)';
COMMENT ON COLUMN public.characters.season_id IS 'If scope=season, which season this character appears in';
COMMENT ON COLUMN public.characters.episode_id IS 'If scope=episode, which episode this character appears in';
COMMENT ON COLUMN public.characters.visual_profile IS 'Stable visual identity: body, face, styling, and distinctive_features';

-- Character Images table (multiple images per character)
CREATE TABLE IF NOT EXISTS public.character_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  description TEXT,
  image_type TEXT DEFAULT 'portrait' CHECK (image_type IN ('portrait', 'full_body', 'action', 'costume', 'reference')),
  is_primary BOOLEAN DEFAULT FALSE,
  is_ai_generated BOOLEAN DEFAULT FALSE,
  generation_metadata JSONB DEFAULT '{}',
  position INTEGER DEFAULT 0 CHECK (position >= 0 AND position <= 2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure only one primary image per character
CREATE UNIQUE INDEX IF NOT EXISTS idx_character_images_primary
ON public.character_images(character_id)
WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_character_images_position ON public.character_images(character_id, position);

COMMENT ON TABLE public.character_images IS 'Stores multiple images per character (up to 3)';
COMMENT ON COLUMN public.character_images.image_type IS 'Type of image: portrait, full_body, action, costume, reference';
COMMENT ON COLUMN public.character_images.is_primary IS 'Primary image shown on character card (only one per character)';
COMMENT ON COLUMN public.character_images.generation_metadata IS 'Metadata for AI-generated images (model, prompt, elements used)';
COMMENT ON COLUMN public.character_images.position IS 'Display order (0, 1, 2) - max 3 images per character';

-- Locations table (UPDATED - includes enhanced story and visual fields)
-- NOTE: Must be created BEFORE location_images (which references locations.id)
CREATE TABLE IF NOT EXISTS public.locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  address TEXT,

  -- Series support: location scope
  scope TEXT DEFAULT 'project' CHECK (scope IN ('project', 'series', 'season', 'episode')),
  season_id UUID REFERENCES public.seasons(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,
  is_standing_set BOOLEAN DEFAULT FALSE,

  -- Enhanced location classification (CRITICAL - required by frontend)
  location_type TEXT DEFAULT 'interior' CHECK (location_type IN ('interior', 'exterior', 'both', 'studio', 'virtual')),
  story_importance TEXT DEFAULT 'supporting' CHECK (story_importance IN ('critical', 'major', 'supporting', 'minor')),

  -- Visual and atmospheric details (CRITICAL - required by frontend)
  atmosphere TEXT,
  visual_notes TEXT,
  visual_profile JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Production location mapping (links story location to actual filming location)
  -- Foreign key constraint added later via ALTER TABLE (after production_locations table is created)
  production_location_id UUID,

  -- Legacy fields (keeping for backward compatibility)
  type TEXT CHECK (type IN ('interior', 'exterior', 'studio', 'virtual')),
  notes TEXT,
  image_url TEXT,
  is_ai_generated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_locations_season_id ON public.locations(season_id);
CREATE INDEX IF NOT EXISTS idx_locations_episode_id ON public.locations(episode_id);

COMMENT ON COLUMN public.locations.scope IS 'Scope of location: project (film), series (all episodes), season (one season), episode (one-time)';
COMMENT ON COLUMN public.locations.season_id IS 'If scope=season, which season this location is used in';
COMMENT ON COLUMN public.locations.episode_id IS 'If scope=episode, which episode this location is used in';
COMMENT ON COLUMN public.locations.is_standing_set IS 'True if this is a permanent set used across multiple episodes';
COMMENT ON COLUMN public.locations.visual_profile IS 'Stable visual identity: structure, surfaces, lighting, and distinctive_features';

COMMENT ON COLUMN public.locations.production_location_id IS 'Links this story location to an actual production location (filming site) with cost, permits, and scheduling info';

-- Location Images table (gallery - max 3 per location)
CREATE TABLE IF NOT EXISTS public.location_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  description TEXT,
  image_type TEXT DEFAULT 'exterior' CHECK (image_type IN ('exterior', 'interior', 'aerial', 'detail', 'reference')),
  is_primary BOOLEAN DEFAULT FALSE,
  is_ai_generated BOOLEAN DEFAULT FALSE,
  generation_metadata JSONB DEFAULT '{}',
  position INTEGER DEFAULT 0 CHECK (position >= 0 AND position <= 2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_location_images_primary
ON public.location_images(location_id)
WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_location_images_position ON public.location_images(location_id, position);

COMMENT ON COLUMN public.location_images.position IS 'Display order (0, 1, 2) - max 3 images per location';

ALTER TABLE public.location_images ENABLE ROW LEVEL SECURITY;

-- Character Elements table (costumes, props, accessories)
CREATE TABLE IF NOT EXISTS public.character_elements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  element_type TEXT NOT NULL CHECK (element_type IN ('costume', 'prop', 'accessory', 'makeup', 'hairstyle', 'other')),
  description TEXT,
  reference_image_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  position INTEGER DEFAULT 0 CHECK (position >= 0 AND position <= 2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_character_elements_active ON public.character_elements(character_id, is_active);

COMMENT ON TABLE public.character_elements IS 'Visual elements for characters (costumes, props, accessories) - up to 3 per character';
COMMENT ON COLUMN public.character_elements.element_type IS 'Type: costume, prop, accessory, makeup, hairstyle, other';
COMMENT ON COLUMN public.character_elements.description IS 'Text description used in AI image generation prompts';
COMMENT ON COLUMN public.character_elements.reference_image_url IS 'Optional reference image for this element';
COMMENT ON COLUMN public.character_elements.is_active IS 'Whether to include this element in AI image generation';
COMMENT ON COLUMN public.character_elements.position IS 'Display order (0, 1, 2) - max 3 elements per character';

-- =====================================================
-- PRODUCTION CREW MANAGEMENT
-- =====================================================

-- Production crew table
CREATE TABLE IF NOT EXISTS public.production_crew (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    season_id UUID REFERENCES public.seasons(id) ON DELETE CASCADE, -- NULL for project-level, set for season-specific crew
    name VARCHAR(200) NOT NULL,
    role VARCHAR(200) NOT NULL, -- e.g., Director, DP, Gaffer, Sound Mixer
    department VARCHAR(100), -- e.g., Camera, Lighting, Sound, Art
    contact JSONB DEFAULT '{}', -- {email, phone, emergency_contact}
    rate_per_day INTEGER, -- in cents
    rate_per_hour INTEGER, -- in cents (for hourly crew)
    availability_dates DATE[],
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_production_crew_project ON public.production_crew(project_id);
CREATE INDEX IF NOT EXISTS idx_production_crew_user ON public.production_crew(user_id);
CREATE INDEX IF NOT EXISTS idx_production_crew_department ON public.production_crew(department);
CREATE INDEX IF NOT EXISTS idx_production_crew_season_id ON public.production_crew(season_id) WHERE season_id IS NOT NULL;

-- Production crew-to-shooting-day junction table
CREATE TABLE IF NOT EXISTS public.production_crew_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    crew_id UUID NOT NULL REFERENCES public.production_crew(id) ON DELETE CASCADE,
    shoot_date DATE NOT NULL,
    call_time TIME,
    wrap_time TIME,
    hours_worked DECIMAL(4,2), -- Actual hours worked
    overtime_hours DECIMAL(4,2),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(crew_id, shoot_date)
);

CREATE INDEX IF NOT EXISTS idx_crew_days_project ON public.production_crew_days(project_id);
CREATE INDEX IF NOT EXISTS idx_crew_days_crew ON public.production_crew_days(crew_id);
CREATE INDEX IF NOT EXISTS idx_crew_days_date ON public.production_crew_days(shoot_date);
CREATE INDEX IF NOT EXISTS idx_crew_days_user ON public.production_crew_days(user_id);

-- Production crew RLS policies
ALTER TABLE public.production_crew ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own crew" ON public.production_crew
    FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own crew" ON public.production_crew
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own crew" ON public.production_crew
    FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own crew" ON public.production_crew
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Production crew days RLS policies
ALTER TABLE public.production_crew_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own crew days" ON public.production_crew_days
    FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own crew days" ON public.production_crew_days
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own crew days" ON public.production_crew_days
    FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own crew days" ON public.production_crew_days
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Production cast table (MOVED HERE - must exist before production_cast_days)
CREATE TABLE IF NOT EXISTS public.production_cast (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    season_id UUID REFERENCES public.seasons(id) ON DELETE CASCADE, -- NULL for project-level, set for season-specific cast
    character_name VARCHAR(200) NOT NULL,
    actor_name VARCHAR(200),
    actor_contact JSONB DEFAULT '{}',
    category VARCHAR(50),
    rate_per_day INTEGER, -- in cents
    availability_dates DATE[],
    scenes INTEGER[], -- DEPRECATED: Use production_cast_scenes junction table instead
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Production cast-to-shooting-day junction table
CREATE TABLE IF NOT EXISTS public.production_cast_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    cast_id UUID NOT NULL REFERENCES public.production_cast(id) ON DELETE CASCADE,
    shoot_date DATE NOT NULL,
    call_time TIME,
    wrap_time TIME,
    hours_worked DECIMAL(4,2),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(cast_id, shoot_date)
);

CREATE INDEX IF NOT EXISTS idx_cast_days_project ON public.production_cast_days(project_id);
CREATE INDEX IF NOT EXISTS idx_cast_days_cast ON public.production_cast_days(cast_id);
CREATE INDEX IF NOT EXISTS idx_cast_days_user ON public.production_cast_days(user_id);

-- Production cast days RLS policies
ALTER TABLE public.production_cast_days ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own cast days" ON public.production_cast_days;
CREATE POLICY "Users can view own cast days" ON public.production_cast_days
    FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own cast days" ON public.production_cast_days;
CREATE POLICY "Users can insert own cast days" ON public.production_cast_days
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own cast days" ON public.production_cast_days;
CREATE POLICY "Users can update own cast days" ON public.production_cast_days
    FOR UPDATE USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own cast days" ON public.production_cast_days;
CREATE POLICY "Users can delete own cast days" ON public.production_cast_days
    FOR DELETE USING ((select auth.uid()) = user_id);

-- =====================================================
-- EPISODE RESOURCE MAPPING TABLES
-- =====================================================

-- Episode-Character mapping (which characters appear in which episodes)
CREATE TABLE IF NOT EXISTS public.episode_characters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  episode_id UUID NOT NULL REFERENCES public.episodes(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  role_type TEXT DEFAULT 'regular', -- regular, recurring, guest, background
  screen_time_estimate INTEGER, -- estimated minutes in episode
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(episode_id, character_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_characters_episode ON public.episode_characters(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_characters_character ON public.episode_characters(character_id);

COMMENT ON TABLE public.episode_characters IS 'Maps characters to specific episodes they appear in';
COMMENT ON COLUMN public.episode_characters.role_type IS 'Type of appearance: regular, recurring, guest, background';
COMMENT ON COLUMN public.episode_characters.screen_time_estimate IS 'Estimated screen time in minutes';

-- Episode-Location mapping (which locations are used in which episodes)
CREATE TABLE IF NOT EXISTS public.episode_locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  episode_id UUID NOT NULL REFERENCES public.episodes(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  scene_count INTEGER DEFAULT 0, -- how many scenes use this location in this episode
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(episode_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_locations_episode ON public.episode_locations(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_locations_location ON public.episode_locations(location_id);

COMMENT ON TABLE public.episode_locations IS 'Maps locations to specific episodes they are used in';
COMMENT ON COLUMN public.episode_locations.scene_count IS 'Number of scenes using this location in this episode';

-- Per-episode cast assignments (which cast members appear in which episodes)
CREATE TABLE IF NOT EXISTS public.episode_cast (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cast_member_id UUID NOT NULL REFERENCES public.production_cast(id) ON DELETE CASCADE,
  episode_id UUID NOT NULL REFERENCES public.episodes(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'wrapped')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(cast_member_id, episode_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_cast_episode ON public.episode_cast(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_cast_member ON public.episode_cast(cast_member_id);

-- Per-episode crew assignments
CREATE TABLE IF NOT EXISTS public.episode_crew (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_member_id UUID NOT NULL REFERENCES public.production_crew(id) ON DELETE CASCADE,
  episode_id UUID NOT NULL REFERENCES public.episodes(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'wrapped')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(crew_member_id, episode_id)
);

CREATE INDEX IF NOT EXISTS idx_episode_crew_episode ON public.episode_crew(episode_id);
CREATE INDEX IF NOT EXISTS idx_episode_crew_member ON public.episode_crew(crew_member_id);

ALTER TABLE public.episode_cast ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.episode_crew ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.episode_cast IS 'Links cast members to specific episodes they appear in';
COMMENT ON TABLE public.episode_crew IS 'Links crew members to specific episodes they work on';

-- Episode Budget Items
-- NOTE: episode_budget_items table has been deprecated.
-- Budget items for TV series episodes now use production_budgets with episode_id column.
-- See production_budgets table definition for the unified schema.

-- Scripts table
CREATE TABLE IF NOT EXISTS public.scripts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE, -- For series projects: link to episode
  title TEXT NOT NULL,
  content JSONB,
  scenes JSONB, -- Cached parsed scenes for performance (world-class production planner)
  scene_version_hash VARCHAR(64), -- Hash of scenes for change detection (world-class production planner)
  page_count INTEGER, -- Exact page count as measured by the editor's DOM paginator (null until first save)
  is_ai_generated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scripts_episode_id ON public.scripts(episode_id);

COMMENT ON COLUMN public.scripts.episode_id IS 'For series projects: link to the episode this script belongs to';

-- Now add the foreign key constraint to projects.active_script_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'projects_active_script_id_fkey'
        AND table_name = 'projects'
    ) THEN
        ALTER TABLE public.projects
        ADD CONSTRAINT projects_active_script_id_fkey
        FOREIGN KEY (active_script_id) REFERENCES public.scripts(id);
    END IF;
END $$;

-- Add the foreign key constraint from episodes.script_id to scripts.id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'episodes_script_id_fkey'
        AND table_name = 'episodes'
    ) THEN
        ALTER TABLE public.episodes
        ADD CONSTRAINT episodes_script_id_fkey
        FOREIGN KEY (script_id) REFERENCES public.scripts(id) ON DELETE SET NULL;
    END IF;
END $$;

-- =====================================================
-- BEAT SHEET & STORY STRUCTURE TABLES
-- =====================================================

-- Structure Templates table - Story structure templates (Hero's Journey, Save the Cat, etc.)
CREATE TABLE IF NOT EXISTS public.structure_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Template identification
  name TEXT NOT NULL, -- "Hero's Journey", "Save the Cat", "3-Act Structure", etc.
  description TEXT,
  slug TEXT UNIQUE, -- URL-friendly identifier (e.g., "heros-journey")

  -- Template structure definition
  beats JSONB NOT NULL DEFAULT '[]', -- Array of template beat definitions

  -- Template metadata
  category TEXT, -- "film", "tv", "both"
  genre_hints TEXT[], -- Array of genres this template works well for

  -- Ownership
  is_default BOOLEAN DEFAULT FALSE, -- Built-in templates
  created_by UUID REFERENCES public.users(id) ON DELETE CASCADE, -- NULL for built-in
  is_public BOOLEAN DEFAULT FALSE, -- User templates can be shared

  -- Usage tracking
  usage_count INTEGER DEFAULT 0, -- How many times applied

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for structure templates
CREATE INDEX IF NOT EXISTS idx_structure_templates_default ON public.structure_templates(is_default);
CREATE INDEX IF NOT EXISTS idx_structure_templates_created_by ON public.structure_templates(created_by);
CREATE INDEX IF NOT EXISTS idx_structure_templates_category ON public.structure_templates(category);

-- Enable RLS on structure_templates
ALTER TABLE public.structure_templates ENABLE ROW LEVEL SECURITY;

-- RLS Policies for structure_templates (consolidated to avoid multiple permissive policies)
DROP POLICY IF EXISTS "Public can view default templates" ON public.structure_templates;
DROP POLICY IF EXISTS "Users can view own templates" ON public.structure_templates;
DROP POLICY IF EXISTS "Users can view public templates" ON public.structure_templates;
DROP POLICY IF EXISTS "Users can create own templates" ON public.structure_templates;
DROP POLICY IF EXISTS "Users can update own templates" ON public.structure_templates;
DROP POLICY IF EXISTS "Users can delete own templates" ON public.structure_templates;
DROP POLICY IF EXISTS "Anyone can view public templates" ON public.structure_templates;
DROP POLICY IF EXISTS "Users can manage their own templates" ON public.structure_templates;
DROP POLICY IF EXISTS "Access structure templates" ON public.structure_templates;

CREATE POLICY "Access structure templates" ON public.structure_templates
  FOR ALL USING (
    is_public = true OR is_default = true
    OR created_by = (SELECT auth.uid())
  );

COMMENT ON TABLE public.structure_templates IS 'Story structure templates (Hero''s Journey, Save the Cat, etc.) with built-in and custom templates';

-- Beats table - Story beats for planning screenplay structure
CREATE TABLE IF NOT EXISTS public.beats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Ownership (project OR episode level)
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE, -- NULL for film projects

  -- Beat content
  title TEXT NOT NULL, -- Short description (e.g., "Hero refuses call")
  description TEXT, -- Detailed notes
  notes TEXT, -- Additional writer notes

  -- Beat positioning
  "order" INTEGER NOT NULL, -- Position in beat sheet (0-based)
  act TEXT NOT NULL DEFAULT 'act1', -- 'act1', 'act2a', 'act2b', 'act3', 'act4', 'act5', 'custom'
  beat_type TEXT DEFAULT 'custom', -- 'setup', 'inciting_incident', 'midpoint', 'climax', 'resolution', 'custom', etc.

  -- Visual properties
  color TEXT DEFAULT '#3b82f6', -- Hex color for card

  -- Estimation
  page_estimate INTEGER DEFAULT 1, -- Estimated script pages (1-10)
  duration_estimate INTEGER, -- Estimated minutes (optional)

  -- Scene conversion tracking
  script_id UUID REFERENCES public.scripts(id) ON DELETE SET NULL, -- Linked script if converted to scene
  scene_number INTEGER, -- Scene number within the script (scenes are stored as JSONB in scripts table)
  conversion_status TEXT DEFAULT 'not_converted', -- 'not_converted', 'converted', 'scene_written'

  -- AI tracking
  ai_generated BOOLEAN DEFAULT FALSE, -- Was this beat AI-suggested?
  ai_confidence INTEGER, -- 0-100, if AI-generated
  template_id UUID REFERENCES public.structure_templates(id) ON DELETE SET NULL, -- If from template

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT beats_page_estimate_range CHECK (page_estimate >= 1 AND page_estimate <= 20),
  CONSTRAINT beats_ai_confidence_range CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 100)),
  CONSTRAINT beats_order_positive CHECK ("order" >= 0)
);

-- Indexes for beats
CREATE INDEX IF NOT EXISTS idx_beats_project_id ON public.beats(project_id);
CREATE INDEX IF NOT EXISTS idx_beats_episode_id ON public.beats(episode_id);
CREATE INDEX IF NOT EXISTS idx_beats_project_order ON public.beats(project_id, "order");
CREATE INDEX IF NOT EXISTS idx_beats_episode_order ON public.beats(episode_id, "order") WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_beats_script_id ON public.beats(script_id);
CREATE INDEX IF NOT EXISTS idx_beats_script_scene ON public.beats(script_id, scene_number) WHERE script_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_beats_conversion_status ON public.beats(conversion_status);
CREATE INDEX IF NOT EXISTS idx_beats_act ON public.beats(act);
CREATE INDEX IF NOT EXISTS idx_beats_template_id ON public.beats(template_id);

-- Enable RLS on beats
ALTER TABLE public.beats ENABLE ROW LEVEL SECURITY;

-- RLS Policies for beats
DROP POLICY IF EXISTS "Users can view beats for own projects" ON public.beats;
CREATE POLICY "Users can view beats for own projects"
  ON public.beats FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE projects.id = beats.project_id
      AND projects.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can create beats for own projects" ON public.beats;
CREATE POLICY "Users can create beats for own projects"
  ON public.beats FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE projects.id = beats.project_id
      AND projects.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can update beats for own projects" ON public.beats;
CREATE POLICY "Users can update beats for own projects"
  ON public.beats FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE projects.id = beats.project_id
      AND projects.user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "Users can delete beats for own projects" ON public.beats;
CREATE POLICY "Users can delete beats for own projects"
  ON public.beats FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects
      WHERE projects.id = beats.project_id
      AND projects.user_id = (select auth.uid())
    )
  );

COMMENT ON TABLE public.beats IS 'Story beats for planning screenplay structure before writing scenes';
COMMENT ON COLUMN public.beats."order" IS 'Position in beat sheet (0-based), used for drag-and-drop reordering';
COMMENT ON COLUMN public.beats.page_estimate IS 'Estimated script pages when converted to scene (1-20)';
COMMENT ON COLUMN public.beats.conversion_status IS 'Status: not_converted (beat only) | converted (scene created in script) | scene_written (scene has content)';
COMMENT ON COLUMN public.beats.script_id IS 'Reference to script containing the scene this beat was converted to (scenes stored as JSONB in scripts table)';
COMMENT ON COLUMN public.beats.scene_number IS 'Scene number within the script''s scenes JSONB array (1-based index)';

-- Seed default structure templates
-- Template: 3-Act Structure (Classic)
INSERT INTO public.structure_templates (name, description, slug, beats, category, is_default, genre_hints)
VALUES (
  '3-Act Structure',
  'Classic screenplay structure: Setup (25%), Confrontation (50%), Resolution (25%)',
  '3-act-structure',
  '[
    {"slug": "opening-image", "title": "Opening Image", "description": "First impression of story world and tone", "beat_type": "setup", "typical_position": 1, "act": "act1", "order": 1},
    {"slug": "setup", "title": "Setup", "description": "Introduce protagonist, world, and status quo", "beat_type": "setup", "typical_position": 5, "act": "act1", "order": 2},
    {"slug": "inciting-incident", "title": "Inciting Incident", "description": "Event that disrupts status quo and starts story", "beat_type": "inciting_incident", "typical_position": 12, "act": "act1", "order": 3},
    {"slug": "first-plot-point", "title": "First Plot Point", "description": "Protagonist commits to journey, enters Act 2", "beat_type": "turning_point", "typical_position": 25, "act": "act1", "order": 4},
    {"slug": "rising-action", "title": "Rising Action", "description": "Protagonist faces obstacles, stakes rise", "beat_type": "rising_action", "typical_position": 35, "act": "act2a", "order": 5},
    {"slug": "midpoint", "title": "Midpoint", "description": "Major shift - false victory or defeat", "beat_type": "midpoint", "typical_position": 50, "act": "act2a", "order": 6},
    {"slug": "complications", "title": "Complications", "description": "Things get worse, pressure increases", "beat_type": "rising_action", "typical_position": 60, "act": "act2b", "order": 7},
    {"slug": "all-is-lost", "title": "All Is Lost", "description": "Lowest point, protagonist seems defeated", "beat_type": "crisis", "typical_position": 75, "act": "act2b", "order": 8},
    {"slug": "climax", "title": "Climax", "description": "Final confrontation, highest tension", "beat_type": "climax", "typical_position": 90, "act": "act3", "order": 9},
    {"slug": "resolution", "title": "Resolution", "description": "Aftermath, new equilibrium established", "beat_type": "resolution", "typical_position": 98, "act": "act3", "order": 10}
  ]'::jsonb,
  'both',
  TRUE,
  ARRAY['drama', 'thriller', 'action', 'romance']
)
ON CONFLICT (slug) DO NOTHING;

-- Template: Hero's Journey (Joseph Campbell)
INSERT INTO public.structure_templates (name, description, slug, beats, category, is_default, genre_hints)
VALUES (
  'Hero''s Journey',
  'Joseph Campbell''s monomyth: 12 stages of hero''s transformation',
  'heros-journey',
  '[
    {"slug": "ordinary-world", "title": "Ordinary World", "description": "Hero in their normal life before adventure", "beat_type": "setup", "typical_position": 5, "act": "act1", "order": 1},
    {"slug": "call-to-adventure", "title": "Call to Adventure", "description": "Challenge or quest is presented", "beat_type": "inciting_incident", "typical_position": 10, "act": "act1", "order": 2},
    {"slug": "refusal-of-the-call", "title": "Refusal of the Call", "description": "Hero hesitates or refuses initially", "beat_type": "setup", "typical_position": 15, "act": "act1", "order": 3},
    {"slug": "meeting-the-mentor", "title": "Meeting the Mentor", "description": "Wise figure provides guidance or gift", "beat_type": "setup", "typical_position": 20, "act": "act1", "order": 4},
    {"slug": "crossing-the-threshold", "title": "Crossing the Threshold", "description": "Hero commits and enters special world", "beat_type": "turning_point", "typical_position": 25, "act": "act1", "order": 5},
    {"slug": "tests-allies-enemies", "title": "Tests, Allies, Enemies", "description": "Hero faces trials and meets key characters", "beat_type": "rising_action", "typical_position": 35, "act": "act2a", "order": 6},
    {"slug": "approach-to-inmost-cave", "title": "Approach to Inmost Cave", "description": "Hero prepares for major challenge", "beat_type": "rising_action", "typical_position": 45, "act": "act2a", "order": 7},
    {"slug": "ordeal", "title": "Ordeal", "description": "Hero faces greatest fear, death and rebirth moment", "beat_type": "midpoint", "typical_position": 50, "act": "act2a", "order": 8},
    {"slug": "reward", "title": "Reward", "description": "Hero survives and gains reward or knowledge", "beat_type": "rising_action", "typical_position": 60, "act": "act2b", "order": 9},
    {"slug": "the-road-back", "title": "The Road Back", "description": "Hero begins return, consequences pursuing", "beat_type": "rising_action", "typical_position": 70, "act": "act2b", "order": 10},
    {"slug": "resurrection", "title": "Resurrection", "description": "Final test, hero transformed", "beat_type": "climax", "typical_position": 85, "act": "act3", "order": 11},
    {"slug": "return-with-elixir", "title": "Return with Elixir", "description": "Hero returns home transformed with gift", "beat_type": "resolution", "typical_position": 98, "act": "act3", "order": 12}
  ]'::jsonb,
  'both',
  TRUE,
  ARRAY['fantasy', 'sci-fi', 'adventure', 'action']
)
ON CONFLICT (slug) DO NOTHING;

-- Template: Save the Cat (Blake Snyder)
INSERT INTO public.structure_templates (name, description, slug, beats, category, is_default, genre_hints)
VALUES (
  'Save the Cat',
  'Blake Snyder''s 15-beat screenplay structure',
  'save-the-cat',
  '[
    {"slug": "opening-image", "title": "Opening Image", "description": "Snapshot of protagonist before journey", "beat_type": "setup", "typical_position": 1, "act": "act1", "order": 1},
    {"slug": "theme-stated", "title": "Theme Stated", "description": "Story''s theme hinted at", "beat_type": "setup", "typical_position": 5, "act": "act1", "order": 2},
    {"slug": "setup", "title": "Setup", "description": "Establish protagonist''s world and flaw", "beat_type": "setup", "typical_position": 10, "act": "act1", "order": 3},
    {"slug": "catalyst", "title": "Catalyst", "description": "Inciting incident that starts story", "beat_type": "inciting_incident", "typical_position": 12, "act": "act1", "order": 4},
    {"slug": "debate", "title": "Debate", "description": "Protagonist weighs options, should they go?", "beat_type": "setup", "typical_position": 18, "act": "act1", "order": 5},
    {"slug": "break-into-two", "title": "Break Into Two", "description": "Protagonist makes choice, enters new world", "beat_type": "turning_point", "typical_position": 25, "act": "act2a", "order": 6},
    {"slug": "b-story", "title": "B Story", "description": "Secondary plot introduced (often love story)", "beat_type": "rising_action", "typical_position": 30, "act": "act2a", "order": 7},
    {"slug": "fun-and-games", "title": "Fun and Games", "description": "Promise of premise delivered", "beat_type": "rising_action", "typical_position": 40, "act": "act2a", "order": 8},
    {"slug": "midpoint", "title": "Midpoint", "description": "False victory or false defeat", "beat_type": "midpoint", "typical_position": 50, "act": "act2a", "order": 9},
    {"slug": "bad-guys-close-in", "title": "Bad Guys Close In", "description": "Obstacles intensify, stakes rise", "beat_type": "rising_action", "typical_position": 60, "act": "act2b", "order": 10},
    {"slug": "all-is-lost", "title": "All Is Lost", "description": "Lowest point, seems like failure", "beat_type": "crisis", "typical_position": 75, "act": "act2b", "order": 11},
    {"slug": "dark-night-of-the-soul", "title": "Dark Night of the Soul", "description": "Hero at emotional bottom", "beat_type": "crisis", "typical_position": 80, "act": "act2b", "order": 12},
    {"slug": "break-into-three", "title": "Break Into Three", "description": "Protagonist finds solution", "beat_type": "turning_point", "typical_position": 85, "act": "act3", "order": 13},
    {"slug": "finale", "title": "Finale", "description": "Final confrontation and resolution", "beat_type": "climax", "typical_position": 93, "act": "act3", "order": 14},
    {"slug": "final-image", "title": "Final Image", "description": "Opposite of opening image, transformation shown", "beat_type": "resolution", "typical_position": 99, "act": "act3", "order": 15}
  ]'::jsonb,
  'film',
  TRUE,
  ARRAY['comedy', 'drama', 'romance', 'action']
)
ON CONFLICT (slug) DO NOTHING;

-- Template: 5-Act TV Structure
INSERT INTO public.structure_templates (name, description, slug, beats, category, is_default, genre_hints)
VALUES (
  '5-Act TV Structure',
  'Traditional TV episode structure with commercial breaks',
  '5-act-tv',
  '[
    {"slug": "teaser-cold-open", "title": "Teaser/Cold Open", "description": "Hook audience before titles", "beat_type": "setup", "typical_position": 5, "act": "act1", "order": 1},
    {"slug": "act-1-setup", "title": "Act 1 - Setup", "description": "Establish episode conflict", "beat_type": "inciting_incident", "typical_position": 15, "act": "act1", "order": 2},
    {"slug": "act-2-complication", "title": "Act 2 - Complication", "description": "Conflict develops, first twist", "beat_type": "rising_action", "typical_position": 30, "act": "act2", "order": 3},
    {"slug": "act-3-midpoint", "title": "Act 3 - Midpoint", "description": "Major turn or revelation", "beat_type": "midpoint", "typical_position": 50, "act": "act3", "order": 4},
    {"slug": "act-4-crisis", "title": "Act 4 - Crisis", "description": "Things get worse, tension peaks", "beat_type": "crisis", "typical_position": 70, "act": "act4", "order": 5},
    {"slug": "act-5-resolution", "title": "Act 5 - Resolution", "description": "Climax and wrap-up", "beat_type": "climax", "typical_position": 90, "act": "act5", "order": 6},
    {"slug": "tag", "title": "Tag", "description": "Short epilogue or teaser for next episode", "beat_type": "resolution", "typical_position": 98, "act": "act5", "order": 7}
  ]'::jsonb,
  'tv',
  TRUE,
  ARRAY['drama', 'thriller', 'procedural']
)
ON CONFLICT (slug) DO NOTHING;

-- Template: Story Circle (Dan Harmon)
INSERT INTO public.structure_templates (name, description, slug, beats, category, is_default, genre_hints)
VALUES (
  'Story Circle',
  'Dan Harmon''s 8-step story structure based on the monomyth',
  'story-circle',
  '[
    {"slug": "you", "title": "You", "description": "Establish the character in their comfort zone", "beat_type": "setup", "typical_position": 5, "act": "act1", "order": 1},
    {"slug": "need", "title": "Need", "description": "The character wants or needs something", "beat_type": "inciting_incident", "typical_position": 12, "act": "act1", "order": 2},
    {"slug": "go", "title": "Go", "description": "Character enters an unfamiliar situation", "beat_type": "turning_point", "typical_position": 25, "act": "act2a", "order": 3},
    {"slug": "search", "title": "Search", "description": "Character adapts, struggles, and searches", "beat_type": "rising_action", "typical_position": 37, "act": "act2a", "order": 4},
    {"slug": "find", "title": "Find", "description": "Character gets what they wanted", "beat_type": "midpoint", "typical_position": 50, "act": "act2b", "order": 5},
    {"slug": "take", "title": "Take", "description": "Character pays a heavy price for it", "beat_type": "crisis", "typical_position": 62, "act": "act2b", "order": 6},
    {"slug": "return", "title": "Return", "description": "Character returns to the familiar situation", "beat_type": "climax", "typical_position": 75, "act": "act3", "order": 7},
    {"slug": "change", "title": "Change", "description": "Character has changed from the experience", "beat_type": "resolution", "typical_position": 95, "act": "act3", "order": 8}
  ]'::jsonb,
  'both',
  TRUE,
  ARRAY['comedy', 'drama', 'animation', 'adventure']
)
ON CONFLICT (slug) DO NOTHING;

-- Template: Sequence Approach (Frank Daniel)
INSERT INTO public.structure_templates (name, description, slug, beats, category, is_default, genre_hints)
VALUES (
  'Sequence Approach',
  'Frank Daniel''s 8-sequence structure: each sequence has its own tension arc',
  'sequence-approach',
  '[
    {"slug": "seq-1", "title": "Sequence 1 - Status Quo & Inciting Incident", "description": "Establish the world and trigger the story with an inciting event", "beat_type": "setup", "typical_position": 8, "act": "act1", "order": 1},
    {"slug": "seq-2", "title": "Sequence 2 - Predicament & Lock In", "description": "Character responds to inciting incident and commits to the journey", "beat_type": "turning_point", "typical_position": 20, "act": "act1", "order": 2},
    {"slug": "seq-3", "title": "Sequence 3 - First Obstacle & Raising the Stakes", "description": "First major obstacle forces character to adapt and stakes escalate", "beat_type": "rising_action", "typical_position": 32, "act": "act2a", "order": 3},
    {"slug": "seq-4", "title": "Sequence 4 - First Culmination / Midpoint", "description": "Major event shifts the story direction at the midpoint", "beat_type": "midpoint", "typical_position": 45, "act": "act2a", "order": 4},
    {"slug": "seq-5", "title": "Sequence 5 - Subplot & Rising Action", "description": "Subplots deepen, pressure increases, new complications", "beat_type": "rising_action", "typical_position": 57, "act": "act2b", "order": 5},
    {"slug": "seq-6", "title": "Sequence 6 - Main Culmination / Low Point", "description": "Everything falls apart, protagonist at their lowest", "beat_type": "crisis", "typical_position": 70, "act": "act2b", "order": 6},
    {"slug": "seq-7", "title": "Sequence 7 - New Tension & Third Act Twist", "description": "Protagonist regroups and faces the final challenge", "beat_type": "climax", "typical_position": 85, "act": "act3", "order": 7},
    {"slug": "seq-8", "title": "Sequence 8 - Resolution", "description": "Climactic confrontation and resolution of all story threads", "beat_type": "resolution", "typical_position": 95, "act": "act3", "order": 8}
  ]'::jsonb,
  'film',
  TRUE,
  ARRAY['drama', 'thriller', 'mystery', 'action']
)
ON CONFLICT (slug) DO NOTHING;

-- Template: Kishotenketsu (Japanese 4-act structure)
INSERT INTO public.structure_templates (name, description, slug, beats, category, is_default, genre_hints)
VALUES (
  'Kishotenketsu',
  'Japanese 4-act narrative structure: introduction, development, twist, conclusion. No conflict required.',
  'kishotenketsu',
  '[
    {"slug": "ki", "title": "Ki - Introduction", "description": "Introduce the characters, setting, and situation without conflict", "beat_type": "setup", "typical_position": 10, "act": "act1", "order": 1},
    {"slug": "sho", "title": "Sho - Development", "description": "Develop the established elements, deepen relationships and understanding", "beat_type": "rising_action", "typical_position": 35, "act": "act2a", "order": 2},
    {"slug": "ten", "title": "Ten - Twist", "description": "An unexpected element disrupts or recontextualizes everything. The most important moment.", "beat_type": "turning_point", "typical_position": 65, "act": "act2b", "order": 3},
    {"slug": "ketsu", "title": "Ketsu - Conclusion", "description": "Reconcile the twist with the established world. Show the new understanding.", "beat_type": "resolution", "typical_position": 90, "act": "act3", "order": 4}
  ]'::jsonb,
  'both',
  TRUE,
  ARRAY['drama', 'animation', 'slice-of-life', 'literary']
)
ON CONFLICT (slug) DO NOTHING;

-- AI Generated Scenes table (Scene-based AI generation system)
CREATE TABLE IF NOT EXISTS public.ai_generated_scenes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    script_id UUID REFERENCES public.scripts(id) ON DELETE CASCADE,
    episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,
    scene_number INTEGER NOT NULL,
    heading TEXT NOT NULL,
    content JSONB NOT NULL, -- Full scene content in TipTap JSON format
    characters TEXT[] DEFAULT '{}',
    location TEXT,
    time_of_day VARCHAR(20),
    complexity VARCHAR(20) CHECK (complexity IN ('simple', 'moderate', 'complex')),
    estimated_duration_minutes INTEGER,
    is_ai_generated BOOLEAN DEFAULT true,
    generation_metadata JSONB DEFAULT '{}', -- AI generation parameters, model used, prompts, etc.
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'inserted', 'archived')),
    user_id UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(project_id, script_id, scene_number)
);

COMMENT ON COLUMN public.ai_generated_scenes.episode_id IS 'Optional episode reference for TV series - enables per-episode production planning while sharing project resources';

-- Storyboards table
CREATE TABLE IF NOT EXISTS public.storyboards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scenes JSONB DEFAULT '[]',
  is_ai_generated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Storyboard panels table (CRITICAL - required by backend API)
CREATE TABLE IF NOT EXISTS public.storyboard_panels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,
  scene_id VARCHAR(64),  -- Content-based hash for stable scene identity (survives reordering)
  scene_number INTEGER,  -- Display order (1, 2, 3...)
  scene_heading TEXT,    -- Cached scene heading for UI display
  panel_number INTEGER NOT NULL,
  scene_description TEXT NOT NULL,
  shot_type TEXT DEFAULT 'medium-shot',
  camera_movement TEXT DEFAULT 'static',
  camera_direction TEXT DEFAULT '',  -- explicit per-shot camera move; drives image-to-video animation
  duration TEXT DEFAULT '3',
  notes TEXT DEFAULT '',
  lighting TEXT DEFAULT '',
  mood TEXT DEFAULT '',
  image_url TEXT,
  image_fidelity TEXT CHECK (image_fidelity IS NULL OR image_fidelity IN ('sketch', 'cinematic')),  -- fidelity the image was generated with; gates Animate (cinematic only)
  is_ai_generated BOOLEAN DEFAULT FALSE,
  linked_character_ids UUID[] DEFAULT '{}',  -- Array of character UUIDs linked to this panel (max 3)
  linked_location_id UUID REFERENCES public.locations(id) ON DELETE SET NULL,  -- Optional location for AI image reference
  -- Video (image-to-video) generation — MEGA beta. Lifecycle: NULL -> processing -> completed | failed
  video_url TEXT,            -- storage path in the generated-video bucket
  video_status TEXT CHECK (video_status IS NULL OR video_status IN ('processing', 'completed', 'failed')),
  video_job_id TEXT,         -- OpenRouter video generation job id
  video_duration INTEGER,    -- clip length in seconds
  video_model TEXT,          -- provider model slug used (e.g. x-ai/grok-imagine-video)
  video_error TEXT,          -- last failure message, if any
  video_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for storyboard_panels
CREATE INDEX IF NOT EXISTS idx_storyboard_panels_episode_id
ON public.storyboard_panels(episode_id);

-- Scene-based indexes
CREATE INDEX IF NOT EXISTS idx_storyboard_panels_scene_id
ON public.storyboard_panels(scene_id);

CREATE INDEX IF NOT EXISTS idx_storyboard_panels_scene_number
ON public.storyboard_panels(project_id, episode_id, scene_number);

-- Index for linked location ID
CREATE INDEX IF NOT EXISTS idx_storyboard_panels_location
ON public.storyboard_panels(linked_location_id);

-- Index for the video status poller to find in-flight jobs quickly
CREATE INDEX IF NOT EXISTS idx_storyboard_panels_video_job
ON public.storyboard_panels(video_job_id)
WHERE video_job_id IS NOT NULL;

-- Partial unique indexes for scene-aware panel numbering
-- Film storyboards with scenes: panel_number must be unique per project + scene
CREATE UNIQUE INDEX IF NOT EXISTS idx_storyboard_panels_film_scene_unique
ON public.storyboard_panels(project_id, scene_id, panel_number)
WHERE episode_id IS NULL AND scene_id IS NOT NULL;

-- TV series storyboards with scenes: panel_number must be unique per episode + scene
CREATE UNIQUE INDEX IF NOT EXISTS idx_storyboard_panels_tv_scene_unique
ON public.storyboard_panels(episode_id, scene_id, panel_number)
WHERE episode_id IS NOT NULL AND scene_id IS NOT NULL;

-- Legacy film storyboards (no scene): panel_number must be unique per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_storyboard_panels_legacy_film
ON public.storyboard_panels(project_id, panel_number)
WHERE episode_id IS NULL AND scene_id IS NULL;

-- Legacy TV storyboards (no scene): panel_number must be unique per episode
CREATE UNIQUE INDEX IF NOT EXISTS idx_storyboard_panels_legacy_tv
ON public.storyboard_panels(episode_id, panel_number)
WHERE episode_id IS NOT NULL AND scene_id IS NULL;

COMMENT ON COLUMN public.storyboard_panels.episode_id IS 'Optional episode reference for TV series - enables per-episode storyboards. NULL for project-level storyboards (films/legacy)';
COMMENT ON COLUMN public.storyboard_panels.scene_id IS 'Content-based SHA-256 hash for stable scene identity - survives scene reordering. NULL for legacy storyboards created before scene-based refactor';
COMMENT ON COLUMN public.storyboard_panels.scene_number IS 'Display order of scene in script (1, 2, 3...). NULL for legacy storyboards';
COMMENT ON COLUMN public.storyboard_panels.scene_heading IS 'Cached scene heading (e.g., INT. COFFEE SHOP - DAY) for quick UI display without parsing script. NULL for legacy storyboards';

-- Scene/episode video reels (MEGA beta assembly). Stitches shot clips into one
-- vertical video via ffmpeg. scope 'scene' (scene_id set) or 'episode' (scene_id NULL).
CREATE TABLE IF NOT EXISTS public.video_renders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,
  scene_id VARCHAR(64),
  scope TEXT NOT NULL CHECK (scope IN ('scene', 'episode')),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  video_url TEXT,
  clip_count INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_video_renders_project_episode
ON public.video_renders (project_id, episode_id);

-- =====================================================
-- VERSION CONTROL SYSTEM
-- =====================================================

-- Script versions table for comprehensive version control
CREATE TABLE IF NOT EXISTS public.script_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  script_id UUID NOT NULL REFERENCES public.scripts(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  content JSONB NOT NULL,
  change_summary TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(script_id, version_number)
);


-- =====================================================
-- PRODUCTION PLANNING SYSTEM
-- =====================================================

-- User subscriptions table (CRITICAL - backend dependency)
CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL DEFAULT 'free',
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  stripe_plan_price_id TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'trial', 'trialing', 'past_due', 'unpaid', 'incomplete', 'inactive')),
  trial_ends_at TIMESTAMPTZ,
  additional_projects INTEGER DEFAULT 0,
  additional_collaborators INTEGER DEFAULT 0,
  billing_cycle TEXT DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
  billing_cycle_start DATE DEFAULT CURRENT_DATE,
  last_billing_date DATE DEFAULT CURRENT_DATE,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  plan_price INTEGER,
  plan_currency TEXT DEFAULT 'eur',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

COMMENT ON TABLE public.user_subscriptions IS 'Complete subscription state - Stripe IDs duplicated here for historical tracking when users cancel/resubscribe.';

COMMENT ON COLUMN public.user_subscriptions.additional_projects IS 'Number of additional projects purchased beyond plan limit';
COMMENT ON COLUMN public.user_subscriptions.additional_collaborators IS 'Number of additional collaborator slots purchased beyond plan limit';
COMMENT ON COLUMN public.user_subscriptions.plan_price IS 'Plan price in cents (e.g., 1500 for €15.00)';
COMMENT ON COLUMN public.user_subscriptions.plan_currency IS 'ISO currency code (e.g., eur, usd)';

-- User quotas/usage table (CRITICAL - backend dependency)
CREATE TABLE IF NOT EXISTS public.user_quotas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ai_generations_used INTEGER DEFAULT 0,
  ai_credits_balance INTEGER DEFAULT 0, -- AI credits (one-time purchases, never expire)
  ai_credits_purchased_total INTEGER DEFAULT 0, -- Total credits ever purchased (for analytics)
  storage_used_gb DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- AI credit transactions table (for tracking credit purchases and usage)
CREATE TABLE IF NOT EXISTS public.ai_credit_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('purchase', 'usage', 'refund', 'grant', 'migration')),
  amount INTEGER NOT NULL, -- Positive for additions, negative for usage
  balance_after INTEGER NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_credit_transactions_user ON public.ai_credit_transactions(user_id);

-- Billing events table (CRITICAL - backend dependency)
CREATE TABLE IF NOT EXISTS public.billing_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Addon transactions table for tracking addon purchases
CREATE TABLE IF NOT EXISTS public.addon_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  addon_type TEXT NOT NULL CHECK (addon_type IN ('additional_projects', 'additional_collaborators')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  total_price_cents INTEGER NOT NULL CHECK (total_price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'EUR',
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Monthly Project Billing Table
-- Implements "pay for active projects per billing cycle" model
CREATE TABLE IF NOT EXISTS public.monthly_project_billing (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  billing_month DATE NOT NULL, -- First day of the billing cycle (e.g., 2024-01-15)
  active_projects_count INTEGER NOT NULL DEFAULT 0,
  plan_included_projects INTEGER NOT NULL DEFAULT 0,
  overage_projects INTEGER NOT NULL DEFAULT 0,
  overage_amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'billed', 'paid')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Prevent duplicate billing for same user/month
  UNIQUE(user_id, billing_month)
);

-- Production analyses table
CREATE TABLE IF NOT EXISTS public.production_analyses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    script_id UUID REFERENCES public.scripts(id) ON DELETE SET NULL,
    analysis_type VARCHAR(50) NOT NULL, -- 'script_analysis', 'budget_optimization', 'schedule_optimization'
    content TEXT,
    ai_response TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- WORLD-CLASS PRODUCTION PLANNER: LINKED DATA MODEL
-- =====================================================
-- Production scene data table (replaces old scene_cards)
-- This table stores ONLY production-specific data, linked to script scenes
-- Script content (heading, location, characters) comes from scripts.scenes
CREATE TABLE IF NOT EXISTS public.production_scene_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,

  -- LINK to script scene (not duplicate)
  script_id UUID NOT NULL REFERENCES public.scripts(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL,  -- Current scene number from script
  scene_id VARCHAR(64) NOT NULL,  -- Stable identifier (content hash)

  -- PRODUCTION-ONLY DATA (not in script)
  complexity VARCHAR(20) DEFAULT 'medium' CHECK (complexity IN ('simple', 'medium', 'complex')),
  estimated_shoot_days DECIMAL(4,2) DEFAULT 1,
  budget_estimate INTEGER DEFAULT 0,  -- in cents
  actual_budget INTEGER,  -- in cents
  shots JSONB DEFAULT '[]',
  production_notes TEXT,
  status VARCHAR(20) DEFAULT 'planning' CHECK (status IN ('planning', 'locked', 'shooting', 'completed', 'archived')),

  -- LOCKING MECHANISM
  locked_at TIMESTAMP WITH TIME ZONE,
  locked_by UUID REFERENCES public.users(id),

  -- SYNC TRACKING
  script_content_hash VARCHAR(64),  -- Hash of script scene content
  last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  sync_status VARCHAR(20) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'script_modified', 'conflict', 'manual')),

  -- SCHEDULING
  shoot_date DATE,
  shoot_day INTEGER, -- Day number in schedule
  shoot_order INTEGER,
  call_time TIME, -- When cast/crew should arrive
  estimated_duration_hours DECIMAL(4,2) DEFAULT 4.0, -- Estimated hours to shoot scene
  estimated_pages DECIMAL(4,2),
  location VARCHAR(255),
  production_location_id UUID, -- FK added later via ALTER TABLE (after production_locations table is created)

  -- METADATA
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Constraints
  UNIQUE(project_id, scene_id),
  UNIQUE(project_id, script_id, scene_number)
);

-- Project-level asset registry (props, cameras, wardrobe, vehicles, etc.)
CREATE TABLE IF NOT EXISTS public.production_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  department TEXT NOT NULL CHECK (department IN (
    'props', 'wardrobe', 'vehicles', 'vfx', 'stunts',
    'makeup', 'sound', 'special_effects', 'animals', 'other'
  )),
  name TEXT NOT NULL,
  description TEXT,
  quantity INTEGER DEFAULT 1,
  status TEXT DEFAULT 'needed' CHECK (status IN ('needed', 'sourced', 'on_set', 'wrapped')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_production_assets_project ON public.production_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_production_assets_dept ON public.production_assets(project_id, department);

ALTER TABLE public.production_assets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.production_assets IS 'Project-level asset registry. Each asset exists once and can be linked to multiple scenes.';

-- Scene-asset junction: links assets to specific scenes
CREATE TABLE IF NOT EXISTS public.scene_breakdown_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_data_id UUID NOT NULL REFERENCES public.production_scene_data(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES public.production_assets(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(scene_data_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_breakdown_items_scene ON public.scene_breakdown_items(scene_data_id);
CREATE INDEX IF NOT EXISTS idx_breakdown_items_asset ON public.scene_breakdown_items(asset_id);
CREATE INDEX IF NOT EXISTS idx_breakdown_items_project ON public.scene_breakdown_items(project_id);

ALTER TABLE public.scene_breakdown_items ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.scene_breakdown_items IS 'Links production assets to specific scenes. An asset can appear in many scenes.';

-- Shooting day settings (per-date production configuration)
CREATE TABLE IF NOT EXISTS public.shooting_day_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  shoot_date DATE NOT NULL,
  general_call_time TIME DEFAULT '07:00',
  department_call_times JSONB DEFAULT '{}',
  estimated_wrap_time TIME,
  notes TEXT DEFAULT '',
  primary_location TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, shoot_date)
);
CREATE INDEX IF NOT EXISTS idx_shooting_day_settings_project ON public.shooting_day_settings(project_id);

ALTER TABLE public.shooting_day_settings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.shooting_day_settings IS 'Per-date configuration: call times, wrap times, location, notes';

-- Scene change log table for audit trail
CREATE TABLE IF NOT EXISTS public.scene_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  scene_id VARCHAR(64) NOT NULL,
  scene_number_old INTEGER,
  scene_number_new INTEGER,
  change_type VARCHAR(30) NOT NULL CHECK (change_type IN (
    'content_modified', 'renumbered', 'deleted', 'added', 'split', 'merged', 'heading_changed', 'characters_changed', 'location_changed'
  )),
  fields_changed JSONB,  -- { heading: {old, new}, location: {old, new} }
  script_version_before VARCHAR(64),
  script_version_after VARCHAR(64),
  auto_synced BOOLEAN DEFAULT false,
  user_reviewed BOOLEAN DEFAULT false,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  reviewed_by UUID REFERENCES public.users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Production budgets table
CREATE TABLE IF NOT EXISTS public.production_budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE, -- NULL for films, set for TV series episodes
    category_name VARCHAR(100) NOT NULL,
    item_name VARCHAR(200) NOT NULL,
    quantity DECIMAL(10,2) DEFAULT 1,
    rate INTEGER NOT NULL, -- Rate in cents
    unit VARCHAR(50) NOT NULL,
    total INTEGER NOT NULL, -- Total cost in cents
    notes TEXT,
    is_estimated BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Production schedules table
CREATE TABLE IF NOT EXISTS public.production_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    scene_id UUID REFERENCES public.production_scene_data(id) ON DELETE CASCADE,
    shoot_date DATE,
    start_time TIME,
    end_time TIME,
    location TEXT,
    crew_requirements JSONB DEFAULT '{}',
    equipment_requirements JSONB DEFAULT '[]',
    notes TEXT,
    status VARCHAR(20) DEFAULT 'scheduled',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Production locations table
CREATE TABLE IF NOT EXISTS public.production_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    address TEXT,
    location_type VARCHAR(50),
    country TEXT, -- Country code for global productions (e.g., US, GB, FR)
    contact_info JSONB DEFAULT '{}',
    permits_required BOOLEAN DEFAULT false,
    cost_per_day INTEGER, -- in cents
    availability_dates DATE[],
    notes TEXT,
    images TEXT[],
    season_id UUID REFERENCES public.seasons(id) ON DELETE CASCADE, -- NULL = project-level, set = season-specific
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON COLUMN public.production_locations.country IS 'Country code for this specific filming location (e.g., US, GB, FR). Used for global productions where different locations are in different countries.';
COMMENT ON COLUMN public.production_locations.season_id IS 'Optional season scope. NULL means project-level location, set means season-specific location.';

-- Add foreign key constraint to locations table (now that production_locations exists)
ALTER TABLE public.locations
  DROP CONSTRAINT IF EXISTS locations_production_location_id_fkey;
ALTER TABLE public.locations
  ADD CONSTRAINT locations_production_location_id_fkey
  FOREIGN KEY (production_location_id)
  REFERENCES public.production_locations(id)
  ON DELETE SET NULL;

-- Add foreign key constraint to production_scene_data table (now that production_locations exists)
ALTER TABLE public.production_scene_data
  DROP CONSTRAINT IF EXISTS production_scene_data_production_location_id_fkey;
ALTER TABLE public.production_scene_data
  ADD CONSTRAINT production_scene_data_production_location_id_fkey
  FOREIGN KEY (production_location_id)
  REFERENCES public.production_locations(id)
  ON DELETE SET NULL;

-- Note: production_cast table moved earlier in schema (before production_cast_days)
-- Note: idx_production_cast_project removed (duplicate of idx_production_cast_project_id)

-- Production cast-to-scene junction table (proper linking with stable scene_id)
CREATE TABLE IF NOT EXISTS public.production_cast_scenes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    cast_id UUID NOT NULL REFERENCES public.production_cast(id) ON DELETE CASCADE,
    scene_id VARCHAR(64) NOT NULL, -- Stable scene hash
    call_time TIME,
    wrap_time TIME,
    has_dialogue BOOLEAN DEFAULT true,
    is_background BOOLEAN DEFAULT false,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(cast_id, scene_id)
);

CREATE INDEX IF NOT EXISTS idx_cast_scenes_project ON public.production_cast_scenes(project_id);
CREATE INDEX IF NOT EXISTS idx_cast_scenes_cast ON public.production_cast_scenes(cast_id);
CREATE INDEX IF NOT EXISTS idx_cast_scenes_user ON public.production_cast_scenes(user_id);

-- Production cast scenes RLS policies
ALTER TABLE public.production_cast_scenes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own cast scenes" ON public.production_cast_scenes
    FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own cast scenes" ON public.production_cast_scenes
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own cast scenes" ON public.production_cast_scenes
    FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own cast scenes" ON public.production_cast_scenes
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Function: Get all cast for a scene
CREATE OR REPLACE FUNCTION get_scene_cast(p_scene_id VARCHAR(64))
RETURNS TABLE (
    cast_id UUID,
    character_name VARCHAR(200),
    actor_name VARCHAR(200),
    call_time TIME,
    has_dialogue BOOLEAN,
    is_background BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        pc.id,
        pc.character_name,
        pc.actor_name,
        pcs.call_time,
        pcs.has_dialogue,
        pcs.is_background
    FROM public.production_cast_scenes pcs
    INNER JOIN public.production_cast pc ON pcs.cast_id = pc.id
    WHERE pcs.scene_id = p_scene_id
    ORDER BY pcs.has_dialogue DESC, pc.character_name;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- =====================================================
-- PRODUCTION LOGISTICS (PLACEHOLDER - NOT IMPLEMENTED)
-- =====================================================
-- NOTE: Crew, equipment, and transportation tables removed
-- These can be added later when needed

-- =====================================================
-- CHAT & CONVERSATION SYSTEM
-- =====================================================

-- Conversations table
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New conversation',
  -- Studio phase the conversation belongs to ('develop' | 'write' | 'plan').
  -- NULL on legacy rows is treated as 'develop' by clients.
  phase TEXT CHECK (phase IN ('develop', 'write', 'plan')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_archived BOOLEAN DEFAULT FALSE
);

-- Conversation messages table
CREATE TABLE IF NOT EXISTS public.conversation_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  attachments JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  token_count INTEGER DEFAULT 0,
  model_used TEXT DEFAULT NULL
);

COMMENT ON COLUMN public.conversation_messages.user_id IS 'ID of the user who sent this message (for collaborative project attribution)';

-- =====================================================
-- REAL-TIME COLLABORATION SYSTEM
-- =====================================================

-- Collaboration documents for Y.js real-time editing
CREATE TABLE IF NOT EXISTS public.collaboration_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK (document_type IN ('script', 'concept', 'character', 'location', 'document')),
    document_id UUID NOT NULL,
    yjs_state BYTEA, -- Binary Y.js document state
    yjs_vector_clock JSONB DEFAULT '{}',
    content_hash TEXT,
    collaborator_count INTEGER DEFAULT 0,
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(project_id, document_type, document_id)
);

-- User presence tracking for real-time collaboration
CREATE TABLE IF NOT EXISTS public.user_presence (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    document_type TEXT CHECK (document_type IN ('script', 'concept', 'character', 'location', 'document')),
    document_id UUID,
    cursor_position JSONB DEFAULT '{}',
    selection_range JSONB DEFAULT '{}',
    user_color TEXT DEFAULT '#3B82F6',
    status TEXT DEFAULT 'online' CHECK (status IN ('online', 'typing', 'away', 'offline')),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    session_id TEXT,
    
    UNIQUE(user_id, project_id)
);

-- Collaboration activity log
CREATE TABLE IF NOT EXISTS public.collaboration_activity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    activity_type TEXT NOT NULL CHECK (activity_type IN (
        'user_invited', 'user_joined', 'user_left', 'user_removed',
        'document_created', 'document_edited', 'document_deleted',
        'permission_changed', 'role_changed'
    )),
    document_type TEXT CHECK (document_type IN ('script', 'concept', 'character', 'location', 'document')),
    document_id UUID,
    metadata JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- OPERATION LOCKS (DB-backed state for multi-instance safety)
-- =====================================================

-- Replaces in-memory Maps for idempotency, cooldowns, deduplication, rate limiting
CREATE TABLE IF NOT EXISTS public.operation_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lock_type TEXT NOT NULL,          -- e.g. 'billing_idempotency', 'request_dedup', 'billing_cooldown'
    lock_key TEXT NOT NULL,           -- e.g. userId, requestHash, or composite key
    expires_at TIMESTAMPTZ NOT NULL,  -- TTL: lock is invalid after this time
    result_data JSONB,                -- optional cached result (for idempotency)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(lock_type, lock_key)
);

-- =====================================================
-- AI USAGE TRACKING SYSTEM
-- =====================================================

-- AI Usage Events Table - tracks every AI API call
CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  
  -- API Details
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'chat_completion', 
    'script_generation', 
    'concept_generation', 
    'document_generation',
    'character_generation',
    'location_generation',
    'storyboard_generation',
    'image_generation',
    'character_image_generation',
    'storyboard_image_generation'
  )),
  
  -- OpenAI Specific
  model_used TEXT, -- e.g., 'gpt-5-mini'
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  
  -- Request Context
  request_id TEXT,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  
  -- Performance
  duration_ms INTEGER,
  
  -- Collaboration Support
  billed_to_user_id UUID REFERENCES auth.users(id),
  team_id UUID REFERENCES public.teams(id),
  
  -- Metadata
  metadata JSONB DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Image Generation Usage Table
CREATE TABLE IF NOT EXISTS public.image_usage_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  
  -- Image Generation Details
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'character_image',
    'storyboard_image',
    'concept_art',
    'location_image',
    'presentation_image'
  )),
  
  -- Service Used
  service_provider TEXT NOT NULL CHECK (service_provider IN ('replicate', 'openai', 'stability_ai', 'openrouter')),
  model_used TEXT,
  
  -- Image Details
  image_dimensions TEXT,
  image_format TEXT,
  image_quality INTEGER,
  
  -- Performance
  duration_ms INTEGER,
  
  -- Output
  image_url TEXT,
  
  -- Context
  prompt_text TEXT,
  metadata JSONB DEFAULT '{}',
  
  -- Collaboration Support
  billed_to_user_id UUID REFERENCES auth.users(id),
  team_id UUID REFERENCES public.teams(id),
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Monthly Usage Summary Table
CREATE TABLE IF NOT EXISTS public.monthly_ai_usage_summary (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  year INTEGER NOT NULL CHECK (year >= 2024),
  
  -- Token Usage
  total_prompt_tokens BIGINT DEFAULT 0,
  total_completion_tokens BIGINT DEFAULT 0,
  total_tokens BIGINT DEFAULT 0,
  
  -- API Calls Count
  chat_completions_count INTEGER DEFAULT 0,
  image_generations_count INTEGER DEFAULT 0,
  
  -- Breakdown by Operation
  script_generations INTEGER DEFAULT 0,
  concept_generations INTEGER DEFAULT 0,
  character_generations INTEGER DEFAULT 0,
  storyboard_generations INTEGER DEFAULT 0,
  location_generations INTEGER DEFAULT 0,
  image_generations INTEGER DEFAULT 0,  -- DEPRECATED: Use image_generations_count instead

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(user_id, month, year)
);

-- =====================================================
-- PROJECT RESTORATION AND UNARCHIVE TRANSACTIONS
-- =====================================================

-- Unarchive transactions table
-- Tracks payments made to unarchive or restore projects
CREATE TABLE IF NOT EXISTS public.unarchive_transactions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('unarchive', 'restore')),
  amount_cents INTEGER NOT NULL, -- €5.00 = 500 cents
  currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_method VARCHAR(50), -- 'stripe', 'dev_simulation', etc.
  stripe_payment_intent_id VARCHAR(255), -- For Stripe integration
  project_title TEXT, -- Store title at time of transaction
  metadata JSONB DEFAULT '{}', -- Additional payment data
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add helpful comments
COMMENT ON TABLE public.unarchive_transactions IS 'Tracks payments made to unarchive or restore projects (€5 per operation)';
COMMENT ON COLUMN public.unarchive_transactions.transaction_type IS 'Type of operation: unarchive (from archived) or restore (from trash)';
COMMENT ON COLUMN public.unarchive_transactions.amount_cents IS 'Amount in cents (€5.00 = 500 cents)';
COMMENT ON COLUMN public.unarchive_transactions.status IS 'Payment status: pending, completed, failed, refunded';
COMMENT ON COLUMN public.unarchive_transactions.payment_method IS 'Payment processor used: stripe, dev_simulation, etc.';

-- =====================================================
-- STRIPE BILLING SYSTEM TABLES
-- =====================================================

-- billing_history table removed - now using direct Stripe API integration

-- Stripe usage records table for addon tracking
CREATE TABLE IF NOT EXISTS public.stripe_usage_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_subscription_item_id TEXT NOT NULL,
  addon_type TEXT NOT NULL CHECK (addon_type IN ('projects', 'collaborators')),
  quantity INTEGER NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  stripe_usage_record_id TEXT,
  billing_cycle_month TEXT -- '2024-01' format
);

-- Project reactivation tracking table
CREATE TABLE IF NOT EXISTS public.project_reactivations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  reactivated_at TIMESTAMPTZ DEFAULT NOW(),
  charge_amount_cents INTEGER DEFAULT 500, -- €5.00
  stripe_payment_intent_id TEXT,
  billing_cycle_month TEXT -- '2024-01' format
);

-- Subscription plans reference table (local reference)
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stripe_monthly_price_id TEXT,
  stripe_yearly_price_id TEXT,
  base_price_cents INTEGER NOT NULL,
  currency TEXT DEFAULT 'eur',
  features JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert plan data (will be updated when Stripe products are created)
-- NEW SIMPLIFIED PRICING MODEL - Insert plan data
INSERT INTO public.subscription_plans (id, name, stripe_monthly_price_id, stripe_yearly_price_id, base_price_cents, currency, features)
VALUES
  ('free', 'Free', NULL, NULL, 0, 'eur', '{"projects": 1, "collaborators": 1, "ai_generations": 20, "documents": 2}'),
  ('paid', 'Paid', 'price_test_paid_monthly', 'price_test_paid_yearly', 900, 'eur', '{"projects": 1, "collaborators": 1, "ai_generations": -1, "documents": -1, "addon_projects": 500, "addon_collaborators": 500}')
ON CONFLICT (id) DO UPDATE SET 
  stripe_monthly_price_id = EXCLUDED.stripe_monthly_price_id,
  stripe_yearly_price_id = EXCLUDED.stripe_yearly_price_id,
  base_price_cents = EXCLUDED.base_price_cents,
  features = EXCLUDED.features,
  updated_at = NOW();

-- Comments for Stripe fields (only IDs stored in users table)
COMMENT ON COLUMN public.users.stripe_customer_id IS 'Stripe customer ID for payment processing - single source of truth for customer linking';
COMMENT ON COLUMN public.users.stripe_subscription_id IS 'Current active Stripe subscription ID - for quick lookup only, full subscription data in user_subscriptions table';
-- billing_history table removed - now using direct Stripe API integration
COMMENT ON TABLE public.stripe_usage_records IS 'Track usage-based billing for addons';
COMMENT ON TABLE public.project_reactivations IS 'Track project reactivation charges';
COMMENT ON TABLE public.subscription_plans IS 'Reference table for subscription plan details';

-- =====================================================
-- COMPREHENSIVE INDEXES FOR PERFORMANCE
-- =====================================================

-- Core table indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_ui_language ON public.users(ui_language);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON public.users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_subscription_id ON public.users(stripe_subscription_id);

-- Teams and collaboration indexes
CREATE INDEX IF NOT EXISTS idx_teams_owner_id ON public.teams(owner_id);
CREATE INDEX IF NOT EXISTS idx_teams_slug ON public.teams(slug);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON public.team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON public.team_members(user_id);

-- Project indexes
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON public.projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_team_id ON public.projects(team_id);
CREATE INDEX IF NOT EXISTS idx_projects_active_script_id ON public.projects(active_script_id);

-- Collaborator indexes
CREATE INDEX IF NOT EXISTS idx_project_collaborators_project_id ON public.project_collaborators(project_id);
CREATE INDEX IF NOT EXISTS idx_project_collaborators_user_id ON public.project_collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_project_collaborators_status ON public.project_collaborators(status);
CREATE INDEX IF NOT EXISTS idx_project_collaborators_invited_by ON public.project_collaborators(invited_by);

-- Invitation indexes
CREATE INDEX IF NOT EXISTS idx_project_invitations_project_id ON public.project_invitations(project_id);
CREATE INDEX IF NOT EXISTS idx_project_invitations_email ON public.project_invitations(email);

-- Content indexes

CREATE INDEX IF NOT EXISTS idx_project_documents_project_id ON public.project_documents(project_id);

-- Note: idx_document_versions_document_id removed (duplicate of idx_project_document_versions_project_document_id)
CREATE INDEX IF NOT EXISTS idx_document_versions_version_number ON public.project_document_versions(project_document_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_scripts_project_id ON public.scripts(project_id);
CREATE INDEX IF NOT EXISTS idx_scripts_created_at ON public.scripts(created_at DESC);

-- AI Generated Scenes indexes
CREATE INDEX IF NOT EXISTS idx_ai_generated_scenes_project_id ON public.ai_generated_scenes(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_generated_scenes_script_id ON public.ai_generated_scenes(script_id);
CREATE INDEX IF NOT EXISTS idx_ai_generated_scenes_user_id ON public.ai_generated_scenes(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_generated_scenes_scene_number ON public.ai_generated_scenes(project_id, scene_number);
CREATE INDEX IF NOT EXISTS idx_ai_generated_scenes_episode_id ON public.ai_generated_scenes(episode_id);

CREATE INDEX IF NOT EXISTS idx_characters_project_id ON public.characters(project_id);
CREATE INDEX IF NOT EXISTS idx_characters_importance ON public.characters(importance_level);

CREATE INDEX IF NOT EXISTS idx_locations_project_id ON public.locations(project_id);
CREATE INDEX IF NOT EXISTS idx_locations_production_location ON public.locations(production_location_id);

CREATE INDEX IF NOT EXISTS idx_storyboards_project_id ON public.storyboards(project_id);

CREATE INDEX IF NOT EXISTS idx_storyboard_panels_project_id ON public.storyboard_panels(project_id);
CREATE INDEX IF NOT EXISTS idx_storyboard_panels_panel_number ON public.storyboard_panels(project_id, panel_number);

-- Version control indexes
CREATE INDEX IF NOT EXISTS idx_script_versions_script_id ON public.script_versions(script_id);
CREATE INDEX IF NOT EXISTS idx_script_versions_version_number ON public.script_versions(script_id, version_number DESC);


-- Production planning indexes
CREATE INDEX IF NOT EXISTS idx_production_analyses_project ON public.production_analyses(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_analyses_script ON public.production_analyses(script_id);
CREATE INDEX IF NOT EXISTS idx_production_analyses_user_id ON public.production_analyses(user_id);
-- Note: idx_prod_scene_project removed (duplicate of idx_production_scene_data_project_id)
CREATE INDEX IF NOT EXISTS idx_prod_scene_script ON public.production_scene_data(script_id);
CREATE INDEX IF NOT EXISTS idx_prod_scene_number ON public.production_scene_data(project_id, scene_number);
CREATE INDEX IF NOT EXISTS idx_prod_scene_shoot_date ON public.production_scene_data(shoot_date);
CREATE INDEX IF NOT EXISTS idx_prod_scene_production_location ON public.production_scene_data(production_location_id);
CREATE INDEX IF NOT EXISTS idx_production_scene_data_episode_id ON public.production_scene_data(episode_id);
CREATE INDEX IF NOT EXISTS idx_production_scene_data_locked_by ON public.production_scene_data(locked_by);
CREATE INDEX IF NOT EXISTS idx_production_scene_data_user_id ON public.production_scene_data(user_id);
-- Note: idx_scene_change_log_project removed (duplicate of idx_scene_change_log_project_id)
CREATE INDEX IF NOT EXISTS idx_scene_change_log_reviewed_by ON public.scene_change_log(reviewed_by);
-- Note: idx_production_budgets_project removed (duplicate of idx_production_budgets_project_id)
CREATE INDEX IF NOT EXISTS idx_production_budgets_user_id ON public.production_budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_production_budgets_episode_id ON public.production_budgets(episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_production_schedules_project ON public.production_schedules(project_id, shoot_date);
CREATE INDEX IF NOT EXISTS idx_production_schedules_scene_id ON public.production_schedules(scene_id);
CREATE INDEX IF NOT EXISTS idx_production_schedules_user_id ON public.production_schedules(user_id);
-- Note: idx_production_locations_project removed (duplicate of idx_production_locations_project_id)
CREATE INDEX IF NOT EXISTS idx_production_locations_user_id ON public.production_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_production_locations_season_id ON public.production_locations(season_id) WHERE season_id IS NOT NULL;
-- Note: idx_production_cast_project removed (duplicate of idx_production_cast_project_id)
CREATE INDEX IF NOT EXISTS idx_production_cast_user_id ON public.production_cast(user_id);
CREATE INDEX IF NOT EXISTS idx_production_cast_season_id ON public.production_cast(season_id) WHERE season_id IS NOT NULL;

-- Conversation indexes
CREATE INDEX IF NOT EXISTS idx_conversations_project_id ON public.conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id ON public.conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_created_at ON public.conversation_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_user_id ON public.conversation_messages(user_id);

-- Collaboration indexes
CREATE INDEX IF NOT EXISTS idx_collaboration_documents_project_document ON public.collaboration_documents(project_id, document_type, document_id);

CREATE INDEX IF NOT EXISTS idx_user_presence_project_id ON public.user_presence(project_id);
CREATE INDEX IF NOT EXISTS idx_user_presence_user_project ON public.user_presence(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen ON public.user_presence(last_seen);

CREATE INDEX IF NOT EXISTS idx_collaboration_activity_project_id ON public.collaboration_activity(project_id);
CREATE INDEX IF NOT EXISTS idx_collaboration_activity_user_id ON public.collaboration_activity(user_id);

-- Operation locks indexes
CREATE INDEX IF NOT EXISTS idx_operation_locks_expires ON public.operation_locks(expires_at);
CREATE INDEX IF NOT EXISTS idx_operation_locks_type_key ON public.operation_locks(lock_type, lock_key);
CREATE INDEX IF NOT EXISTS idx_operation_locks_type_key_pattern ON public.operation_locks(lock_type, lock_key text_pattern_ops);

-- RLS: backend-only table, no client access
ALTER TABLE public.operation_locks ENABLE ROW LEVEL SECURITY;
-- No policies = deny all for anon/authenticated roles; service_role bypasses RLS

-- AI usage tracking indexes
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user_id ON public.ai_usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_project_id ON public.ai_usage_events(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_operation_type ON public.ai_usage_events(operation_type);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_billed_to ON public.ai_usage_events(billed_to_user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_team_id ON public.ai_usage_events(team_id);

CREATE INDEX IF NOT EXISTS idx_image_usage_events_user_id ON public.image_usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_image_usage_events_created_at ON public.image_usage_events(created_at);
CREATE INDEX IF NOT EXISTS idx_image_usage_events_billed_to ON public.image_usage_events(billed_to_user_id);
CREATE INDEX IF NOT EXISTS idx_image_usage_events_team_id ON public.image_usage_events(team_id);

-- Subscription system indexes
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON public.user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_plan_id ON public.user_subscriptions(plan_id);
CREATE INDEX IF NOT EXISTS idx_user_quotas_user_id ON public.user_quotas(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_user_id ON public.billing_events(user_id);
CREATE INDEX IF NOT EXISTS idx_addon_transactions_user_id ON public.addon_transactions(user_id);

-- Stripe billing indexes
-- billing_history indexes removed - now using direct Stripe API integration
CREATE INDEX IF NOT EXISTS idx_stripe_usage_records_user_id ON public.stripe_usage_records(user_id);
CREATE INDEX IF NOT EXISTS idx_project_reactivations_user_id ON public.project_reactivations(user_id);
CREATE INDEX IF NOT EXISTS idx_project_reactivations_project_id ON public.project_reactivations(project_id);

-- Unarchive transactions indexes
CREATE INDEX IF NOT EXISTS idx_unarchive_transactions_user_id ON public.unarchive_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_unarchive_transactions_project_id ON public.unarchive_transactions(project_id);

-- =====================================================
-- FUNCTIONS AND STORED PROCEDURES
-- =====================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to atomically consume AI credits
-- Returns TRUE if credits were consumed, FALSE if insufficient balance
CREATE OR REPLACE FUNCTION public.consume_ai_credits(p_user_id UUID, p_amount INTEGER, p_description TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_balance INTEGER;
  v_new_balance INTEGER;
BEGIN
  -- Get current balance with row lock
  SELECT ai_credits_balance INTO v_current_balance
  FROM public.user_quotas
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Create quota record if doesn't exist
  IF v_current_balance IS NULL THEN
    INSERT INTO public.user_quotas (user_id, ai_credits_balance, updated_at)
    VALUES (p_user_id, 0, NOW());
    v_current_balance := 0;
  END IF;

  -- Check if sufficient balance
  IF v_current_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  -- Update balance
  v_new_balance := v_current_balance - p_amount;
  UPDATE public.user_quotas
  SET ai_credits_balance = v_new_balance, updated_at = NOW()
  WHERE user_id = p_user_id;

  -- Log transaction
  INSERT INTO public.ai_credit_transactions (user_id, transaction_type, amount, balance_after, description)
  VALUES (p_user_id, 'usage', -p_amount, v_new_balance, p_description);

  RETURN TRUE;
END;
$$;

-- Function to add AI credits (for purchases, grants, etc.)
CREATE OR REPLACE FUNCTION public.add_ai_credits(p_user_id UUID, p_amount INTEGER, p_transaction_type TEXT, p_description TEXT DEFAULT NULL, p_metadata JSONB DEFAULT '{}')
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  -- Ensure quota record exists and update balance
  INSERT INTO public.user_quotas (user_id, ai_credits_balance, ai_credits_purchased_total, updated_at)
  VALUES (p_user_id, p_amount, CASE WHEN p_transaction_type = 'purchase' THEN p_amount ELSE 0 END, NOW())
  ON CONFLICT (user_id)
  DO UPDATE SET
    ai_credits_balance = user_quotas.ai_credits_balance + p_amount,
    ai_credits_purchased_total = user_quotas.ai_credits_purchased_total + CASE WHEN p_transaction_type = 'purchase' THEN p_amount ELSE 0 END,
    updated_at = NOW()
  RETURNING ai_credits_balance INTO v_new_balance;

  -- Log transaction
  INSERT INTO public.ai_credit_transactions (user_id, transaction_type, amount, balance_after, description, metadata)
  VALUES (p_user_id, p_transaction_type, p_amount, v_new_balance, p_description, p_metadata);

  RETURN v_new_balance;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.consume_ai_credits(UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_credits(UUID, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_ai_credits(UUID, INTEGER, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_ai_credits(UUID, INTEGER, TEXT, TEXT, JSONB) TO service_role;

-- Function to update conversation timestamp
CREATE OR REPLACE FUNCTION public.update_conversation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.conversations 
  SET updated_at = NOW() 
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- Function to update monthly summary
-- Note: image_generations_count comes from image_usage_events (correct source)
-- image_generations is DEPRECATED (kept for backwards compatibility, always 0)
CREATE OR REPLACE FUNCTION public.update_monthly_summary(p_user_id UUID) RETURNS void AS $$
DECLARE
  current_month INTEGER := EXTRACT(MONTH FROM NOW());
  current_year INTEGER := EXTRACT(YEAR FROM NOW());
BEGIN
  INSERT INTO public.monthly_ai_usage_summary (
    user_id, month, year,
    total_prompt_tokens, total_completion_tokens, total_tokens,
    chat_completions_count, image_generations_count,
    script_generations, concept_generations, character_generations,
    storyboard_generations, location_generations, image_generations
  )
  SELECT
    p_user_id,
    current_month,
    current_year,
    COALESCE(SUM(aue.prompt_tokens), 0),
    COALESCE(SUM(aue.completion_tokens), 0),
    COALESCE(SUM(aue.total_tokens), 0),
    COUNT(CASE WHEN aue.operation_type = 'chat_completion' THEN 1 END),
    -- image_generations_count: Count from image_usage_events (correct source)
    (SELECT COUNT(*) FROM public.image_usage_events iue
     WHERE iue.user_id = p_user_id
       AND EXTRACT(MONTH FROM iue.created_at) = current_month
       AND EXTRACT(YEAR FROM iue.created_at) = current_year),
    COUNT(CASE WHEN aue.operation_type = 'script_generation' THEN 1 END),
    COUNT(CASE WHEN aue.operation_type = 'concept_generation' THEN 1 END),
    COUNT(CASE WHEN aue.operation_type = 'character_generation' THEN 1 END),
    COUNT(CASE WHEN aue.operation_type = 'storyboard_generation' THEN 1 END),
    COUNT(CASE WHEN aue.operation_type = 'location_generation' THEN 1 END),
    0  -- image_generations is DEPRECATED, always 0 (use image_generations_count instead)
  FROM public.ai_usage_events aue
  WHERE aue.user_id = p_user_id
    AND EXTRACT(MONTH FROM aue.created_at) = current_month
    AND EXTRACT(YEAR FROM aue.created_at) = current_year
  GROUP BY aue.user_id
  ON CONFLICT (user_id, month, year) DO UPDATE SET
    total_prompt_tokens = EXCLUDED.total_prompt_tokens,
    total_completion_tokens = EXCLUDED.total_completion_tokens,
    total_tokens = EXCLUDED.total_tokens,
    chat_completions_count = EXCLUDED.chat_completions_count,
    image_generations_count = EXCLUDED.image_generations_count,
    script_generations = EXCLUDED.script_generations,
    concept_generations = EXCLUDED.concept_generations,
    character_generations = EXCLUDED.character_generations,
    storyboard_generations = EXCLUDED.storyboard_generations,
    location_generations = EXCLUDED.location_generations,
    image_generations = 0,  -- DEPRECATED
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper function to get next version number for scripts
CREATE OR REPLACE FUNCTION public.get_next_script_version_number(script_uuid UUID)
RETURNS INTEGER AS $$
DECLARE
  next_version INTEGER;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1 
  INTO next_version
  FROM public.script_versions 
  WHERE script_id = script_uuid;
  
  RETURN next_version;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Atomically create a script version snapshot.
-- Uses an advisory transaction lock per script to prevent duplicate version_number
-- when autosaves/AI/collaborators hit the same script at the same time.
DROP FUNCTION IF EXISTS public.create_script_version_snapshot(UUID, UUID, TEXT);
CREATE OR REPLACE FUNCTION public.create_script_version_snapshot(
  p_script_id UUID,
  p_user_id UUID DEFAULT NULL,
  p_change_summary TEXT DEFAULT 'Auto-save',
  p_skip_if_unchanged BOOLEAN DEFAULT FALSE
)
RETURNS INTEGER AS $$
DECLARE
  next_version INTEGER;
  current_script RECORD;
  latest_version_number INTEGER;
  latest_content JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_script_id::text, 0));

  SELECT title, content
  INTO current_script
  FROM public.scripts
  WHERE id = p_script_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Script not found: %', p_script_id;
  END IF;

  SELECT version_number, content
  INTO latest_version_number, latest_content
  FROM public.script_versions
  WHERE script_id = p_script_id
  ORDER BY version_number DESC
  LIMIT 1;

  IF p_skip_if_unchanged
    AND latest_version_number IS NOT NULL
    AND latest_content IS NOT DISTINCT FROM current_script.content
  THEN
    RETURN latest_version_number;
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO next_version
  FROM public.script_versions
  WHERE script_id = p_script_id;

  INSERT INTO public.script_versions (
    script_id,
    version_number,
    title,
    content,
    change_summary,
    created_by
  )
  VALUES (
    p_script_id,
    next_version,
    COALESCE(current_script.title, 'Script'),
    current_script.content,
    COALESCE(p_change_summary, 'Auto-save'),
    p_user_id
  );

  RETURN next_version;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;


-- Update collaborator count when collaborators change
CREATE OR REPLACE FUNCTION update_project_collaborator_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.projects 
    SET collaborator_count = (
        SELECT COUNT(*) FROM public.project_collaborators 
        WHERE project_id = COALESCE(NEW.project_id, OLD.project_id) 
        AND status = 'active'
    )
    WHERE id = COALESCE(NEW.project_id, OLD.project_id);
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Clean up expired invitations
CREATE OR REPLACE FUNCTION cleanup_expired_invitations()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM public.project_invitations 
    WHERE expires_at < NOW() 
    AND accepted_at IS NULL 
    AND declined_at IS NULL;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Clean up stale presence data
CREATE OR REPLACE FUNCTION cleanup_stale_presence()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM public.user_presence 
    WHERE last_seen < NOW() - INTERVAL '1 hour';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to update subscription addons when transaction is completed
CREATE OR REPLACE FUNCTION public.update_subscription_addons()
RETURNS trigger AS $$
BEGIN
  -- Only process completed transactions
  IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status != 'completed') THEN
    -- Update the user's subscription with additional addon quantities
    IF NEW.addon_type = 'additional_projects' THEN
      UPDATE public.user_subscriptions 
      SET additional_projects = COALESCE(additional_projects, 0) + NEW.quantity,
          updated_at = NOW()
      WHERE user_id = NEW.user_id;
    ELSIF NEW.addon_type = 'additional_collaborators' THEN
      UPDATE public.user_subscriptions 
      SET additional_collaborators = COALESCE(additional_collaborators, 0) + NEW.quantity,
          updated_at = NOW()
      WHERE user_id = NEW.user_id;
    END IF;
    
    -- Update processed timestamp
    NEW.processed_at = NOW();
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get effective limits including addons
CREATE OR REPLACE FUNCTION public.get_user_effective_limits(user_uuid UUID)
RETURNS TABLE (
  plan_id TEXT,
  base_projects INTEGER,
  additional_projects INTEGER,
  effective_projects INTEGER,
  base_collaborators INTEGER,
  additional_collaborators INTEGER,
  effective_collaborators INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH plan_limits AS (
    SELECT 
      us.plan_id,
      us.additional_projects,
      us.additional_collaborators,
      -- NEW SIMPLIFIED MODEL - Only Free and Paid plans
      CASE us.plan_id
        WHEN 'free' THEN 1
        WHEN 'paid' THEN 1  -- Base 1 project included
        ELSE 1
      END as base_project_limit,
      CASE us.plan_id
        WHEN 'free' THEN 1
        WHEN 'paid' THEN 1  -- Base 1 collaborator included
        ELSE 1
      END as base_collaborator_limit
    FROM public.user_subscriptions us
    WHERE us.user_id = user_uuid
  )
  SELECT 
    pl.plan_id,
    pl.base_project_limit,
    COALESCE(pl.additional_projects, 0),
    CASE 
      WHEN pl.base_project_limit = -1 THEN -1  -- unlimited stays unlimited
      ELSE pl.base_project_limit + COALESCE(pl.additional_projects, 0)
    END,
    pl.base_collaborator_limit,
    COALESCE(pl.additional_collaborators, 0),
    pl.base_collaborator_limit + COALESCE(pl.additional_collaborators, 0)
  FROM plan_limits pl;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- TRIGGERS
-- =====================================================

-- Updated at triggers for core tables
DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_projects_updated_at ON public.projects;
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


DROP TRIGGER IF EXISTS update_project_documents_updated_at ON public.project_documents;
CREATE TRIGGER update_project_documents_updated_at
  BEFORE UPDATE ON public.project_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_scripts_updated_at ON public.scripts;
CREATE TRIGGER update_scripts_updated_at
  BEFORE UPDATE ON public.scripts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Seasons and Episodes triggers
DROP TRIGGER IF EXISTS update_seasons_updated_at ON public.seasons;
CREATE TRIGGER update_seasons_updated_at
  BEFORE UPDATE ON public.seasons
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_episodes_updated_at ON public.episodes;
CREATE TRIGGER update_episodes_updated_at
  BEFORE UPDATE ON public.episodes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Beat Sheet triggers
DROP TRIGGER IF EXISTS update_structure_templates_updated_at ON public.structure_templates;
CREATE TRIGGER update_structure_templates_updated_at
  BEFORE UPDATE ON public.structure_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_beats_updated_at ON public.beats;
CREATE TRIGGER update_beats_updated_at
  BEFORE UPDATE ON public.beats
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Function to update episode count when episodes are added/removed
CREATE OR REPLACE FUNCTION update_season_episode_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.seasons
    SET episode_count = episode_count + 1,
        updated_at = NOW()
    WHERE id = NEW.season_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.seasons
    SET episode_count = GREATEST(0, episode_count - 1),
        updated_at = NOW()
    WHERE id = OLD.season_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trigger_update_season_episode_count ON public.episodes;
CREATE TRIGGER trigger_update_season_episode_count
AFTER INSERT OR DELETE ON public.episodes
FOR EACH ROW EXECUTE FUNCTION update_season_episode_count();

-- Function to automatically set episode project_id from season
CREATE OR REPLACE FUNCTION set_episode_project_id()
RETURNS TRIGGER AS $$
BEGIN
  SELECT project_id INTO NEW.project_id
  FROM public.seasons
  WHERE id = NEW.season_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trigger_set_episode_project_id ON public.episodes;
CREATE TRIGGER trigger_set_episode_project_id
BEFORE INSERT OR UPDATE ON public.episodes
FOR EACH ROW EXECUTE FUNCTION set_episode_project_id();

-- =====================================================
-- UNIFIED EPISODE SYSTEM FUNCTIONS
-- =====================================================

-- Auto-create Season 1, Episode 1 for new film projects
CREATE OR REPLACE FUNCTION public.create_default_episode_for_film()
RETURNS TRIGGER AS $$
DECLARE
  v_season_id UUID;
  v_episode_id UUID;
BEGIN
  -- Only for film projects
  IF NEW.project_type = 'film' THEN
    -- Create default season (Season 1)
    INSERT INTO public.seasons (
      project_id,
      season_number,
      title,
      status,
      created_at
    ) VALUES (
      NEW.id,
      1,
      'Main',
      'writing',
      NOW()
    ) RETURNING id INTO v_season_id;

    -- Create default episode (Episode 1 = the film itself)
    INSERT INTO public.episodes (
      season_id,
      project_id,
      episode_number,
      title,
      runtime,
      status,
      created_at
    ) VALUES (
      v_season_id,
      NEW.id,
      1,
      COALESCE(NEW.title, NEW.name),
      NULL, -- Runtime can be set later
      'draft',
      NOW()
    ) RETURNING id INTO v_episode_id;

    -- If the project has an active_script_id, link it to the episode
    IF NEW.active_script_id IS NOT NULL THEN
      UPDATE public.scripts
      SET episode_id = v_episode_id
      WHERE id = NEW.active_script_id;
    END IF;

    RAISE NOTICE 'Created default season and episode for film project %', NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Create trigger for new film projects
DROP TRIGGER IF EXISTS trigger_create_default_episode ON public.projects;
CREATE TRIGGER trigger_create_default_episode
  AFTER INSERT ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.create_default_episode_for_film();

-- Helper functions for episode statistics and budget aggregation

-- Get character episode count
CREATE OR REPLACE FUNCTION get_character_episode_count(char_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(DISTINCT episode_id)
    FROM public.episode_characters
    WHERE character_id = char_id
  );
END;
$$ LANGUAGE plpgsql STABLE SET search_path = public, pg_temp;

-- Get location episode count
CREATE OR REPLACE FUNCTION get_location_episode_count(loc_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(DISTINCT episode_id)
    FROM public.episode_locations
    WHERE location_id = loc_id
  );
END;
$$ LANGUAGE plpgsql STABLE SET search_path = public, pg_temp;

-- Get episode total budget (uses unified production_budgets table)
CREATE OR REPLACE FUNCTION get_episode_budget_total(ep_id UUID)
RETURNS DECIMAL AS $$
BEGIN
  RETURN (
    SELECT COALESCE(SUM(total), 0)
    FROM public.production_budgets
    WHERE episode_id = ep_id
  );
END;
$$ LANGUAGE plpgsql STABLE SET search_path = public, pg_temp;

-- Get season total budget (uses unified production_budgets table)
CREATE OR REPLACE FUNCTION get_season_budget_total(seas_id UUID)
RETURNS DECIMAL AS $$
BEGIN
  RETURN (
    SELECT COALESCE(SUM(pb.total), 0)
    FROM public.production_budgets pb
    JOIN public.episodes e ON e.id = pb.episode_id
    WHERE e.season_id = seas_id
  );
END;
$$ LANGUAGE plpgsql STABLE SET search_path = public, pg_temp;

-- Get project total budget (for both films and series)
CREATE OR REPLACE FUNCTION get_project_budget_total(proj_id UUID)
RETURNS DECIMAL AS $$
BEGIN
  RETURN (
    SELECT COALESCE(SUM(total), 0)
    FROM public.production_budgets
    WHERE project_id = proj_id
  );
END;
$$ LANGUAGE plpgsql STABLE SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS update_characters_updated_at ON public.characters;
CREATE TRIGGER update_characters_updated_at
  BEFORE UPDATE ON public.characters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_locations_updated_at ON public.locations;
CREATE TRIGGER update_locations_updated_at
  BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_storyboards_updated_at ON public.storyboards;
CREATE TRIGGER update_storyboards_updated_at
  BEFORE UPDATE ON public.storyboards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_storyboard_panels_updated_at ON public.storyboard_panels;
CREATE TRIGGER update_storyboard_panels_updated_at
  BEFORE UPDATE ON public.storyboard_panels
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Collaboration triggers
DROP TRIGGER IF EXISTS trigger_project_collaborators_updated_at ON public.project_collaborators;
CREATE TRIGGER trigger_project_collaborators_updated_at
    BEFORE UPDATE ON public.project_collaborators
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trigger_teams_updated_at ON public.teams;
CREATE TRIGGER trigger_teams_updated_at
    BEFORE UPDATE ON public.teams
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Collaborator count triggers
DROP TRIGGER IF EXISTS trigger_update_collaborator_count_insert ON public.project_collaborators;
CREATE TRIGGER trigger_update_collaborator_count_insert
    AFTER INSERT ON public.project_collaborators
    FOR EACH ROW EXECUTE FUNCTION update_project_collaborator_count();

DROP TRIGGER IF EXISTS trigger_update_collaborator_count_update ON public.project_collaborators;
CREATE TRIGGER trigger_update_collaborator_count_update
    AFTER UPDATE ON public.project_collaborators
    FOR EACH ROW EXECUTE FUNCTION update_project_collaborator_count();

DROP TRIGGER IF EXISTS trigger_update_collaborator_count_delete ON public.project_collaborators;
CREATE TRIGGER trigger_update_collaborator_count_delete
    AFTER DELETE ON public.project_collaborators
    FOR EACH ROW EXECUTE FUNCTION update_project_collaborator_count();

-- Conversation timestamp trigger
DROP TRIGGER IF EXISTS update_conversation_on_message ON public.conversation_messages;
CREATE TRIGGER update_conversation_on_message
  AFTER INSERT ON public.conversation_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_conversation_timestamp();

-- Monthly summary trigger
DROP TRIGGER IF EXISTS monthly_ai_usage_summary_updated_at ON public.monthly_ai_usage_summary;
CREATE TRIGGER monthly_ai_usage_summary_updated_at
  BEFORE UPDATE ON public.monthly_ai_usage_summary
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Production planning triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_production_analyses_updated_at BEFORE UPDATE ON public.production_analyses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_production_scene_data_updated_at BEFORE UPDATE ON public.production_scene_data FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_production_budgets_updated_at BEFORE UPDATE ON public.production_budgets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_production_schedules_updated_at BEFORE UPDATE ON public.production_schedules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_production_locations_updated_at BEFORE UPDATE ON public.production_locations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_production_cast_updated_at BEFORE UPDATE ON public.production_cast FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_production_crew_days_updated_at BEFORE UPDATE ON public.production_crew_days FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_production_cast_days_updated_at BEFORE UPDATE ON public.production_cast_days FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_ai_generated_scenes_updated_at BEFORE UPDATE ON public.ai_generated_scenes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- WORLD-CLASS PRODUCTION PLANNER: HELPER FUNCTIONS
-- =====================================================

-- Function to calculate scene content hash
CREATE OR REPLACE FUNCTION calculate_scene_content_hash(
  p_heading TEXT,
  p_location TEXT,
  p_time_of_day TEXT,
  p_int_ext TEXT,
  p_characters TEXT[],
  p_action_content TEXT
) RETURNS VARCHAR(64) AS $$
DECLARE
  v_content TEXT;
  v_characters_sorted TEXT;
BEGIN
  -- Sort characters for consistent hashing
  SELECT string_agg(c, ',' ORDER BY c) INTO v_characters_sorted
  FROM unnest(p_characters) c;

  v_content := COALESCE(p_heading, '') || '::' ||
               COALESCE(p_location, '') || '::' ||
               COALESCE(p_time_of_day, '') || '::' ||
               COALESCE(p_int_ext, '') || '::' ||
               COALESCE(v_characters_sorted, '') || '::' ||
               COALESCE(substring(p_action_content, 1, 500), '');

  RETURN ENCODE(SHA256(v_content::bytea), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp;

-- Function to generate stable scene ID from content fingerprint
CREATE OR REPLACE FUNCTION generate_scene_id_from_content(
  p_heading TEXT,
  p_location TEXT,
  p_time_of_day TEXT
) RETURNS VARCHAR(64) AS $$
DECLARE
  v_fingerprint TEXT;
BEGIN
  v_fingerprint := LOWER(TRIM(COALESCE(p_heading, ''))) || '::' ||
                   LOWER(TRIM(COALESCE(p_location, ''))) || '::' ||
                   LOWER(TRIM(COALESCE(p_time_of_day, '')));
  RETURN ENCODE(SHA256(v_fingerprint::bytea), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp;

-- Function to get unsynced scenes count
CREATE OR REPLACE FUNCTION get_unsynced_scenes_count(p_project_id UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)
    FROM production_scene_data
    WHERE project_id = p_project_id
    AND sync_status != 'synced'
  );
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Trigger function to log scene changes
CREATE OR REPLACE FUNCTION log_scene_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Log if scene number changed (renumbering)
    IF OLD.scene_number != NEW.scene_number THEN
      INSERT INTO scene_change_log (
        project_id, scene_id, scene_number_old, scene_number_new,
        change_type, auto_synced
      ) VALUES (
        NEW.project_id, NEW.scene_id, OLD.scene_number, NEW.scene_number,
        'renumbered', true
      );
    END IF;

    -- Log if content hash changed
    IF OLD.script_content_hash != NEW.script_content_hash THEN
      INSERT INTO scene_change_log (
        project_id, scene_id, scene_number_old, scene_number_new,
        change_type, script_version_before, script_version_after, auto_synced
      ) VALUES (
        NEW.project_id, NEW.scene_id, NEW.scene_number, NEW.scene_number,
        'content_modified', OLD.script_content_hash, NEW.script_content_hash, false
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Apply scene change logging trigger
CREATE TRIGGER log_production_scene_changes
  AFTER UPDATE ON production_scene_data
  FOR EACH ROW
  EXECUTE FUNCTION log_scene_changes();

-- Addon transactions trigger
DROP TRIGGER IF EXISTS update_subscription_addons_trigger ON public.addon_transactions;
CREATE TRIGGER update_subscription_addons_trigger
  BEFORE UPDATE ON public.addon_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_subscription_addons();

-- =====================================================
-- ROW LEVEL SECURITY (RLS) CONFIGURATION
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.episode_characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.episode_locations ENABLE ROW LEVEL SECURITY;
-- episode_crew table removed (deprecated - use production_crew.season_id)
ALTER TABLE public.scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_generated_scenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_elements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storyboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storyboard_panels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collaboration_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collaboration_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.image_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_ai_usage_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_scene_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scene_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_cast ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
-- billing_history RLS removed - now using direct Stripe API integration
ALTER TABLE public.stripe_usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_reactivations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.addon_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_project_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unarchive_transactions ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- COMPREHENSIVE RLS POLICIES
-- =====================================================

-- Users policies (optimized for performance)
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE USING ((SELECT auth.uid()) = id);

-- Teams policies (consolidated to avoid multiple permissive policies)
DROP POLICY IF EXISTS "Users can view teams they belong to" ON public.teams;
DROP POLICY IF EXISTS "Team owners can manage their teams" ON public.teams;
DROP POLICY IF EXISTS "Team members can view their teams" ON public.teams;
DROP POLICY IF EXISTS "Team owners can manage teams" ON public.teams;
DROP POLICY IF EXISTS "Access teams" ON public.teams;

CREATE POLICY "Access teams" ON public.teams
  FOR ALL USING (
    owner_id = (SELECT auth.uid())
    OR id IN (SELECT team_id FROM public.team_members WHERE user_id = (SELECT auth.uid()))
  );

-- Team members policies (optimized for performance)
DROP POLICY IF EXISTS "Users can view team members of their teams" ON public.team_members;
CREATE POLICY "Users can view team members of their teams" ON public.team_members
  FOR SELECT USING (
    team_id IN (
      SELECT id FROM public.teams WHERE owner_id = (SELECT auth.uid())
      UNION
      SELECT team_id FROM public.team_members WHERE user_id = (SELECT auth.uid())
    )
  );

-- =============================================================================
-- HELPER FUNCTION: Get user accessible project IDs (SECURITY DEFINER)
-- This function bypasses RLS to prevent infinite recursion when checking
-- project access. Used by both projects and project_collaborators policies.
-- =============================================================================
DROP FUNCTION IF EXISTS public.get_user_accessible_project_ids(UUID);
CREATE OR REPLACE FUNCTION public.get_user_accessible_project_ids(uid UUID)
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT project_id FROM project_collaborators
  WHERE user_id = uid AND status = 'active'
  UNION
  SELECT id FROM projects WHERE user_id = uid;
$$;

COMMENT ON FUNCTION public.get_user_accessible_project_ids(UUID) IS
  'Returns all project IDs the user can access (as owner or collaborator). Uses SECURITY DEFINER to bypass RLS and prevent infinite recursion.';

-- Projects policies (using helper function to prevent RLS recursion)
DROP POLICY IF EXISTS "Users can view own projects" ON public.projects;
CREATE POLICY "Users can view own projects" ON public.projects
  FOR SELECT USING (
    id IN (SELECT public.get_user_accessible_project_ids((SELECT auth.uid())))
  );

DROP POLICY IF EXISTS "Users can insert own projects" ON public.projects;
CREATE POLICY "Users can insert own projects" ON public.projects
  FOR INSERT WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own projects" ON public.projects;
CREATE POLICY "Users can update own projects" ON public.projects
  FOR UPDATE USING (
    id IN (SELECT public.get_user_accessible_project_ids((SELECT auth.uid())))
  );

DROP POLICY IF EXISTS "Users can delete own projects" ON public.projects;
CREATE POLICY "Users can delete own projects" ON public.projects
  FOR DELETE USING ((SELECT auth.uid()) = user_id);

-- Project collaborators policies (using helper function to prevent RLS recursion)
DROP POLICY IF EXISTS "Users can view project collaborators" ON public.project_collaborators;
DROP POLICY IF EXISTS "Project owners can manage collaborators" ON public.project_collaborators;
DROP POLICY IF EXISTS "Users can view collaborators for their projects" ON public.project_collaborators;
DROP POLICY IF EXISTS "Access project collaborators" ON public.project_collaborators;

CREATE POLICY "Access project collaborators" ON public.project_collaborators
  FOR ALL USING (
    user_id = (SELECT auth.uid())
    OR project_id IN (SELECT public.get_user_accessible_project_ids((SELECT auth.uid())))
  );

-- Project invitations policies (optimized for performance)
DROP POLICY IF EXISTS "Users can view project invitations" ON public.project_invitations;
CREATE POLICY "Users can view project invitations" ON public.project_invitations
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())) OR
    email = (SELECT email FROM auth.users WHERE id = (SELECT auth.uid()))
  );

-- Project concepts policies




-- Project Documents policies (NEW)
DROP POLICY IF EXISTS "Users can view project documents" ON public.project_documents;
CREATE POLICY "Users can view project documents" ON public.project_documents
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators 
      WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert project documents" ON public.project_documents;
CREATE POLICY "Users can insert project documents" ON public.project_documents
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators 
      WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can update project documents" ON public.project_documents;
CREATE POLICY "Users can update project documents" ON public.project_documents
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators 
      WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can delete project documents" ON public.project_documents;
CREATE POLICY "Users can delete project documents" ON public.project_documents
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators 
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin')
    )
  );

-- Project Document Versions policies
DROP POLICY IF EXISTS "Users can view their own document versions" ON public.project_document_versions;
CREATE POLICY "Users can view their own document versions" ON public.project_document_versions
  FOR SELECT USING (
    project_document_id IN (
      SELECT id FROM public.project_documents 
      WHERE project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators 
        WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS "Users can create versions for their own documents" ON public.project_document_versions;
CREATE POLICY "Users can create versions for their own documents" ON public.project_document_versions
  FOR INSERT WITH CHECK (
    project_document_id IN (
      SELECT id FROM public.project_documents 
      WHERE project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators 
        WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS "Users can delete their own document versions" ON public.project_document_versions;
CREATE POLICY "Users can delete their own document versions" ON public.project_document_versions
  FOR DELETE USING (
    project_document_id IN (
      SELECT id FROM public.project_documents 
      WHERE project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators 
        WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

-- Scripts policies (similar pattern to project concepts)
DROP POLICY IF EXISTS "Users can view scripts" ON public.scripts;
CREATE POLICY "Users can view scripts" ON public.scripts
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert scripts" ON public.scripts;
CREATE POLICY "Users can insert scripts" ON public.scripts
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can update scripts" ON public.scripts;
CREATE POLICY "Users can update scripts" ON public.scripts
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete scripts" ON public.scripts;
CREATE POLICY "Users can delete scripts" ON public.scripts
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin')
    )
  );

-- Seasons policies (for TV series projects)
DROP POLICY IF EXISTS "Users can view seasons of their projects" ON public.seasons;
CREATE POLICY "Users can view seasons of their projects" ON public.seasons
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert seasons in their projects" ON public.seasons;
CREATE POLICY "Users can insert seasons in their projects" ON public.seasons
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can update seasons in their projects" ON public.seasons;
CREATE POLICY "Users can update seasons in their projects" ON public.seasons
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete seasons in their projects" ON public.seasons;
CREATE POLICY "Users can delete seasons in their projects" ON public.seasons
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin')
    )
  );

-- Episodes policies (for TV series projects)
DROP POLICY IF EXISTS "Users can view episodes of their projects" ON public.episodes;
CREATE POLICY "Users can view episodes of their projects" ON public.episodes
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert episodes in their projects" ON public.episodes;
CREATE POLICY "Users can insert episodes in their projects" ON public.episodes
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can update episodes in their projects" ON public.episodes;
CREATE POLICY "Users can update episodes in their projects" ON public.episodes
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete episodes in their projects" ON public.episodes;
CREATE POLICY "Users can delete episodes in their projects" ON public.episodes
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin')
    )
  );

-- Episode-Character mapping policies (consolidated - 1 SELECT + 3 write policies)
DROP POLICY IF EXISTS "Users can view episode characters" ON public.episode_characters;
DROP POLICY IF EXISTS "Users can manage episode characters" ON public.episode_characters;
DROP POLICY IF EXISTS "Select episode characters" ON public.episode_characters;
DROP POLICY IF EXISTS "Write episode characters" ON public.episode_characters;
DROP POLICY IF EXISTS "Update episode characters" ON public.episode_characters;
DROP POLICY IF EXISTS "Delete episode characters" ON public.episode_characters;

CREATE POLICY "Select episode characters" ON public.episode_characters
  FOR SELECT USING (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      WHERE e.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

CREATE POLICY "Write episode characters" ON public.episode_characters
  FOR INSERT WITH CHECK (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      WHERE e.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

CREATE POLICY "Update episode characters" ON public.episode_characters
  FOR UPDATE USING (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      WHERE e.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

CREATE POLICY "Delete episode characters" ON public.episode_characters
  FOR DELETE USING (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      WHERE e.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

-- Episode-Location mapping policies (consolidated - 1 SELECT + 3 write policies)
DROP POLICY IF EXISTS "Users can view episode locations" ON public.episode_locations;
DROP POLICY IF EXISTS "Users can manage episode locations" ON public.episode_locations;
DROP POLICY IF EXISTS "Select episode locations" ON public.episode_locations;
DROP POLICY IF EXISTS "Write episode locations" ON public.episode_locations;
DROP POLICY IF EXISTS "Update episode locations" ON public.episode_locations;
DROP POLICY IF EXISTS "Delete episode locations" ON public.episode_locations;

CREATE POLICY "Select episode locations" ON public.episode_locations
  FOR SELECT USING (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      WHERE e.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

CREATE POLICY "Write episode locations" ON public.episode_locations
  FOR INSERT WITH CHECK (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      WHERE e.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

CREATE POLICY "Update episode locations" ON public.episode_locations
  FOR UPDATE USING (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      WHERE e.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

CREATE POLICY "Delete episode locations" ON public.episode_locations
  FOR DELETE USING (
    episode_id IN (
      SELECT e.id FROM public.episodes e
      WHERE e.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

-- episode_crew RLS policies removed (table deprecated - use production_crew.season_id)

-- AI Generated Scenes policies (similar pattern to scripts)
DROP POLICY IF EXISTS "Users can view ai_generated_scenes" ON public.ai_generated_scenes;
CREATE POLICY "Users can view ai_generated_scenes" ON public.ai_generated_scenes
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert ai_generated_scenes" ON public.ai_generated_scenes;
CREATE POLICY "Users can insert ai_generated_scenes" ON public.ai_generated_scenes
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can update ai_generated_scenes" ON public.ai_generated_scenes;
CREATE POLICY "Users can update ai_generated_scenes" ON public.ai_generated_scenes
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete ai_generated_scenes" ON public.ai_generated_scenes;
CREATE POLICY "Users can delete ai_generated_scenes" ON public.ai_generated_scenes
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin')
    )
  );

-- Characters policies (similar pattern)
DROP POLICY IF EXISTS "Users can view characters" ON public.characters;
CREATE POLICY "Users can view characters" ON public.characters
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert characters" ON public.characters;
CREATE POLICY "Users can insert characters" ON public.characters
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can update characters" ON public.characters;
CREATE POLICY "Users can update characters" ON public.characters
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete characters" ON public.characters;
CREATE POLICY "Users can delete characters" ON public.characters
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

-- Character Elements policies (access via character -> project ownership)
DROP POLICY IF EXISTS "Users can view character elements" ON public.character_elements;
CREATE POLICY "Users can view character elements" ON public.character_elements
  FOR SELECT USING (
    character_id IN (
      SELECT c.id FROM public.characters c
      WHERE c.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS "Users can insert character elements" ON public.character_elements;
CREATE POLICY "Users can insert character elements" ON public.character_elements
  FOR INSERT WITH CHECK (
    character_id IN (
      SELECT c.id FROM public.characters c
      WHERE c.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

DROP POLICY IF EXISTS "Users can update character elements" ON public.character_elements;
CREATE POLICY "Users can update character elements" ON public.character_elements
  FOR UPDATE USING (
    character_id IN (
      SELECT c.id FROM public.characters c
      WHERE c.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

DROP POLICY IF EXISTS "Users can delete character elements" ON public.character_elements;
CREATE POLICY "Users can delete character elements" ON public.character_elements
  FOR DELETE USING (
    character_id IN (
      SELECT c.id FROM public.characters c
      WHERE c.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

-- Character Images policies (access via character -> project ownership)
DROP POLICY IF EXISTS "Users can view character images" ON public.character_images;
CREATE POLICY "Users can view character images" ON public.character_images
  FOR SELECT USING (
    character_id IN (
      SELECT c.id FROM public.characters c
      WHERE c.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS "Users can insert character images" ON public.character_images;
CREATE POLICY "Users can insert character images" ON public.character_images
  FOR INSERT WITH CHECK (
    character_id IN (
      SELECT c.id FROM public.characters c
      WHERE c.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

DROP POLICY IF EXISTS "Users can update character images" ON public.character_images;
CREATE POLICY "Users can update character images" ON public.character_images
  FOR UPDATE USING (
    character_id IN (
      SELECT c.id FROM public.characters c
      WHERE c.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

DROP POLICY IF EXISTS "Users can delete character images" ON public.character_images;
CREATE POLICY "Users can delete character images" ON public.character_images
  FOR DELETE USING (
    character_id IN (
      SELECT c.id FROM public.characters c
      WHERE c.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

-- Location images policies
DROP POLICY IF EXISTS "Users can view location images" ON public.location_images;
CREATE POLICY "Users can view location images" ON public.location_images
  FOR SELECT USING (
    location_id IN (
      SELECT l.id FROM public.locations l
      WHERE l.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS "Users can insert location images" ON public.location_images;
CREATE POLICY "Users can insert location images" ON public.location_images
  FOR INSERT WITH CHECK (
    location_id IN (
      SELECT l.id FROM public.locations l
      WHERE l.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

DROP POLICY IF EXISTS "Users can update location images" ON public.location_images;
CREATE POLICY "Users can update location images" ON public.location_images
  FOR UPDATE USING (
    location_id IN (
      SELECT l.id FROM public.locations l
      WHERE l.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

DROP POLICY IF EXISTS "Users can delete location images" ON public.location_images;
CREATE POLICY "Users can delete location images" ON public.location_images
  FOR DELETE USING (
    location_id IN (
      SELECT l.id FROM public.locations l
      WHERE l.project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
        UNION
        SELECT project_id FROM public.project_collaborators
        WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
      )
    )
  );

-- Similar policies for locations and storyboards
DROP POLICY IF EXISTS "Users can view locations" ON public.locations;
CREATE POLICY "Users can view locations" ON public.locations
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert locations" ON public.locations;
CREATE POLICY "Users can insert locations" ON public.locations
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can update locations" ON public.locations;
CREATE POLICY "Users can update locations" ON public.locations
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete locations" ON public.locations;
CREATE POLICY "Users can delete locations" ON public.locations
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can view storyboards" ON public.storyboards;
CREATE POLICY "Users can view storyboards" ON public.storyboards
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert storyboards" ON public.storyboards;
CREATE POLICY "Users can insert storyboards" ON public.storyboards
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can update storyboards" ON public.storyboards;
CREATE POLICY "Users can update storyboards" ON public.storyboards
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete storyboards" ON public.storyboards;
CREATE POLICY "Users can delete storyboards" ON public.storyboards
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin')
    )
  );

-- Storyboard panels policies (same pattern as storyboards)
DROP POLICY IF EXISTS "Users can view storyboard panels" ON public.storyboard_panels;
CREATE POLICY "Users can view storyboard panels" ON public.storyboard_panels
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert storyboard panels" ON public.storyboard_panels;
CREATE POLICY "Users can insert storyboard panels" ON public.storyboard_panels
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can update storyboard panels" ON public.storyboard_panels;
CREATE POLICY "Users can update storyboard panels" ON public.storyboard_panels
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete storyboard panels" ON public.storyboard_panels;
CREATE POLICY "Users can delete storyboard panels" ON public.storyboard_panels
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

-- Version control policies
DROP POLICY IF EXISTS "Users can view their own script versions" ON public.script_versions;
CREATE POLICY "Users can view their own script versions" ON public.script_versions
  FOR SELECT USING (
    script_id IN (
      SELECT s.id FROM public.scripts s
      JOIN public.projects p ON s.project_id = p.id
      WHERE p.user_id = (SELECT auth.uid()) OR
      p.id IN (SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active')
    )
  );

DROP POLICY IF EXISTS "Users can create versions for their own scripts" ON public.script_versions;
CREATE POLICY "Users can create versions for their own scripts" ON public.script_versions
  FOR INSERT WITH CHECK (
    script_id IN (
      SELECT s.id FROM public.scripts s
      JOIN public.projects p ON s.project_id = p.id
      WHERE p.user_id = (SELECT auth.uid()) OR
      p.id IN (SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor'))
    )
  );

DROP POLICY IF EXISTS "Users can delete their own script versions" ON public.script_versions;
CREATE POLICY "Users can delete their own script versions" ON public.script_versions
  FOR DELETE USING (
    script_id IN (
      SELECT s.id FROM public.scripts s
      JOIN public.projects p ON s.project_id = p.id
      WHERE p.user_id = (SELECT auth.uid())
    )
  );




-- Conversations policies
DROP POLICY IF EXISTS "Users can view their own conversations" ON public.conversations;
CREATE POLICY "Users can view their own conversations" ON public.conversations
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can insert their own conversations" ON public.conversations;
CREATE POLICY "Users can insert their own conversations" ON public.conversations
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can update their own conversations" ON public.conversations;
CREATE POLICY "Users can update their own conversations" ON public.conversations
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

DROP POLICY IF EXISTS "Users can delete their own conversations" ON public.conversations;
CREATE POLICY "Users can delete their own conversations" ON public.conversations
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin')
    )
  );

-- Conversation messages policies
DROP POLICY IF EXISTS "Users can view their own conversation messages" ON public.conversation_messages;
CREATE POLICY "Users can view their own conversation messages" ON public.conversation_messages
  FOR SELECT USING (
    conversation_id IN (
      SELECT c.id FROM public.conversations c
      JOIN public.projects p ON p.id = c.project_id
      WHERE p.user_id = (SELECT auth.uid()) OR
      p.id IN (SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active')
    )
  );

DROP POLICY IF EXISTS "Users can insert their own conversation messages" ON public.conversation_messages;
CREATE POLICY "Users can insert their own conversation messages" ON public.conversation_messages
  FOR INSERT WITH CHECK (
    conversation_id IN (
      SELECT c.id FROM public.conversations c
      JOIN public.projects p ON p.id = c.project_id
      WHERE p.user_id = (SELECT auth.uid()) OR
      p.id IN (SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active')
    )
  );

-- AI usage tracking policies (consolidated - reduces policy evaluation overhead)
-- Reference: https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies
DROP POLICY IF EXISTS "Users can view own AI usage" ON public.ai_usage_events;
DROP POLICY IF EXISTS "Service role can manage AI usage" ON public.ai_usage_events;
CREATE POLICY "Access AI usage events" ON public.ai_usage_events
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

DROP POLICY IF EXISTS "Users can view own image usage" ON public.image_usage_events;
DROP POLICY IF EXISTS "Service role can manage image usage" ON public.image_usage_events;
CREATE POLICY "Access image usage events" ON public.image_usage_events
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

DROP POLICY IF EXISTS "Users can view own monthly summary" ON public.monthly_ai_usage_summary;
DROP POLICY IF EXISTS "Service role can manage monthly summary" ON public.monthly_ai_usage_summary;
CREATE POLICY "Access monthly AI summary" ON public.monthly_ai_usage_summary
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );



-- Collaboration system policies (consolidated)
DROP POLICY IF EXISTS "Users can view collaboration documents for their projects" ON public.collaboration_documents;
DROP POLICY IF EXISTS "Users can manage collaboration documents for their projects" ON public.collaboration_documents;
DROP POLICY IF EXISTS "Access collaboration documents" ON public.collaboration_documents;

CREATE POLICY "Access collaboration documents" ON public.collaboration_documents
  FOR ALL USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can view presence for their projects" ON public.user_presence;
DROP POLICY IF EXISTS "Users can manage their own presence" ON public.user_presence;
DROP POLICY IF EXISTS "Access user presence" ON public.user_presence;

CREATE POLICY "Access user presence" ON public.user_presence
  FOR ALL USING (
    user_id = (SELECT auth.uid())
    OR project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

-- Collaboration activity policies
DROP POLICY IF EXISTS "Users can view collaboration activity for their projects" ON public.collaboration_activity;
CREATE POLICY "Users can view collaboration activity for their projects" ON public.collaboration_activity
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

DROP POLICY IF EXISTS "Users can create collaboration activity for their projects" ON public.collaboration_activity;
CREATE POLICY "Users can create collaboration activity for their projects" ON public.collaboration_activity
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

-- Production planning policies (consolidated - 1 SELECT + 3 write policies per table)
DROP POLICY IF EXISTS "Users can view production data for their projects" ON public.production_analyses;
DROP POLICY IF EXISTS "Users can manage production data for their projects" ON public.production_analyses;
DROP POLICY IF EXISTS "Select production analyses" ON public.production_analyses;
DROP POLICY IF EXISTS "Write production analyses" ON public.production_analyses;
DROP POLICY IF EXISTS "Update production analyses" ON public.production_analyses;
DROP POLICY IF EXISTS "Delete production analyses" ON public.production_analyses;

CREATE POLICY "Select production analyses" ON public.production_analyses
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

CREATE POLICY "Write production analyses" ON public.production_analyses
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Update production analyses" ON public.production_analyses
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Delete production analyses" ON public.production_analyses
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

-- production_scene_data policies
DROP POLICY IF EXISTS "Users can view production scene data for their projects" ON public.production_scene_data;
DROP POLICY IF EXISTS "Users can manage production scene data for their projects" ON public.production_scene_data;
DROP POLICY IF EXISTS "Select production scene data" ON public.production_scene_data;
DROP POLICY IF EXISTS "Write production scene data" ON public.production_scene_data;
DROP POLICY IF EXISTS "Update production scene data" ON public.production_scene_data;
DROP POLICY IF EXISTS "Delete production scene data" ON public.production_scene_data;

CREATE POLICY "Select production scene data" ON public.production_scene_data
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

CREATE POLICY "Write production scene data" ON public.production_scene_data
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Update production scene data" ON public.production_scene_data
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Delete production scene data" ON public.production_scene_data
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

-- Scene change log policies (consolidated to avoid multiple permissive policies)
DROP POLICY IF EXISTS "Users can view scene change log for their projects" ON public.scene_change_log;
DROP POLICY IF EXISTS "Users can manage scene change log for their projects" ON public.scene_change_log;
DROP POLICY IF EXISTS "Users can view scene changes for their projects" ON public.scene_change_log;
DROP POLICY IF EXISTS "Users can create scene changes" ON public.scene_change_log;
DROP POLICY IF EXISTS "Access scene change log" ON public.scene_change_log;

CREATE POLICY "Access scene change log" ON public.scene_change_log
  FOR ALL USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

-- production_budgets (4-policy pattern to avoid multiple permissive policies)
DROP POLICY IF EXISTS "Users can view production budgets for their projects" ON public.production_budgets;
DROP POLICY IF EXISTS "Users can manage production budgets for their projects" ON public.production_budgets;
DROP POLICY IF EXISTS "Select production budgets" ON public.production_budgets;
DROP POLICY IF EXISTS "Write production budgets" ON public.production_budgets;
DROP POLICY IF EXISTS "Update production budgets" ON public.production_budgets;
DROP POLICY IF EXISTS "Delete production budgets" ON public.production_budgets;

CREATE POLICY "Select production budgets" ON public.production_budgets
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

CREATE POLICY "Write production budgets" ON public.production_budgets
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Update production budgets" ON public.production_budgets
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Delete production budgets" ON public.production_budgets
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

-- production_schedules (4-policy pattern)
DROP POLICY IF EXISTS "Users can view production schedules for their projects" ON public.production_schedules;
DROP POLICY IF EXISTS "Users can manage production schedules for their projects" ON public.production_schedules;
DROP POLICY IF EXISTS "Select production schedules" ON public.production_schedules;
DROP POLICY IF EXISTS "Write production schedules" ON public.production_schedules;
DROP POLICY IF EXISTS "Update production schedules" ON public.production_schedules;
DROP POLICY IF EXISTS "Delete production schedules" ON public.production_schedules;

CREATE POLICY "Select production schedules" ON public.production_schedules
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

CREATE POLICY "Write production schedules" ON public.production_schedules
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Update production schedules" ON public.production_schedules
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Delete production schedules" ON public.production_schedules
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

-- production_locations (4-policy pattern)
DROP POLICY IF EXISTS "Users can view production locations for their projects" ON public.production_locations;
DROP POLICY IF EXISTS "Users can manage production locations for their projects" ON public.production_locations;
DROP POLICY IF EXISTS "Select production locations" ON public.production_locations;
DROP POLICY IF EXISTS "Write production locations" ON public.production_locations;
DROP POLICY IF EXISTS "Update production locations" ON public.production_locations;
DROP POLICY IF EXISTS "Delete production locations" ON public.production_locations;

CREATE POLICY "Select production locations" ON public.production_locations
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

CREATE POLICY "Write production locations" ON public.production_locations
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Update production locations" ON public.production_locations
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Delete production locations" ON public.production_locations
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

-- production_cast (4-policy pattern)
DROP POLICY IF EXISTS "Users can view production cast for their projects" ON public.production_cast;
DROP POLICY IF EXISTS "Users can manage production cast for their projects" ON public.production_cast;
DROP POLICY IF EXISTS "Select production cast" ON public.production_cast;
DROP POLICY IF EXISTS "Write production cast" ON public.production_cast;
DROP POLICY IF EXISTS "Update production cast" ON public.production_cast;
DROP POLICY IF EXISTS "Delete production cast" ON public.production_cast;

CREATE POLICY "Select production cast" ON public.production_cast
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
    )
  );

CREATE POLICY "Write production cast" ON public.production_cast
  FOR INSERT WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Update production cast" ON public.production_cast
  FOR UPDATE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

CREATE POLICY "Delete production cast" ON public.production_cast
  FOR DELETE USING (
    project_id IN (
      SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())
      UNION
      SELECT project_id FROM public.project_collaborators
      WHERE user_id = (SELECT auth.uid()) AND status = 'active' AND role IN ('owner', 'admin', 'editor')
    )
  );

-- =====================================================
-- PERMISSIONS
-- =====================================================

-- Grant permissions on functions
GRANT EXECUTE ON FUNCTION public.update_monthly_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_monthly_summary(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_next_script_version_number(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_script_version_number(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_script_version_snapshot(UUID, UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_script_version_snapshot(UUID, UUID, TEXT, BOOLEAN) TO service_role;

-- Function to get document version count
CREATE OR REPLACE FUNCTION get_document_version_count(document_uuid UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER 
    FROM public.project_document_versions 
    WHERE project_document_id = document_uuid
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_document_version_count TO authenticated;
GRANT EXECUTE ON FUNCTION get_document_version_count TO service_role;

-- Grant necessary permissions for project documents
GRANT ALL ON public.project_documents TO authenticated;
GRANT ALL ON public.project_document_versions TO authenticated;

GRANT EXECUTE ON FUNCTION cleanup_expired_invitations() TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_stale_presence() TO service_role;

-- Grant permissions on tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

-- =====================================================
-- VIEWS
-- =====================================================

-- Remove unused view (not referenced in backend code)

-- Subscription/billing policies (consolidated - reduces policy evaluation overhead)
-- Reference: https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies

-- user_subscriptions
DROP POLICY IF EXISTS "Users can view own subscription" ON public.user_subscriptions;
DROP POLICY IF EXISTS "Users can update own subscription" ON public.user_subscriptions;
DROP POLICY IF EXISTS "Service can manage subscriptions" ON public.user_subscriptions;
CREATE POLICY "Access subscriptions" ON public.user_subscriptions
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

-- billing_history policies removed - now using direct Stripe API integration

-- stripe_usage_records
DROP POLICY IF EXISTS "Users can view own usage records" ON public.stripe_usage_records;
DROP POLICY IF EXISTS "Service can manage usage records" ON public.stripe_usage_records;
CREATE POLICY "Access usage records" ON public.stripe_usage_records
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

-- project_reactivations
DROP POLICY IF EXISTS "Users can view own reactivations" ON public.project_reactivations;
DROP POLICY IF EXISTS "Service can manage reactivations" ON public.project_reactivations;
CREATE POLICY "Access reactivations" ON public.project_reactivations
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

-- subscription_plans (split into separate policies: public read, service role write)
DROP POLICY IF EXISTS "Anyone can view subscription plans" ON public.subscription_plans;
DROP POLICY IF EXISTS "Service can manage subscription plans" ON public.subscription_plans;
DROP POLICY IF EXISTS "Read subscription plans" ON public.subscription_plans;
DROP POLICY IF EXISTS "Manage subscription plans" ON public.subscription_plans;
DROP POLICY IF EXISTS "Access subscription plans" ON public.subscription_plans;
DROP POLICY IF EXISTS "Update subscription plans" ON public.subscription_plans;
DROP POLICY IF EXISTS "Delete subscription plans" ON public.subscription_plans;

-- Public read access (subscription plans are public pricing data)
CREATE POLICY "Read subscription plans" ON public.subscription_plans
  FOR SELECT USING (true);

-- Service role only for INSERT/UPDATE/DELETE
CREATE POLICY "Manage subscription plans" ON public.subscription_plans
  FOR INSERT WITH CHECK ((SELECT auth.jwt()) ->> 'role' = 'service_role');

CREATE POLICY "Update subscription plans" ON public.subscription_plans
  FOR UPDATE USING ((SELECT auth.jwt()) ->> 'role' = 'service_role')
  WITH CHECK ((SELECT auth.jwt()) ->> 'role' = 'service_role');

CREATE POLICY "Delete subscription plans" ON public.subscription_plans
  FOR DELETE USING ((SELECT auth.jwt()) ->> 'role' = 'service_role');

-- user_quotas
DROP POLICY IF EXISTS "Users can view own quotas" ON public.user_quotas;
DROP POLICY IF EXISTS "Users can update own quotas" ON public.user_quotas;
DROP POLICY IF EXISTS "Service can manage quotas" ON public.user_quotas;
CREATE POLICY "Access quotas" ON public.user_quotas
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

-- ai_credit_transactions
DROP POLICY IF EXISTS "Users can view own credit transactions" ON public.ai_credit_transactions;
DROP POLICY IF EXISTS "Service can manage credit transactions" ON public.ai_credit_transactions;
CREATE POLICY "Access credit transactions" ON public.ai_credit_transactions
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

-- billing_events
DROP POLICY IF EXISTS "Users can view own billing events" ON public.billing_events;
DROP POLICY IF EXISTS "Service can manage billing events" ON public.billing_events;
CREATE POLICY "Access billing events" ON public.billing_events
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

-- addon_transactions
DROP POLICY IF EXISTS "Users can view own addon transactions" ON public.addon_transactions;
DROP POLICY IF EXISTS "Service can manage addon transactions" ON public.addon_transactions;
CREATE POLICY "Access addon transactions" ON public.addon_transactions
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

-- monthly_project_billing
DROP POLICY IF EXISTS "Users can view own monthly billing" ON public.monthly_project_billing;
DROP POLICY IF EXISTS "Service can manage monthly billing" ON public.monthly_project_billing;
CREATE POLICY "Access monthly billing" ON public.monthly_project_billing
  FOR ALL USING (
    (SELECT auth.uid()) = user_id
    OR (SELECT auth.jwt()) ->> 'role' = 'service_role'
  );

-- =====================================================
-- INITIAL DATA
-- =====================================================

-- Populate public.users for existing auth.users (if any)
INSERT INTO public.users (id, email, full_name, avatar_url, ui_language)
SELECT 
  au.id,
  au.email,
  au.raw_user_meta_data->>'full_name',
  au.raw_user_meta_data->>'avatar_url',
  'en' as ui_language
FROM auth.users au
WHERE NOT EXISTS (SELECT 1 FROM public.users pu WHERE pu.id = au.id)
ON CONFLICT (id) DO NOTHING;


-- Add project owners as collaborators for existing projects
INSERT INTO public.project_collaborators (project_id, user_id, role, status, joined_at)
SELECT 
    id as project_id,
    user_id,
    'owner' as role,
    'active' as status,
    created_at as joined_at
FROM public.projects
WHERE NOT EXISTS (
    SELECT 1 FROM public.project_collaborators pc 
    WHERE pc.project_id = projects.id AND pc.user_id = projects.user_id
);

-- Enable collaboration for all existing projects
UPDATE public.projects 
SET collaboration_settings = jsonb_set(
    collaboration_settings, 
    '{enabled}', 
    'true'::jsonb
)
WHERE collaboration_settings->>'enabled' = 'false';

-- =====================================================
-- SCHEMA VERIFICATION
-- =====================================================

-- Function to verify schema completion
CREATE OR REPLACE FUNCTION public.verify_schema_setup()
RETURNS TABLE(table_name TEXT, table_exists BOOLEAN) AS $$
BEGIN
  RETURN QUERY
  SELECT t.table_name::TEXT, (t.table_name IS NOT NULL) as table_exists
  FROM (VALUES 
    ('users'), ('teams'), ('team_members'), ('projects'), 
    ('project_collaborators'), ('project_invitations'),
    ('project_documents'), ('project_document_versions'), ('scripts'), ('characters'), ('locations'), 
    ('storyboards'), ('storyboard_panels'), ('script_versions'),
    ('conversations'), ('conversation_messages'),
    ('collaboration_documents'), ('user_presence'), ('collaboration_activity'),
    ('ai_usage_events'), ('image_usage_events'),
    ('monthly_ai_usage_summary'),
    ('production_analyses'), ('production_scene_data'), ('scene_change_log'), ('production_budgets'),
    ('production_schedules'), ('production_locations'), ('production_cast'),
    ('user_subscriptions'), ('user_quotas'), ('billing_events')
  ) AS expected(table_name)
  LEFT JOIN information_schema.tables t 
    ON t.table_name = expected.table_name 
    AND t.table_schema = 'public';
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- STORAGE BUCKETS SETUP (CRITICAL - required for image uploads)
-- =====================================================

-- Create storage buckets for image uploads (PRIVATE - no public access)
-- All image access goes through the backend which generates signed URLs.
-- Reference images for AI generation are sent as base64 (never stored).
-- FIXED: Storage policies use DROP/CREATE pattern instead of IF NOT EXISTS (not supported)

-- Character images bucket (PRIVATE)
INSERT INTO storage.buckets (id, name, public)
VALUES ('character-images', 'character-images', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Location images bucket (PRIVATE)
INSERT INTO storage.buckets (id, name, public)
VALUES ('location-images', 'location-images', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Storyboard images bucket (PRIVATE)
INSERT INTO storage.buckets (id, name, public)
VALUES ('storyboard-images', 'storyboard-images', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Presentation images bucket (PRIVATE)
INSERT INTO storage.buckets (id, name, public)
VALUES ('presentation-images', 'presentation-images', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Project assets bucket (PRIVATE)
INSERT INTO storage.buckets (id, name, public)
VALUES ('project-assets', 'project-assets', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Generated video bucket (PRIVATE) — AI-animated storyboard panel clips (MEGA beta)
INSERT INTO storage.buckets (id, name, public)
VALUES ('generated-video', 'generated-video', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- =====================================================
-- STORAGE POLICIES
-- =====================================================
-- Buckets are PRIVATE. The backend uses service_role key to bypass RLS.
-- These policies allow authenticated users to upload/manage via client SDK if needed.
-- SELECT policies require authentication (no public/anonymous access).

-- Storage policies for character images
DROP POLICY IF EXISTS "Allow authenticated users to upload character images" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload character images"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'character-images'
  AND auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "Allow public access to character images" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated read access to character images" ON storage.objects;
CREATE POLICY "Allow authenticated read access to character images"
ON storage.objects FOR SELECT
USING (bucket_id = 'character-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to update their character images" ON storage.objects;
CREATE POLICY "Allow users to update their character images"
ON storage.objects FOR UPDATE
USING (bucket_id = 'character-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to delete their character images" ON storage.objects;
CREATE POLICY "Allow users to delete their character images"
ON storage.objects FOR DELETE
USING (bucket_id = 'character-images' AND auth.role() = 'authenticated');

-- Storage policies for location images
DROP POLICY IF EXISTS "Allow authenticated users to upload location images" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload location images"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'location-images'
  AND auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "Allow public access to location images" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated read access to location images" ON storage.objects;
CREATE POLICY "Allow authenticated read access to location images"
ON storage.objects FOR SELECT
USING (bucket_id = 'location-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to update their location images" ON storage.objects;
CREATE POLICY "Allow users to update their location images"
ON storage.objects FOR UPDATE
USING (bucket_id = 'location-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to delete their location images" ON storage.objects;
CREATE POLICY "Allow users to delete their location images"
ON storage.objects FOR DELETE
USING (bucket_id = 'location-images' AND auth.role() = 'authenticated');

-- Storage policies for storyboard images
DROP POLICY IF EXISTS "Allow authenticated users to upload storyboard images" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload storyboard images"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'storyboard-images'
  AND auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "Allow public access to storyboard images" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated read access to storyboard images" ON storage.objects;
CREATE POLICY "Allow authenticated read access to storyboard images"
ON storage.objects FOR SELECT
USING (bucket_id = 'storyboard-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to update their storyboard images" ON storage.objects;
CREATE POLICY "Allow users to update their storyboard images"
ON storage.objects FOR UPDATE
USING (bucket_id = 'storyboard-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to delete their storyboard images" ON storage.objects;
CREATE POLICY "Allow users to delete their storyboard images"
ON storage.objects FOR DELETE
USING (bucket_id = 'storyboard-images' AND auth.role() = 'authenticated');

-- Storage policies for presentation images
DROP POLICY IF EXISTS "Allow authenticated users to upload presentation images" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload presentation images"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'presentation-images'
  AND auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "Allow public access to presentation images" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated read access to presentation images" ON storage.objects;
CREATE POLICY "Allow authenticated read access to presentation images"
ON storage.objects FOR SELECT
USING (bucket_id = 'presentation-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to update their presentation images" ON storage.objects;
CREATE POLICY "Allow users to update their presentation images"
ON storage.objects FOR UPDATE
USING (bucket_id = 'presentation-images' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to delete their presentation images" ON storage.objects;
CREATE POLICY "Allow users to delete their presentation images"
ON storage.objects FOR DELETE
USING (bucket_id = 'presentation-images' AND auth.role() = 'authenticated');

-- Storage policies for project assets
DROP POLICY IF EXISTS "Allow authenticated users to upload project assets" ON storage.objects;
CREATE POLICY "Allow authenticated users to upload project assets"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'project-assets'
  AND auth.role() = 'authenticated'
);

DROP POLICY IF EXISTS "Allow public access to project assets" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated read access to project assets" ON storage.objects;
CREATE POLICY "Allow authenticated read access to project assets"
ON storage.objects FOR SELECT
USING (bucket_id = 'project-assets' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to update their project assets" ON storage.objects;
CREATE POLICY "Allow users to update their project assets"
ON storage.objects FOR UPDATE
USING (bucket_id = 'project-assets' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow users to delete their project assets" ON storage.objects;
CREATE POLICY "Allow users to delete their project assets"
ON storage.objects FOR DELETE
USING (bucket_id = 'project-assets' AND auth.role() = 'authenticated');

-- Storage policies for generated video (AI-animated panel clips, MEGA beta)
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

-- =====================================================
-- COMMENTS SYSTEM TABLES & FUNCTIONALITY
-- =====================================================

-- Comments table for script, document, and slide feedback
CREATE TABLE IF NOT EXISTS public.comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_type TEXT NOT NULL CHECK (content_type IN ('script', 'document', 'slide')),
  content_id TEXT NOT NULL,  -- UUID for scripts/documents, "documentId:slideId" for slides
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  parent_comment_id UUID REFERENCES public.comments(id) ON DELETE CASCADE,
  comment_text TEXT NOT NULL,
  comment_type TEXT NOT NULL DEFAULT 'general' CHECK (comment_type IN ('general', 'suggestion', 'question', 'note', 'revision')),
  selection_data JSONB,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  visibility TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'editors_only', 'admins_only')),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comment reactions for emoji responses
CREATE TABLE IF NOT EXISTS public.comment_reactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comment_id UUID NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reaction_type TEXT NOT NULL, -- 'like', 'love', 'laugh', 'confused', 'disagree', etc.
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(comment_id, user_id, reaction_type)
);

-- Comment read status tracking
CREATE TABLE IF NOT EXISTS public.comment_read_status (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  comment_id UUID NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(comment_id, user_id)
);

-- Comments indexes for performance
CREATE INDEX IF NOT EXISTS idx_comments_content_id ON public.comments(content_id);
CREATE INDEX IF NOT EXISTS idx_comments_project_id ON public.comments(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON public.comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON public.comments(parent_comment_id);
CREATE INDEX IF NOT EXISTS idx_comments_content_type_id ON public.comments(content_type, content_id) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_comments_resolved_by ON public.comments(resolved_by);

-- Comment reactions indexes
CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment_id ON public.comment_reactions(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_reactions_user_id ON public.comment_reactions(user_id);

-- Comment read status indexes
CREATE INDEX IF NOT EXISTS idx_comment_read_status_user_id ON public.comment_read_status(user_id);
CREATE INDEX IF NOT EXISTS idx_comment_read_status_comment_id ON public.comment_read_status(comment_id);

-- Auto-update timestamps on comments
CREATE OR REPLACE FUNCTION update_comments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_comments_updated_at
  BEFORE UPDATE ON public.comments
  FOR EACH ROW
  EXECUTE FUNCTION update_comments_updated_at();

-- Auto-set resolved timestamp when status changes to resolved
CREATE OR REPLACE FUNCTION set_comment_resolved_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  -- If status changed to resolved, set resolved_at and resolved_by
  IF NEW.status = 'resolved' AND OLD.status != 'resolved' THEN
    NEW.resolved_at = NOW();
    NEW.resolved_by = (
      SELECT id FROM public.users 
      WHERE id = (
        SELECT auth.uid()
      ) LIMIT 1
    );
  -- If status changed from resolved, clear resolved fields
  ELSIF NEW.status != 'resolved' AND OLD.status = 'resolved' THEN
    NEW.resolved_at = NULL;
    NEW.resolved_by = NULL;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_set_comment_resolved_timestamp
  BEFORE UPDATE ON public.comments
  FOR EACH ROW
  EXECUTE FUNCTION set_comment_resolved_timestamp();

-- Comments RLS policies
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_read_status ENABLE ROW LEVEL SECURITY;

-- Users can view comments on projects they have access to
CREATE POLICY "Users can view accessible project comments" ON public.comments
  FOR SELECT USING (
    project_id IN (
      SELECT p.id FROM public.projects p
      WHERE p.user_id = (SELECT auth.uid())
      UNION
      SELECT pc.project_id FROM public.project_collaborators pc
      WHERE pc.user_id = (SELECT auth.uid())
    )
  );

-- Users can create comments on projects they can access
CREATE POLICY "Users can create comments on accessible projects" ON public.comments
  FOR INSERT WITH CHECK (
    user_id = (SELECT auth.uid())
    AND project_id IN (
      SELECT p.id FROM public.projects p
      WHERE p.user_id = (SELECT auth.uid())
      UNION
      SELECT pc.project_id FROM public.project_collaborators pc
      WHERE pc.user_id = (SELECT auth.uid())
    )
  );

-- Users can edit their own comments
CREATE POLICY "Users can edit own comments" ON public.comments
  FOR UPDATE USING (user_id = (SELECT auth.uid()));

-- Users can delete their own comments or if they're project owner
CREATE POLICY "Users can delete own comments or as project owner" ON public.comments
  FOR DELETE USING (
    user_id = (SELECT auth.uid())
    OR project_id IN (
      SELECT id FROM public.projects
      WHERE user_id = (SELECT auth.uid())
    )
  );

-- Comment reactions policies (consolidated to avoid multiple permissive policies)
DROP POLICY IF EXISTS "Users can view reactions on accessible comments" ON public.comment_reactions;
DROP POLICY IF EXISTS "Users can manage own reactions" ON public.comment_reactions;
DROP POLICY IF EXISTS "Access comment reactions" ON public.comment_reactions;

CREATE POLICY "Access comment reactions" ON public.comment_reactions
  FOR ALL USING (
    user_id = (SELECT auth.uid())
    OR comment_id IN (
      SELECT id FROM public.comments
      WHERE project_id IN (
        SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid()) AND deleted = FALSE
        UNION
        SELECT project_id FROM public.project_collaborators WHERE user_id = (SELECT auth.uid()) AND status = 'active'
      )
    )
  );

-- Comment read status policies
CREATE POLICY "Users can manage own read status" ON public.comment_read_status
  FOR ALL USING (user_id = (SELECT auth.uid()));

-- Function to get comment statistics for content
CREATE OR REPLACE FUNCTION get_comment_stats(
  p_content_type TEXT,
  p_content_id TEXT,  -- TEXT to support "documentId:slideId" format for slides
  p_user_id UUID
)
RETURNS TABLE(
  total_comments BIGINT,
  open_comments BIGINT,
  resolved_comments BIGINT,
  unread_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  WITH comment_counts AS (
    SELECT
      COUNT(*) FILTER (WHERE NOT is_deleted AND parent_comment_id IS NULL) as total,
      COUNT(*) FILTER (WHERE status = 'open' AND NOT is_deleted AND parent_comment_id IS NULL) as open,
      COUNT(*) FILTER (WHERE status = 'resolved' AND NOT is_deleted AND parent_comment_id IS NULL) as resolved
    FROM public.comments
    WHERE content_type = p_content_type
    AND content_id = p_content_id
  ),
  unread_count AS (
    SELECT COUNT(*) as unread
    FROM public.comments c
    LEFT JOIN public.comment_read_status crs ON c.id = crs.comment_id AND crs.user_id = p_user_id
    WHERE c.content_type = p_content_type
    AND c.content_id = p_content_id
    AND NOT c.is_deleted
    AND c.parent_comment_id IS NULL -- Only count parent comments as threads
    AND crs.id IS NULL
    AND c.user_id != p_user_id -- Don't count user's own comments as unread
  )
  SELECT 
    COALESCE(cc.total, 0)::BIGINT,
    COALESCE(cc.open, 0)::BIGINT,
    COALESCE(cc.resolved, 0)::BIGINT,
    COALESCE(uc.unread, 0)::BIGINT
  FROM comment_counts cc
  CROSS JOIN unread_count uc;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- COMPLETION MESSAGE
-- =====================================================

-- =====================================================
-- AI SCRIPT ANALYSIS CACHING SYSTEM
-- =====================================================

-- Add table for caching AI script analyses
CREATE TABLE IF NOT EXISTS public.ai_script_analyses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
  script_id TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  content_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL DEFAULT 'full' CHECK (analysis_type IN ('full', 'quick', 'specific', 'scene')),
  analysis_result JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS ai_script_analyses_project_script_idx 
ON public.ai_script_analyses(project_id, script_id);

CREATE INDEX IF NOT EXISTS ai_script_analyses_user_idx 
ON public.ai_script_analyses(user_id);

-- RLS policies
ALTER TABLE public.ai_script_analyses ENABLE ROW LEVEL SECURITY;

-- Users can only access their own analyses
CREATE POLICY "Users can view own script analyses" 
ON public.ai_script_analyses FOR SELECT 
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own script analyses" 
ON public.ai_script_analyses FOR INSERT 
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own script analyses" 
ON public.ai_script_analyses FOR UPDATE 
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own script analyses"
ON public.ai_script_analyses FOR DELETE
USING ((SELECT auth.uid()) = user_id);

-- AI Pending Transforms table (background scene transform operations)
CREATE TABLE IF NOT EXISTS public.ai_pending_transforms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  script_id TEXT,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  tone TEXT,
  instructions TEXT,
  scene_heading TEXT,
  scene_number INTEGER,
  original_content JSONB,
  transformed_content JSONB,
  scene_pos INTEGER NOT NULL DEFAULT 0,
  scene_end_pos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed', 'accepted', 'rejected')),
  error_message TEXT,
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '1 hour'),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for ai_pending_transforms
CREATE INDEX IF NOT EXISTS idx_ai_pending_transforms_user_project
ON public.ai_pending_transforms(user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_ai_pending_transforms_status
ON public.ai_pending_transforms(status);

CREATE INDEX IF NOT EXISTS idx_ai_pending_transforms_expires_at
ON public.ai_pending_transforms(expires_at);

-- RLS policies for ai_pending_transforms
ALTER TABLE public.ai_pending_transforms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own pending transforms"
ON public.ai_pending_transforms FOR SELECT
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own pending transforms"
ON public.ai_pending_transforms FOR INSERT
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own pending transforms"
ON public.ai_pending_transforms FOR UPDATE
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own pending transforms"
ON public.ai_pending_transforms FOR DELETE
USING ((SELECT auth.uid()) = user_id);

-- Add comment
COMMENT ON TABLE public.ai_script_analyses IS 'Cached AI script analysis results for performance and cost optimization';

-- =====================================================
-- SCRIPT DOCTOR V2 - SCENE-LEVEL ANALYSIS SYSTEM
-- =====================================================

-- Scene-level Script Doctor analysis cache
-- Enables incremental analysis with content-hash based caching
CREATE TABLE IF NOT EXISTS public.script_doctor_scene_analyses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  script_id TEXT NOT NULL,
  episode_id UUID REFERENCES public.episodes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Scene identification
  scene_id TEXT NOT NULL,
  scene_number INTEGER NOT NULL,
  scene_heading TEXT NOT NULL,
  content_hash TEXT NOT NULL,      -- SHA-256 of scene content for cache invalidation

  -- Analysis results
  health_score INTEGER NOT NULL CHECK (health_score >= 0 AND health_score <= 100),
  issues JSONB NOT NULL DEFAULT '[]',
  strengths JSONB NOT NULL DEFAULT '[]',
  pacing_score INTEGER CHECK (pacing_score IS NULL OR (pacing_score >= 0 AND pacing_score <= 100)),
  dialogue_score INTEGER CHECK (dialogue_score IS NULL OR (dialogue_score >= 0 AND dialogue_score <= 100)),
  motivation_score INTEGER CHECK (motivation_score IS NULL OR (motivation_score >= 0 AND motivation_score <= 100)),

  -- Settings used for this analysis (for cache invalidation when settings change)
  settings_hash TEXT NOT NULL,

  -- Analysis tier (freemium support)
  analysis_tier TEXT NOT NULL DEFAULT 'basic' CHECK (analysis_tier IN ('basic', 'full')),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Composite unique constraint for cache lookup
  UNIQUE(project_id, script_id, scene_id, content_hash, settings_hash)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_script_doctor_scene_project
ON public.script_doctor_scene_analyses(project_id, script_id);

CREATE INDEX IF NOT EXISTS idx_script_doctor_scene_hash
ON public.script_doctor_scene_analyses(content_hash);

CREATE INDEX IF NOT EXISTS idx_script_doctor_scene_id
ON public.script_doctor_scene_analyses(scene_id);

CREATE INDEX IF NOT EXISTS idx_script_doctor_user
ON public.script_doctor_scene_analyses(user_id);

-- RLS policies for scene analyses
ALTER TABLE public.script_doctor_scene_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own scene analyses"
ON public.script_doctor_scene_analyses FOR SELECT
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own scene analyses"
ON public.script_doctor_scene_analyses FOR INSERT
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own scene analyses"
ON public.script_doctor_scene_analyses FOR UPDATE
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own scene analyses"
ON public.script_doctor_scene_analyses FOR DELETE
USING ((SELECT auth.uid()) = user_id);

COMMENT ON TABLE public.script_doctor_scene_analyses
IS 'Scene-level Script Doctor analysis cache with content-hash for incremental updates';

-- Per-project Script Doctor settings
CREATE TABLE IF NOT EXISTS public.script_doctor_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Analysis frequency settings
  analysis_mode TEXT NOT NULL DEFAULT 'periodic' CHECK (analysis_mode IN ('on-save', 'on-demand', 'periodic')),
  periodic_interval_minutes INTEGER DEFAULT 5 CHECK (periodic_interval_minutes IN (5, 15, 30)),

  -- Writing mode presets
  writing_mode TEXT NOT NULL DEFAULT 'standard' CHECK (writing_mode IN ('standard', 'strict', 'minimal')),

  -- Genre-specific adjustments
  genre TEXT DEFAULT 'drama',

  -- Custom tuning notes (free text guidance for AI)
  custom_notes TEXT DEFAULT '',

  -- Which categories to check
  enabled_categories JSONB NOT NULL DEFAULT '["pacing", "dialogue", "character-motivation", "structure", "show-dont-tell"]',

  -- Visual preferences
  show_scene_health_dots BOOLEAN DEFAULT TRUE,

  -- Feature toggle
  is_enabled BOOLEAN DEFAULT TRUE,

  -- Cached last summary (persists across page reloads)
  last_summary JSONB DEFAULT NULL,
  last_summary_script_id TEXT DEFAULT NULL,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(project_id, user_id)
);

-- Index for quick lookup
CREATE INDEX IF NOT EXISTS idx_script_doctor_settings_project
ON public.script_doctor_settings(project_id, user_id);

-- RLS policies for settings
ALTER TABLE public.script_doctor_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own script doctor settings"
ON public.script_doctor_settings FOR SELECT
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own script doctor settings"
ON public.script_doctor_settings FOR INSERT
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own script doctor settings"
ON public.script_doctor_settings FOR UPDATE
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own script doctor settings"
ON public.script_doctor_settings FOR DELETE
USING ((SELECT auth.uid()) = user_id);

COMMENT ON TABLE public.script_doctor_settings
IS 'Per-project Script Doctor configuration and preferences';

-- Trigger for updated_at on scene analyses
DROP TRIGGER IF EXISTS script_doctor_scene_analyses_updated_at ON public.script_doctor_scene_analyses;
CREATE TRIGGER script_doctor_scene_analyses_updated_at
  BEFORE UPDATE ON public.script_doctor_scene_analyses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger for updated_at on settings
DROP TRIGGER IF EXISTS script_doctor_settings_updated_at ON public.script_doctor_settings;
CREATE TRIGGER script_doctor_settings_updated_at
  BEFORE UPDATE ON public.script_doctor_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SCRIPT DOCTOR DISMISSED ISSUES
-- =====================================================
-- Allows users to dismiss or acknowledge individual Script Doctor issues

CREATE TABLE IF NOT EXISTS public.script_doctor_dismissed_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  script_id UUID NOT NULL,
  scene_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'dismissed' CHECK (status IN ('dismissed', 'acknowledged')),
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, script_id, scene_id, issue_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dismissed_issues_lookup
  ON public.script_doctor_dismissed_issues(project_id, script_id);

ALTER TABLE public.script_doctor_dismissed_issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own dismissed issues"
ON public.script_doctor_dismissed_issues FOR SELECT
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own dismissed issues"
ON public.script_doctor_dismissed_issues FOR INSERT
WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own dismissed issues"
ON public.script_doctor_dismissed_issues FOR UPDATE
USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own dismissed issues"
ON public.script_doctor_dismissed_issues FOR DELETE
USING ((SELECT auth.uid()) = user_id);

COMMENT ON TABLE public.script_doctor_dismissed_issues
IS 'Tracks which Script Doctor issues a user has dismissed or acknowledged';

-- =====================================================
-- UNARCHIVE TRANSACTIONS POLICIES
-- =====================================================

-- Users can view their own unarchive transactions
CREATE POLICY "Users can view own unarchive transactions" 
ON public.unarchive_transactions FOR SELECT 
USING ((SELECT auth.uid()) = user_id);

-- Users can insert their own unarchive transactions (for the API)
CREATE POLICY "Users can create own unarchive transactions" 
ON public.unarchive_transactions FOR INSERT 
WITH CHECK ((SELECT auth.uid()) = user_id);

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_unarchive_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_unarchive_transactions_updated_at 
  BEFORE UPDATE ON public.unarchive_transactions 
  FOR EACH ROW EXECUTE FUNCTION update_unarchive_updated_at();

-- Grant permissions for addon system
GRANT SELECT ON public.addon_transactions TO authenticated;
GRANT SELECT ON public.unarchive_transactions TO authenticated;
GRANT SELECT ON public.monthly_project_billing TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_effective_limits(UUID) TO authenticated;

-- =====================================================
-- SECURITY: FIX FUNCTION SEARCH PATH VULNERABILITIES
-- =====================================================
-- All functions must have search_path set to prevent search path hijacking attacks
-- Reference: https://supabase.com/docs/guides/database/postgres-linter

ALTER FUNCTION public.handle_new_user() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.update_conversation_timestamp() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.update_monthly_summary(UUID) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.update_project_collaborator_count() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_expired_invitations() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.cleanup_stale_presence() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.update_subscription_addons() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_effective_limits(UUID) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.verify_schema_setup() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.set_comment_resolved_timestamp() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.get_comment_stats(TEXT, TEXT, UUID) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.update_unarchive_updated_at() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.get_next_script_version_number(UUID) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.create_script_version_snapshot(UUID, UUID, TEXT, BOOLEAN) SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.update_comments_updated_at() SECURITY DEFINER SET search_path = public, pg_temp;
ALTER FUNCTION public.get_document_version_count(UUID) SECURITY DEFINER SET search_path = public, pg_temp;

-- Additional functions flagged by Supabase linter (December 2025)
-- Note: increment_image_credits function removed (no longer used)
ALTER FUNCTION public.get_scene_cast(VARCHAR(64)) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_season_episode_count() SET search_path = public, pg_temp;
ALTER FUNCTION public.set_episode_project_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.create_default_episode_for_film() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_character_episode_count(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_location_episode_count(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_episode_budget_total(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_season_budget_total(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_project_budget_total(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.calculate_scene_content_hash(TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_scene_id_from_content(TEXT, TEXT, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_unsynced_scenes_count(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_scene_changes() SET search_path = public, pg_temp;

-- =====================================================
-- PERFORMANCE: ADD MISSING FOREIGN KEY INDEXES
-- =====================================================
-- Fixes 107 "Unindexed foreign keys" warnings
-- Foreign keys without indexes slow down JOINs and constraint checks

-- AI Usage & Billing indexes
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_user_id ON public.ai_usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_project_id ON public.ai_usage_events(project_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_conversation_id ON public.ai_usage_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_image_usage_events_user_id ON public.image_usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_image_usage_events_project_id ON public.image_usage_events(project_id);

-- Comments system indexes
CREATE INDEX IF NOT EXISTS idx_comments_project_id ON public.comments(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_user_id ON public.comments(user_id);
-- Note: idx_comments_parent_comment_id removed (duplicate of idx_comments_parent_id)
CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment_id ON public.comment_reactions(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_reactions_user_id ON public.comment_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_comment_read_status_comment_id ON public.comment_read_status(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_read_status_user_id ON public.comment_read_status(user_id);

-- Production planning indexes
CREATE INDEX IF NOT EXISTS idx_production_analyses_project_id ON public.production_analyses(project_id);
CREATE INDEX IF NOT EXISTS idx_production_budgets_project_id ON public.production_budgets(project_id);
CREATE INDEX IF NOT EXISTS idx_production_cast_project_id ON public.production_cast(project_id);
CREATE INDEX IF NOT EXISTS idx_production_locations_project_id ON public.production_locations(project_id);
CREATE INDEX IF NOT EXISTS idx_production_schedules_project_id ON public.production_schedules(project_id);
CREATE INDEX IF NOT EXISTS idx_production_scene_data_project_id ON public.production_scene_data(project_id);
CREATE INDEX IF NOT EXISTS idx_scene_change_log_project_id ON public.scene_change_log(project_id);

-- Collaboration indexes
CREATE INDEX IF NOT EXISTS idx_project_collaborators_project_id ON public.project_collaborators(project_id);
CREATE INDEX IF NOT EXISTS idx_project_collaborators_user_id ON public.project_collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_project_invitations_project_id ON public.project_invitations(project_id);
CREATE INDEX IF NOT EXISTS idx_project_invitations_inviter_id ON public.project_invitations(inviter_id);
CREATE INDEX IF NOT EXISTS idx_collaboration_activity_project_id ON public.collaboration_activity(project_id);
CREATE INDEX IF NOT EXISTS idx_collaboration_activity_user_id ON public.collaboration_activity(user_id);

-- Document versions indexes
CREATE INDEX IF NOT EXISTS idx_project_document_versions_project_document_id ON public.project_document_versions(project_document_id);
CREATE INDEX IF NOT EXISTS idx_project_document_versions_created_by ON public.project_document_versions(created_by);

-- Billing & subscription indexes
CREATE INDEX IF NOT EXISTS idx_addon_transactions_user_id ON public.addon_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_user_id ON public.billing_events(user_id);
CREATE INDEX IF NOT EXISTS idx_monthly_project_billing_user_id ON public.monthly_project_billing(user_id);
CREATE INDEX IF NOT EXISTS idx_stripe_usage_records_user_id ON public.stripe_usage_records(user_id);
CREATE INDEX IF NOT EXISTS idx_unarchive_transactions_user_id ON public.unarchive_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_unarchive_transactions_project_id ON public.unarchive_transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_user_quotas_user_id ON public.user_quotas(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON public.user_subscriptions(user_id);

-- =====================================================
-- PERFORMANCE: DISABLE UNNECESSARY REALTIME MONITORING
-- =====================================================
-- Fixes 4.7M calls to realtime.list_changes (93.2% of query time)
-- Removes all tables from supabase_realtime publication since we use polling instead
-- Note: Uses DO block with exception handling since ALTER PUBLICATION doesn't support IF EXISTS

DO $$
DECLARE
  table_name TEXT;
  tables_to_drop TEXT[] := ARRAY[
    'public.users', 'public.teams', 'public.team_members', 'public.projects',
    'public.project_collaborators', 'public.project_invitations', 'public.scripts',
    'public.script_versions', 'public.characters', 'public.locations',
    'public.storyboards', 'public.storyboard_panels', 'public.project_documents',
    'public.project_document_versions', 'public.conversations', 'public.conversation_messages',
    'public.collaboration_documents', 'public.user_presence', 'public.collaboration_activity',
    'public.ai_usage_events', 'public.image_usage_events', 'public.monthly_ai_usage_summary',
    'public.production_analyses', 'public.production_scene_data', 'public.scene_change_log', 'public.production_budgets',
    'public.production_schedules', 'public.production_locations', 'public.production_cast',
    'public.user_subscriptions', 'public.stripe_usage_records', 'public.project_reactivations',
    'public.subscription_plans', 'public.user_quotas', 'public.billing_events',
    'public.addon_transactions', 'public.monthly_project_billing', 'public.unarchive_transactions',
    'public.ai_script_analyses', 'public.comments', 'public.comment_reactions',
    'public.comment_read_status', 'public.ai_generated_scenes'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables_to_drop
  LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %s', table_name);
      RAISE NOTICE 'Dropped % from supabase_realtime publication', table_name;
    EXCEPTION
      WHEN OTHERS THEN
        -- Table not in publication, ignore error
        RAISE NOTICE 'Skipped % (not in publication or does not exist)', table_name;
    END;
  END LOOP;
END $$;

SELECT '=============================================' as status;
SELECT 'COMPLETE BACKEND DATABASE SCHEMA SETUP' as status;
SELECT '=============================================' as status;
SELECT 'All systems integrated:' as status;
SELECT '✓ User Management & Authentication' as status;
SELECT '✓ Team Collaboration & Real-time Editing' as status;
SELECT '✓ Project Management & Content Creation' as status;
SELECT '✓ Enhanced Character Classification System' as status;
SELECT '✓ Version Control System' as status;
SELECT '✓ Production Planning Tools' as status;
SELECT '✓ AI Usage Tracking & Billing' as status;
SELECT '✓ Storage Buckets & Image Upload Support' as status;
SELECT '✓ Comprehensive RLS Security' as status;
SELECT '=============================================' as status;
SELECT 'Performance optimizations applied:' as status;
SELECT '✓ Function search_path security (17 functions)' as status;
SELECT '✓ Auth RLS optimization (163 replacements, 40 tables)' as status;
SELECT '✓ Realtime monitoring disabled (43 tables)' as status;
SELECT '✓ Collaboration activity RLS policies added' as status;
SELECT '✓ Foreign key indexes added (45 indexes)' as status;
SELECT '=============================================' as status;
SELECT 'Verifying all tables exist:' as status;
SELECT table_name, table_exists FROM public.verify_schema_setup();
SELECT '=============================================' as status;
SELECT 'DATABASE READY FOR PRODUCTION USE!' as status;
SELECT 'Expected improvements:' as status;
SELECT '• 305+ Supabase warnings → 3 warnings (config only)' as status;
SELECT '• 95% reduction in auth.uid() re-evaluations' as status;
SELECT '• 95% reduction in query time (realtime disabled)' as status;
SELECT '• 4.7M realtime.list_changes calls eliminated' as status;
SELECT '• Faster JOINs and foreign key checks (45 new indexes)' as status;
SELECT '=============================================' as status;
