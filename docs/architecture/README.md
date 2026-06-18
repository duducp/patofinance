# Fincance — Architecture Documentation

Telegram finance bot using Supabase Edge Functions + PostgreSQL.

## Pages

| Page | Description |
|------|-------------|
| [Overview](overview.md) | High-level architecture, data flow, runtime |
| [Database](database.md) | Schema, migrations, stored procedures, RLS |
| [Edge Function](edge-function.md) | Entry point, routing, request lifecycle |
| [Handlers](handlers.md) | All handler functions organized by module |
| [Services](services.md) | Telegram API, Database CRUD, DeepSeek NL |
| [Utils](utils.md) | Formatting, rate limiting, session protection, date helpers |
| [Natural Language](natural-language.md) | NL pipeline, DeepSeek integration, intent routing |
| [Callbacks](callbacks.md) | Inline keyboard callback routing system |
| [Session](session.md) | Callback session protection: addSession, validation, increment rules |
| [Wizard](wizard.md) | Multi-step wizard system for transaction creation |
| [Patterns](patterns.md) | Coding patterns, conventions, rules |
| [Development](development.md) | Makefile commands, debugging, deploy workflow |

## Quick Reference

```bash
make dev              # Start local Supabase
make check            # Type-check (Deno)
make lint             # Lint edge function code
make test             # All checks (type + lint + boot)
make prod-deploy      # Deploy to production
```

## Project Structure

```
supabase/
├── config.toml                  # verify_jwt=false for local
├── migrations/                  # 24 SQL migrations
└── functions/bot-core/
    ├── index.ts                 # Entry point (serve handler)
    ├── config.ts                # Env vars, commonPhrases, nlCache
    ├── types/index.ts           # Shared TypeScript interfaces
    ├── utils/                   # 5 utility modules
    ├── services/                # 3 service modules
    └── handlers/                # 6 handler modules
```
