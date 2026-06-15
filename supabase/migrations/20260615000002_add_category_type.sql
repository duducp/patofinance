-- Add transaction_type column to predefined_categories
-- NULL = both expense and income, 'expense' = despesa only, 'income' = receita only
ALTER TABLE predefined_categories ADD COLUMN transaction_type TEXT CHECK (transaction_type IN ('expense', 'income'));

-- Add transaction_type column to user categories (matching the predefined schema)
ALTER TABLE categories ADD COLUMN transaction_type TEXT CHECK (transaction_type IN ('expense', 'income'));

-- Update existing predefined categories with type assignments
-- Expense categories
UPDATE predefined_categories SET transaction_type = 'expense' WHERE name IN (
  'Alimentação', 'Moradia', 'Transporte', 'Saúde',
  'Educação', 'Lazer', 'Vestuário', 'Contas'
);

-- Income categories
UPDATE predefined_categories SET transaction_type = 'income' WHERE name IN (
  'Salário'
);

-- 'Outros' stays NULL (both) -- already the default

-- Insert new income-specific predefined category if not exists
INSERT INTO predefined_categories (name, transaction_type) VALUES ('Freela', 'income');
INSERT INTO predefined_categories (name, transaction_type) VALUES ('Investimentos', 'income');
INSERT INTO predefined_categories (name, transaction_type) VALUES ('Benefícios', 'income');

-- Grant permissions
GRANT ALL ON predefined_categories TO service_role;
GRANT ALL ON categories TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
