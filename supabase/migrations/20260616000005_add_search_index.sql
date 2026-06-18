-- Add GIN trigram index on transactions.description for full-text search via /buscar
CREATE INDEX IF NOT EXISTS idx_transactions_description_trgm
  ON transactions USING gin (description gin_trgm_ops);

-- Grant permissions
GRANT EXECUTE ON FUNCTION normalize_string TO service_role;
