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

### `handleDetails(supabase, userId, chatId, args)`
- Shows all transaction details: ID, type, amount, category, group, tags, date, description
- Same edit/delete keyboard as `handleEdit`

### `handleEdit(supabase, userId, chatId, args)`
- Shows transaction detail + 6 edit action buttons:
  - Edit amount, category, group, tags, description, date
  - Delete button also available

### `showDetailsMainView(supabase, userId, chatId, transaction, sessionSeq)`
- Renders the main transaction detail view with all fields (ID, type, amount, category, group, tags, date, description)
- Shows inline keyboard: Edit, Delete, Back to list
- Used by both `/detalhes` command and callback navigation

### `showDetailsEditActions(supabase, userId, chatId, transaction, sessionSeq)`
- Renders the edit action menu for a transaction with 6 inline buttons:
  - 💰 Valor, 🏷️ Categoria, 📁 Grupo, 🔖 Tags, 📝 Descrição, 📅 Data
- Also includes ❌ Excluir button

### `handleDelete(supabase, userId, chatId, args)`
- Shows transaction detail + confirm/cancel keyboard

### `handleLogin(supabase, userId, chatId, _args?)`
- Generates a 6-character alphanumeric link code for authenticating the web dashboard
- Inserts code into `link_codes` table with 5-minute expiry
- Sends message with code and instructions
- The code is validated by `auth-telegram` Edge Function and creates a Supabase Auth session

### `handleCategory(supabase, userId, chatId, args)`
- Standalone handler for category operations (separated from group in refactoring)
- If no args or `args[0] === "listar"`: lists categories with transaction counts + type icons (expense/income) + management buttons
  - Includes system-global (`user_id IS NULL`) categories, deduplicated
  - System categories show "⭐ Categoria padrão" — no rename/delete
- If args: checks similarity against user + system categories before creating
  - Exact normalized match → "⚠️ Categoria 'X' já existe"
  - Trigram similarity → suggest prompt "Usar X?" or "Criar Y mesmo assim?"
  - No match → creates directly

### `handleGroup(supabase, userId, chatId, args)`
- Standalone handler for group operations (separated from category in refactoring)
- If no args: lists groups with transaction counts + management buttons
- If args: checks similarity before creating
  - Exact normalized match → warn
  - Trigram similarity → suggest prompt
  - No match → creates directly

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
- Includes system-global categories (`user_id IS NULL`), deduplicated (user's own overrides system)

### `handleListTransactions(supabase, userId, chatId, limit, tag?, page?, messageId?)`
- Parallel COUNT + data queries
- `limit + 1` fetch pattern for "hasMore" detection
- Edits message when `messageId` provided (pagination)

### `handleShowLastTransaction`
- Shows detail + edit/delete buttons

### `showDeleteConfirmation(supabase, userId, chatId, transactionId)`
- Shows a delete confirmation dialog with transaction details and a shared `buildDeleteConfirmKeyboard`
- Called by `handleDelete` command and `confirm_delete_` callback handler
- On confirm: deletes transaction and sends success message

### `handleDeleteLastTransaction`
- Confirm dialog with transaction detail

### `handleListByTag(supabase, userId, chatId, tag, page?, messageId?)`
- Same pagination pattern as `handleListTransactions`
- Tag-filtered via `contains` on tags array

### `handleSearch(supabase, userId, chatId, query)`
- Searches transactions by description, tags, and category name using pg_trgm similarity
- Calls `search_transactions` RPC with the given query
- Returns up to 15 results formatted as a list

## Module: `handlers/queries.ts` — Aggregation

### `getSummaryData(supabase, userId, period?, groupId?)`
- Returns `SummaryData` with totals + per-category breakdown
- Used by both `/resumo` and NL summary queries

### `formatSummaryMessage(data, groupName?)`
- Formats income/expense sections + balance

### `handleQueryExpenses(supabase, userId, chatId, period, date, category)`
- Handles NL expense queries with optional category filter
- Client-side category filter (Supabase JS doesn't support ilike on joined tables)

### `formatFutureBlock(data, options?)` → `string`
- Formats the "previsto" (projected) section for balance and summary responses
- Shows projected income, expenses, and remaining balance for the current month
- Returns an empty string if no data is available

### `buildQueryExpensesFilters(category)` → `{ type, limit }`
- Builds filter parameters for expense queries
- Returns base filter object with `type: "expense"` and configurable `limit`
- Used by NL expense queries

### `sendTransactionSuccess(supabase, chatId, userId, type, data)`
- Sends a formatted success message after transaction creation
- Includes amount, category, group, date, description, tags
- Shows inline keyboard with edit/delete options and "Transformar em recorrência" button
- Used by `completeWizard` and direct creation flows

### `handleQuerySummary(supabase, userId, chatId, period)`
- Delegates to shared `getSummaryData` + `formatSummaryMessage`

## Module: `handlers/recurrences.ts` — Recurring Transactions

### `handleRecurrences(supabase, userId, chatId)`
- Lists all active recurrences sorted by `next_date`
- Shows amount, category, frequency, next_date per item
- "Transformar em recorrência" button after `/despesa`/`/receita` calls this flow
- Same view as `rec_manage` callback

### `handleManageRecurrences(supabase, userId, chatId)`
- Lists recurrences WITH clickable management buttons (show detail, archive)
- Used by callback `rec_manage`

### `handleRecurrenceDetail(supabase, userId, chatId, recId, messageId?)`
- Full recurrence detail with management buttons:
  - 🚀 Adiantar — create next occurrence now
  - ⏭️ Pular — skip next occurrence
  - 📦 Arquivar — archive (stop generating)
  - 📝 Editar — edit fields
  - Reativar — for archived recurrences

### `handleAdvanceRecurrence(supabase, userId, chatId, recId)`
- Creates a transaction with `transaction_date = next_date`
- Recalculates next_date via `process_recurrences` logic
- Re-renders updated recurrence detail

### `handleSkipRecurrence(supabase, userId, chatId, recId)`
- Recalculates next_date without creating a transaction
- Shows "Próxima: {new date}"

### `handleArchiveRecurrence(supabase, userId, chatId, recId)`
- Sets `archived = true`
- Stops future auto-generation

### `handleActivateRecurrence(supabase, userId, chatId, recId)`
- Sets `archived = false`
- If `next_date` is in the past, recalculates to today

### `handleAdvanceRecurrenceConfirm(supabase, userId, chatId, recId)`
- Second step of advance flow: creates the transaction after user confirms via `rec_advance_yes_` callback
- Creates transaction with `transaction_date = next_date`
- Recalculates next_date and updates recurrence
- Re-renders updated recurrence detail

### `handleSkipRecurrenceConfirm(supabase, userId, chatId, recId)`
- Second step of skip flow: executes skip after user confirms via `rec_skip_yes_` callback
- Recalculates next_date without creating transaction
- Re-renders updated recurrence detail

### `handleArchiveRecurrenceConfirm(supabase, userId, chatId, recId)`
- Second step of archive flow: archives after user confirms via `rec_archive_yes_` callback
- Sets `archived = true` and clears `next_date`
- Shows confirmation with reactivate option

### `handleActivateRecurrenceConfirm(supabase, userId, chatId, recId)`
- Second step of activate flow: reactivates after user confirms via callback
- Sets `archived = false`
- If `next_date` is in the past, recalculates to today
- Re-renders recurrence detail with management buttons

### `handleRecurrenceTransactions(supabase, userId, chatId, recId)`
- Lists all transactions generated by a specific recurrence
- Shows paginated list with dates and amounts
- Clickable items to view transaction details

### `handleEditRecurrence(supabase, userId, chatId, recId)`
- Shows edit action buttons (same pattern as edit transaction fields)
- Each field opens its own edit flow (text input or select)

### `handleEditRecurrenceField(supabase, userId, chatId, recId, field)`
- Editable fields: amount, description, category, group, frequency, tags, start_date
- Text input: amount, description, start_date, frequency detail
- Select: category, group, frequency type

## Module: `handlers/wizard.ts` — Wizards

### `getWizardState(supabase, userId)` → `WizardState | null`
- Reads DB, checks expiry, auto-deletes expired states

### `setWizardState(supabase, userId, step, data?)`
- Upserts wizard state with 10-min TTL

### `clearWizardState(supabase, userId)`
- Deletes wizard state row

### `sendWizardStepMessage(chatId, step, userId, supabase, sessionSeq, messageId?)`
- Renders step UI: text input, category select, group select, tags, date picker
- `sessionSeq` — session protection sequence for callback data
- `messageId?` — if provided, **edits** existing message in-place instead of sending new
- For text-input steps (amount, description, tags), stores the returned `message_id` in wizard state as `_<step>PromptMessageId` for later in-place editing

### `completeWizard(supabase, userId, chatId, data)`
- Creates transaction from accumulated wizard data
- Checks similarity for categories, groups, tags
- Formats success message

### `completeRecurrenceWizard(supabase, userId, chatId, data)`
- Creates recurrence from accumulated wizard data (type, amount, description, category, group, frequency, tags, start_date)
- Formats success message with frequency label and management buttons

### `advanceWizardToNextStep(supabase, userId, chatId, currentStep, sessionSeq, newStateData, messageId?)`
- **Confirmation edit always happens first** — before querying the next step, edits the current prompt via `buildStepConfirmation` when `messageId` is provided
- This ensures the confirmation (`✅ 🔖 Tags: Nenhuma tag`) appears even when the current step is the **last step** (e.g., tags in gasto/receita wizards)
- Then finds next step by `step_order`
- Sends next step or completes wizard (calls `completeRecurrenceWizard` for recorrencia, `completeWizard` otherwise)

### `handleEntityRename(type, supabase, userId, chatId, entityName)`
- Starts a rename wizard for a category or group
- `type: "category" | "group"` — verifies the entity is not predefined/default before proceeding
- Sets wizard state with step `rename_cat` or `rename_grp` and the old name in data
- The user's next text input is handled by `handleTransactionWizard` which reads `state.data.name`

### `handleEntityDeletePrompt(type, supabase, userId, chatId, entityName, sessionSeq)`
- Shows a delete confirmation dialog with the entity's transaction count
- `type: "category" | "group"` — adjusts labels and article gender ("a categoria" / "o grupo")
- Queries transaction count for the entity, shows it in the confirmation message
- Uses shared `buildDeleteConfirmKeyboard` with `cat_del_yes_` / `grp_del_yes_` and back buttons
- Prevents deletion of predefined/default entities (returns early with warning message if flagged)

### `handleEntityDeleteExecute(type, supabase, userId, chatId, entityName)`
- Executes entity deletion after user confirms
- Reassigns affected transactions to fallback ("Sem categoria" or "Pessoal")
- Deletes the entity row from categories/groups table
- Sends success message with count of reassigned transactions

### `handleTransactionWizard(type, supabase, userId, chatId, state, input, userMessageId?)`
- Routes wizard input by step key
- `userMessageId?` — when provided, the user's typed message is **deleted** after processing
- **Amount step:** edits prompt in-place to `✅ 💰 Valor: R$ XX,XX`, deletes user message, advances
- **Description step:** edits prompt to `✅ 📝 Descrição: texto`, deletes user message, advances
- **Category/Group text input:** edits prompt to `✅ 🏷️ Categoria: nome` / `✅ 📁 Grupo: nome`, deletes user message, advances
- **Tags step:** accumulates tags (multi-step text input), re-renders tag keyboard in-place, deletes user message
- **Custom date:** edits prompt to `✅ 📅 Data: DD/MM/AAAA`, deletes user message, advances
- **Default:** sets `[stepKey]: value` in wizard state and advances

### `toggleTagInWizardState(supabase, userId, tag)` → `string[]`
- Toggles a tag on/off in the wizard state `data.tags` array
- Shared by both `edit_tag_tog_` (transaction edit) and `wiz_tag_` (wizard) callback handlers
- Returns the updated tags array

### `buildTagKeyboard(supabase, userId, sessionSeq, { togglePrefix, extraButtons? })`
- Builds a tag selection keyboard with `✅` indicators for selected tags
- Reads current tags from wizard state, queries user's existing tags via `getAllUserTags`
- Returns `{ keyboard, currentTags, hasExistingTags }`
- Used by `sendWizardStepMessage` for the tags step

### `buildCategoryKeyboard(supabase, userId, sessionSeq, { callbackPrefix, wizardType?, extraButtons? })`
- Builds a category selection keyboard grid with deduplication by `normalized_name`
- Includes both user-owned and system-global categories via `userOrNullFilter`
- Optionally filters by `transaction_type` via `typeOrNullFilter`
- Used by `sendWizardStepMessage` for the category step and recurrence edit flows

### `buildGroupKeyboard(supabase, userId, sessionSeq, { callbackPrefix, extraButtons? })`
- Builds a group selection keyboard grid
- Queries groups where `user_id = userId`
- Used by `sendWizardStepMessage` for the group step and recurrence edit flows

### `handleWizardSkip(supabase, userId, chatId, sessionSeq, messageId?)`
- Handles skip actions for wizard steps (description, tags)
- Reads the current wizard step via `getCurrentWizardStep`, sets the step's value to empty string
- Calls `advanceWizardToNextStep` with the empty value (which shows `"Nenhuma tag"` / `"Nenhuma descrição informada"` confirmation)
- Shared by `wizard_skip_description` and `wizard_skip_tags` callback handlers

### `getCurrentWizardStep(supabase, userId)` → `{ state, currentStep } | null`
- Reads the current wizard state and resolves the corresponding `wizard_step` row
- Parses `state.step` (e.g., `"gasto_amount"`) into `wizardName` + `stepKey`
- Returns `null` if no state exists or step definition is missing

### `handleRecurrenceWizard(supabase, userId, chatId, state, input, userMessageId?)`
- Routes recurrence wizard input by step key
- `userMessageId?` — when provided, the user's typed message is **deleted** after processing
- **Frequency detail:**
  - `every_x_days`: validates interval, edits prompt to `✅ 🔄 Frequência: A cada X dias`, deletes user message
  - `monthly`: validates day (1–31), edits prompt to `✅ 🔄 Frequência: Mensal (dia X)`, deletes user message
  - `annual`: validates day + month, edits prompt to `✅ 🔄 Frequência: Anual (X de Mês)`, deletes user message
- **Start date:** edits prompt to `✅ 📅 Data de início: DD/MM/AAAA`, deletes user message, completes wizard
- **Amount/Description/Category/Group/Tags:** same visual confirmation pattern as `handleTransactionWizard`

## Module: `handlers/nl-processing.ts` — NL Routing

### `buildNLCategoryKeyboard(categories, seq)` → `InlineKeyboard`
- Builds a 2-column keyboard grid of category names for NL follow-up
- Each button callback uses `nl_cat_` prefix with session protection via `addSession`
- Used when DeepSeek returns a multi-word category (hallucination detection)

### `handleNaturalLanguageWithFollowUp(supabase, userId, chatId, natural, sessionSeq)`
- Routes parsed NL response
- Missing fields → follow-up wizard
- Valid intent → execute action

### `executeNaturalLanguageAction(supabase, userId, chatId, natural, sessionSeq?)`
- Routes all 18 supported intents to appropriate handlers
- Category resolution via `resolveCategoryForNL()`
- Group check: if >1 group, show group picker
- Handles DeepSeek hallucination detection (multi-word category → show picker)

## Module: `handlers/statement.ts` — Statement/Extrato Filter Panel

Filte panel system for `/extrato` command with multi-select category, group, tag, type, and period filters.

### `resolvePeriod(period)` → `{ start, end, label }`
- Resolves period presets (`"this_month"`, `"last_month"`, `"last_15_days"`, etc.) to actual date ranges
- For custom periods, passes through the `{ start, end }` object directly
- Returns the ISO date strings and a formatted label string

### `handleStatement(supabase, userId, chatId, page?, typeFilter?, filters?)`
- Complex handler with full filtering capability
- Resolves period from filters or defaults to `"this_month"`
- Shows income/expense sections separately with category breakdown
- Pagination with `◀️ Anterior` / `▶️ Próximo` buttons
- Filter toggle: income / expense / all
- "Novo filtro" button opens filter panel

### `handleFilterPanel(supabase, userId, chatId, messageId?)`
- Opens or updates the filter panel UI
- Shows current filter selections with clear/edit buttons for each dimension
- Stores filter state in `wizard_states.data` as `ExtratoFilters` object
- Renders via `renderFilterPanelMessage()`

### `showCategorySelector(supabase, userId, chatId, filters, messageId?)`
- Shows category selection with keyboard (includes "Sem categoria" + "Todas" options)
- Edits the filter panel message in-place
- Includes cached category list for performance

### `showGroupSelector(supabase, userId, chatId, filters, messageId?)`
- Shows group selection keyboard
- Edits the filter panel message in-place

### `showTagSelector(supabase, userId, chatId, filters, messageId?)`
- Shows tag toggle keyboard with Concluir/Limpar buttons
- Edits the filter panel message in-place

### `showTypeSelector(supabase, userId, chatId, filters, messageId?)`
- Shows type filter (all / income / expense) with radio-button style selection
- Edits the filter panel message in-place

### `showStatusSelector(supabase, userId, chatId, filters, messageId?)`
- Shows status filter (all / future only / past only)
- Edits the filter panel message in-place

### `showPeriodSelector(supabase, userId, chatId, filters, messageId?)`
- Shows period presets keyboard (this month, last month, last 15 days, custom date)
- Custom date option stores filter state and starts a two-step date input wizard
- Edits the filter panel message in-place

### `handleFilterCallback(supabase, userId, chatId, selectedValue, sessionSeq, messageId)`
- Routes filter panel interactions by prefix (`stmt_f_cat_`, `stmt_f_grp_`, `stmt_f_tag_`, `stmt_f_type_`, `stmt_f_period_`, `stmt_f_apply`, `stmt_f_clear`)
- Reads current filter state from wizard_states, applies the change, re-renders via `makeFilterMessage`
- Used by `handleCallbackQuery` in callbacks.ts for all `stmt_f_` prefixes
