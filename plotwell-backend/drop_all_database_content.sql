-- =====================================================
-- COMPLETE DATABASE CLEANUP SCRIPT
-- =====================================================
-- 
-- This script completely drops ALL content from the Supabase database
-- including tables, functions, triggers, policies, storage buckets, and data.
-- 
-- ⚠️  WARNING: This is DESTRUCTIVE and IRREVERSIBLE!
-- ⚠️  This will delete ALL data, users, and content!
-- 
-- USAGE:
-- 1. Copy this entire script
-- 2. Paste into Supabase SQL Editor  
-- 3. Execute to completely clean the database
-- 4. Then run database_complete_schema.sql to recreate everything
-- 
-- =====================================================

-- =====================================================
-- REFRESH SUPABASE SCHEMA CACHE
-- =====================================================
-- This ensures Supabase recognizes schema changes properly
-- and prevents webhook/API issues after schema modifications

DO $$ 
BEGIN 
    RAISE NOTICE 'Refreshing Supabase schema cache...';
END $$;

-- Primary method to refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

-- Alternative method (backup)
SELECT pg_notify('pgrst', 'reload schema');

DO $$ 
BEGIN 
    RAISE NOTICE '✅ Schema cache refresh triggered';
    RAISE NOTICE 'PostgREST will reload schema definitions for proper API/webhook processing';
END $$;

-- First, let's see what tables actually exist
DO $$
DECLARE
    table_record RECORD;
BEGIN
    RAISE NOTICE 'Tables found in database:';
    FOR table_record IN 
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
        RAISE NOTICE 'Table: %', table_record.tablename;
    END LOOP;
END $$;

-- Disable RLS temporarily to avoid permission issues during cleanup
-- Using dynamic SQL to handle tables that may or may not exist
DO $$
DECLARE
    table_names TEXT[] := ARRAY[
        'users', 'teams', 'team_members', 'projects',
        'project_collaborators', 'project_invitations',
        'project_concepts', 'seasons', 'episodes', 'episode_characters', 'episode_locations',
        'scripts', 'characters', 'locations',
        'storyboards', 'storyboard_panels',
        'script_versions', 'project_concept_versions',
        'conversations', 'conversation_messages',
        'collaboration_documents', 'user_presence', 'collaboration_activity',
        'ai_usage_events', 'image_usage_events',
        'monthly_ai_usage_summary',
        'ai_generated_scenes',
        'production_analyses', 'production_scene_data', 'scene_change_log', 'production_budgets',
        'production_schedules', 'production_locations', 'production_cast',
        'user_subscriptions', 'user_quotas', 'billing_events'
    ];
    tbl_name TEXT;
BEGIN
    FOREACH tbl_name IN ARRAY table_names
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_name = tbl_name) THEN
            EXECUTE format('ALTER TABLE IF EXISTS public.%I DISABLE ROW LEVEL SECURITY', tbl_name);
            RAISE NOTICE 'Disabled RLS for table: %', tbl_name;
        END IF;
    END LOOP;
END $$;

-- =====================================================
-- DROP ALL VIEWS
-- =====================================================

DROP VIEW IF EXISTS public.user_subscription_details CASCADE;

DO $$ BEGIN RAISE NOTICE 'Dropped views'; END $$;

-- =====================================================
-- DROP ALL TRIGGERS (dynamically)
-- =====================================================

DO $$
DECLARE
    trigger_record RECORD;
BEGIN
    -- Drop all triggers on all tables dynamically
    FOR trigger_record IN 
        SELECT trigger_schema, event_object_table, trigger_name
        FROM information_schema.triggers 
        WHERE trigger_schema IN ('public', 'auth')
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', 
                      trigger_record.trigger_name, 
                      trigger_record.trigger_schema, 
                      trigger_record.event_object_table);
        RAISE NOTICE 'Dropped trigger % on %.%', 
                     trigger_record.trigger_name,
                     trigger_record.trigger_schema,
                     trigger_record.event_object_table;
    END LOOP;
    
    RAISE NOTICE 'Dropped all triggers';
END $$;

-- =====================================================
-- DROP ALL FUNCTIONS (dynamically)
-- =====================================================

DO $$
DECLARE
    func_record RECORD;
BEGIN
    -- Drop all functions in public schema
    FOR func_record IN 
        SELECT proname, oidvectortypes(proargtypes) as argtypes
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        AND p.prokind = 'f'  -- Only functions, not procedures
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE', 
                      func_record.proname, 
                      func_record.argtypes);
        RAISE NOTICE 'Dropped function: public.%(%)', func_record.proname, func_record.argtypes;
    END LOOP;
    
    RAISE NOTICE 'Dropped all functions';
END $$;

-- =====================================================
-- DROP ALL TABLES (dynamically)
-- =====================================================

DO $$
DECLARE
    table_record RECORD;
BEGIN
    -- First, drop all tables that exist (CASCADE will handle dependencies)
    FOR table_record IN 
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public'
        ORDER BY tablename
    LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', table_record.tablename);
        RAISE NOTICE 'Dropped table: public.%', table_record.tablename;
    END LOOP;
    
    RAISE NOTICE 'Dropped all tables';
END $$;

-- =====================================================
-- DROP ALL STORAGE BUCKETS AND OBJECTS
-- =====================================================

-- Drop all storage policies on storage.objects
DO $$
DECLARE
    policy_record RECORD;
BEGIN
    FOR policy_record IN
        SELECT policyname FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', policy_record.policyname);
        RAISE NOTICE 'Dropped storage policy: %', policy_record.policyname;
    END LOOP;

    RAISE NOTICE 'Dropped all storage policies';
END $$;

-- ⚠️  IMPORTANT: Storage buckets and objects CANNOT be deleted via SQL.
-- Supabase blocks direct DELETE on storage.objects/storage.buckets tables.
-- You MUST delete them manually from the Supabase Dashboard:
--   1. Go to Storage in the sidebar
--   2. For each bucket: select all files → delete
--   3. Once empty, delete the bucket itself
-- List existing buckets for reference:
DO $$
DECLARE
    bucket_record RECORD;
BEGIN
    FOR bucket_record IN
        SELECT id, name FROM storage.buckets
    LOOP
        RAISE NOTICE '⚠️  MANUAL DELETE REQUIRED - Storage bucket: % (%)', bucket_record.name, bucket_record.id;
    END LOOP;

    RAISE NOTICE '👆 Delete these buckets manually from Supabase Dashboard → Storage';
END $$;

-- =====================================================
-- DELETE ALL AUTH USERS (CRITICAL - THIS DELETES ALL USERS!)
-- =====================================================

-- ⚠️  WARNING: This deletes ALL user accounts!
-- Comment out this line if you want to keep existing users:
DELETE FROM auth.users;

DO $$ BEGIN RAISE NOTICE 'Deleted all auth users'; END $$;

-- =====================================================
-- DROP ANY REMAINING SEQUENCES
-- =====================================================

-- Drop any sequences that might have been created
DO $$
DECLARE
    seq_record RECORD;
BEGIN
    FOR seq_record IN 
        SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
    LOOP
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', seq_record.sequence_name);
        RAISE NOTICE 'Dropped sequence: %', seq_record.sequence_name;
    END LOOP;
END $$;

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Function to verify cleanup completion
CREATE OR REPLACE FUNCTION public.verify_cleanup_complete()
RETURNS TABLE(table_name TEXT, table_exists BOOLEAN, record_count BIGINT) AS $$
DECLARE
    table_record RECORD;
    count_result BIGINT;
    expected_tables TEXT[] := ARRAY[
        'users', 'teams', 'team_members', 'projects',
        'project_collaborators', 'project_invitations',
        'project_concepts', 'seasons', 'episodes', 'episode_characters', 'episode_locations',
        'scripts', 'characters', 'locations',
        'storyboards', 'storyboard_panels',
        'script_versions', 'project_concept_versions',
        'conversations', 'conversation_messages',
        'collaboration_documents', 'user_presence', 'collaboration_activity',
        'ai_usage_events', 'image_usage_events',
        'monthly_ai_usage_summary',
        'ai_generated_scenes',
        'production_analyses', 'production_scene_data', 'scene_change_log', 'production_budgets',
        'production_schedules', 'production_locations', 'production_cast',
        'user_subscriptions', 'user_quotas', 'billing_events'
    ];
    tbl_name_to_check TEXT;
BEGIN
    FOREACH tbl_name_to_check IN ARRAY expected_tables
    LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_name = tbl_name_to_check) THEN
            EXECUTE format('SELECT COUNT(*) FROM public.%I', tbl_name_to_check) INTO count_result;
            RETURN QUERY SELECT tbl_name_to_check, true, count_result;
        END IF;
    END LOOP;
    
    -- Check auth.users count
    SELECT COUNT(*) INTO count_result FROM auth.users;
    RETURN QUERY SELECT 'auth.users'::TEXT, true, count_result;
    
    -- Show remaining public tables
    FOR table_record IN 
        SELECT t.table_name::TEXT as tbl_name
        FROM information_schema.tables t 
        WHERE t.table_schema = 'public'
    LOOP
        EXECUTE format('SELECT COUNT(*) FROM public.%I', table_record.tbl_name) INTO count_result;
        RETURN QUERY SELECT table_record.tbl_name, true, count_result;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- COMPLETION MESSAGE
-- =====================================================

SELECT '=============================================' as status;
SELECT 'DATABASE CLEANUP COMPLETED!' as status;
SELECT '=============================================' as status;
SELECT 'Checking for any remaining tables:' as status;
SELECT table_name, table_exists, record_count FROM public.verify_cleanup_complete();
SELECT '=============================================' as status;
SELECT 'If any tables still exist above, they may need manual cleanup' as status;
SELECT 'Ready to run database_complete_schema.sql for fresh setup!' as status;
SELECT '=============================================' as status;

-- Clean up the verification function
DROP FUNCTION IF EXISTS public.verify_cleanup_complete();