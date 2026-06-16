# Development Workflow

## Makefile Commands

### Setup
```bash
make install            # Install Supabase CLI (brew)
make install-login      # Login to Supabase
make install-link       # Link to project zjcfjqtlijktrikgvwrv
```

### Local Development
```bash
make dev                # Start local Supabase (port 54321)
make dev-stop           # Stop local Supabase
make dev-deploy         # Deploy Edge Function locally
make dev-db-push        # Push migrations locally
make dev-db-reset       # Reset local database
make dev-logs           # Tail local function logs
make dev-test-start     # Test /start via curl
make dev-test-despesa   # Test /despesa via curl
```

### Production
```bash
make prod-deploy        # Push migrations + deploy function (CLI)
make prod-db-push       # Push migrations only
make prod-webhook-set   # Set Telegram webhook URL
make prod-webhook-info  # Check webhook status
make prod-webhook-delete# Delete webhook
make prod-logs          # Show recent deployment logs
```

### Quality
```bash
make check              # Type-check (deno check)
make lint               # Lint (deno lint)
make test-boot          # Verify function boots
make test               # check + lint + test-boot
```

### Other
```bash
make secrets            # Set TELEGRAM_BOT_TOKEN + TELEGRAM_SECRET_TOKEN
make status             # Supabase status
make open               # Open Supabase Dashboard
```

## Deploy Workflow

**ALWAYS test locally before deploying to production:**

```bash
make dev-deploy             # Deploy locally
make dev-test-start         # Test
make dev-test-despesa       # Test more
# Only then:
make prod-deploy            # Deploy to production
```

**ALWAYS use CLI for deploy:**

```bash
# CORRECT
npx supabase functions deploy bot-core --no-verify-jwt

# WRONG — MCP tool doesn't read file content correctly
# supabase_deploy_edge_function (not reliable)
```

## Testing with curl

### Test slash commands
```bash
curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
  -H "Content-Type: application/json" \
  -H "apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" \
  -H "X-Telegram-Bot-Api-Secret-Token: test_secret" \
  -d '{"update_id": 99, "message": {"message_id": 99, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/saldo"}}'
```

### Test callbacks
```bash
curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
  -H "Content-Type: application/json" \
  -H "apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH" \
  -H "X-Telegram-Bot-Api-Secret-Token: test_secret" \
  -d '{"update_id": 100, "callback_query": {"id": "cb1", "from": {"id": 123}, "message": {"message_id": 1, "chat": {"id": 123, "type": "private"}, "date": 1234567890}, "data": "txlist_p1"}}'
```

## Debugging

### Common Issues

| Symptom | Likely Cause |
|---------|-------------|
| `502 Bad Gateway` | Function crashed on boot → run `make check` + `make lint` |
| `401 Unauthorized` | `TELEGRAM_SECRET_TOKEN` mismatch between Supabase secrets and webhook config |
| `Read timed out` | Function took >10s → slow DB query or infinite loop |
| Button does nothing | Callback prefix typo in `startsWith()` or missing `return;` |
| Callback falls through to wizard | Missing `return;` in `if` block |
| "Botão expirou" | Session seq mismatch — old button after new command |
| NL returns "desculpe" | DeepSeek API key not set or API timeout |
| TypeScript boot error | `const` redeclaration in switch/case |

### Debug Tools

```bash
# Type-check
make check

# Lint
make lint

# Boot test
make test-boot

# Direct Deno check for detailed output
deno check supabase/functions/bot-core/index.ts
```

### Supabase Dashboard Debugging

```bash
make open  # Opens dashboard
```

Useful SQL queries:
```sql
-- Check user exists
SELECT * FROM users WHERE telegram_id = 123;

-- Check recent transactions
SELECT * FROM transactions WHERE user_id = 1 ORDER BY created_at DESC LIMIT 5;

-- Check wizard state
SELECT * FROM wizard_states WHERE user_id = 1;

-- Check callback data length
SELECT length('txlist_t#minha_tag_muito_longa_p1') as cb_length;
```

### Webhook Status

```bash
make prod-webhook-info

# Expected:
# {
#   "ok": true,
#   "result": {
#     "url": "https://.../functions/v1/bot-core",
#     "pending_update_count": 0,
#     "last_error_message": null
#   }
# }
```

## Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `TELEGRAM_BOT_TOKEN` | Supabase Secrets | Bot token from @BotFather |
| `TELEGRAM_SECRET_TOKEN` | Supabase Secrets | Webhook verification |
| `SUPABASE_URL` | Auto (runtime) | Internal DB URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto (runtime) | Bypass RLS |
| `DEEPSEEK_API_KEY` | Supabase Secrets | NL processing |

## Critical Gotchas

- **`verify_jwt = false`** in `supabase/config.toml` for local — never commit with `true`
- **Service Role Key** hardcoded for local dev (`your_service_role_key_here`) — production uses env var
- **Internal Supabase URL** is `http://kong:8000` inside Edge Functions, not `127.0.0.1:54321`
- **Webhook secret token** must match between Telegram and Supabase secrets
- **`const` in switch cases** can cause boot errors — use unique names per case
- **Every callback handler MUST `return`** to avoid wizard fallthrough
- **Callback data limit**: 64 bytes — use `truncateCallbackData()` for dynamic content
