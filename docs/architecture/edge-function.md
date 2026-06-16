# Edge Function

Single Deno Edge Function at `supabase/functions/bot-core/index.ts`.

## Entry Point

```typescript
serve(async (req: Request): Promise<Response> => {
  // 1. POST only → 405
  // 2. Validate X-Telegram-Bot-Api-Secret-Token → 401
  // 3. Parse TelegramUpdate JSON
  // 4. Route by update type
  // 5. Always return 200
})
```

## Routing Logic

```
serve()
  │
  ├── update.callback_query? ──► handleCallbackQuery()
  │
  ├── !update.message? ──► 200 (keepalive)
  │
  ├── isRateLimited? ──► "Aguarde..."
  │
  ├── Auto-create user on first message
  │   ├── Insert user
  │   ├── Create default "Pessoal" group
  │   ├── Copy predefined_categories → categories
  │   ├── Create "Sem categoria" fallback
  │   └── handleStart()
  │
  ├── Active wizard (non-slash text)?
  │   ├── gasto_* or receita_* ──► handleTransactionWizard()
  │   ├── edit_amount / edit_description / edit_date ──► direct DB update
  │   ├── edit_tags_* ──► direct DB update
  │   ├── rename_cat / rename_grp ──► handleEntityRename()
  │   ├── nl_*_amount / nl_*_category / nl_*_period ──► NL follow-up
  │   ├── nl_create_category_name / nl_create_group_name ──► executeNL
  │   ├── nl_ask_type ──► type disambiguation
  │   ├── nl_*_group ──► handleTransaction()
  │   ├── nl_list_by_tag_name ──► executeNL
   │   ├── reset_confirm ──► deletes all user data if text === "RESETAR"
   │   └── extrato_custom_period / extrato_custom_period_end ──► date wizard
   │
  ├── Non-slash text (NL)?
  │   ├── fetchUserContext() (categories + groups + tags, parallel)
  │   ├── parseNaturalLanguage() → DeepSeekResponse
  │   ├── intent === null?
  │   │   ├── Has number? ──► "Despesa ou Receita?" prompt
  │   │   └── No number? ──► "Não entendi" + help
  │   └── handleNaturalLanguageWithFollowUp()
  │
  └── Slash command?
      ├── incrementSessionSeq() (invalidate old callbacks)
      ├── Clear conflicting wizards
      └── Switch on command:
          /start → handleStart()
          /ajuda | /help → handleHelp()
          /saldo → handleBalance()
          /despesa | /gasto → handleTransaction("expense")
          /receita → handleTransaction("income")
          /extrato → handleStatement() or handleFilterPanel()
          /resumo → handleSummary()
          /editar → handleEdit()
          /excluir → handleDelete()
          /grupo → handleGroup()
          /categoria → handleCategory()
          /tag → handleTag()
           /resetar → handleReset()
           /limpar → handleCleanup()
           /cancelar → clear wizard
```

## Key Details

### First-time User Creation

When a user sends a first message (no existing DB record):
1. `supabase.from("users").insert({ telegram_id, username, first_name })`
2. `supabase.from("groups").insert({ name: "Pessoal", is_default: true })`
3. Fetch all `predefined_categories` → insert as `categories` with `is_predefined: true`
4. Insert "Sem categoria" fallback category
5. Call `handleStart()` (welcome message)

### User Resolution

All handlers receive `telegramId` (the Telegram integer ID) and call `getOrCreateUser()` internally to resolve the internal DB `user.id`. This is a read-only lookup (no auto-creation in handlers).

### Wizard Interception

If a user has an active wizard state and sends non-slash text, the text is treated as wizard input (not as a new NL query). This applies to:
- Transaction wizards (`gasto_amount`, `receita_tags`, etc.)
- Edit wizards (`edit_amount`, `edit_date`, etc.)
- Rename wizards (`rename_cat`, `rename_grp`)
- NL follow-up wizards
- Statement custom date wizards

Slash commands `/despesa`, `/gasto`, `/receita`, `/cancelar`, and `/resetar` can interrupt wizards.

### Helper Functions

**`fetchUserContext(supabase, userId)`**: Fetches categories (with `transaction_type`), groups, and tags in 3 parallel queries for NL prompt building.

**`handleEntityRename(supabase, userId, chatId, table, oldName, newName, label)`**: Handles renaming categories/groups in `index.ts` (not in a handler module). Validates empty name, detects no-op same-name, handles duplicate error code `23505`.
