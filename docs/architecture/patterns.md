# Coding Patterns and Conventions

## 1. Handler Parameter Convention

```typescript
handleXxx(supabase: any, userId: number, chatId: number, ...args) => Promise<void>
```

- `supabase` first — the Supabase client instance
- `userId` second — the **Telegram ID** (external), NOT the internal DB `user.id`. Each handler calls `getOrCreateUser(supabase, userId)` internally to resolve the DB user
- `chatId` third — the Telegram chat to respond to
- `args` — command-specific parameters

**Exception:** `handleEntity(type, supabase, userId, chatId, args)` has `type` first because it's a shared handler for both category and group operations.

## 2. Send vs Edit: Message Lifecycle

| Pattern | Function | When to use |
|---------|----------|-------------|
| **Send** | `sendTelegramMessage[WithKeyboard]` | First interaction (slash command, new wizard step, confirmation) |
| **Edit** | `editTelegramMessageWithKeyboard` | Update in-place (pagination, tag toggle, filter state change, wizard step confirmation) |

**Rule of thumb:** If the callback changes the *state of the current view* (next page, toggle tag), edit. If the callback *completes an action or starts a new flow* (confirm delete), send new.

**Wizard keyboard cleanup:** When the user selects an option via keyboard (category, group, date, type, frequency), the **original keyboard is edited** to show a confirmation (`✅ 🏷️ Categoria: Alimentação`) before the next step/sub-step prompt is sent as a new message. This keeps the chat clean — the edited message replaces the keyboard with a simple confirmation, and the next question appears below.

**Edit flows cleanup (transaction & recurrence editing):** The same **edit-in-place** pattern applies when the user clicks a button to change a field. The action menu or selection keyboard is edited with a descriptive label before the next interface is sent:

| Click | Original message → Edited to | Then |
|-------|------------------------------|------|
| Editar valor (text input) | Ação → `💰 Alterando valor...` | Envia prompt de texto |
| Editar descrição (text input) | Ação → `📝 Alterando descrição...` | Envia prompt de texto |
| Editar categoria (keyboard select) | Ação → `🏷️ Alterando categoria...` | Envia teclado de categorias |
| Editar data (keyboard select) | Ação → `📅 Alterando data...` | Envia teclado de datas |
| Editar grupo (keyboard select) | Ação → `📁 Alterando grupo...` | Envia teclado de grupos |
| Editar frequência (keyboard select) | Ação → `🔄 Alterando frequência...` | Envia teclado de frequência |
| Editar tags (keyboard select) | Ação → `🔖 Alterando tags...` | Envia teclado de tags |
| Custom date (text input) | Teclado de data → `📅 Alterando data...` | Envia prompt de texto |
| Nova categoria/grupo (text input, NL) | Teclado → `✏️ Digitando nova categoria...` | Envia prompt de texto |
| Adicionar descrição (text input, Sim/Não) | Prompt Sim/Não → `✏️ Digitando descrição...` | Envia prompt de texto |

**Regra geral:** Se o clique leva a um novo prompt (texto ou teclado de seleção), **sempre edite a mensagem original** com uma label descritiva antes de enviar o próximo prompt. Use labels com emoji consistente (💰 valor, 📝 descrição, 🏷️ categoria, 📁 grupo, 📅 data, 🔄 frequência, 🔖 tags, ✏️ digitar). A label deve descrever o que está sendo alterado no presente ("Alterando X...") ou no futuro próximo ("Digitando X..."), nunca usar pretérito.

**Important:** Always call `await answerCallbackQuery(callbackQuery.id)` at the very start of every callback handler, before any DB queries.

## 3. Callback Routing Pattern

Three things needed for a new interaction:

1. **Callback prefix** in `callbacks.ts` (`handleCallbackQuery`):
   ```typescript
   if (selectedValue.startsWith("my_prefix_")) {
     const value = selectedValue.replace("my_prefix_", "");
     // handle it
     return; // MUST return
   }
   ```

2. **Handler function** in the appropriate module (commands.ts, management.ts, etc.)

3. **Keyboard button** that generates the callback

**CRITICAL:** Every `if` block in `handleCallbackQuery` MUST end with `return;`.

### 3a. Callback Ordering: Specific Before Generic

When routing with `startsWith()`, order more specific prefixes before less specific ones:

```typescript
// ✅ Correct order
if (selectedValue.startsWith("edit_tags_done_")) { }
if (selectedValue.startsWith("edit_tags_")) { }

// ❌ Wrong — edit_tags_ catches edit_tags_done_ first
if (selectedValue.startsWith("edit_tags_")) { }     // catches everything
if (selectedValue.startsWith("edit_tags_done_")) { } // DEAD CODE
```

**Full ordering example** (from `callbacks.ts`):

```text
MOST SPECIFIC (order first):
  edit_show_         → exact prefix match
  edit_cat_select_   → specific confirm
  edit_date_select_  → specific confirm
  edit_date_custom_  → specific confirm
  edit_group_sel_    → specific confirm (before edit_group_)
  edit_group_        → broader group prefix
  edit_tags_done_    → before edit_tags_ (both start with "edit_tags_")
  edit_tags_clr_     → before edit_tags_
  edit_tags_         → initial tag edit
  edit_tag_tog_      → distinct prefix (differs at pos 7)
LEAST SPECIFIC:
  edit_              → generic amount/category/date
```

Recurrence callbacks follow the same rule:
```text
MOST SPECIFIC:
  rec_advance_yes_   → before rec_advance_
  rec_skip_yes_      → before rec_skip_
  rec_edit_field_    → before rec_edit_
  rec_edit_set_cat_  → before rec_edit_
  rec_edit_set_grp_  → before rec_edit_
  rec_edit_set_tag_  → before rec_edit_
  rec_edit_set_freqtype_ → before rec_edit_
  rec_edit_          → generic edit menu
  rec_advance_       → after rec_advance_yes_
  rec_skip_          → after rec_skip_yes_
LEAST SPECIFIC:
  rec_               → catches rec_new, rec_manage, rec_show_, rec_close, rec_back, rec_archive_, rec_activate_, rec_transform_
```

**How to test:** For each pair where prefix A is a prefix of prefix B:
- `"B_value".startsWith("A_")` → TRUE → B must come before A
- `"A_value".startsWith("B_")` → FALSE → fine after B

## 4. Entity-Based Handler Pattern

Category and group operations share ~95% logic. Use a parameterized builder:

```typescript
export async function handleEntity(type: "category" | "group", supabase, userId, chatId, args) {
  const isCategory = type === "category";
  const table = isCategory ? "categories" : "groups";
  const flagColumn = isCategory ? "is_predefined" : "is_default";
  const icon = isCategory ? "🏷️" : "📁";
  // ... 95% shared logic ...
}

export function handleGroup(...) { return handleEntity("group", ...); }
export function handleCategory(...) { return handleEntity("category", ...); }
```

Define differences upfront as a table of constants, then write the logic once.

## 5. Pagination Pattern

Any list that can exceed 10 items supports pagination:

1. **Fetch `limit + 1`** items to detect next page:
   ```typescript
   const fetchLimit = limit + 1;
   const { data: items } = await query.range(offset, offset + fetchLimit - 1);
   const hasMore = items.length > limit;
   const displayItems = hasMore ? items.slice(0, limit) : items;
   ```

2. **Parallel COUNT query** for "Página X de Y":
   ```typescript
   const [countResult, dataResult] = await Promise.all([
     supabase.from("table").select("*", { count: "exact", head: true }),
     supabase.from("table").select("...").range(...),
   ]);
   ```

3. **Navigation keyboard** (conditional buttons):
   ```typescript
   if (page > 0) navRow.push({ text: "◀️ Anterior", callback_data: `prefix_${page - 1}` });
   if (hasMore) navRow.push({ text: "▶️ Próximo", callback_data: `prefix_${page + 1}` });
   ```

4. **Edit existing message** when navigating (pass `messageId`):
   ```typescript
   if (messageId) { await editTelegramMessageWithKeyboard(...); }
   else { await sendTelegramMessageWithKeyboard(...); }
   ```

## 6. Parallel Queries Pattern

When a handler needs independent queries, run them in parallel:

```typescript
// GOOD: parallel, cuts ~50% latency
const [countResult, dataResult] = await Promise.all([
  supabase.from("transactions").select("*", { count: "exact", head: true }).eq("user_id", user.id),
  supabase.from("transactions").select("id, amount, type").eq("user_id", user.id).range(0, 9),
]);

// BAD: sequential, unnecessary wait
const { count } = await supabase.from("transactions").select(..."count"...);
const { data } = await supabase.from("transactions").select(..."data"...);
```

Used in: `handleListTransactions`, `handleListByTag`, `handleStatement`.

## 7. Portuguese Plural Pattern: Full Words

Always write full singular/plural words instead of concatenating suffixes:

```typescript
// ✅ Correct
`${count} ${count !== 1 ? "transações" : "transação"}`
`${count} ${count !== 1 ? "reatribuídas" : "reatribuída"}`

// ❌ Wrong — Portuguese plurals are irregular
`${count} transação${count !== 1 ? "ões" : ""}`  // "transaçãoões" bug
```

**Why:** Portuguese plurals are irregular (ão → ões, ãos, or ães). Concatenation produces bugs like "transaçãoões".

**Note:** Keep `${count}` outside the ternary to avoid duplication.

## 8. Session Protection

Every interactive keyboard must use `addSession()` or `truncateCallbackData()`:

```typescript
{ text: "Button", callback_data: addSession("my_prefix_value", sessionSeq) }
{ text: tag, callback_data: truncateCallbackData(`edit_tag_tog_${id}_${tag}`, sessionSeq) }
```

The session sequence increments on every new command, invalidating old callbacks.

## 9. Similarity Warning Pattern

Before creating entities, check for similar existing ones:

```typescript
if (parsed.category) {
  await sendSimilarityWarning(supabase, user.id, chatId, "category", parsed.category);
}
```

The warning function calls `suggestSimilar*` and sends a Telegram message if similarity > 0.3:
> "💡 Dica: categoria 'alimentao' é similar a Alimentação (90%). Considere usar Alimentação."

## 10. Error Handling

- **DB errors**: Logged via `console.error`, user gets a friendly Portuguese message
- **Telegram API errors**: Silent on `"message is not modified"`, logged otherwise
- **DeepSeek API errors**: Timeout after 5s, returns `null` → falls back to default response
- **Unexpected errors**: Caught by `serve()` try/catch, returns 200 to Telegram

## 11. TypeScript Variable Declaration

Use unique variable names per `switch` case or `if` block. `const` redeclaration in switch cases causes Deno boot errors:

```typescript
// WRONG — const redeclaration error
switch (command) {
  case "/a": const result = ...; break;
  case "/b": const result = ...; break; // ERROR: result already declared
}

// CORRECT
switch (command) {
  case "/a": const resultA = ...; break;
  case "/b": const resultB = ...; break;
}
```

## 12. User Resolution

All handlers receive `userId` (Telegram ID) and must resolve the internal DB ID:

```typescript
const user = await getOrCreateUser(supabase, userId);
if (!user) return; // or send error message
```

`getOrCreateUser` is read-only (no auto-creation). Use `requireUser` for handlers that should send an error on missing user.

## 13. Callback Data Truncation

Telegram limits callback_data to 64 bytes:
- Use `addSession(data, sessionSeq)` for short, safe data
- Use `truncateCallbackData(data, sessionSeq)` for any user-generated content (tags, names)
- `truncateCallbackData` adds session prefix and truncates to 60 chars

## 14. Import Organization

Imports are grouped: types, services, utils, handlers:
```typescript
import type { ... } from "../types/index.ts";
import { ... } from "../services/telegram.ts";
import { ... } from "../utils/formatting.ts";
import { ... } from "./wizard.ts";
```

No third-party libraries beyond Deno std and esm.sh.

## 15. Generic Filter Selector Pattern

When multiple inline keyboard selectors follow the same pattern (read wizard state → build grid with ✅ selection indicators → extra buttons → Voltar), extract a shared function:

```typescript
// Generic selector helper in statement.ts
async function showFilterSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number | undefined,
  sessionSeq: number,
  config: SelectorConfig,  // { title, options, isSelected, columns, extraButtons, messageSuffix }
): Promise<void>
```

Each concrete selector keeps only its unique logic (fetching data, defining options/`isSelected`/extra buttons) and delegates to `showFilterSelector`. Saves ~70 lines of boilerplate across 6 selectors.

## 16. Generic Filter Field Update Pattern

When multiple callback handlers follow the same pattern (extract value → read wizard state → set filter field → update DB → re-render), extract a shared helper:

```typescript
async function updateFilterField(
  supabase: any, userId: number, chatId: number,
  messageId: number | undefined, sessionSeq: number,
  selectedValue: string, prefix: string,
  setter: (filters: ExtratoFilters, value: any) => void,
  transform?: (v: string) => any,
): Promise<void>
```

Replaces 5 duplicated `stmt_f_*` blocks (category, group, type, status, period) with 1-liner calls. Saves ~30 lines.

## 17. In-Place Editing (Edit-in-Place)

### Problem

When a user clicks a button that requires additional input (typed text or selection), sending a **new** message without editing the original leaves the original message with buttons visible in the chat — creating "orphan" messages that clutter the conversation.

### Solution

Always **edit the callback message in-place** (`message.message_id`) before sending follow-up content. This creates a clean lifecycle per message: the original buttons are replaced, and the user sees only the active prompt.

### Variant A: Text Input — 3-State Lifecycle

For callbacks that need typed user input, a single message progresses through 3 states:

```text
[Buttons]  →  [Prompt]  →  [Confirmation]
"Selecione"    "✏️ Digite..."   "✅ 🏷️ Categoria: X"
```

**Code pattern (callback handler):**

```typescript
// ✅ CORRECT: Edit callback message in-place, store message_id for later
await editTelegramMessageWithKeyboard(chatId, message.message_id, "✏️ Digite o nome:", []);
// Store message.message_id as promptMessageId in wizard state
const key = "_categoryPromptMessageId";
// ... update wizard state data with [key]: message.message_id
```

Then, when the user types, the confirmation handler edits the **same** message:

```typescript
// In advanceWithConfirmation or handleWizardInput:
if (confirmText && promptMessageId) {
  await editTelegramMessageWithKeyboard(chatId, promptMessageId, confirmText, []);
}
```

**Examples:** `wizard_new_category`, `wizard_new_group`, `custom_date`.

### Variant B: Edit → Send (Keyboard Selection)

For callbacks that show a selection keyboard next, edit the original with a label then send the new UI:

```typescript
// ✅ CORRECT: Edit with descriptive label, then send
await editTelegramMessageWithKeyboard(chatId, message.message_id, "💰 Alterando valor...", []);
await sendTelegramMessage(chatId, "Informe o novo valor:");
```

**Examples:** `edit_amount`, `edit_category`, `edit_date`, `edit_group_`, `edit_tags_`, `rec_edit_field_*`, `tx_desc_sim_`, `rec_edit_set_freqtype_`.

### ❌ Wrong Pattern (Orphan Message)

```typescript
// ❌ WRONG: Sends new message, original buttons stay visible
await sendTelegramMessage(chatId, "✏️ Digite o nome da nova categoria:");
// Original category selection screen with buttons is now orphaned
```

### Emoji + Label Convention

Use consistent emoji-labels for the edit placeholder:

| Field | Label |
|-------|-------|
| Valor | `💰 Alterando valor...` |
| Descrição | `📝 Alterando descrição...` |
| Categoria | `🏷️ Alterando categoria...` |
| Grupo | `📁 Alterando grupo...` |
| Data | `📅 Alterando data...` |
| Frequência | `🔄 Alterando frequência...` |
| Tags | `🔖 Alterando tags...` |
| Digitar (novo) | `✏️ Digitando {label}...` |

- Use **present tense** ("Alterando...", "Digitando..."), never past tense
- Always send with `[]` (empty keyboard) to remove any existing inline buttons

### Checklist

When adding a new callback that needs additional input:

1. [ ] Does it **edit** `message.message_id` before sending a new message?
2. [ ] Does it use a **consistent emoji + label** from the table above?
3. [ ] Is the `[]` (empty keyboard) passed to `editTelegramMessageWithKeyboard`?
4. [ ] For typed input: is the **message_id stored** in wizard state for later confirmation?
5. [ ] Does the **confirmation handler** edit that stored message_id?
6. [ ] For keyboard selection: is the new UI sent via `sendTelegramMessage[WithKeyboard]`?

### Related

- Pattern #2 (Send vs Edit) for the general send/edit distinction
- AGENTS.md > Wizard Visual Confirmation Pattern for wizard-specific lifecycle
