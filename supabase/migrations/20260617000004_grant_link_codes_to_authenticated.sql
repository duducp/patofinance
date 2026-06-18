-- Grant link_codes permissions to authenticated role
--
-- The web dashboard (using supabase-js with the authenticated role's JWT)
-- needs to SELECT, INSERT, and UPDATE link_codes for the login flow:
--   1. web_to_telegram: dashboard inserts code, bot validates
--   2. telegram_to_web: bot inserts code, dashboard validates
--
-- The existing RLS policies (from migration 17000001) already restrict
-- access to the user's own link_codes via auth.uid(). These GRANTs
-- enable that RLS to be evaluated.
--
-- DELETE is intentionally excluded — codes are marked as used=true,
-- never deleted by the web client.

GRANT SELECT, INSERT, UPDATE ON link_codes TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMENT ON TABLE link_codes IS 'One-time codes for Telegram→Web authentication. Authenticated users can read/insert/update their own codes via RLS.';
