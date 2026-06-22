# Callback Routing System

All inline keyboard interactions are routed through `handleCallbackQuery()` in `handlers/callbacks.ts`.

> 📖 Register completo de todos os callbacks que seguem o padrão **edit-in-place** (19 callbacks): [`AGENTS.md` > In-Place Callbacks — Complete Register](../AGENTS.md#in-place-callbacks--complete-register)
> Padrão formal de in-place editing: [`docs/architecture/patterns.md` > §17 In-Place Editing](patterns.md#17-in-place-editing-edit-in-place)

## Architecture

Every callback goes through:

```
callback_query received
  │
  ├── answerCallbackQuery(id) ── dismiss loading spinner (always first!)
  │
  ├── removeSession(data) ── extract session seq + real data
  │   └── null? ── "Botão expirou"
  │
  ├── validateCallbackSession(supabase, user.id, decoded.seq)
  │   └── invalid? ── "Sessão expirou"
  │
  └── Route by selectedValue.startsWith(prefix)
```

## Critical Rules

### 1. Always `return` after handling

Every `if` block must end with `return;`. Otherwise the callback falls through to the generic wizard handler at the bottom, which causes confusing bugs.

### 2. Specific Before Generic

Callback prefixes that are prefixes of other prefixes MUST be ordered with the more specific one first:

```
MOST SPECIFIC (order first):
  edit_show_         → exact prefix match
  edit_cat_select_   → before edit_ (specific confirm)
  edit_date_select_  → before edit_
  edit_date_custom_  → before edit_
  edit_group_sel_    → before edit_group_ (specific confirm)
  edit_group_        → broader group prefix
  edit_tags_done_    → before edit_tags_
  edit_tags_clr_     → before edit_tags_
  edit_tags_         → initial tag edit
  edit_tag_tog_      → distinct prefix (differs at pos 7)
LEAST SPECIFIC:
  edit_              → generic amount/category/date
```

Recurrence callbacks follow the same rule:
```
MOST SPECIFIC (order first):
  rec_advance_yes_   → before rec_advance_
  rec_skip_yes_      → before rec_skip_
  rec_edit_field_    → before rec_edit_
  rec_edit_set_cat_  → before rec_edit_set_freqtype_ → before rec_edit_
  rec_edit_set_grp_  → before rec_edit_
  rec_edit_set_tag_  → before rec_edit_
  rec_edit_set_freqtype_ → before rec_edit_
  rec_edit_          → generic edit menu
  rec_advance_       → after rec_advance_yes_
  rec_skip_          → after rec_skip_yes_
LEAST SPECIFIC:
  rec_               → catches rec_new, rec_manage, rec_show_, rec_close, rec_back, rec_archive_, rec_activate_, rec_transform_
```

### 3. Under 64 Bytes

Telegram limits `callback_data` to 64 bytes. Use `truncateCallbackData()` (truncates at 60 chars) for any callback containing dynamic values (tags, category names, dates, long transaction IDs).

## Complete Callback Prefix Reference

### Delete & Cleanup

| Prefix | Action | Message |
|--------|--------|---------|
| `confirm_delete_{id}` | Delete transaction (confirmed) | Sends new |
| `cancel_delete_{id}` | Cancel deletion | Sends new |
| `confirm_cleanup` | Execute cleanup | Sends new |
| `cancel_cleanup` | Cancel cleanup | Sends new |

### Statement Filter Panel

| Prefix | Action | Message |
|--------|--------|---------|
| `stmt_filter` | Open/reset filter panel | Sends new |
| `stmt_f_cat` | Show category selector | Edits |
| `stmt_f_cat_{id}` | Select category (0=clear) | Edits |
| `stmt_f_grp` | Show group selector | Edits |
| `stmt_f_grp_{id}` | Select group (0=clear) | Edits |
| `stmt_f_tag` | Show tag selector | Edits |
| `stmt_f_tag_{tag}` | Toggle tag | Edits |
| `stmt_f_tag_done` | Confirm tags | Edits |
| `stmt_f_tag_clr` | Clear tags | Edits |
| `stmt_f_type` | Show type selector | Edits |
| `stmt_f_type_{type}` | Select type (all/income/expense) | Edits |
| `stmt_f_period` | Show period selector | Edits |
| `stmt_f_period_{key}` | Select period preset | Edits |
| `stmt_f_period_custom` | Custom date range | Sends new |
| `stmt_f_apply` | Apply filters → handleStatement | Sends new |
| `stmt_f_clear` | Reset filters | Edits |

### Statement & List Navigation

| Prefix | Action | Message |
|--------|--------|---------|
| `statement_{filter}_{page}` | Statement page nav + filter toggle | Sends new |
| `txlist_p{page}` | Transaction list page | Edits |
| `txlist_t{tag}_p{page}` | Tag-filtered list page | Edits |

### NL Interaction

| Prefix | Action | Message |
|--------|--------|---------|
| `nl_type_expense` / `nl_type_income` | Type disambiguation | Sends new |
| `nl_create_cat` | Create new category (typed name) | Edits | Edits NL category selection screen in-place to show `"✏️ Digite o nome da nova categoria:"` |
| `nl_cat_{name}` | Category selection | Sends new |
| `nl_grp_{name}` | Group selection | Sends new |
| `nl_period_{key}` | Period selection | Sends new |

### Edit Transaction

| Prefix | Action | Message | Detail |
|--------|--------|---------|--------|
| `edit_show_{id}` | Show edit dialog | Sends new | |
| `edit_amount_{id}` | Prompt new amount | Edits + sends new | **Edits** action menu to `💰 Alterando valor...` before sending text prompt |
| `edit_category_{id}` | Show category picker | Edits + sends new | **Edits** action menu to `🏷️ Alterando categoria...` before sending category keyboard |
| `edit_cat_select_{id}_{name}` | Confirm category | Sends new | |
| `edit_desc_{id}` | Prompt new description | Edits + sends new | **Edits** action menu to `📝 Alterando descrição...` before sending text prompt |
| `edit_date_{id}` | Show date options | Edits + sends new | **Edits** action menu to `📅 Alterando data...` before sending date keyboard |
| `edit_date_select_{id}_{date}` | Confirm date | Sends new | |
| `edit_date_custom_{id}` | Custom date input | Edits + sends new | **Edits** date keyboard to `📅 Alterando data...` before sending text prompt |
| `edit_group_{id}` | Show group picker | Edits + sends new | **Edits** action menu to `📁 Alterando grupo...` before sending group keyboard |
| `edit_group_sel_{id}_{name}` | Confirm group | Sends new | |
| `edit_tags_{id}` | Tag management UI | Edits + sends new | **Edits** action menu to `🔖 Alterando tags...` before sending tag toggle keyboard |
| `edit_tag_tog_{id}_{tag}` | Toggle tag | Edits | |
| `edit_tags_done_{id}` | Confirm tags | Sends new | |
| `edit_tags_clr_{id}` | Clear tags | Sends new | |

### Entity Management (Category/Group)

| Prefix | Action | Message |
|--------|--------|---------|
| `cat_sel_{name}` / `grp_sel_{name}` | Select entity (system categories show "Categoria padrão" — no rename/delete) | Sends new |
| `cat_ren_{name}` / `grp_ren_{name}` | Rename prompt | Edits | Edits entity action menu in-place to show `"✏️ Digite o novo nome para *X*:"` |
| `cat_del_{name}` / `grp_del_{name}` | Delete confirmation | Sends new |
| `cat_del_yes_{name}` / `grp_del_yes_{name}` | Confirm delete | Sends new |
| `cat_back` / `grp_back` | Back to list | Sends new |
| `cat_sug_use` / `grp_sug_use` | Use suggested name | Sends new |
| `cat_sug_new` / `grp_sug_new` | Create anyway | Sends new |

### Balance & Summary Group Filter

| Prefix | Action | Message |
|--------|--------|---------|
| `balance_shwgrp` / `summary_shwgrp` | Show group picker | Sends new |
| `balance_grp_{name}` / `summary_grp_{name}` | Filter by group | Sends new |

### Tag Management

| Prefix | Action | Message |
|--------|--------|---------|
| `tag_sel_{tag}` | Show transactions with tag | Edits |

### Wizard — Transaction (gasto/receita)

| Prefix | Action | Message | Detail |
|--------|--------|---------|--------|
| `wiz_category_{name}` | Select category by name | Delegates | Generic step handler via `advanceWizardToNextStep` with `message.message_id`. Edits keyboard to `✅ 🏷️ Categoria: {name}` |
| `wiz_group_{name}` | Select group by name | Delegates | Same pattern — edits keyboard to `✅ 📁 Grupo: {name}` |
| `wiz_date_{date}` | Select date (today/yesterday) | Delegates | Generic step handler — edits keyboard to `✅ 📅 Data: {date}` |
| `wiz_start_date_{date}` | Select start date for recurrence | Delegates | Generic step handler — edits keyboard to `✅ 📅 Data de início: {date}` |
| `wizard_new_category` | Type custom category name | Edits | Edits category selection screen in-place to show prompt, stores `message.message_id` as `_categoryPromptMessageId`. When user types, handler edits the **same** message to confirmation (e.g., `"✅ 🏷️ Categoria: Mercado"`) — buttons → prompt → confirmation in one message |
| `wizard_new_group` | Type custom group name | Edits | Edits group selection screen in-place to show prompt, stores `message.message_id` as `_groupPromptMessageId`. Same pattern as `wizard_new_category` |
| `wiz_tag_{tag}` | Toggle tag on/off | Edits | Reads/writes `wizard_states.data.tags` array. Re-renders tag keyboard with ✅ indicators |
| `wiz_done_tags` | Confirm tag selection | Delegates | Calls `advanceWizardToNextStep` with current data — edits tag keyboard to show `✅ 🔖 Tags: ...` |
| `wizard_skip_tags` | Skip tags step | Delegates | Calls `handleWizardSkip` — edits tag keyboard to `✅ 🔖 Tags: Nenhuma tag` |
| `wizard_skip_description` | Skip description step | Delegates | Calls `handleWizardSkip` — edits description keyboard to `✅ 📝 Descrição: Nenhuma descrição informada` |
| `tx_desc_sim_{id}` | Add description after creation | Edits + sends new | **Edits** Sim/Não prompt to `✏️ Digitando descrição...` before sending text input prompt |
| `tx_desc_nao_{id}` | Skip description after creation | Sends new | |
| `custom_date` | Custom date input | Edits | Edits date selection screen in-place to show prompt, stores `message.message_id` as `_customDatePromptMessageId`. When user types, handler edits the **same** message to confirmation (e.g., `"✅ 📅 Data: 15/07/2026"`). For `start_date` steps (recurrence), keeps original step name so `handleWizardInput` processes the input |

### Wizard — Recurrence (recorrencia)

| Prefix | Action | Message | Detail |
|--------|--------|---------|--------|
| `wiz_type_expense` | Select "Despesa" type | Delegates | Generic `wiz_type_` handler |
| `wiz_type_income` | Select "Receita" type | Delegates | Generic `wiz_type_` handler |
| `wiz_category_{name}` | Select category | Delegates | Generic step handler |
| `wiz_group_{name}` | Select group | Delegates | Generic step handler |
| `wiz_frequency_{freq}` | Select frequency type | Sends new | `daily` → advances directly. `weekly` → shows day-of-week keyboard. `monthly`/`annual`/`every_x_days` → shows text prompt, stores `_freqDetailPromptMessageId` |
| `wiz_freq_detail_{i}` | Weekly day-of-week (0–6) | Delegates | Calls `advanceWizardToNextStep` with `frequency_type: "weekly"` |
| `wiz_start_date_{date}` | Select start date (today/yesterday) | Delegates | Generic step handler |
| `wizard_new_category` | Typed new category name | Edits | Edits category selection screen in-place to show prompt, stores message.message_id. Same as transaction wizard |
| `wizard_new_group` | Typed new group name | Edits | Same as `wizard_new_category` |
| `wiz_tag_{tag}` | Toggle tag | Edits | Same as transaction wizard |
| `wiz_done_tags` | Confirm tags | Delegates | Same as transaction wizard |
| `wizard_skip_tags` | Skip tags | Delegates | Same as transaction wizard |
| `wizard_skip_description` | Skip description | Delegates | Same as transaction wizard |
| `custom_date` | Custom start date input | Edits | Edits date selection screen in-place to show prompt, stores message.message_id. Same as transaction wizard |

**Note:** Recurrence frequency step options (`daily`, `weekly`, `monthly`, `annual`, `every_x_days`) come from `wizard_step_options` table and use prefix `wiz_frequency_`. The `wiz_frequency_daily` handler is intercepted before the generic wizard handler to store `frequency_type` and `frequency_interval` correctly.

### Generic Wizard Step Handler

At the bottom of `handleCallbackQuery`, a fallback catches any `wiz_{stepKey}_{value}` callback that wasn't caught by specific handlers above:

```typescript
const wizard = await getCurrentWizardStep(supabase, user.id);
if (!wizard) return;
const stepKey = wizard.currentStep.step_key;
const prefix = `wiz_${stepKey}_`;
if (selectedValue.startsWith(prefix)) {
  const value = selectedValue.replace(prefix, "");
  const newStateData = { ...wizard.state.data, [stepKey]: value };
  await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, sessionSeq, newStateData, message.message_id);
}
```

This handles: category selection, group selection, date presets, type selection, and any other select-type wizard steps.

**Important:** Every specific wizard callback handler (frequency, tags, skip, custom_date, new_category) MUST `return` before reaching this fallback.

### Recurrence Management

| Prefix | Action | Message |
|--------|--------|---------|
| `rec_transform_{id}` | Transform existing transaction into recurrence | Sends new |
| `rec_close` | Close recurrence detail view | Sends new |
| `rec_back` | Back to recurrence list | Sends new |
| `rec_new` | Start recurrence creation wizard | Sends new |
| `rec_manage` | List recurrences with management buttons | Sends new |
| `rec_show_{id}` | Show recurrence detail | Sends new |
| `rec_advance_{id}` | Confirm advance prompt | Sends new |
| `rec_advance_yes_{id}` | Execute advance (create transaction + recalculate) | Sends new |
| `rec_skip_{id}` | Confirm skip prompt | Sends new |
| `rec_skip_yes_{id}` | Execute skip (recalculate without creating) | Sends new |
| `rec_archive_{id}` | Confirm archive prompt | Sends new |
| `rec_archive_yes_{id}` | Execute archive | Sends new |
| `rec_activate_{id}` | Reactivate archived recurrence | Sends new |
| `rec_edit_{id}` | Show edit action menu | Sends new |
| `rec_edit_field_{id}_amount` | Prompt new amount | Edits + sends new | **Edits** action menu to `💰 Alterando valor...` before sending text prompt |
| `rec_edit_field_{id}_description` | Prompt new description | Edits + sends new | **Edits** action menu to `📝 Alterando descrição...` before sending text prompt |
| `rec_edit_field_{id}_start_date` | Prompt new start date | Edits + sends new | **Edits** action menu to `📅 Alterando data de início...` before sending text prompt |
| `rec_edit_field_{id}_category` | Show category picker | Edits + sends new | **Edits** action menu to `🏷️ Alterando categoria...` before sending category keyboard |
| `rec_edit_field_{id}_group` | Show group picker | Edits + sends new | **Edits** action menu to `📁 Alterando grupo...` before sending group keyboard |
| `rec_edit_field_{id}_frequency` | Show frequency keyboard | Edits + sends new | **Edits** action menu to `🔄 Alterando frequência...` before sending frequency keyboard |
| `rec_edit_field_{id}_tags` | Show tag toggle UI | Edits + sends new | **Edits** action menu to `🔖 Alterando tags...` before sending tag keyboard |
| `rec_edit_set_cat_{id}_{name}` | Confirm category change | Sends new | |
| `rec_edit_set_grp_{id}_{name}` | Confirm group change | Sends new | |
| `rec_edit_set_freqtype_{id}_daily` | Confirm daily frequency | Edits + sends new | **Edits** frequency keyboard to `✅ 🔄 Frequência: Diária` before sending success message |
| `rec_edit_set_freqtype_{id}_{freq}` | Confirm non-daily frequency | Edits + sends new | **Edits** frequency keyboard to `✅ 🔄 Frequência: Semanal/Mensal/etc` before sending detail prompt |
| `rec_edit_set_tag_{id}_{tag}` | Toggle tag in recurrence edit | Edits |
| `rec_edit_set_tag_{id}_done` | Confirm recurrence tags | Sends new |
| `rec_edit_set_tag_{id}_clr` | Clear recurrence tags | Sends new |

## Filter Panel Internals

The statement filter panel (`handleFilterPanel`) stores filter state in `wizard_states.data` as an `ExtratoFilters` object:

```typescript
interface ExtratoFilters {
  category_id: number | null;
  group_id: number | null;
  tags: string[];
  type: "all" | "income" | "expense";
  period: PeriodPreset | { start: string; end: string };
}
```

Flow:
1. `/extrato` without args → opens filter panel (persists state in wizard_states)
2. User adjusts filters via category/group/type/period selectors
3. `renderFilterPanelMessage()` shows current filter state
4. "Aplicar" → `clearWizardState()` + `handleStatement()` with filters
5. "Limpar" → resets to `DEFAULT_FILTERS` and re-renders

## Group Filter Callback (`handleGroupFilterCallback`)

Shared between balance and summary handlers:
- `{prefix}_shwgrp` → show group list keyboard
- `{prefix}_grp_{name}` → filter by group name
- `{prefix}_grp_all` → clear group filter
