# Services Layer

## `services/telegram.ts` — Telegram API Wrapper

4 exported functions wrapping the Telegram Bot API:

| Function | API Method | Purpose |
|----------|-----------|---------|
| `sendTelegramMessage(chatId, text)` | `sendMessage` | Plain text |
| `sendTelegramMessageWithKeyboard(chatId, text, keyboard)` | `sendMessage` | With inline keyboard |
| `editTelegramMessageWithKeyboard(chatId, msgId, text, keyboard)` | `editMessageText` | Edit existing message |
| `answerCallbackQuery(callbackQueryId)` | `answerCallbackQuery` | Acknowledge button press |

Common behavior:
- All use `parse_mode: "Markdown"` (except auto-retry on parse error)
- All wrapped in try/catch with console.error on failure
- Silent on `"message is not modified"` errors (harmless edit conflicts)

## `services/database.ts` — Data Access Layer

11 exported functions:

| Function | Params | Returns |
|----------|--------|---------|
| `normalizeString(str)` | `string` | `string` — lowercase, strip accents, strip non-alnum |
| `getOrCreateUser(supabase, telegramId)` | `(any, number)` | `user \| null` — read-only lookup |
| `requireUser(supabase, userId, chatId)` | `(any, number, number)` | `user \| null` — sends error message if missing |
| `getCategories(supabase, userId, type?)` | `(any, number, "expense"\|"income"?)` | `{name}[]` — filtered by transaction_type |
| `getOrCreateCategory(supabase, userId, name, transactionType?)` | `(any, number, string, string?)` | `category_id \| null` |
| `resolveCategoryForNL(supabase, userId, name, transactionType?)` | `(any, number, string, string?)` | `{id, name} \| null` — exact + trigram |
| `getOrCreateGroup(supabase, userId, name)` | `(any, number, string\|null)` | `group_id \| null` — null name → default group |
| `suggestSimilarCategories(supabase, userId, query, limit?)` | `(any, number, string, number)` | `{name, similarity}[]` |
| `suggestSimilarGroups(supabase, userId, query, limit?)` | `(any, number, string, number)` | `{name, similarity}[]` |
| `suggestSimilarTags(supabase, userId, query, limit?)` | `(any, number, string, number)` | `{tag, similarity}[]` |
| `sendSimilarityWarning(supabase, userId, chatId, type, query)` | `(any, number, number, string, string)` | `void` — sends Telegram message |
| `getAllUserTags(supabase, userId)` | `(any, number)` | `string[]` — sorted, unique |
| `getOrCreateUncategorizedCategory(supabase, userId)` | `(any, number)` | `category_id \| null` — returns system "Outros" as fallback |

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
