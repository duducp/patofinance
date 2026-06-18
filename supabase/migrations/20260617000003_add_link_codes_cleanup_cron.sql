-- Add pg_cron scheduled job to periodically clean up expired link_codes
--
-- Runs daily at 03:00 AM, deletes codes that expired more than 1 hour ago
-- (keeps recently expired codes in case of clock skew)
--
-- pg_cron is pre-installed in Supabase projects (extension in the extensions schema).
-- This migration enables it if not already enabled and schedules the cleanup job.

-- Enable pg_cron extension (pre-installed in Supabase, safe to run multiple times)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule daily cleanup at 03:00 (Brazil/SP — BRT)
-- Uses the cron extension's schedule function.
-- The job name is unique, so running this migration multiple times is safe:
-- cron.schedule() with the same job name will UPDATE the existing schedule.
SELECT cron.schedule(
  'cleanup-expired-link-codes',  -- job name (unique)
  '0 3 * * *',                   -- cron expression: daily at 03:00
  $$DELETE FROM link_codes WHERE expires_at < NOW() - INTERVAL '1 hour'$$
);

COMMENT ON TABLE link_codes IS 'One-time codes for Telegram→Web authentication. Bot generates 6-char codes that the web dashboard validates to create Supabase Auth sessions. Expired codes are cleaned up daily at 03:00 via pg_cron.';
