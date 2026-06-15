# AGENTS.md

Telegram finance bot using Supabase Edge Functions + PostgreSQL.

## Quick Reference

```bash
make dev              # Start local Supabase (port 54321)
make check            # Type-check with Deno
make lint             # Lint edge function code
make test             # Run all checks (type + lint + boot)
make prod-deploy      # Deploy Edge Function to production
make help             # List all commands
```

## Architecture

Single Edge Function (`supabase/functions/bot-core/`) handles all Telegram webhook processing. Refactored into modules:

```text
Telegram → Edge Function (webhook) → Supabase DB → Bot API response
```

Runtime: **Deno** (not Node.js). Imports use `https://deno.land/std` and `https://esm.sh`.

## NL Processing

Natural language via DeepSeek API. Flow:
1. Check common phrases (no API call)
2. Check cache (5min TTL)
3. Call DeepSeek API (5s timeout)
4. Parse JSON response
5. Cache result

If `DEEPSEEK_API_KEY` is not set, falls back to commands only.

## Critical Gotchas

- **`verify_jwt = false`** in `supabase/config.toml` for local testing — never commit with `true`
- **Service Role Key** hardcoded for local dev (`your_service_role_key_here`) — production uses env var
- **Internal Supabase URL** is `http://kong:8000` inside Edge Functions, not `127.0.0.1:54321`
- **Webhook secret token** must match between Telegram and Supabase secrets — mismatch causes 401 errors
- **TypeScript variable redeclaration** — `const` in switch cases can cause boot errors. Use unique names per case.
- **`supabase functions logs`** does not exist — use Supabase Dashboard or check webhook `last_error_message`
- **ALWAYS use CLI for deploy** — `npx supabase functions deploy bot-core --no-verify-jwt`. The MCP tool `supabase_deploy_edge_function` doesn't read file content correctly.
- **DeepSeek API key** required for natural language. Without it, bot only responds to slash commands.

## Development Workflow

**Rule: Always test Edge Functions locally before deploying to production.**

**Rule: Always use CLI for deploy, not the MCP tool.**

```bash
make dev-deploy             # Deploy locally first
make dev-test-start         # Test the change
make dev-test-gasto         # Test another command
# Only then:
make prod-deploy            # Deploy to production (uses CLI)
```

**Deploy method:**
```bash
# ✅ CORRECT - Use CLI
npx supabase functions deploy bot-core --no-verify-jwt

# ❌ WRONG - MCP tool doesn't read file content correctly
# supabase_deploy_edge_function (not reliable)
```

## Local Development

```bash
make dev                    # Start Supabase
make dev-deploy             # Deploy Edge Function locally
make dev-test-start         # Test /start command
make dev-test-gasto         # Test /gasto command
make dev-db-push            # Apply migrations locally
make dev-db-reset           # Reset local database
```

Local test requires env vars:

- `SUPABASE_ANON_KEY` — from `supabase status`
- `TELEGRAM_SECRET_TOKEN` — must match webhook config

## Production

```bash
make prod-deploy            # Deploy Edge Function
make prod-db-push           # Apply migrations
make prod-webhook-set       # Configure Telegram webhook
make prod-webhook-info      # Check webhook status
```

## Environment Variables

| Variable | Where | Description |
| -------- | ----- | ----------- |
| `TELEGRAM_BOT_TOKEN` | Supabase Secrets | Bot token from @BotFather |
| `TELEGRAM_SECRET_TOKEN` | Supabase Secrets | Webhook verification token |
| `SUPABASE_URL` | Auto-set by Supabase | Internal URL (`http://kong:8000` locally) |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set by Supabase | Used to bypass RLS |
| `DEEPSEEK_API_KEY` | Supabase Secrets | DeepSeek API key for NL processing |

## Database

Project ref: `zjcfjqtlijktrikgvwrv`

Tables: `users`, `groups`, `categories`, `transactions`, `wizard_states`, `predefined_categories`

Migrations: `supabase/migrations/`

## File Structure

```text
supabase/
├── config.toml              # Supabase config (verify_jwt, ports)
├── migrations/              # SQL migrations
└── functions/bot-core/      # Single Edge Function (all bot logic)
    ├── index.ts             # Entry point (serve handler)
    ├── config.ts            # Env vars, DeepSeek cache, common phrases
    ├── types/
    │   └── index.ts         # Interfaces (DeepSeekResponse, Telegram, etc.)
    ├── utils/
    │   ├── formatting.ts    # formatCurrencyBR, formatDateBR, etc.
    │   ├── rate-limiter.ts  # isRateLimited, truncateCallbackData
    │   ├── date-helpers.ts  # getDateRange
    │   └── command-parsing.ts  # parseCommand
    ├── services/
    │   ├── telegram.ts      # sendTelegramMessage, etc.
    │   ├── database.ts      # getOrCreateUser, getOrCreateCategory, etc.
    │   └── deepseek.ts      # callDeepSeek, parseNaturalLanguage
    └── handlers/
        ├── commands.ts      # handleTransaction, handleSaldo, etc.
        ├── management.ts    # handleCreateCategory, handleListTags, etc.
        ├── queries.ts       # handleQueryExpenses, handleQuerySummary
        ├── nl-processing.ts # handleNaturalLanguageWithFollowUp
        ├── callbacks.ts     # handleCallbackQuery
        └── wizard.ts        # getWizardState, completeWizard, etc.
```
