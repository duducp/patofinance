-- Separate Telegram-specific user data into its own table
-- This decouples the core users table from the Telegram identity,
-- allowing future integration with other platforms (web, Discord, etc.)

-- 1. Create telegram_accounts table
CREATE TABLE telegram_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Migrate existing data from users to telegram_accounts
INSERT INTO telegram_accounts (user_id, telegram_id, username, first_name)
SELECT id, telegram_id, username, first_name FROM users;

-- 3. Drop Telegram-specific columns from users
ALTER TABLE users DROP COLUMN telegram_id;
ALTER TABLE users DROP COLUMN username;
ALTER TABLE users DROP COLUMN first_name;

-- 4. Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_accounts TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
