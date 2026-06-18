# Session-Based Callback Protection

## Problem

Telegram inline keyboards use static `callback_data` strings. Once sent, anyone can press any button at any time — there is no built-in expiration. Without protection:

- A user presses "Excluir" from yesterday's message → deletes a different transaction today
- A user starts a new command, then presses an old button → operates on stale data
- Replay attack: an old callback is captured and replayed

## Solution

Every `callback_data` gets a **monotonic session sequence** prefix. The sequence increments on every new command, instantly invalidating all previously issued callbacks.

```
format:  s{sessionSeq}_{realData}
example: s5_Alimentação     ← session 5, data = "Alimentação"
         s6_rec_new          ← session 6, data = "rec_new"
```

## Storage

Single table `user_sessions` (one row per user):

```sql
user_sessions (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_seq INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
)
```

## API

All functions in `utils/session.ts`:

| Function | Purpose |
|----------|---------|
| `addSession(data, seq, maxLen?)` | Prefix data with `s{seq}_`, truncate if exceeds 64 bytes |
| `removeSession(encoded)` | Strip prefix → `{data, seq}` or `null` if malformed |
| `incrementSessionSeq(supabase, userId)` | Bump seq +1, return new value |
| `getSessionSeq(supabase, userId)` | Read current seq (no mutation) |
| `validateCallbackSession(supabase, userId, callbackSeq)` | Compare callback seq vs current DB seq |

### `addSession(data, seq, maxLength = 64)`

```typescript
addSession("rec_new", 5)       → "s5_rec_new"           // normal
addSession("Alimentação", 5)   → "s5_Alimentação"       // UTF-8 safe
addSession("rec_new", 0)       → "rec_new"               // no protection (seq=0)
addSession("very_long_...", 3) → "s3_very_long_..."      // truncated at 64 bytes
```

- If `seq <= 0`, returns data unchanged (no prefix)
- Telegram limit is 64 bytes — the function truncates the data part to stay under

### `removeSession(encoded)`

```typescript
removeSession("s5_rec_new")  → { data: "rec_new", seq: 5 }
removeSession("s5")          → null     // too short after prefix
removeSession("sNaN_xxx")    → null     // invalid seq
removeSession("rec_new")     → { data: "rec_new", seq: 0 }  // no prefix, seq=0
removeSession("s999999_xxx") → null     // seq too many digits (>5)
```

Returns `null` when the format is malformed — the callback handler shows "⏰ Este botão expirou."

### `incrementSessionSeq(supabase, userId)`

Inserts or updates the user's row with `session_seq + 1`. Called at the start of every slash command and after completing actions (edits, deletes, wizard completion).

```typescript
await incrementSessionSeq(supabase, user.id);
// All previous callbacks are now invalid
```

### `validateCallbackSession(supabase, userId, callbackSeq)`

Compares the callback's sequence against the current DB value:

```typescript
validateSession(supabase, 1, 5)  → true   // seq 5 matches current
validateSession(supabase, 1, 4)  → false  // seq 4 is stale
validateSession(supabase, 1, 0)  → true   // only if current seq is also 0
```

## Flow

### 1. User sends a slash command

```
User: /despesa 50 mercado
        │
        ▼
incrementSessionSeq(user.id)  ← seq jumps to 5
        │
        ▼
Handler builds keyboard:
  addSession("cat_sel_Alimentação", 5) → "s5_cat_sel_Alimentação"
  addSession("cat_sel_Transporte", 5)  → "s5_cat_sel_Transporte"
        │
        ▼
Bot sends message with inline keyboard (all callbacks at seq=5)
```

### 2. User clicks a button

```
Callback data: "s5_cat_sel_Alimentação"
        │
        ▼
removeSession("s5_cat_sel_Alimentação")
  → { data: "cat_sel_Alimentação", seq: 5 }
        │
        ▼
validateCallbackSession(supabase, user.id, 5)
  → reads current seq from DB → 5
  → 5 === 5 → VALID ✅
        │
        ▼
Handler executes: cat_sel_Alimentação
```

### 3. User starts a new command (old buttons expire)

```
User: /saldo
        │
        ▼
incrementSessionSeq(user.id)  ← seq jumps to 6
        │
        ▼
Bot sends new keyboard with "s6_..." callbacks
  (all previous "s5_..." callbacks are now stale)

--- Later, user clicks old "s5_cat_sel_Alimentação" button ---

validateCallbackSession(supabase, user.id, 5)
  → reads current seq from DB → 6
  → 5 !== 6 → INVALID ❌
  → "⏰ Este botão expirou pois você iniciou uma nova conversa."
```

## Two Error Messages

| `removeSession` returns | Validation | Message |
|------------------------|-----------|---------|
| `null` (no session prefix or malformed) | — | "⏰ Este botão expirou. Execute o comando novamente." |
| `{data, seq}` with stale seq | seq !== current | "⏰ Este botão expirou pois você iniciou uma nova conversa. Execute o comando novamente." |

**"botão expirou"** = the callback_data has no valid session prefix at all. Usually means `addSession()` was forgotten.

**"iniciou uma nova conversa"** = the callback is valid but from an older session. Normal behavior when user starts a new command.

## When to increment

| Scenario | Action |
|----------|--------|
| Slash command received | `incrementSessionSeq()` at start of handler |
| NL text processed | `incrementSessionSeq()` before showing follow-up keyboard |
| Edit/delete completed | `incrementSessionSeq()` after the action |
| Wizard completed/cancelled | `incrementSessionSeq()` after state cleared |
| Statement filter "Aplicar" | `clearWizardState()` (seq is not incremented — filters use same session) |

Do NOT increment after every callback — only after actions that should invalidate previous buttons (e.g., completing an edit). Pagination callbacks (`txlist_p`, `search_`) do NOT increment.

When session seq is 0 (never incremented), `validateCallbackSession` accepts seq=0 only. Calling `incrementSessionSeq` once bumps seq to 1.

## When to use `addSession` vs bare `callback_data`

| Use `addSession(data, seq)` | Use bare string |
|----------------------------|-----------------|
| All inline keyboard buttons | Navigation-only data not routed through callback handler |
| Wizard step options | — |
| Entity management buttons | — |
| NL follow-up keyboards | — |

**Every callback that reaches `handleCallbackQuery` must have a session prefix.** There is no exception. A bare `callback_data` causes `removeSession` to return `null`, triggering the "botão expirou" error.

## The `truncateCallbackData` Helper

For dynamic user-generated content (long tag names, category names, dates):

```typescript
// In rate-limiter.ts
export function truncateCallbackData(data: string, sessionSeq: number = 0): string {
  return addSession(data, sessionSeq, 60); // 60-char safety margin
}
```

Use when the total data could exceed 64 bytes:

```typescript
// Safe for short fixed data
{ text: "Nova", callback_data: addSession("rec_new", sessionSeq) }

// Must truncate for user-generated names
{ text: tag, callback_data: truncateCallbackData(`edit_tag_tog_${id}_${tag}`, sessionSeq) }
```

## Common Mistakes

### Mistake 1: Missing `addSession`

```typescript
// WRONG — user clicks → "botão expirou"
{ text: "Nova recorrência", callback_data: "rec_new" }

// RIGHT
{ text: "Nova recorrência", callback_data: addSession("rec_new", sessionSeq) }
```

### Mistake 2: Not calling `incrementSessionSeq` before building keyboard

```typescript
// WRONG — keyboard uses seq from previous command
const sessionSeq = await getSessionSeq(supabase, user.id);
keyboard.push({ text: "OK", callback_data: addSession("ok", sessionSeq) });

// RIGHT — invalidate old, get new seq
const sessionSeq = await incrementSessionSeq(supabase, user.id);
keyboard.push({ text: "OK", callback_data: addSession("ok", sessionSeq) });
```

### Mistake 3: Passing internal DB ID instead of `user.id` (DB users.id) to session functions

```typescript
// WRONG — incrementSessionSeq uses DB user_id column
await incrementSessionSeq(supabase, telegramId);  // telegramId is NOT the DB users.id

// RIGHT — use user.id (resolved from getOrCreateUser)
const user = await getOrCreateUser(supabase, telegramId);
await incrementSessionSeq(supabase, user.id);      // user.id IS the DB users.id
```

Session functions (`user_sessions.user_id`) are FK to `users.id` (internal DB ID). Always use the resolved `user.id` from `getOrCreateUser`, never the raw `telegramId`.

### Mistake 4: Forgetting to get `sessionSeq` for the empty-state keyboard

When building a keyboard in a handler that handles both empty and non-empty states, both paths must fetch `sessionSeq`:

```typescript
// WRONG — empty state has no session
if (items.length === 0) {
  keyboard.push({ text: "Criar", callback_data: "rec_new" });  // no addSession!
}

// RIGHT
if (items.length === 0) {
  const sessionSeq = await getSessionSeq(supabase, user.id);
  keyboard.push({ text: "Criar", callback_data: addSession("rec_new", sessionSeq) });
}
```
