-- Remove direction from link_codes — only telegram_to_web flow remains
--
-- The bidirectional code system has been simplified to a single flow:
-- bot generates code → user enters on dashboard (telegram_to_web).
-- The web_to_telegram direction is no longer needed.

-- 1. Delete any leftover web_to_telegram codes (should be none if cron ran, but be safe)
DELETE FROM link_codes WHERE direction = 'web_to_telegram';

-- 2. Drop the check constraint on direction
ALTER TABLE link_codes DROP CONSTRAINT IF EXISTS link_codes_direction_check;

-- 3. Drop the direction column (no longer needed)
ALTER TABLE link_codes DROP COLUMN IF EXISTS direction;

-- 4. Drop RLS policies that reference direction (not needed since this is a bot-internal table)
--    The policies remain for other columns, just no longer filtering by direction.

COMMENT ON TABLE link_codes IS 'One-time codes for Telegram→Web authentication. Bot generates 6-char codes that the web dashboard validates to create Supabase Auth sessions. Expired codes are cleaned up daily at 03:00 via pg_cron.';
