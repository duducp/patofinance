# Callback Routing System

All inline keyboard interactions are routed through `handleCallbackQuery()` in `handlers/callbacks.ts`.

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

### 3. Under 64 Bytes

Telegram limits `callback_data` to 64 bytes. Use `truncateCallbackData()` (truncates at 60 chars) for any callback containing dynamic values (tags, category names, dates, long transaction IDs).

## Complete Callback Prefix Reference

### Delete & Cleanup

| Prefix | Action | Message |
|--------|--------|---------|
| `confirm_delete_{id}` | Delete transaction | Sends new |
| `cancel_delete` | Cancel deletion | Sends new |
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
| `nl_cat_{name}` | Category selection | Sends new |
| `nl_grp_{name}` | Group selection | Sends new |
| `nl_period_{key}` | Period selection | Sends new |

### Edit Transaction

| Prefix | Action | Message |
|--------|--------|---------|
| `edit_show_{id}` | Show edit dialog | Sends new |
| `edit_amount_{id}` | Prompt new amount | Sends new |
| `edit_category_{id}` | Show category picker | Sends new |
| `edit_cat_select_{id}_{name}` | Confirm category | Sends new |
| `edit_desc_{id}` | Prompt new description | Sends new |
| `edit_date_{id}` | Show date options | Sends new |
| `edit_date_select_{id}_{date}` | Confirm date | Sends new |
| `edit_date_custom_{id}` | Custom date input | Sends new |
| `edit_group_{id}` | Show group picker | Sends new |
| `edit_group_sel_{id}_{name}` | Confirm group | Sends new |
| `edit_tags_{id}` | Tag management UI | Sends new |
| `edit_tag_tog_{id}_{tag}` | Toggle tag | Edits |
| `edit_tags_done_{id}` | Confirm tags | Sends new |
| `edit_tags_clr_{id}` | Clear tags | Sends new |

### Entity Management (Category/Group)

| Prefix | Action | Message |
|--------|--------|---------|
| `cat_sel_{name}` / `grp_sel_{name}` | Select entity (system categories show "Categoria padrão" — no rename/delete) | Sends new |
| `cat_ren_{name}` / `grp_ren_{name}` | Rename prompt | Sends new |
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

### Wizard

| Prefix | Action | Message |
|--------|--------|---------|
| `wizard_new_category` / `wizard_new_group` | Type custom name | Sends new |
| `wiz_tag_{tag}` | Toggle tag in wizard | Edits |
| `wiz_done_tags` | Confirm wizard tags | Delegates |
| `wizard_skip_tags` | Skip wizard tags | Delegates |
| `custom_date` | Custom date in wizard | Sends new |

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
