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

### Category Step Logic

Categories are filtered by transaction type:
- `/despesa` wizard → shows categories where `transaction_type = 'expense'` OR `transaction_type IS NULL`
- `/receita` wizard → shows categories where `transaction_type = 'income'` OR `transaction_type IS NULL`

A "✏️ Nova categoria" button lets users type a custom name.

### Tags Step Logic

- Shows existing tags as toggle buttons (multi-select)
- User can also type tag names directly (accumulated on each input)
- "✅ Concluir" → advance to completion
- "⏭️ Pular" → skip tags, advance

## Completion (`completeWizard`)

When all steps are done:
1. Clear wizard state
2. Check similarity warnings for category, group, tags
3. Create/retrieve category, group
4. Format tags (ensure # prefix)
5. Insert transaction
6. Send success message with details

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
