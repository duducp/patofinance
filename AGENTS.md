# AGENTS.md

Telegram finance bot using Supabase Edge Functions + PostgreSQL.

## Quick Reference

```bash
make dev              # Start local Supabase (port 54321)
make check            # Type-check with Deno
make lint             # Lint edge function code
make test             # Run all checks (type + lint + boot)
make prod-deploy      # Deploy Edge Function to production
make help             # List all commands
```

## Architecture

Single Edge Function (`supabase/functions/bot-core/`) handles all Telegram webhook processing:

```text
Telegram -> Edge Function (webhook) -> Supabase DB -> Bot API response
                              |
                    handleCallbackQuery routes ~25 prefixes
                    (pagination, filters, wizards, CRUD)
```

Runtime: **Deno** (not Node.js). Imports use `https://deno.land/std`, `https://esm.sh`.

## Coding Patterns

### 1. Send vs Edit: When to Create vs Update Messages

Two Telegram API patterns used for user interaction:

| Pattern | Function | When to use |
|---------|----------|-------------|
| **Send** | `sendTelegramMessage[WithKeyboard]` | First interaction with user (slash command, new wizard step, confirmation dialog) |
| **Edit** | `editTelegramMessageWithKeyboard` | Updating an existing message in-place (pagination, tag toggle, interactive state change) |

**Rule of thumb:** If the callback changes the *state of the current view* (next page, toggle tag), edit the existing message. If the callback *completes an action or starts a new flow* (confirm delete, select category), send a new message.

**Important:** Always call `await answerCallbackQuery(callbackQuery.id)` at the very start of every callback handler. This dismisses the Telegram client loading spinner. Do not await any DB queries before it -- the user sees a frozen button otherwise.

**Example -- Pagination (edit):**
```typescript
// callbacks.ts - txlist_p handler
if (selectedValue.startsWith("txlist_p")) {
  const page = parseInt(selectedValue.replace("txlist_p", ""), 10);
  if (!isNaN(page)) {
    await handleListTransactions(supabase, telegramId, chatId, 10, undefined, page, message.message_id);
    // message.message_id passed as messageId -> function calls editTelegramMessageWithKeyboard
  }
  return;
}
```

**Example -- Confirmation (send new):**
```typescript
// callbacks.ts - confirm_delete_ handler
if (selectedValue.startsWith("confirm_delete_")) {
  const transactionId = selectedValue.replace("confirm_delete_", "");
  const user = await getOrCreateUser(supabase, telegramId);
  if (!user) return;
  const { error } = await supabase.from("transactions").delete().eq("id", transactionId).eq("user_id", user.id);
  if (error) {
    await sendTelegramMessage(chatId, "FAIL");
  } else {
    await sendTelegramMessage(chatId, "OK");
  }
  return;
}
```

### 2. Handler Parameter Convention

Every handler function follows a consistent parameter order:

```typescript
handleXxx(supabase: any, userId: number, chatId: number, ...args) => Promise<void>
```

- `supabase` first -- the Supabase client instance
- `userId` second -- the **Telegram ID** (external), NOT the internal DB `user.id`. Each handler calls `getOrCreateUser(supabase, userId)` internally to resolve the DB user
- `chatId` third -- the Telegram chat to respond to
- `...args` -- command-specific parameters (strings, numbers, options)

**Exception:** `handleEntity(type, supabase, userId, chatId, args)` has `type` first because it's a shared handler for both category and group operations.

### 3. Callback Routing Pattern

Adding a new interaction requires three things:

1. **Callback prefix** in `callbacks.ts` (`handleCallbackQuery`):
   ```typescript
   if (selectedValue.startsWith("my_prefix_")) {
     const value = selectedValue.replace("my_prefix_", "");
     // handle it
     return; // MUST return to avoid falling through to generic wizard
   }
   ```

2. **Handler function** in the appropriate module (commands.ts, management.ts, etc.)

3. **Keyboard button** that generates the callback:
   ```typescript
   { text: "Button text", callback_data: `my_prefix_${dynamicValue}` }
   ```

**CRITICAL:** Every `if` block in `handleCallbackQuery` MUST end with `return;`. Otherwise it falls through to the generic wizard handler at the bottom, which tries to interpret the callback as a wizard step selection and causes confusing bugs.

**Callback data limit:** Telegram caps callback_data at 64 bytes. Use `truncateCallbackData()` from `rate-limiter.ts` (truncates at 60 chars) for any callback containing dynamic user-generated values (tags, category names, dates, long transaction IDs):
```typescript
{ text: tag, callback_data: truncateCallbackData(`edit_tag_tog_${transactionId}_${tag}`) }
```

### 3a. Callback Ordering Rule: Specific Before Generic

**CRITICAL:** When routing callbacks with `startsWith()`, **always order more specific prefixes before less specific ones.** A generic prefix like `"cat_del_"` matches `"cat_del_yes_Casa"`, causing the specific handler to never fire.

**Wrong** -- `cat_del_` catches `cat_del_yes_Casa` first, extracts `"yes_Casa"` as the name, and generates `cat_del_yes_yes_Casa` in an infinite loop:
```typescript
// ❌ Generic BEFORE specific -- cat_del_yes_Casa never reaches its handler
if (selectedValue.startsWith("cat_del_")) { }
if (selectedValue.startsWith("cat_del_yes_")) { } // DEAD CODE
```

**Correct** -- specific before generic:
```typescript
// ✅ Specific BEFORE generic -- cat_del_yes_Casa hits the right handler
if (selectedValue.startsWith("cat_del_yes_")) { }
if (selectedValue.startsWith("cat_del_")) { }
```

**Full ordering example** (from `callbacks.ts`):
```text
MOST SPECIFIC (order first):
  edit_show_         → exact prefix match
  edit_cat_select_   → specific confirm
  edit_date_select_  → specific confirm
  edit_date_custom_  → specific confirm
  edit_group_sel_    → specific confirm (before edit_group_)
  edit_group_        → broader group prefix
  edit_tags_done_    → before edit_tags_ (both start with "edit_tags_")
  edit_tags_clr_     → before edit_tags_
  edit_tags_         → initial tag edit
  edit_tag_tog_      → distinct prefix (differs at pos 7: 't' ≠ 's')
LEAST SPECIFIC (order last):
  edit_              → generic, handles only amount/category/date
```

**How to test if ordering is correct:** For each pair of prefixes where one is a prefix of the other (e.g., `"edit_tags_"` and `"edit_tags_done_"`), trace through `selectedValue.startsWith()`:
- `"edit_tags_done_42".startsWith("edit_tags_")` → **TRUE** → must come AFTER `edit_tags_done_`
- `"edit_tags_42".startsWith("edit_tags_done_")` → FALSE → fine after `edit_tags_done_`
- `"edit_tag_tog_42".startsWith("edit_tags_")` → FALSE (pos 7: 't' ≠ 's') → no conflict

This bug was fixed for all callback prefixes in a single session: `cat_del_yes_`, `grp_del_yes_`, `edit_group_sel_`, `edit_cat_select_`, `edit_date_select_`, `edit_date_custom_`, `edit_tags_done_`, and `edit_tags_clr_`.

### 4. Entity-Based Handler Pattern

Category and group operations share ~95% of their logic. Instead of duplicating, use `handleEntity(type, ...)` with a parameterized builder:

```typescript
export async function handleEntity(type: "category" | "group", supabase, userId, chatId, args) {
  const isCategory = type === "category";
  const table = isCategory ? "categories" : "groups";
  const flagColumn = isCategory ? "is_predefined" : "is_default";
  const icon = isCategory ? "TAGS_ICON" : "FOLDER_ICON";
  // ... 95% shared logic ...
}

// Public aliases:
export async function handleGroup(supabase, userId, chatId, args) {
  return handleEntity("group", supabase, userId, chatId, args);
}
export async function handleCategory(supabase, userId, chatId, args) {
  return handleEntity("category", supabase, userId, chatId, args);
}
```

**Use this pattern whenever you have two or more handlers with nearly identical logic.** Define the differences upfront as a table of constants (table name, icon, SQL column, labels), then write the logic once.

### 5. Pagination Pattern

Any list of items that can exceed one screen (10 items) should support pagination:

1. **Fetch `limit + 1`** items to detect if there's a next page:
   ```typescript
   const fetchLimit = limit + 1;
   const { data: items } = await query.range(offset, offset + fetchLimit - 1);
   const hasMore = items.length > limit;
   const displayItems = hasMore ? items.slice(0, limit) : items;
   ```

2. **Parallel COUNT query** for total pages indicator (`Pagina X de Y`):
   ```typescript
   const [countResult, dataResult] = await Promise.all([
     supabase.from("table").select("*", { count: "exact", head: true }).eq("user_id", user.id),
     supabase.from("table").select("...").range(...),
   ]);
   const totalPages = Math.ceil((countResult.count || 0) / limit);
   ```

3. **Navigation keyboard** (conditional buttons):
   ```typescript
   const navRow = [];
   if (page > 0) navRow.push({ text: "ANTERIOR", callback_data: `prefix_${page - 1}` });
   if (page + 1 < totalPages) navRow.push({ text: "PROXIMO", callback_data: `prefix_${page + 1}` });
   if (navRow.length > 0) keyboard.push(navRow);
   ```

4. **Edit existing message** when navigating pages (pass `messageId` from the callback):
   ```typescript
   if (messageId) {
     await editTelegramMessageWithKeyboard(chatId, messageId, message, keyboard);
   } else {
     await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
   }
   ```

### 6. Parallel Queries Pattern

When a handler needs both a COUNT query and a data query (or any two independent queries), run them in parallel with `Promise.all` instead of sequentially:

```typescript
// GOOD -- parallel, cuts ~50% latency
const [countResult, dataResult] = await Promise.all([
  supabase.from("transactions").select("*", { count: "exact", head: true }).eq("user_id", user.id),
  supabase.from("transactions").select("id, amount, type").eq("user_id", user.id).range(0, 9),
]);

// BAD -- sequential, unnecessary wait
const { count } = await supabase.from("transactions").select(..."count"...);
const { data } = await supabase.from("transactions").select(..."data"...);
```

Applied in: `handleListTransactions` (COUNT + items), `handleListByTag` (COUNT + items), `handleStatement` (COUNT + items).

### 7. Plural Pattern: Full Words, Not Concatenation

When building user-facing strings with conditional plurals in Portuguese, **always write the full singular and plural words** instead of concatenating suffixes.

**Wrong** -- concatenates "ões" to "transação", producing "transaçãoões" (a real bug):
```typescript
`${count} transação${count !== 1 ? "ões" : ""}`
// count=5 → "5 transaçãoões" ❌
```

**Correct** -- uses the full plural word:
```typescript
`${count} ${count !== 1 ? "transações" : "transação"}`
// count=5 → "5 transações" ✅
// count=1 → "1 transação" ✅
```

**Same pattern for adjectives** like "reatribuída(s)" / "criad(a/o)". Always use the full word in each branch:
```typescript
// ✅ Correct
`${count} ${count !== 1 ? "transações" : "transação"} ${count !== 1 ? "reatribuídas" : "reatribuída"}`

// ❌ Wrong -- concatenates suffix
`${count} transação${count !== 1 ? "ões" : ""} reatribuída${count !== 1 ? "s" : ""}`
```

**Why:** Portuguese plurals are irregular (ão → ões, ãos, or ães depending on the word). Concatenation causes bugs like "transaçãoões" and doesn't generalize.

**Note:** Keep the numeric value (`${count}`) **outside** the ternary to avoid duplication and ensure it interpolates correctly at the template literal level (nested `${}` inside double-quoted strings does not interpolate).

## NL Processing

Natural language via DeepSeek API.

### Flow

1. **Common phrases** (no API call): `quanto tenho`, `saldo`, `extrato`, `resumo`, `quais categorias`, `meus grupos`, `quais tags`, `ultimas transacoes`, `ultimo gasto`, `apagar ultima`, `limpe`, `limpar` -- mapped in `config.ts` `commonPhrases` map
2. **Cache check**: 5-minute TTL (`nlCache` in `config.ts`)
3. **DeepSeek API call**: 5s timeout, returns `DeepSeekResponse` with parsed intent + fields
4. **Parse JSON**: Validates fields, fills `missingFields` array
5. **Cache result**

### Missing fields wizard

If DeepSeek response has missing fields (amount, category, period, name, tag), the bot starts a multi-step wizard:
- `nl_{intent}_amount` -> asks for value
- `nl_{intent}_category` -> shows keyboard with existing categories
- `nl_{intent}_period` -> `this_month` / `last_month` buttons
- `nl_create_category_name`, `nl_create_group_name` -> asks for name
- `nl_list_by_tag_name` -> asks for tag

### Supported intents

`expense`, `income`, `query_balance`, `query_expenses_month`, `query_expenses_last_month`, `query_expenses_date`, `query_expenses_category`, `query_summary`, `query_extract`, `create_category`, `create_group`, `list_categories`, `list_groups`, `list_tags`, `list_transactions`, `show_last_transaction`, `delete_last_transaction`, `list_by_tag`, `cleanup`

### Pagination via NL

`list_transactions` intent -> `handleListTransactions` with `page` param + navigation keyboard:
- `txlist_p{page}` callback -- non-tagged pagination
- `txlist_t{tag}_p{page}` callback -- tag-filtered pagination
- Shows `Pagina X de Y` with parallel COUNT query

If `DEEPSEEK_API_KEY` is not set, falls back to commands only.

## Critical Gotchas

- **`verify_jwt = false`** in `supabase/config.toml` for local testing -- never commit with `true`
- **Service Role Key** hardcoded for local dev (`your_service_role_key_here`) -- production uses env var
- **Internal Supabase URL** is `http://kong:8000` inside Edge Functions, not `127.0.0.1:54321`
- **Webhook secret token** must match between Telegram and Supabase secrets -- mismatch causes 401 errors
- **TypeScript variable redeclaration** -- `const` in switch cases can cause boot errors. Use unique names per case.
- **ALWAYS use CLI for deploy** -- `npx supabase functions deploy bot-core --no-verify-jwt`. The MCP tool `supabase_deploy_edge_function` doesn't read file content correctly.
- **DeepSeek API key** required for natural language. Without it, bot only responds to slash commands.
- **Callback data limit**: Telegram limits inline keyboard callback_data to 64 bytes. Use `truncateCallbackData()` from `rate-limiter.ts` (truncates at 60 chars) for any callback containing dynamic values (tags, category names, dates).
- **Every callback handler MUST `return`**: Without an explicit return, the callback falls through to the generic wizard handler at the bottom of `handleCallbackQuery`, causing confusing errors.

## Debugging Tips

### 1. Test Locally with curl

```bash
# Test /start
make dev-test-start

# Test /despesa 50 alimentacao (/gasto also works)
make dev-test-gasto

# Test a custom webhook payload (edit the JSON inline)
curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
  -H "Content-Type: application/json" \
  -H "apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" \
  -H "X-Telegram-Bot-Api-Secret-Token: test_secret" \
  -d '{"update_id": 99, "message": {"message_id": 99, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/saldo"}}'
```

**To test callbacks**, change the payload to use `callback_query` instead of `message`:
```bash
curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
  -H "Content-Type: application/json" \
  -H "apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" \
  -H "X-Telegram-Bot-Api-Secret-Token: test_secret" \
  -d '{"update_id": 100, "callback_query": {"id": "cb1", "from": {"id": 123}, "message": {"message_id": 1, "chat": {"id": 123, "type": "private"}, "date": 1234567890}, "data": "txlist_p1"}}'
```

### 2. View Logs

```bash
# Local: tail function logs (runs the function in serve mode)
make dev-logs

# Production: recent deployment logs
make prod-logs
```

### 3. Check Webhook Status

```bash
# Verify webhook is set and working
make prod-webhook-info

# Expected output (condensed):
# {
#   "ok": true,
#   "result": {
#     "url": "https://.../functions/v1/bot-core",
#     "has_custom_certificate": false,
#     "pending_update_count": 0,
#     "last_error_date": null,
#     "last_error_message": null
#   }
# }
```

**If `last_error_message` is not null**, it will say why webhook calls are failing:
- `"502 Bad Gateway"` -> Function crashed on boot (check `make check` + `make lint`)
- `"401 Unauthorized"` -> `TELEGRAM_SECRET_TOKEN` mismatch between Supabase secrets and webhook config
- `"Read timed out"` -> Function took >10s to respond (check for slow DB queries or infinite loops)

### 4. Diagnose Silent Callback Failures

If clicking a button does nothing:
1. Check the callback prefix in `handleCallbackQuery` -- typos in `startsWith()` are the #1 cause
2. Verify the `callback_data` you generate matches the prefix you check:
   ```typescript
   // Generating: `my_prefix_${id}`
   // Checking:   `selectedValue.startsWith("my_prefix_")` -- note trailing underscore!
   ```
3. Check if the callback falls through to the generic wizard handler (every `if` needs `return;`)
4. Check if `truncateCallbackData()` cut off a critical part of the callback data (e.g., the distinguishing suffix)
5. Test the exact callback payload via curl (see #1 above)

### 5. Type-Check and Lint

```bash
# Quick type-check (catches 90% of bugs)
make check

# Full lint (catches unused vars, style issues)
make lint

# Both + boot test
make test
```

**Common type errors and fixes:**
- `TS2304: Cannot find name 'X'` -> Missing import (check the import block at the top of the file)
- `TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'` -> Wrong parameter passed to a handler (e.g., passed DB `user.id` instead of Telegram ID)
- `TS2322: Type 'string | null' is not assignable to type 'string'` -> Add null check or default value
- `TS7006: Parameter 'X' implicitly has an 'any' type` -> Add explicit type annotation

### 6. Debug Deno Boot Errors

```bash
# Test if the function boots without deploying
make test-boot

# If it fails, run deno check directly for detailed output:
deno check supabase/functions/bot-core/index.ts
```

**Common boot errors:**
- `Uncaught SyntaxError: Identifier 'X' has already been declared` -> `const` redeclaration in switch/case. Rename variables to be unique per case block.
- `Uncaught TypeError: Deno.env.get is not a function` -> Missing `--allow-env` permission (not applicable in Edge Functions; the runtime provides it)
- `Uncaught TypeError: Cannot read properties of null (reading 'X')` -> Missing env var. Check that `TELEGRAM_BOT_TOKEN` and `SUPABASE_SERVICE_ROLE_KEY` are set.

### 7. Debug NL Processing

```bash
# Check if common phrase matching works (bypasses API)
# The bot logs what common phrase matched via console.log

# To test if DeepSeek API key is set:
# - If NL fails silently, try a slash command instead
# - If slash commands work but NL returns "desculpe" -> API key issue or timeout

# Check the nlCache (5min TTL): same query within 5min uses cached response
```

### 8. Supabase Dashboard

```bash
make open  # Opens Supabase dashboard in browser
```

Useful dashboard pages for debugging:
- **Edge Functions** -> `bot-core` -> Logs: see function invocations and errors
- **SQL Editor**: run ad-hoc queries to inspect data:
  ```sql
  -- Check user exists
  SELECT * FROM users WHERE telegram_id = 123;

  -- Check recent transactions
  SELECT * FROM transactions WHERE user_id = 1 ORDER BY created_at DESC LIMIT 5;

  -- Check wizard state
  SELECT * FROM wizard_states WHERE user_id = 1;

  -- Check a callback data for truncation issues
  SELECT length('txlist_t#minha_tag_muito_longa_p1') as cb_length;
  ```
- **Database** -> `wizard_states`: manually clear a stuck wizard state by deleting the row

### 9. Debug Deploy Issues

```bash
# Deploy failed? Check the error message from:
npx supabase functions deploy bot-core --no-verify-jwt

# Common deploy errors:
# - "Failed to parse config.toml" -> syntax error in config.toml
# - "Import failed" -> missing or unreachable remote import
# - "Function size exceeds limit" -> too many imports, use smaller deps

# After successful deploy, verify:
curl -X POST "https://api.telegram.org/bot$(BOT_TOKEN)/getWebhookInfo" | jq '.result.last_error_message'
```

## Development Workflow

**Rule: Always test Edge Functions locally before deploying to production.**

**Rule: Always use CLI for deploy, not the MCP tool.**

```bash
make dev-deploy             # Deploy locally first
make dev-test-start         # Test the change
make dev-test-gasto         # Test another command
# Only then:
make prod-deploy            # Deploy to production (uses CLI)
```

**Deploy method:**
```bash
# CORRECT - Use CLI
npx supabase functions deploy bot-core --no-verify-jwt

# WRONG - MCP tool doesn't read file content correctly
# supabase_deploy_edge_function (not reliable)
```

## All Makefile Commands

### Setup
```bash
make install            # Install Supabase CLI
make install-login      # Login to Supabase (paste access token)
make install-link       # Link to project zjcfjqtlijktrikgvwrv
```

### Local
```bash
make dev                # Start local Supabase
make dev-stop           # Stop local Supabase
make dev-logs           # Tail local Edge Function logs
make dev-deploy         # Deploy Edge Function locally
make dev-db-push        # Push migrations locally
make dev-db-reset       # Reset local database
make dev-test-start     # Test /start via curl
make dev-test-despesa  # Test /despesa via curl
```

### Production
```bash
make prod-deploy        # Deploy Edge Function
make prod-db-push       # Push migrations to production
make prod-webhook-set   # Set Telegram webhook URL
make prod-webhook-info  # Check webhook status
make prod-webhook-delete# Delete webhook
make prod-logs          # Show recent deployment logs
```

### Both
```bash
make secrets            # Set TELEGRAM_BOT_TOKEN + TELEGRAM_SECRET_TOKEN
make status             # Show Supabase project status
make open               # Open Supabase Dashboard
```

### Quality
```bash
make check              # Type-check (deno check)
make lint               # Lint (deno lint)
make test-boot          # Verify function boots without error
make test               # check + lint + test-boot
```

## Environment Variables

| Variable | Where | Description |
| -------- | ----- | ----------- |
| `TELEGRAM_BOT_TOKEN` | Supabase Secrets | Bot token from @BotFather |
| `TELEGRAM_SECRET_TOKEN` | Supabase Secrets | Webhook verification token |
| `SUPABASE_URL` | Auto-set by Supabase | Internal URL (`http://kong:8000` locally) |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set by Supabase | Used to bypass RLS |
| `DEEPSEEK_API_KEY` | Supabase Secrets | DeepSeek API key for NL processing |

## Database

Project ref: `zjcfjqtlijktrikgvwrv`

### Tables

| Table | Key columns | Notes |
|-------|-------------|-------|
| `users` | `id`, `telegram_id`, `username`, `first_name` | |
| `groups` | `id`, `user_id`, `name`, `normalized_name`, `is_default` | `normalized_name` + pg_trgm index |
| `categories` | `id`, `user_id`, `name`, `normalized_name`, `is_predefined` | `normalized_name` + pg_trgm index |
| `transactions` | `id`, `user_id`, `group_id`, `category_id`, `type`, `amount`, `tags TEXT[]` | |
| `wizard_states` | `user_id`, `step`, `data JSONB`, `expires_at` | |
| `predefined_categories` | `id`, `name` | Seeded with 9 default categories |

### Stored Procedures

| Function | Purpose |
|----------|---------|
| `normalize_string(text)` | Lowercase + remove accents + remove non-alphanumeric |
| `suggest_categories(p_user_id, p_query, p_limit)` | Trigram similarity search on categories |
| `suggest_groups(p_user_id, p_query, p_limit)` | Trigram similarity search on groups |
| `suggest_tags(p_user_id, p_query, p_limit)` | Trigram similarity search on tags (unnests transactions.tags[]) |

### Migrations

```text
20260614000000_initial_schema.sql              # Tables + RLS + predefined_categories
20260614000001_add_wizard_steps.sql            # wizard_steps table
20260614000002_add_wizard_steps_index_and_timestamps.sql
20260615000000_add_tags_step_to_receita_wizard.sql
20260615000001_add_normalized_name_and_trgm.sql  # pg_trgm extension + normalized_name + suggest_* functions
```

### Extensions

- `pg_trgm` -- enables `%` similarity operator and `gin_trgm_ops` indexes

## Exported Functions Reference

### `services/database.ts` -- Data access layer

| Function | Returns | Used by |
|----------|---------|---------|
| `normalizeString(str)` | `string` | Internal -- lowercase + strip accents/alphanumeric |
| `getOrCreateUser(supabase, telegramId)` | `user | null` | All handlers |
| `requireUser(supabase, userId, chatId)` | `user | null` | `handleTransaction` |
| `getCategories(supabase, userId)` | `{name}[]` | NL wizard |
| `getOrCreateCategory(supabase, userId, name)` | `category_id | null` | `handleTransaction` |
| `getOrCreateGroup(supabase, userId, name)` | `group_id | null` | `handleTransaction` |
| `suggestSimilarCategories(supabase, userId, query, limit?)` | `{name, similarity}[]` | Handlers |
| `suggestSimilarGroups(supabase, userId, query, limit?)` | `{name, similarity}[]` | Handlers |
| `suggestSimilarTags(supabase, userId, query, limit?)` | `{tag, similarity}[]` | Handlers |
| `sendSimilarityWarning(supabase, userId, chatId, type, query)` | `void` | `handleTransaction` |
| `getAllUserTags(supabase, userId)` | `string[]` | Tag editors |

### `services/telegram.ts` -- Telegram API wrapper

| Function | Purpose |
|----------|---------|
| `sendTelegramMessage(chatId, text)` | Send plain message |
| `sendTelegramMessageWithKeyboard(chatId, text, keyboard)` | Send with inline keyboard |
| `editTelegramMessageWithKeyboard(chatId, messageId, text, keyboard)` | Edit existing message |
| `answerCallbackQuery(callbackQueryId)` | Acknowledge callback (required by Telegram) |

### `handlers/commands.ts` -- Slash command handlers

| Function | Command | Notes |
|----------|---------|-------|
| `handleStart(chatId, firstName)` | `/start` | |
| `handleHelp(chatId)` | `/ajuda` | |
| `handleBalance(supabase, userId, chatId, args?)` | `/saldo` | Optional group filter via args |
| `handleTransaction(type, supabase, userId, chatId, args)` | `/gasto`, `/receita` | Unified handler, `type: "expense"|"income"` |
| `handleStatement(supabase, userId, chatId, page?, filter?, filters?)` | `/extrato` | Pagination + optional `ExtratoFilters` object (category_id, group_id, tags, type, period) |
| `resolvePeriod(period)` | (utility) | `PeriodPreset` or `{start,end}` → `{start, end, label}` |
| `handleSummary(supabase, userId, chatId, args?)` | `/resumo` | Delegates to `getSummaryData` + `formatSummaryMessage` |
| `handleEdit(supabase, userId, chatId, args)` | `/editar` | |
| `handleDelete(supabase, userId, chatId, args)` | `/excluir` | |
| `handleEntity(type, supabase, userId, chatId, args)` | (shared) | `type: "category"|"group"` -- list, create, suggest |
| `handleGroup(supabase, userId, chatId, args)` | `/grupo` | Alias for `handleEntity("group", ...)` |
| `handleCategory(supabase, userId, chatId, args)` | `/categoria` | Alias for `handleEntity("category", ...)` |
| `handleTag(supabase, userId, chatId, args)` | `/tag` | Lists all tags with transaction counts + clickable buttons |
| `handleCleanup(supabase, userId, chatId)` | `/limpar` | Removes unused categories (excluding `is_predefined`) + groups (excluding `is_default`). Tags are NOT shown — they're metadata on transactions, not deletable entities. |

### `handlers/management.ts` -- Entity management

| Function | Purpose |
|----------|---------|
| `handleCreateCategory(supabase, userId, chatId, name)` | Create with similarity check |
| `handleCreateGroup(supabase, userId, chatId, name)` | Same pattern |
| `handleListCategories(supabase, userId, chatId)` | List with predefined indicator |
| `handleListGroups(supabase, userId, chatId)` | List with default indicator |
| `handleListTransactions(supabase, userId, chatId, limit, tag?, page?, messageId?)` | Paginated list with COUNT + nav keyboard |
| `handleShowLastTransaction(supabase, userId, chatId)` | Detail + edit/delete buttons |
| `handleDeleteLastTransaction(supabase, userId, chatId)` | Confirm dialog |
| `handleListByTag(supabase, userId, chatId, tag, page?, messageId?)` | Tag-filtered list with pagination |

### `handlers/queries.ts` -- Query/aggregation

| Function | Purpose |
|----------|---------|
| `getSummaryData(supabase, userId, period, groupId?)` | Shared -- aggregates transactions by category, returns `SummaryData` |
| `formatSummaryMessage(data, groupName?)` | Shared -- formats summary message |
| `handleQueryExpenses(supabase, userId, chatId, period, date, category)` | NL expense queries |
| `handleQuerySummary(supabase, userId, chatId, period)` | NL summary (delegates to shared fns) |

### `handlers/wizard.ts` -- Multi-step wizards

| Function | Purpose |
|----------|---------|
| `getWizardState(supabase, userId)` | Read current wizard state |
| `setWizardState(supabase, userId, step, data?)` | Set/update wizard state |
| `clearWizardState(supabase, userId)` | Clear wizard state |
| `completeWizard(supabase, userId, chatId, data)` | Clear + send success + handle transaction creation |
| `sendWizardStepMessage(chatId, step, userId, supabase, messageId?)` | Render wizard step UI |
| `getCurrentWizardStep(supabase, userId)` | Read state + current step, returns `{state, currentStep}` |
| `advanceWizardToNextStep(supabase, userId, chatId, currentStep, newStateData)` | Find next step, update state, send message or complete |
| `handleTransactionWizard(type, supabase, userId, chatId, state, input)` | Route wizard input to correct step handler |

### `handlers/nl-processing.ts` -- NL routing

| Function | Purpose |
|----------|---------|
| `handleNaturalLanguageWithFollowUp(supabase, userId, chatId, natural)` | Route NL response + start wizards for missing fields |
| `executeNaturalLanguageAction(supabase, userId, chatId, natural)` | Execute parsed intent (no missing fields) |

### `handlers/callbacks.ts` -- Inline keyboard routing

Routes ~42 callback prefixes via `handleCallbackQuery`. Key callbacks:

| Prefix | Purpose | Sends vs Edits |
|--------|---------|----------------|
| `confirm_delete_` | Delete confirmation | Sends new msg |
| `cancel_delete` | Cancel delete | Sends new msg |
| `confirm_cleanup` | Execute cleanup (deletes only non-predefined cats + non-default groups) | Sends new msg |
| `cancel_cleanup` | Cancel cleanup | Sends new msg |
| `stmt_filter` | Open filter panel | Sends new msg |
| `stmt_f_cat` | Open category selector | Edits msg |
| `stmt_f_cat_{id}` | Select category (`0` = limpar) | Edits msg |
| `stmt_f_grp` | Open group selector | Edits msg |
| `stmt_f_grp_{id}` | Select group (`0` = limpar) | Edits msg |
| `stmt_f_tag` | Open tag multiselect | Edits msg |
| `stmt_f_tag_{tag}` | Toggle tag selection | Edits msg |
| `stmt_f_tag_done` | Confirm tag selection | Edits msg |
| `stmt_f_tag_clr` | Clear tag selection | Edits msg |
| `stmt_f_type` | Open type selector | Edits msg |
| `stmt_f_type_{type}` | Select type (all/income/expense) | Edits msg |
| `stmt_f_period` | Open period selector | Edits msg |
| `stmt_f_period_{key}` | Select period preset | Edits msg |
| `stmt_f_period_custom` | Custom date range via wizard (2-step: start + end) | Sends new msg |
| `stmt_f_apply` | Apply filters → run `handleStatement` with `ExtratoFilters` | Sends new msg |
| `stmt_f_clear` | Reset all filters to defaults | Edits msg |
| `statement_` | Statement quick-filter (type) + page nav | Sends new msg |
| `txlist_p` | List transactions page nav | Edits msg |
| `txlist_t` | Tag-filtered list page nav | Edits msg |
| `nl_cat_` | NL category selection | Sends new msg |
| `nl_period_` | NL period selection | Sends new msg |
| `edit_show_` | Show edit dialog | Sends new msg |
| `edit_amount_` / `edit_category_` / `edit_date_` | Edit field selection (generic `edit_` handler) | Sends new msg |
| `edit_date_custom_` | Custom date input via wizard | Sends new msg |
| `edit_cat_select_` | Edit category confirm | Sends new msg |
| `edit_date_select_` | Edit date confirm | Sends new msg |
| `edit_group_` / `edit_group_sel_` | Edit group | Sends new msg |
| `edit_tags_` / `edit_tag_tog_` | Edit tags toggle | Edits msg |
| `edit_tags_done_` / `edit_tags_clr_` | Tags confirm/clear | Sends new msg |
| `wizard_new_category` / `wizard_new_group` | Type custom name in wizard | Sends new msg |
| `wiz_tag_` | Wizard tag toggle | Edits msg |
| `wiz_done_tags` / `wizard_skip_tags` | Wizard tag confirm/skip | Delegates to advanceWizard |
| `balance_shwgrp` / `balance_grp_` | Balance group filter | Sends new msg |
| `summary_shwgrp` / `summary_grp_` | Summary group filter | Sends new msg |
| `cat_sel_` / `grp_sel_` | Select entity to manage | Sends new msg |
| `cat_ren_` / `grp_ren_` | Rename entity | Sends new msg |
| `cat_del_yes_` / `grp_del_yes_` | Delete entity confirmed | Sends new msg |
| `cat_del_` / `grp_del_` | Delete entity confirm prompt | Sends new msg |
| `cat_back` / `grp_back` | Back to entity list | Sends new msg |
| `cat_sug_use` / `cat_sug_new` | Category similarity resolve | Sends new msg |
| `grp_sug_use` / `grp_sug_new` | Group similarity resolve | Sends new msg |
| `tag_sel_` | Show transactions with tag | Edits msg |
| `custom_date` | Wizard custom date | Sends new msg |

## File Structure

```text
supabase/
├── config.toml               # verify_jwt=false for local
├── migrations/               # 5 SQL migrations
│   ├── 20260614000000_*.sql
│   ├── 20260614000001_*.sql
│   ├── 20260614000002_*.sql
│   ├── 20260615000000_*.sql
│   └── 20260615000001_*.sql  # pg_trgm + normalized_name + suggest_* functions
└── functions/bot-core/
    ├── index.ts              # Entry point (serve handler + wizard step routing)
    ├── config.ts             # Env vars, commonPhrases map, nlCache
    ├── types/
    │   └── index.ts          # DeepSeekResponse, Telegram types, InlineKeyboard, WizardState
    ├── utils/
    │   ├── formatting.ts     # formatCurrencyBR, formatDateBR, getTodayISOBR, parseDateBR
    │   ├── rate-limiter.ts   # isRateLimited, truncateCallbackData (60 chars)
    │   ├── date-helpers.ts   # getDateRange, getMonthName, getNowBR
    │   └── command-parsing.ts # parseCommand
    ├── services/
    │   ├── telegram.ts       # 4 Telegram API wrappers (send, sendWithKeyboard, edit, answer)
    │   ├── database.ts       # 11 functions: CRUD + suggestSimilar* + getAllUserTags
    │   └── deepseek.ts       # callDeepSeek, parseNaturalLanguage, chat history
    └── handlers/
        ├── commands.ts       # 13 slash command handlers + shared handleEntity
        ├── management.ts     # 8 entity management functions with pagination
        ├── queries.ts        # getSummaryData, formatSummaryMessage, query handlers
        ├── nl-processing.ts  # NL routing + wizard initiation
        ├── callbacks.ts      # ~25 callback prefix handlers + handleGroupFilterCallback
        └── wizard.ts         # 7 wizard functions (state + step + advance)
```
