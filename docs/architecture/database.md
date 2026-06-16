# Database Architecture

Supabase PostgreSQL project: `zjcfjqtlijktrikgvwrv`

## Tables

### `users`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL PK` | Internal ID |
| `telegram_id` | `BIGINT UNIQUE` | Telegram user ID (used as external identifier) |
| `username` | `TEXT` | Telegram @username |
| `first_name` | `TEXT` | Telegram display name |
| `created_at` | `TIMESTAMPTZ` | Auto |

Created on first `/start` or first message from unknown user.

### `groups`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL PK` | |
| `user_id` | `BIGINT FK → users.id` | Owner |
| `name` | `TEXT` | Display name |
| `normalized_name` | `TEXT NOT NULL` | Lowercase, no accents, no special chars |
| `is_default` | `BOOLEAN` | Default group (created on user registration) |
| `created_at` | `TIMESTAMPTZ` | |

**Unique**: `(user_id, normalized_name)` via index.

Default group "Pessoal" is created automatically for every new user and cannot be deleted.

### `categories`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL PK` | |
| `user_id` | `BIGINT FK → users.id` | Owner |
| `name` | `TEXT` | Display name |
| `normalized_name` | `TEXT NOT NULL` | Lowercase, no accents, no special chars |
| `is_predefined` | `BOOLEAN` | True for categories seeded from predefined_categories |
| `transaction_type` | `TEXT CHECK` | `expense` / `income` / `NULL` (both) |
| `created_at` | `TIMESTAMPTZ` | |

**Unique**: `(user_id, normalized_name)` via index.

12 predefined categories seeded from `predefined_categories` table, copied per-user on registration.

### `transactions`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL PK` | |
| `user_id` | `BIGINT FK → users.id` | Owner |
| `group_id` | `BIGINT FK → groups.id` | NULL allowed (defaults to "Pessoal") |
| `category_id` | `BIGINT FK → categories.id` | NULL allowed |
| `type` | `TEXT CHECK` | `income` or `expense` |
| `amount` | `DECIMAL(12,2)` | Always positive (type determines direction) |
| `description` | `TEXT` | Optional description |
| `tags` | `TEXT[]` | Array of tag strings (with or without # prefix) |
| `transaction_date` | `DATE` | Defaults to current date |
| `created_at` | `TIMESTAMPTZ` | |

**Indexes**:
- `idx_transactions_user_date`: `(user_id, transaction_date DESC)` — main query path
- `idx_transactions_group`: `(group_id)` — group filter joins
- `idx_transactions_category`: `(category_id)` — category filter joins

### `wizard_states`

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | `BIGINT PK` | One wizard state per user |
| `step` | `TEXT` | Current wizard step key |
| `data` | `JSONB` | Accumulated wizard data |
| `session_seq` | `INTEGER DEFAULT 0` | Monotonic callback protection counter |
| `expires_at` | `TIMESTAMPTZ` | Auto-expiry (10 min TTL) |

Used for:
- Multi-step wizards (gasto/receita)
- NL follow-up wizards
- Edit transaction flows
- Statement filter state
- Rename entity flows

### `predefined_categories`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL PK` | |
| `name` | `TEXT UNIQUE` | Category name |
| `transaction_type` | `TEXT CHECK` | `expense` / `income` / `NULL` |

Seeded categories (12 total):

| Name | Type |
|------|------|
| Alimentação | expense |
| Moradia | expense |
| Transporte | expense |
| Saúde | expense |
| Educação | expense |
| Lazer | expense |
| Vestuário | expense |
| Contas | expense |
| Salário | income |
| Freela | income |
| Investimentos | income |
| Benefícios | income |
| Outros | both (NULL) |

### `wizard_steps`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL PK` | |
| `wizard_name` | `TEXT` | `gasto` or `receita` |
| `step_order` | `INT` | Position in wizard sequence |
| `step_key` | `TEXT` | `amount` / `category` / `group` / `date` / `tags` |
| `prompt` | `TEXT` | Telegram message to show at this step |
| `input_type` | `TEXT CHECK` | `text` / `select` / `date` / `tags` |
| `is_required` | `BOOLEAN DEFAULT TRUE` | Whether step can be skipped |

### `wizard_step_options`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `SERIAL PK` | |
| `step_id` | `INTEGER FK → wizard_steps.id` | Parent step |
| `value` | `TEXT` | Callback data value |
| `label` | `TEXT` | Display label |
| `sort_order` | `INTEGER` | Display order |

## Stored Procedures

### `normalize_string(text) → TEXT`

Lowercase + remove accents + remove non-alphanumeric characters.
Used by unique constraint on `normalized_name` and trigram similarity.

Implementation: `TRANSLATE` for accent removal + `REGEXP_REPLACE` for non-alphanumeric.

### `suggest_categories(p_user_id, p_query, p_limit) → TABLE(name, similarity)`

Trigram similarity search on `categories.normalized_name`.
Uses `pg_trgm` `%` operator. Excludes exact matches.
Minimum similarity: `0.3`. Returns top `p_limit` results.

### `suggest_groups(p_user_id, p_query, p_limit) → TABLE(name, similarity)`

Same as `suggest_categories` but for `groups` table.

### `suggest_tags(p_user_id, p_query, p_limit) → TABLE(tag, similarity)`

Unnests `transactions.tags` array, applies trigram similarity.
Uses `DISTINCT ON` to avoid duplicate tags. Excludes exact matches.

## Extensions

- `pg_trgm` — enables `%` similarity operator and `gin_trgm_ops` indexes

## Indexes Summary

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| `idx_categories_user_normalized` | categories | `(user_id, normalized_name)` UNIQUE | Prevent duplicate names |
| `idx_categories_normalized_trgm` | categories | `normalized_name` GIN trgm | Fuzzy search |
| `idx_groups_user_normalized` | groups | `(user_id, normalized_name)` UNIQUE | Prevent duplicate names |
| `idx_groups_normalized_trgm` | groups | `normalized_name` GIN trgm | Fuzzy search |
| `idx_transactions_user_date` | transactions | `(user_id, transaction_date DESC)` | Main list query |
| `idx_transactions_group` | transactions | `(group_id)` | Group filter |
| `idx_transactions_category` | transactions | `(category_id)` | Category filter |

## RLS

All tables have RLS enabled, but the bot uses the **service_role key** which bypasses all policies. The policies exist for future-proofing but are not actively enforced.

## Migrations

| Migration | Description |
|-----------|-------------|
| `20260614000000` | Initial schema: users, groups, categories, transactions, wizard_states, predefined_categories |
| `20260614000001` | wizard_steps table + default gasto/receita steps |
| `20260614000002` | Indexes + timestamps on wizard_states |
| `20260615000000` | Add tags step to receita wizard |
| `20260615000001` | pg_trgm extension + normalized_name + suggest_* functions |
| `20260615000002` | transaction_type column on categories/predefined_categories |
| `20260615000003` | session_seq column for callback protection |
| `20260615000004` | wizard_step_options table |
| `20260615000005` | Sync existing categories type + insert new predefined for existing users |
| `20260615000006` | Fix normalize_string TRANSLATE character count bug |

## Category Resolution by Transaction Type

When showing categories in wizards or NL flows:
- `/despesa` → shows categories where `transaction_type = 'expense'` OR `transaction_type IS NULL`
- `/receita` → shows categories where `transaction_type = 'income'` OR `transaction_type IS NULL`
- User-created categories with `NULL` type appear for both
- Predefined categories are typed appropriately

## Trigram Similarity Flow

```
User types "alimentao"
    │
    ▼
normalizeString("alimentao") → "alimentao"
    │
    ▼
suggest_categories(user_id, "alimentao") via RPC
    │
    ▼
PostgreSQL: similarity("alimentacao", "alimentao") = ~0.9
    │
    ▼
Returns: [{name: "Alimentação", similarity: 0.9}]
    │
    ▼
sendSimilarityWarning: "Similar a Alimentação (90%)"
```
