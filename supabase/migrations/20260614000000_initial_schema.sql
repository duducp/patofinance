-- Create users table
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create groups table (bank accounts)
CREATE TABLE groups (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Create categories table
CREATE TABLE categories (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_predefined BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

-- Create transactions table
CREATE TABLE transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  group_id BIGINT REFERENCES groups(id) ON DELETE SET NULL,
  category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  amount DECIMAL(12,2) NOT NULL,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  transaction_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create wizard_states table
CREATE TABLE wizard_states (
  user_id BIGINT PRIMARY KEY,
  step TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL
);

-- Create indexes
CREATE INDEX idx_transactions_user_date ON transactions(user_id, transaction_date DESC);
CREATE INDEX idx_transactions_group ON transactions(group_id);
CREATE INDEX idx_transactions_category ON transactions(category_id);

-- Enable Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wizard_states ENABLE ROW LEVEL SECURITY;

-- Create policies (service role will bypass these)
CREATE POLICY "users_own_data" ON users FOR ALL USING (true);
CREATE POLICY "groups_own_data" ON groups FOR ALL USING (true);
CREATE POLICY "categories_own_data" ON categories FOR ALL USING (true);
CREATE POLICY "transactions_own_data" ON transactions FOR ALL USING (true);
CREATE POLICY "wizard_states_own_data" ON wizard_states FOR ALL USING (true);

-- Insert predefined categories (will be copied per user on /start)
CREATE TABLE predefined_categories (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

INSERT INTO predefined_categories (name) VALUES
  ('Alimentação'),
  ('Moradia'),
  ('Transporte'),
  ('Saúde'),
  ('Educação'),
  ('Lazer'),
  ('Vestuário'),
  ('Contas'),
  ('Outros');
