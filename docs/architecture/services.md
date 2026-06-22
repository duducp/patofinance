# Services Layer

> 📖 Register completo de todos os callbacks que seguem o padrão **edit-in-place** (19 callbacks): [`AGENTS.md` > In-Place Callbacks — Complete Register](../../AGENTS.md#in-place-callbacks--complete-register)
> Padrão formal de in-place editing: [`patterns.md` > §17 In-Place Editing](patterns.md#17-in-place-editing-edit-in-place)

## `services/telegram.ts` — Telegram API Wrapper

5 exported functions wrapping the Telegram Bot API:

| Function | API Method | Purpose |
|----------|-----------|---------|
| `sendTelegramMessage(chatId, text)` | `sendMessage` | Plain text |
| `sendTelegramMessageWithKeyboard(chatId, text, keyboard)` | `sendMessage` | With inline keyboard |
| `editTelegramMessageWithKeyboard(chatId, msgId, text, keyboard)` | `editMessageText` | Edit existing message |
| `answerCallbackQuery(callbackQueryId)` | `answerCallbackQuery` | Acknowledge button press |
| `deleteTelegramMessage(chatId, messageId)` | `deleteMessage` | Delete a message (used to clean up user input in wizard) |

Common behavior:
- All use `parse_mode: "Markdown"` (except auto-retry on parse error)
- All wrapped in try/catch with console.error on failure
- Silent on `"message is not modified"` errors (harmless edit conflicts)

## `services/database.ts` — Data Access Layer

29 exported functions + 1 constant:

| Function | Params | Returns |
|----------|--------|---------|
| `normalizeString(str)` | `string` | `string` — lowercase, strip accents, strip non-alnum |
| `userOrNullFilter(userId)` | `number` | `string` — `.or()` filter for "user_id = X OR user_id IS NULL" |
| `typeOrNullFilter(type)` | `string` | `string` — `.or()` filter for "transaction_type = X OR transaction_type IS NULL" |
| `getOrCreateUser(supabase, telegramId)` | `(any, number)` | `user \| null` — read-only lookup via telegram_accounts |
| `requireUser(supabase, userId, chatId)` | `(any, number, number)` | `user \| null` — sends error message if missing |
| `getCategories(supabase, userId, type?)` | `(any, number, "expense"\|"income"?)` | `{name}[]` — filtered by transaction_type |
| `getOrCreateCategory(supabase, userId, name, transactionType?)` | `(any, number, string, string?)` | `category_id \| null` — exact normalized match, then insert |
| `resolveCategoryForNL(supabase, userId, name, transactionType?)` | `(any, number, string, string?)` | `{id, name} \| null` — exact + trigram |
| `getOrCreateGroup(supabase, userId, name)` | `(any, number, string\|null)` | `group_id \| null` — null name → default group |
| `suggestSimilarCategories(supabase, userId, query, limit?)` | `(any, number, string, number)` | `{name, similarity}[]` — via pg_trgm RPC |
| `suggestSimilarGroups(supabase, userId, query, limit?)` | `(any, number, string, number)` | `{name, similarity}[]` — via pg_trgm RPC |
| `suggestSimilarTags(supabase, userId, query, limit?)` | `(any, number, string, number)` | `{tag, similarity}[]` — via pg_trgm RPC |
| `sendSimilarityWarning(supabase, userId, chatId, type, query)` | `(any, number, number, string, string)` | `void` — sends Telegram message |
| `getAllUserTags(supabase, userId)` | `(any, number)` | `string[]` — sorted, unique |
| `getOrCreateUncategorizedCategory(supabase, userId)` | `(any, number)` | `category_id \| null` — returns system "Outros" as fallback |
| `createTransaction(supabase, data)` | `(any, CreateTransactionData)` | `{error, id?}` — inserts transaction row |
| `deduplicateByNormalizedName(items)` | `any[]` | `any[]` — user category overrides system with same normalized_name |
| `deleteTransactionById(supabase, userId, transactionId)` | `(any, number, number\|string)` | `{success, error?}` — deletes owned transaction |
| `getTransactionById(supabase, userId, transactionId, selectFields?)` | `(any, number, number\|string, string?)` | `transaction \| null` — with category/group joins |
| `findGroupByName(supabase, userId, name)` | `(any, number, string)` | `{id, name} \| null` — ilike match |
| `listTransactionsPaginated(supabase, userId, limit, page, tag?)` | `(any, number, number, number, string?)` | `{transactions, totalCount, hasMore}` — limit+1 fetch pattern |
| `getRecurrences(supabase, userId, includeArchived?)` | `(any, number, boolean?)` | `any[]` — sorted by next_date ascending |
| `getRecurrenceById(supabase, userId, recurrenceId)` | `(any, number, number)` | `any \| null` — with category/group joins |
| `createRecurrence(supabase, data)` | `(any, RecurrenceData)` | `{error, id?}` — inserts recurrence row |
| `updateRecurrence(supabase, userId, recurrenceId, updates)` | `(any, number, number, Record)` | `{error}` — sets updated_at timestamp |
| `archiveRecurrence(supabase, userId, recurrenceId)` | `(any, number, number)` | `{error}` — sets is_archived + archived_at |
| `activateRecurrence(supabase, userId, recurrenceId, newNextDate?)` | `(any, number, number, string?)` | `{error}` — clears archived flag, optionally sets next_date |
| `drainNotificationQueue(supabase, userId)` | `(any, number)` | `string[]` — fetches undelivered messages, marks delivered |

### Constants

| Constant | Type | Purpose |
|----------|------|---------|
| `TRANSACTION_DETAIL_FIELDS` | `string` | Standard Supabase select string for transaction detail/edit views (id, type, amount, description, tags, transaction_date, recurrence_id, categories(name), groups(name)) |

### Category Resolution for NL (`resolveCategoryForNL`)

When DeepSeek returns a category name:
1. **Exact normalized match** — `normalized_name` equality against both user-owned and system-global categories
2. **Trigram similarity** (≥ 0.5 threshold) — first result from `suggest_categories` (includes system)
3. **No match** → `null` (triggers category keyboard in NL processing)

### Trigram Suggest Flow

```
suggestSimilarCategories(userId, query, limit=3)
  → supabase.rpc("suggest_categories", { p_user_id, p_query, p_limit })
  → PostgreSQL: similarity(normalized_name, normalize_string(query))
  → Includes both user-owned and system-global categories (WHERE user_id = p_user_id OR user_id IS NULL)
  → Returns up to 3 similar names with similarity scores
```

## `handlers/wizard.ts` — Wizard Helpers

### Shared Constants

| Constant | Description |
|----------|-------------|
| `FREQ_LABELS` (exported) | `Record<string, string>` mapping frequency type keys to PT labels: `daily` → `"Diária"`, `weekly` → `"Semanal"`, `monthly` → `"Mensal"`, `annual` → `"Anual"`, `every_x_days` → `"A cada X dias"`. Used by `buildStepConfirmation`, `completeRecurrenceWizard`, and imported by `callbacks.ts` for `rec_edit_set_freqtype_` |

### Internal (non-exported) Helpers

| Function | Purpose |
|----------|---------|
| `storePromptMessageId(supabase, userId, key, messageId)` | Reads existing wizard state data, spreads it, and stores the given `key: messageId`. Used internally by `sendOrEditStep` for 5 text-input steps (category, group, tags, description, amount) to save the prompt `message_id` for later in-place editing |
| `getNextWizardStep(supabase, wizardName, currentStepOrder)` | Queries `wizard_steps` for the next step after `currentStepOrder` within the given wizard. Returns `null` if this is the last step. Used by `advanceWithConfirmation` and fallthrough handlers |
| `sendOrEditStep(chatId, messageId, prompt, keyboard, supabase, userId, storeKey)` | Eliminates duplicated send/edit/store pattern from 5 step senders. If `messageId` is provided: edits existing message in-place. If new message: sends with `sendTelegramMessageWithKeyboard` (if keyboard non-empty) or `sendTelegramMessage` (text-only). Stores the returned `message_id` via `storePromptMessageId` |
| `buildStepConfirmation(step, newStateData)` | Builds confirmation text for a completed step (e.g., `"✅ 🔖 Tags: #mercado"`, `"✅ 🔄 Frequência: Mensal (dia 15)"`). Returns `null` if no confirmation. Called by `advanceWizardToNextStep` |
| `advanceWithConfirmation(supabase, userId, chatId, wizardName, currentStep, state, stepKey, value, confirmText, promptMessageId, userMessageId, completeFn)` | Shared helper eliminating **8 duplicated advance blocks**: handles `setWizardState`, edit prompt in-place, delete user message, query next step, send next step or call `completeFn` |
| `parseAmount(input)` | Validates and parses amount string (handles comma → dot). Returns `number | null` on failure |
| `formatTags(tags)` | Ensures `#` prefix on all tags. Accepts array or space-separated string. Returns `string[]` |
| `buildFreqDetailConfirm(freqType, day, month?)` | Builds frequency detail confirmation: `"A cada X dias"`, `"Mensal (dia X)"`, `"Anual (X de Mês)"` |
| `advanceFreqDetailToTags(supabase, userId, chatId, state, extraData, freqDetailPromptMessageId?, userMessageId?)` | After frequency detail input: edits prompt, deletes user msg, sets state to tags step, sends tags keyboard or completes |
| `buildRecurrenceSuccessMsg(recurrenceId, data)` | Formats success message with recurrence details, frequency label, and management buttons |
| `handleTagsInput(supabase, userId, chatId, state, input, wizardName, currentStep, userMessageId?)` | Accumulates tags in wizard state, deduplicates, re-renders tag keyboard via `sendWizardStepMessage`, and deletes user message. Called by `handleWizardInput` when the current step is `tags` |
### `handleWizardInput` (exported)

| Function | Params | Purpose |
|----------|--------|---------|
| `handleWizardInput(supabase, userId, chatId, state, input, userMessageId?)` | `(any, number, number, WizardState, string, number?)` | Unified router for all wizard text input (gasto/receita/recorrencia). Deduces `wizardName` from `state.step` prefix, determines `type` (expense/income) and `completeFn` (completeWizard/completeRecurrenceWizard). Handles 3 special cases: custom_date (gasto/receita), freq_detail (recorrencia), start_date (recorrencia). Standard steps (amount, tags, category, group, description) use `advanceWithConfirmation` with the correct `completeFn`. Replaces the previously separate `handleTransactionWizard` + `handleRecurrenceWizard` |

### `advanceWizardToNextStep` (exported)

| Function | Params | Purpose |
|----------|--------|---------|
| `advanceWizardToNextStep(supabase, userId, chatId, currentStep, sessionSeq, newStateData, messageId?)` | `(any, number, number, any, number, Record<string, any>, number?)` | Moves to the next wizard step or completes the wizard. Key behavior: the confirmation edit via `buildStepConfirmation` runs **before** querying the next step, so it always executes even when the current step is the last one |

**Execution order:**
1. **Confirmation edit** — If `messageId` is provided, edits the prompt in-place with `buildStepConfirmation(currentStep, newStateData)`. This always happens first, regardless of whether there's a next step
2. **Find next step** — Queries `wizard_steps` for the step with the next `step_order` within the same wizard
3. **Advance or complete** — If a next step exists: updates wizard state (`setWizardState`) and sends the next step via `sendWizardStepMessage`. If no next step: calls `completeWizard` (for gasto/receita) or `completeRecurrenceWizard` (for recorrencia)

This ensures that when the user clicks "⏭️ Pular" or "✅ Concluir" on the **last step** (e.g., tags in gasto/receita), the prompt is still edited with the confirmation text (e.g., `"✅ 🔖 Tags: Nenhuma tag"`) before the wizard is completed.

### Entity Management Functions (exported)

| Function | Params | Purpose |
|----------|--------|---------|
| `handleEntityRename(type, supabase, userId, chatId, entityName, messageId)` | `("category"\|"group", any, number, number, string, number)` | Starts a rename wizard: verifies the entity is not predefined/default, edits the callback message in-place with `editTelegramMessageWithKeyboard(chatId, messageId, ...)` to show "✏️ Digite o novo nome" prompt (removing action menu buttons), sets wizard state with step `rename_cat` or `rename_grp`. The user's next text input is handled by `handleWizardInput` which reads `state.data.name` |
| `handleEntityDeletePrompt(type, supabase, userId, chatId, entityName, sessionSeq)` | `("category"\|"group", any, number, number, string, number)` | Shows delete confirmation dialog with entity name and transaction count. Prevents deletion of predefined/default entities. Uses `buildDeleteConfirmKeyboard` for the confirm/cancel buttons. Gender-aware labels ("a categoria" / "o grupo") |
| `handleEntityDeleteExecute(type, supabase, userId, chatId, entityName)` | `("category"\|"group", any, number, number, string)` | Executes entity deletion: verifies not predefined/default, reassigns affected transactions to fallback ("Sem categoria" via `getOrCreateUncategorizedCategory` or "Pessoal" via `is_default` group lookup), deletes entity row, sends success message with reassignment count |

### Keyboard Builders (exported)

| Function | Params | Purpose |
|----------|--------|---------|
| `buildDeleteConfirmKeyboard(confirmCallback, cancelCallback)` | `(string, string)` | Returns a 2-button `InlineKeyboard`: `✅ Sim, excluir` and `❌ Não, manter`. Used by `handleEntityDeletePrompt` and `showDeleteConfirmation` |
| `buildDateKeyboard({ todayCallback, yesterdayCallback, customCallback })` | `(todayCallback, yesterdayCallback, customCallback)` | Returns a date selection keyboard: top row with "📅 Hoje" / "📅 Ontem", bottom row with "📆 Outra data". Callbacks receive the ISO date string as parameter |

### Usage Pattern

```typescript
// sendOrEditStep — eliminates 5x duplicated send/edit/store pattern
await sendOrEditStep(chatId, messageId, step.prompt, keyboard, supabase, userId, "_amountPromptMessageId");

// advanceWithConfirmation — eliminates 8x duplicated pattern
return await advanceWithConfirmation(
  supabase, userId, chatId, wizardName, currentStep, state,
  stepKey, value, confirmText, promptMessageId, userMessageId,
  completeWizard // or completeRecurrenceWizard
);

// advanceWizardToNextStep — called by callback handlers (e.g., wiz_done_tags, wiz_freq_detail)
await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, sessionSeq, newStateData, message.message_id);

// buildDeleteConfirmKeyboard — in callback handlers
const keyboard = buildDeleteConfirmKeyboard(
  addSession(`cat_del_yes_${entityName}`, sessionSeq),
  addSession("cat_back", sessionSeq),
);

// buildDateKeyboard — in step sender functions
const keyboard = buildDateKeyboard({
  todayCallback: (date) => addSession(`wiz_date_${date}`, sessionSeq),
  yesterdayCallback: (date) => addSession(`wiz_date_${date}`, sessionSeq),
  customCallback: addSession("custom_date", sessionSeq),
});
```

## `handlers/callbacks.ts` — Inline Keyboard Routing

### Shared Helpers

| Function | Description |
|----------|-------------|
| `removeUnusedEntities(supabase, userId, table, fkColumn, ownerColumn, flagColumn, flagValue)` | Queries transactions to find unused entity IDs, deletes them. Used by `confirm_cleanup` for both categories (`is_predefined = false`) and groups (`is_default = false`). Replaces previously duplicated inline blocks |
| `handleGroupFilterCallback(supabase, telegramId, chatId, prefix, selectedValue)` | Routes balance/summary group filter buttons (`*_shwgrp`, `*_grp_*`) to show keyboard or execute filtered query |

### `FREQ_LABELS` (exported from wizard.ts)

Shared constant mapping frequency type keys to PT labels. Used by `rec_edit_set_freqtype_` callback handler, `buildStepConfirmation`, and `buildRecurrenceSuccessMsg`.

### `handleWizardInput` (exported from wizard.ts)

Unified router for all wizard text input. Called from `index.ts` when user sends text while in any wizard state (gasto/receita/recorrencia). Deduces wizard name from `state.step` prefix. See services.md for full signature.

## `services/deepseek.ts` — Natural Language Processing

### Architecture

```
parseNaturalLanguage(text, {userId?, context?})
  │
  ├── checkCommonPhrase(text) ──► immediate return if match
  │
  ├── getCachedResponse(userId, text) ──► return if within 5min TTL
  │
  ├── callDeepSeek(text, {context}) ──► DeepSeek API (5s timeout)
  │     │
  │     └── buildSystemPrompt(context) ──► dynamic prompt with:
  │           ├── Current date + yesterday + tomorrow (America/Sao_Paulo)
  │           ├── All valid intents with keyword examples
  │           ├── User's categories (with transaction_type)
  │           ├── User's groups
  │           └── User's tags
  │
  ├── parseDeepSeekResponse(raw) ──► Partial<DeepSeekResponse>
  │
  ├── Validate and detect missingFields
  │
  └── setCachedResponse(userId, text, result)
```

### Common Phrases (No API Call)

12 hardcoded phrases in `config.ts` that bypass DeepSeek entirely:

| Phrase | Intent |
|--------|--------|
| `"quanto tenho"`, `"saldo"` | `query_balance` |
| `"extrato"` | `query_extract` |
| `"resumo"` | `query_summary` |
| `"quais categorias"` | `list_categories` |
| `"meus grupos"` | `list_groups` |
| `"quais tags"` | `list_tags` |
| `"últimas transações"` | `list_transactions` |
| `"último gasto"` | `show_last_transaction` |
| `"apagar última"` | `delete_last_transaction` |
| `"limpe"`, `"limpar"` | `cleanup` |

### Cache (`nlCache`)

- Per-user `Map<text, {response, timestamp}>`
- TTL: 5 minutes (`NL_CACHE_TTL = 300000`)
- Auto-cleanup: stale entries removed on access
- LRU eviction: when >100 entries, oldest 50% are purged

### DeepSeek API Call

- Model: `deepseek-chat`
- Temperature: `0.1` (for consistent JSON output)
- Max tokens: `200`
- Timeout: `5000ms` (via AbortController)
- System prompt includes user's actual categories/groups/tags

### Prompt Design

The `buildSystemPrompt()` function creates a dynamic system prompt with:
1. JSON format specification (`DeepSeekResponse` shape)
2. All valid intents with Portuguese keyword examples
3. Rules for category extraction (single-word matching, no hallucination)
4. Current date context (today/yesterday/tomorrow in America/Sao_Paulo)
5. User's actual categories with type annotations
6. Category rules by type (income categories for income intent)
7. User's groups and tags

### `DeepSeekResponse` Type

```typescript
interface DeepSeekResponse {
  intent: "expense" | "income" | "query_balance" | "query_expenses_month"
        | "query_expenses_last_month" | "query_expenses_date"
        | "query_expenses_category" | "query_summary" | "query_extract"
        | "create_category" | "create_group" | "list_categories"
        | "list_groups" | "list_tags" | "list_transactions"
        | "show_last_transaction" | "delete_last_transaction"
        | "list_by_tag" | "cleanup" | null;
  amount: number | null;
  category: string | null;
  date: string | null;         // YYYY-MM-DD
  period: "this_month" | "last_month" | null;
  name: string | null;          // For create_category / create_group
  tag: string | null;           // Without #
  limit: number | null;         // Default 10 for list_transactions
  missingFields: string[];      // Computed by parseNaturalLanguage
}
```

### Missing Fields Detection

After parsing, `parseNaturalLanguage()` computes `missingFields`:
- `expense` / `income` without `amount` → `["amount"]`
- `expense` / `income` without `category` → `["category"]`
- `query_expenses_date` without `date` → `["date"]`
- Query intents without `period` → `["period"]`
