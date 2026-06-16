# Architecture Overview

## Data Flow

```
Telegram User
    │
    ▼
Telegram Bot API ──── webhook ────► Supabase Edge Function
                                        │
                                        ▼
                                  Supabase PostgreSQL
                                        │
                                        ▼
                              Bot API Response
```

All interactions flow through a **single Edge Function** (`bot-core`) that:
1. Receives webhook POST from Telegram
2. Authenticates via `X-Telegram-Bot-Api-Secret-Token` header
3. Routes to the correct handler based on message type
4. Returns HTTP 200 (always — Telegram expects it)

## Request Lifecycle

```
POST /bot-core
  │
  ├── Validate secret token ── 401 if mismatch
  │
  ├── Parse TelegramUpdate JSON
  │
  ├── callback_query? ──► handleCallbackQuery()
  │
  ├── no message? ──► 200 OK
  │
  ├── Rate limit check ──► "wait" if exceeded
  │
  ├── User exists?
  │   ├── No ──► Create user + default group + predefined categories + /start
  │   └── Yes ──► Continue
  │
  ├── Active wizard? ──► Route to wizard handler
  │
  ├── NL text (no slash)? ──► parseNaturalLanguage() → execute
  │
  └── Slash command? ──► Switch/router
```

## Runtime

- **Deno** (not Node.js) — Edge Function runtime
- Imports from `https://deno.land/std`, `https://esm.sh`
- Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically
- Service role key bypasses RLS (no user auth needed for bot)

## Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `TELEGRAM_BOT_TOKEN` | Supabase Secrets | Bot token from @BotFather |
| `TELEGRAM_SECRET_TOKEN` | Supabase Secrets | Webhook verification header |
| `SUPABASE_URL` | Auto (runtime) | Internal: `http://kong:8000` locally |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto (runtime) | Bypass RLS for bot operations |
| `DEEPSEEK_API_KEY` | Supabase Secrets | Natural language processing |

## Key Design Decisions

1. **Single Edge Function**: All routing happens in one function. No micro-functions for different commands. Simplifies deployment and avoids cold-start overhead per endpoint.

2. **No JWT verification** (`verify_jwt = false`): The bot authenticates via Telegram secret token, not Supabase Auth. Users are identified by `telegram_id`.

3. **Service Role Key**: Used to bypass RLS. The bot is the only client of the database, so per-user RLS policies are not needed.

4. **Session-based Callback Protection**: Every inline keyboard gets a session sequence prefix. When a new command starts, the sequence increments, invalidating all previous callbacks. Prevents replay attacks and stale button clicks.

5. **Wizard System**: Multi-step transactions use a `wizard_states` table with 10-minute TTL. State is persisted in JSONB. The wizard handles amount → category → group → date → tags in sequence.

6. **Natural Language Fallback**: If `DEEPSEEK_API_KEY` is not set, the bot responds to slash commands only. NL uses a 3-tier approach: common phrases (no API), cache (per-user/5min TTL), DeepSeek API.

7. **No Web Framework**: Pure Deno `serve()` handler. No Oak, Hono, or Express-like middleware. Keeps bundle size small and boot time fast.

## Internal URLs

| Service | Local URL | Production URL |
|---------|-----------|----------------|
| Supabase API | `http://127.0.0.1:54321` | `https://zjcfjqtlijktrikgvwrv.supabase.co` |
| Internal DB | `http://kong:8000` (from Edge Function) | Auto by Supabase |
| Telegram API | `https://api.telegram.org/bot<TOKEN>` | Same |
| DeepSeek API | `https://api.deepseek.com` | Same |

## File Organization

```
bot-core/
├── index.ts               # Entry: serve handler, wizard routing, NL dispatch
├── config.ts              # Env vars, commonPhrases map, nlCache
├── types/index.ts         # DeepSeekResponse, TelegramUpdate, WizardState, etc.
├── utils/
│   ├── formatting.ts      # BRL currency, BR date, parsing
│   ├── rate-limiter.ts    # Per-user rate limiting, truncateCallbackData
│   ├── date-helpers.ts    # getDateRange, month names
│   ├── command-parsing.ts # parseCommand for slash args
│   └── session.ts         # addSession/removeSession/validateCallbackSession
├── services/
│   ├── telegram.ts        # 4 wrappers: send, sendWithKeyboard, edit, answerCallback
│   ├── database.ts        # 11 functions: CRUD + suggestSimilar* + getAllUserTags
│   └── deepseek.ts        # buildSystemPrompt, callDeepSeek, parseNaturalLanguage
└── handlers/
    ├── commands.ts        # 14 slash command handlers + shared handleEntity
    ├── management.ts      # 8 entity management functions with pagination
    ├── queries.ts         # getSummaryData, formatSummaryMessage, query handlers
    ├── nl-processing.ts   # NL routing + wizard initiation
    ├── callbacks.ts       # ~45 callback prefixes + filter panel
    └── wizard.ts          # 7 wizard functions (state + step + advance)
```
