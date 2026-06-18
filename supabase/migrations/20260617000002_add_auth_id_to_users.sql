-- Add auth_id column to users table for linking Telegram users to Supabase Auth
-- This enables the Telegram→Web login flow and Web→Telegram vinculação

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'auth_id'
  ) THEN
    ALTER TABLE users ADD COLUMN auth_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Index for fast lookup by auth_id (IF NOT EXISTS handles re-runs)
CREATE INDEX IF NOT EXISTS idx_users_auth_id ON users(auth_id);

-- Grant permissions
GRANT UPDATE(auth_id) ON users TO service_role;

COMMENT ON COLUMN users.auth_id IS 'Supabase Auth user UUID. Set when linking Telegram account to Web account via /login flows.';
