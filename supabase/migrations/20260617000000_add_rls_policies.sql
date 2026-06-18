-- Add RLS policies for web dashboard access
--
-- This migration adds:
-- 1. auth_id column to link users with Supabase Auth
-- 2. Proper RLS policies using auth.uid() for all tables
-- 3. Grants for the authenticated role (used by web dashboard)
-- 4. RLS on telegram_accounts (was missing)
--
-- IMPORTANT: The Edge Function continues to use SUPABASE_SERVICE_ROLE_KEY
-- which bypasses RLS entirely. These policies only affect the web client.

-- ============================================================
-- 1. Add auth_id to users table for Supabase Auth linkage
-- ============================================================
ALTER TABLE users ADD COLUMN auth_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_users_auth_id ON users(auth_id) WHERE auth_id IS NOT NULL;

COMMENT ON COLUMN users.auth_id IS 'Link to Supabase Auth user (auth.users.id). NULL for Telegram-only users until they link their account.';

-- ============================================================
-- 2. Enable RLS on telegram_accounts (was missing)
-- ============================================================
ALTER TABLE telegram_accounts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. Drop dangerously permissive policies
-- ============================================================
DROP POLICY IF EXISTS "users_own_data" ON users;
DROP POLICY IF EXISTS "groups_own_data" ON groups;
DROP POLICY IF EXISTS "categories_own_data" ON categories;
DROP POLICY IF EXISTS "transactions_own_data" ON transactions;
DROP POLICY IF EXISTS "wizard_states_own_data" ON wizard_states;

-- ============================================================
-- 4. Users policies
-- ============================================================
-- User can read their own record (auth_id matches)
CREATE POLICY "users_read_own" ON users
  FOR SELECT
  USING (auth_id = auth.uid());

-- User can create their own record on first login
CREATE POLICY "users_insert_own" ON users
  FOR INSERT
  WITH CHECK (auth_id = auth.uid());

-- User can update their own record
CREATE POLICY "users_update_own" ON users
  FOR UPDATE
  USING (auth_id = auth.uid())
  WITH CHECK (auth_id = auth.uid());

-- ============================================================
-- 5. Telegram accounts policies
-- ============================================================
CREATE POLICY "telegram_accounts_read_own" ON telegram_accounts
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "telegram_accounts_insert_own" ON telegram_accounts
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "telegram_accounts_delete_own" ON telegram_accounts
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- ============================================================
-- 6. Groups policies
-- ============================================================
CREATE POLICY "groups_read_own" ON groups
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "groups_insert_own" ON groups
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "groups_update_own" ON groups
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()))
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "groups_delete_own" ON groups
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- ============================================================
-- 7. Categories policies
-- ============================================================
-- System categories (user_id IS NULL) are readable by all authenticated users
-- User categories are scoped to the user's own data
CREATE POLICY "categories_read_own" ON categories
  FOR SELECT
  USING (
    user_id IS NULL
    OR user_id IN (SELECT id FROM users WHERE auth_id = auth.uid())
  );

CREATE POLICY "categories_insert_own" ON categories
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "categories_update_own" ON categories
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()))
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "categories_delete_own" ON categories
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- ============================================================
-- 8. Transactions policies
-- ============================================================
CREATE POLICY "transactions_read_own" ON transactions
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "transactions_insert_own" ON transactions
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "transactions_update_own" ON transactions
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()))
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "transactions_delete_own" ON transactions
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- ============================================================
-- 9. Wizard states policies
-- ============================================================
CREATE POLICY "wizard_states_read_own" ON wizard_states
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "wizard_states_insert_own" ON wizard_states
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "wizard_states_update_own" ON wizard_states
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()))
  WITH CHECK (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

CREATE POLICY "wizard_states_delete_own" ON wizard_states
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE auth_id = auth.uid()));

-- ============================================================
-- 10. Reference tables (read-only, no user data)
-- ============================================================
CREATE POLICY "wizard_step_options_read_all" ON wizard_step_options
  FOR SELECT
  USING (true);

CREATE POLICY "predefined_categories_read_all" ON predefined_categories
  FOR SELECT
  USING (true);

-- ============================================================
-- 11. Grant permissions to authenticated role
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON wizard_states TO authenticated;
GRANT SELECT ON wizard_step_options TO authenticated;
GRANT SELECT ON predefined_categories TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMENT ON TABLE telegram_accounts IS 'Links users to Telegram identities. RLS: user can only see their own accounts.';
COMMENT ON POLICY "users_read_own" ON users IS 'User can only read their own record (matched by auth_id)';
COMMENT ON POLICY "transactions_read_own" ON transactions IS 'User can only see their own transactions';
COMMENT ON POLICY "categories_read_own" ON categories IS 'User can see system categories (global) and their own';
COMMENT ON POLICY "groups_read_own" ON groups IS 'User can only see their own groups';
