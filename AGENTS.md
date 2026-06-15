# AGENTS.md

Telegram finance bot using Supabase Edge Functions + PostgreSQL.

## Quick Reference

```bash
make dev              # Start local Supabase (port 54321)
make prod-deploy      # Deploy Edge Function to production
make help             # List all commands
```

## Architecture

Single Edge Function (`supabase/functions/bot-core/index.ts`) handles all Telegram webhook processing.

```text
Telegram → Edge Function (webhook) → Supabase DB → Bot API response
```

Runtime: **Deno** (not Node.js). Imports use `https://deno.land/std` and `https://esm.sh`.

## Critical Gotchas

- **`verify_jwt = false`** in `supabase/config.toml` for local testing — never commit with `true`
- **Service Role Key** hardcoded for local dev (`your_service_role_key_here`) — production uses env var
- **Internal Supabase URL** is `http://kong:8000` inside Edge Functions, not `127.0.0.1:54321`
- **Webhook secret token** must match between Telegram and Supabase secrets — mismatch causes 401 errors
- **TypeScript variable redeclaration** — `const` in switch cases can cause boot errors. Use unique names per case.
- **`supabase functions logs`** does not exist — use Supabase Dashboard or check webhook `last_error_message`
- **ALWAYS use CLI for deploy** — `npx supabase functions deploy bot-core --no-verify-jwt`. The MCP tool `supabase_deploy_edge_function` doesn't read file content correctly.

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
    └── index.ts
```
