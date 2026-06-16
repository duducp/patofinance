# Utilities

## `utils/formatting.ts` — Brazilian Locale

| Function | Input | Output | Description |
|----------|-------|--------|-------------|
| `formatCurrencyBR(value)` | `number` | `string` | `R$ 1.234,56` — BRL locale format |
| `formatDateBR(dateString)` | `"2024-06-15"` | `"15/06/2024"` | ISO → BR format |
| `parseDateBR(input)` | `"15/06/2024"` | `"2024-06-15" \| null` | BR → ISO, validates format |
| `getMonthName(date)` | `Date` | `string` | Portuguese month + year |
| `getTodayBR()` | — | `string` | Today in BR format |
| `getNowBR()` | — | `Date` | Current time in America/Sao_Paulo |
| `getTodayISOBR()` | — | `string` | Today in ISO format (BR timezone) |

## `utils/date-helpers.ts` — Date Ranges

### `getDateRange(period, date) → {start, end, label}`

Resolves period presets to date boundaries:

| Period | `start` | `end` | `label` |
|--------|---------|------|---------|
| `null` (default) | 1st of month | last day | Month name |
| `"this_month"` | 1st of month | last day | Month name |
| `"last_month"` | 1st of prev month | last day of prev | Prev month name |
| `"last_3_months"` | 3 months ago 1st | end of current month | "Últimos 3 meses" |
| `"this_year"` | Jan 1 | Dec 31 | `"2024"` |

If `date` is provided, returns single-day range with BR-formatted label.
Supports "hoje" and "ontem" string values.

## `utils/command-parsing.ts` — Slash Argument Parser

### `parseCommand(args) → ParsedCommand`

Parses the `args` array from slash command input.

```
Input: ["50", "alimentação", "--data", "15/06/2024", "--grupo", "Pessoal", "#ifood"]
  ↓
Output: {
  amount: 50,
  category: "alimentação",
  group: "Pessoal",
  date: "15/06/2024",
  tags: ["#ifood"],
  period: null
}
```

Flag parsing:
- `--data <value>` → date
- `--grupo <value>` → group
- `--periodo <value>` or `--mes <value>` → period
- `#something` → tag
- First numeric token → amount
- Remaining tokens → category (rest joined by space)

## `utils/rate-limiter.ts` — Rate Limiting + Callback Truncation

### `isRateLimited(userId) → boolean`

In-memory rate limiter:
- Window: 60 seconds
- Max: 10 requests/user/window
- Cleanup: every 5 minutes (stale entries purged)

Used at the very start of message processing (before any DB calls).

### `truncateCallbackData(data, sessionSeq) → string`

Telegram caps `callback_data` at **64 bytes**. This function:
1. Adds session prefix via `addSession()`
2. Truncates to 60 characters max (safety margin)

Used for any callback containing dynamic user-generated content.

## `utils/session.ts` — Callback Session Protection

Protects against stale/expired button presses by prefixing every callback_data with a monotonic session sequence.

### Format

```
s{SEQ}_{original_data}
s5_stmt_filter
s5_stmt_f_cat
```

### Exported Functions

| Function | Description |
|----------|-------------|
| `addSession(callbackData, sessionSeq, maxLength?)` | Prefix with session seq, truncate if needed |
| `removeSession(encoded)` | Strip prefix → `{data, seq}` or `null` if malformed |
| `incrementSessionSeq(supabase, userId)` | Bump sequence → next command invalidates old buttons |
| `getSessionSeq(supabase, userId)` | Read current sequence |
| `validateCallbackSession(supabase, userId, callbackSeq)` | Verify callback's seq matches current |

### Protection Flow

```
1. User sends "/despesa" → incrementSessionSeq() → seq=5
2. Bot sends keyboard with callbacks like:
     { text: "Alimentação", callback_data: "s5_Alimentação" }
3. User clicks button → removeSession("s5_Alimentação") → {data:"Alimentação", seq:5}
4. validateCallbackSession(supabase, userId, 5) → 5 === currentSeq → VALID
5. User starts new command → incrementSessionSeq() → seq=6
6. Old button clicked → seq=5 !== 6 → "Este botão expirou"
```

### Validation Rules

- Seq=0 (legacy, no prefix): only valid if user has never started a command (`currentSeq === 0`)
- Seq > 0: must exactly match current session seq
