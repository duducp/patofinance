# Natural Language Processing

The bot supports natural language input via the DeepSeek API. Users can type messages like `"gastei 50 no almoço"` without needing slash commands.

## Pipeline

```
User: "gastei 50 no ifood"
  │
  ▼
index.ts: !text.startsWith("/") && existingUser
  │
  ├── fetchUserContext() ── 3 parallel queries (categories, groups, tags)
  │
  └── parseNaturalLanguage(text, {userId, context})
        │
        ├── commonPhrases check ── "saldo", "extrato", etc. → bypass API
        │
        ├── nlCache check ── per-user, 5min TTL
        │
        ├── callDeepSeek() ── 5s timeout, max_tokens=200
        │     └── buildSystemPrompt(context) ── dynamic prompt with user data
        │
        ├── parseDeepSeekResponse(raw) ── JSON extraction + cleaning
        │
        ├── compute missingFields ── amount? category? period?
        │
        └── cache result ── per-user + text
  │
  ▼
intent === null?
  ├── Has number? ── incrementSessionSeq() + "Despesa ou Receita?" keyboard
  └── No number? ── "Não entendi" + /ajuda hint
  │
  ▼
intent !== null
  └── incrementSessionSeq() + handleNaturalLanguageWithFollowUp()
        │
        ├── Missing fields?
        │   ├── amount → wizard: "Quanto você gastou?"
        │   ├── category → keyboard: pick from user's categories
        │   ├── period → buttons: "Esse mês" / "Mês passado"
        │   ├── name → text: "Qual o nome da categoria?"
        │   └── tag → text: "Qual a tag?"
        │
        └── All fields present → executeNaturalLanguageAction()
```

## Intent → Action Mapping

| Intent | Action |
|--------|--------|
| `expense` | `handleTransaction("expense", ...)` |
| `income` | `handleTransaction("income", ...)` |
| `query_balance` | `handleBalance(...)` |
| `query_expenses_month` | `handleQueryExpenses("this_month")` |
| `query_expenses_last_month` | `handleQueryExpenses("last_month")` |
| `query_expenses_date` | `handleQueryExpenses(date)` |
| `query_expenses_category` | `handleQueryExpenses(period, category)` |
| `query_summary` | `handleQuerySummary(period)` |
| `query_extract` | `handleStatement(...)` |
| `create_category` | `handleCreateCategory(supabase, userId, chatId, name)` |
| `create_group` | `handleCreateGroup(supabase, userId, chatId, name)` |
| `list_categories` | `handleListCategories(...)` |
| `list_groups` | `handleListGroups(...)` |
| `list_tags` | `handleTag(...)` |
| `list_transactions` | `handleListTransactions(limit)` |
| `show_last_transaction` | `handleShowLastTransaction(...)` |
| `delete_last_transaction` | `handleDeleteLastTransaction(...)` |
| `list_by_tag` | `handleListByTag(tag)` |
| `cleanup` | `handleCleanup(...)` |

## Category Resolution

When DeepSeek returns a category, `resolveCategoryForNL()` tries:
1. **Exact normalized match** — usually works since context is in the prompt
2. **Trigram similarity ≥ 0.5** — fallback for typos
3. **No match** → category keyboard with session protection

### Hallucination Detection

If DeepSeek returns a multi-word category (e.g., `"sem tempo irmão"`), the system detects this as likely hallucination and shows the category picker keyboard instead.

## Group Handling

If the user has more than 1 group, a group picker keyboard is shown before executing `handleTransaction`. This is triggered in `handleNLWithGroupCheck()`.

## Type Disambiguation

If `intent: null` + numeric value detected:
1. `incrementSessionSeq()` called
2. Shows [💸 Despesa] [💰 Receita] keyboard with session protection
3. On keyboard selection: extracts amount from original text via regex
4. If user types text instead: keyword heuristics check for "despesa", "gastei", etc.

## Tag Support

Tags are optional for NL expense/income:
- If DeepSeek returns `tag`: passed as `#tagname` in args
- If no tag: proceeds without (no wizard for missing NL tags)

## Session Protection for NL Keyboards

All NL-generated keyboards use `addSession()` or `truncateCallbackData()`:
- `nl_cat_*` → `truncateCallbackData(sessionSeq)` (long names)
- `nl_period_*` → `addSession(sessionSeq)` (short)
- `nl_type_*` → `addSession(sessionSeq)` (short)
- `nl_grp_*` → `truncateCallbackData(sessionSeq)` (long names)

## Missing Fields Wizard

When NL response has missing fields, follow-up wizards are started:

| Missing Field | Wizard Step | UI |
|--------------|-------------|----|
| `amount` | `nl_{intent}_amount` | Text input |
| `category` | `nl_{intent}_category` | Keyboard + "Sem categoria" |
| `period` | `nl_{intent}_period` | "Esse mês" / "Mês passado" |
| `name` (create) | `nl_create_category_name` / `nl_create_group_name` | Text input |
| `tag` (list) | `nl_list_by_tag_name` | Text input |

## Supported Intents (Complete List)

`expense`, `income`, `query_balance`, `query_expenses_month`, `query_expenses_last_month`, `query_expenses_date`, `query_expenses_category`, `query_summary`, `query_extract`, `create_category`, `create_group`, `list_categories`, `list_groups`, `list_tags`, `list_transactions`, `show_last_transaction`, `delete_last_transaction`, `list_by_tag`, `cleanup`

## Fallback

If `DEEPSEEK_API_KEY` is not configured, the bot responds to slash commands only. NL text without a matching common phrase returns the "Não entendi" message.
