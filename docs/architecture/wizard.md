# Wizard System

Multi-step wizards guide users through transaction creation when they use `/despesa` or `/receita` without all required arguments.

## Wizard Steps

### `/despesa` Wizard (5 steps)

```
amount → category → group → date → tags → COMPLETE
```

### `/receita` Wizard (5 steps, tags also included)

```
amount → category → group → date → tags → COMPLETE
```

### `/recorrencia` Wizard (8 steps)

```
type → amount → description → category → group → frequency → tags → start_date → COMPLETE
```

Frequency step has sub-steps handled in code (not in wizard_steps table):
- `daily` → advances directly with `frequency_interval: 1`
- `weekly` → shows day-of-week keyboard (Dom–Sáb)
- `monthly` → text input for day (1–31)
- `annual` → text input for month + day (DD/MM)
- `every_x_days` → text input for interval

### Step Definitions (from `wizard_steps` table)

| Wizard | Order | Key | Type | Prompt |
|--------|-------|-----|------|--------|
| gasto | 1 | amount | text | "Qual o valor?" |
| gasto | 2 | category | select | "Qual categoria?" |
| gasto | 3 | group | select | "Qual grupo?" |
| gasto | 4 | date | date | "Qual data?" |
| gasto | 5 | tags | tags | "Tags?" |
| receita | 1 | amount | text | "Qual o valor?" |
| receita | 2 | category | select | "Qual categoria?" |
| receita | 3 | group | select | "Qual grupo?" |
| receita | 4 | date | date | "Qual data?" |
| receita | 5 | tags | tags | "Tags?" |

| recorrencia | 1 | type | select | "Despesa ou Receita?" |
| recorrencia | 2 | amount | text | "Qual o valor?" |
| recorrencia | 3 | description | text | "Descrição?" |
| recorrencia | 4 | category | select | "Qual categoria?" |
| recorrencia | 5 | group | select | "Qual grupo?" |
| recorrencia | 6 | frequency | select | "Qual frequência?" |
| recorrencia | 7 | tags | tags | "Tags?" |
| recorrencia | 8 | start_date | date | "Data da primeira ocorrência?" |

## State Management

State is stored in `wizard_states` table:
- Keyed by `user_id` (one wizard per user)
- `step` field: `{wizard_name}_{step_key}` (e.g., `gasto_amount`, `receita_tags`)
- `data` field: JSONB accumulating user inputs
- TTL: 10 minutes (auto-expired on read)

## Step Renderers (`sendWizardStepMessage`)

Each step type renders differently:

| Input Type | UI |
|------------|-----|
| `text` | Plain text prompt, user types |
| `select` | Inline keyboard from DB (categories or groups) |
| `date` | Buttons: "Hoje", "Ontem", "Outra data" |
| `tags` | Toggle buttons for existing tags + text input + done/skip |

## Visual Confirmation Pattern

Every wizard step now follows a consistent **visual confirmation pattern** that keeps the chat clean:

1. **Prompt sent** — The step's prompt message is sent. For text-input steps (amount, description, tags, custom date, frequency detail), the `message_id` of this prompt is **stored in `wizard_states.data`** as `_<step>PromptMessageId`
2. **User responds** — When the user types text or clicks a button, the handler reads the stored `_<step>PromptMessageId`
3. **Edit prompt in-place** — The **original prompt** is edited to show `✅ [Ícone]: [valor informado]` (e.g., `✅ 💰 Valor: R$ 50,00`)
4. **Delete user message** — The user's typed message is removed via `deleteTelegramMessage()`
5. **New prompt** — The **next wizard step** is sent as a new message

This creates a clean conversation where each user response is confirmed in-place before the next question appears.

### `_promptMessageId` Keys

| Step | Key in `state.data` | Confirmation Example |
|------|---------------------|---------------------|
| amount | `_amountPromptMessageId` | `✅ 💰 Valor: R$ 50,00` |
| description | `_descPromptMessageId` | `✅ 📝 Descrição: almoço` / `Nenhuma descrição informada` |
| category (text) | `_categoryPromptMessageId` | `✅ 🏷️ Categoria: Transporte` |
| group (text) | `_groupPromptMessageId` | `✅ 📁 Grupo: Nubank` |
| custom date | `_customDatePromptMessageId` | `✅ 📅 Data: 15/07/2026` |
| tags (Concluir) | `_tagsPromptMessageId` | `✅ 🔖 Tags: #tag1 #tag2` / `Nenhuma tag` |
| frequency detail | `_freqDetailPromptMessageId` | `✅ 🔄 Frequência: A cada 15 dias` / `Mensal (dia 15)` |

### Flow Diagram

```text
User types text         Handler reads _promptMessageId
       │                         │
       ▼                         ▼
┌────────────────┐    ┌────────────────────────────┐
│ User message   │    │ Edit prompt → "✅ ..."      │
│ e.g. "50"      │    │ (editTelegramMessageWithKB) │
└────────┬───────┘    └────────────┬───────────────┘
         │                         │
         ▼                         ▼
┌────────────────┐    ┌────────────────────────────┐
│ Delete message │    │ Send next step message     │
│ (deleteMsg)    │    │ (sendTelegramMessage)       │
└────────────────┘    └────────────────────────────┘
```

### Implementation

In `sendWizardStepMessage`, after sending the prompt as a new message (`sentMessageId` is non-null), the shared `storePromptMessageId` helper stores the message ID:

```typescript
if (sentMessageId) {
  await storePromptMessageId(supabase, userId, "_amountPromptMessageId", sentMessageId);
}
```

This helper is used for all 5 text-input steps (amount, description, tags, category, group). Similarly, `getNextWizardStep` replaces inline next-step queries:

```typescript
const nextStep = await getNextWizardStep(supabase, wizardName, currentStep.step_order);
if (nextStep) {
  // advance to next step
} else {
  // complete wizard
}
```

Both helpers are defined as internal (non-exported) functions in `wizard.ts`. See [`services.md`](services.md#handlerswizardts--wizard-helpers-internal) for full documentation.

In the handler (`handleTransactionWizard` / `handleRecurrenceWizard`), read and apply:

```typescript
if (stepKey === "amount") {
  const amountPromptMessageId = state.data?._amountPromptMessageId as number | undefined;
  if (amountPromptMessageId && !isNaN(amountNum)) {
    await editTelegramMessageWithKeyboard(chatId, amountPromptMessageId,
      `✅ 💰 Valor: ${formatCurrencyBR(amountNum)}`, []);
    if (userMessageId) await deleteTelegramMessage(chatId, userMessageId);
  }
  // advance to next step
}
```

When the user clicks a button (select/keyboard) rather than typing, the `advanceWizardToNextStep` function handles the confirmation via `buildStepConfirmation`. The confirmation edit happens **before** querying the next step, so it works correctly even when the current step is the **last one** (e.g., tags in gasto/receita wizards — shows `✅ 🔖 Tags: Nenhuma tag` before completing).

### Category Step Logic

Categories are fetched from both user-owned and system-global (`user_id IS NULL`) rows, deduplicated:
- `/despesa` wizard → shows categories where `transaction_type = 'expense'` OR `transaction_type IS NULL`
- `/receita` wizard → shows categories where `transaction_type = 'income'` OR `transaction_type IS NULL`
- System categories appear alongside user-created ones
- If a user has a category with the same name as a system one, theirs takes priority

A "✏️ Nova categoria" button lets users type a custom name.

### Tags Step Logic

- Shows existing tags as toggle buttons (multi-select)
- User can also type tag names directly (accumulated on each input)
- "✅ Concluir" → advance to completion
- "⏭️ Pular" → skip tags, advance

## Completion

### `completeWizard(supabase, userId, chatId, data)`
When all steps are done for gasto/receita:
1. Clear wizard state
2. Check similarity warnings for category, group, tags
3. Create/retrieve category, group
4. Format tags (ensure # prefix)
5. Insert transaction
6. Send success message with details

### `completeRecurrenceWizard(supabase, userId, chatId, data)`
When all steps are done for recorrencia:
1. Clear wizard state
2. Create/retrieve category, group
3. Format tags (ensure # prefix)
4. Insert recurrence with frequency type/interval/month
5. Send success message with frequency label

### `advanceWizardToNextStep`

Key behavior:
- **Confirmation edit first** — Edits current prompt in-place with `buildStepConfirmation` (`messageId` required). This runs **before** the next-step query, ensuring the confirmation always appears — even when the current step is the last one.
- **Next step or complete** — If there's a next step, advances to it. Otherwise, detects `wizard_name === "recorrencia"` and calls `completeRecurrenceWizard` instead of `completeWizard`.

## Interaction with Callbacks

Wizard callbacks use `addSession()` for session protection:
- Category names → `addSession(categoryName, sessionSeq)`
- Group names → `addSession(groupName, sessionSeq)`
- Date presets → `addSession(today, sessionSeq)` or `addSession(yesterday, sessionSeq)`
- Tag toggles → `addSession(\`wiz_tag_${tag}\`, sessionSeq)`
- Special actions: `wizard_new_category`, `wizard_new_group`, `wizard_skip_tags`, `wiz_done_tags`, `custom_date`

The callback handler at the bottom of `handleCallbackQuery` catches wizard category/group name selections that weren't caught by earlier prefixes. This is why every callback handler MUST `return` — otherwise wizard steps consume unrelated callbacks.

## NL Follow-up Wizards

Natural language processing may start follow-up wizards for missing fields:

| Step | Trigger | UI |
|------|---------|-----|
| `nl_{intent}_amount` | Missing amount | Text input |
| `nl_{intent}_category` | Missing category | Keyboard with categories |
| `nl_{intent}_group` | User has >1 group | Keyboard with groups |
| `nl_{intent}_period` | Missing period | "Esse mês" / "Mês passado" |
| `nl_create_category_name` | Create category without name | Text input |
| `nl_create_group_name` | Create group without name | Text input |
| `nl_list_by_tag_name` | List by tag without name | Text input |
| `nl_ask_type` | Unclear intent + has number | "Despesa ou Receita?" |
| `extrato_custom_period` | Custom date range | Text (start date) |
| `extrato_custom_period_end` | Custom date range | Text (end date) |

## Edit Wizards

Simple wizards for editing transactions:

| Step | Purpose |
|------|---------|
| `edit_amount` | New value |
| `edit_description` | New description |
| `edit_date` | New date (text input, parsed) |
| `edit_tags_{id}` | Tag toggle UI |
| `rename_cat` / `rename_grp` | Rename entity |
