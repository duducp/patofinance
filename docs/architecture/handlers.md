# Handlers Reference

## Module: `handlers/commands.ts` — Slash Commands

All handler parameter convention: `(supabase, userId, chatId, ...args)` where `userId` is the Telegram ID (not internal DB id).

### `handleStart(chatId, firstName)`
Welcome message. No DB calls.

### `handleHelp(chatId)`
Lists all slash commands + NL example phrases.

### `handleBalance(supabase, userId, chatId, args?)`
- Parses `--periodo`/`--mes` flag for `last_month`
- Optional group filter via positional arg
- Queries income + expense totals in parallel
- Shows "Filter by group" keyboard button

### `handleTransaction(type, supabase, userId, chatId, args, descriptionOverride?)`
- Unified handler for both `/despesa` and `/receita`
- Checks for active wizard first (routes to wizard if found)
- If no args: starts wizard at `amount` step
- Parses args via `parseCommand()` for `--data`, `--grupo`, `#tags`, amount, category
- Checks similar entities before creating
- Inserts transaction + shows success message

### `handleStatement(supabase, userId, chatId, page?, typeFilter?, filters?)`
- Complex handler with full filtering capability
- Resolves period from filters or defaults to "this_month"
- Shows income/expense sections separately
- Pagination with `◀️ Anterior` / `▶️ Próximo` buttons
- Filter toggle: income / expense / all
- "Novo filtro" button opens filter panel

### `handleSummary(supabase, userId, chatId, args?)`
- Delegates to `getSummaryData()` + `formatSummaryMessage()`
- Supports `--periodo`/`--mes` flag
- Optional group filter
- Shows "Filter by group" keyboard

### `handleEdit(supabase, userId, chatId, args)`
- Shows transaction detail + 6 edit action buttons:
  - Edit amount, category, group, tags, description, date
  - Delete button also available

### `handleDelete(supabase, userId, chatId, args)`
- Shows transaction detail + confirm/cancel keyboard

### `handleEntity(type, supabase, userId, chatId, args)`
- Shared handler for category and group operations
- `type: "category" | "group"` parameterized via table of constants
- If no args: lists entities with counts + clickable management buttons
- If args: checks similarity before creating
- Similarity prompt → "Usar X?" or "Criar Y mesmo assim?"

### `handleGroup(…)`
Alias: `handleEntity("group", …)`

### `handleCategory(…)`
Alias: `handleEntity("category", …)`

### `handleTag(supabase, userId, chatId)`
- Lists all user tags with transaction counts
- Clickable buttons to filter by tag (via management)

### `handleCleanup(supabase, userId, chatId)`
- Shows unused categories (non-predefined) and groups (non-default)
- Confirm dialog: `confirm_cleanup` / `cancel_cleanup`
- Does NOT show or delete tags (tags are metadata)

### `handleReset(supabase, userId, chatId)`
- Shows stats (transactions, categories, groups) and asks user to type `RESETAR` to confirm
- Sets wizard state `reset_confirm` with `user_id` and `telegram_id`
- On confirmation text in `index.ts`: deletes wizard_states → transactions → categories → groups → users (cascade handles all FKs)

## Module: `handlers/management.ts` — Entity Management

### `handleCreateCategory / handleCreateGroup`
- Normalized exact match check → warn if exists
- Trigram similarity check → suggest similar
- Insert with `normalized_name`

### `handleListCategories / handleListGroups`
- With `is_predefined`/`is_default` indicator star
- With `transaction_type` icon for categories

### `handleListTransactions(supabase, userId, chatId, limit, tag?, page?, messageId?)`
- Parallel COUNT + data queries
- `limit + 1` fetch pattern for "hasMore" detection
- Edits message when `messageId` provided (pagination)

### `handleShowLastTransaction`
- Shows detail + edit/delete buttons

### `handleDeleteLastTransaction`
- Confirm dialog with transaction detail

### `handleListByTag(supabase, userId, chatId, tag, page?, messageId?)`
- Same pagination pattern as `handleListTransactions`
- Tag-filtered via `contains` on tags array

## Module: `handlers/queries.ts` — Aggregation

### `getSummaryData(supabase, userId, period?, groupId?)`
- Returns `SummaryData` with totals + per-category breakdown
- Used by both `/resumo` and NL summary queries

### `formatSummaryMessage(data, groupName?)`
- Formats income/expense sections + balance

### `handleQueryExpenses(supabase, userId, chatId, period, date, category)`
- Handles NL expense queries with optional category filter
- Client-side category filter (Supabase JS doesn't support ilike on joined tables)

### `handleQuerySummary(supabase, userId, chatId, period)`
- Delegates to shared `getSummaryData` + `formatSummaryMessage`

## Module: `handlers/wizard.ts` — Wizards

### `getWizardState(supabase, userId)` → `WizardState | null`
- Reads DB, checks expiry, auto-deletes expired states

### `setWizardState(supabase, userId, step, data?)`
- Upserts wizard state with 10-min TTL

### `clearWizardState(supabase, userId)`
- Deletes wizard state row

### `sendWizardStepMessage(chatId, step, userId, supabase, messageId?)`
- Renders step UI: text input, category select, group select, tags, date picker

### `completeWizard(supabase, userId, chatId, data)`
- Creates transaction from accumulated wizard data
- Checks similarity for categories, groups, tags
- Formats success message

### `advanceWizardToNextStep(supabase, userId, chatId, currentStep, newStateData)`
- Finds next step by `step_order`
- Sends next step or completes wizard

### `handleTransactionWizard(type, supabase, userId, chatId, state, input)`
- Routes wizard input by step key
- Accumulates tags (multi-step text input)
- Handles custom date parsing

## Module: `handlers/nl-processing.ts` — NL Routing

### `handleNaturalLanguageWithFollowUp(supabase, userId, chatId, natural, sessionSeq)`
- Routes parsed NL response
- Missing fields → follow-up wizard
- Valid intent → execute action

### `executeNaturalLanguageAction(supabase, userId, chatId, natural, sessionSeq?)`
- Routes all 18 supported intents to appropriate handlers
- Category resolution via `resolveCategoryForNL()`
- Group check: if >1 group, show group picker
- Handles DeepSeek hallucination detection (multi-word category → show picker)
