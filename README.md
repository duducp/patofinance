# Bot de Controle Financeiro via Telegram

Bot para Telegram que permite registrar receitas e despesas, visualizar saldo mensal, e organizar transações por grupos (contas bancárias), categorias e tags livres.

## Funcionalidades

- **Registrar despesas** — `/gasto 50 alimentação`
- **Registrar receitas** — `/receita 3000 salário`
- **Ver saldo mensal** — `/saldo`
- **Ver extrato** — `/extrato`
- **Gerenciar grupos** — `/grupo Nubank`
- **Gerenciar categorias** — `/categoria Viagem`
- **Wizard conversacional** — Enviar mensagem livre e seguir as perguntas

## Arquitetura

```
Telegram → Edge Function (webhook) → Supabase DB → Resposta via Bot API
```

- **Edge Function** — Processa mensagens do Telegram
- **Supabase DB** — PostgreSQL com 6 tabelas
- **Bot API** — Envia respostas para o usuário

## Tecnologias

- **Runtime:** Deno (Supabase Edge Functions)
- **Banco:** PostgreSQL (Supabase)
- **API:** Telegram Bot API
- **Linguagem:** TypeScript

## Estrutura do Projeto

```text
fincance/
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   └── 20260614000000_initial_schema.sql
│   └── functions/
│       └── bot-core/
│           └── index.ts
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   └── 2026-06-14-telegram-finance-bot-design.md
│       └── plans/
│           └── 2026-06-14-telegram-finance-bot.md
└── README.md
```

## Banco de Dados

### Tabelas

| Tabela | Descrição |
|--------|-----------|
| `users` | Usuários do bot (Telegram ID) |
| `groups` | Grupos/contas bancárias (ex: Pessoal, Nubank) |
| `categories` | Categorias (pré-definidas + usuário) |
| `transactions` | Receitas e despesas |
| `wizard_states` | Estado do wizard (TTL 10min) |
| `predefined_categories` | Categorias padrão do sistema |

### Categorias Pré-definidas

- Alimentação
- Moradia
- Transporte
- Saúde
- Educação
- Lazer
- Vestuário
- Contas
- Outros

## Configuração

### 1. Criar Bot no Telegram

1. Abra o Telegram e procure por **@BotFather**
2. Envie `/newbot`
3. Escolha um nome para o bot (ex: "Meu Bot Financeiro")
4. Escolha um username (ex: `meubotfinanceiro_bot`)
5. Copie o **token** fornecido (formato: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Configurar Supabase

1. Acesse [supabase.com](https://supabase.com) e faça login
2. Crie um novo projeto ou use um existente
3. Vá em **Project Settings > API** e copie:
   - **Project URL** (ex: `https://xyzproject.supabase.co`)
   - **Service Role Key** (eyJ...)

### 3. Instalar Supabase CLI

```bash
# macOS
brew install supabase/tap/supabase

# Linux
npx supabase --version
```

### 4. Fazer Login no Supabase

```bash
supabase login --token seu_token_de_acesso
```

Para obter o token:
1. Acesse [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
2. Crie um novo token

### 5. Linkar ao Projeto

```bash
supabase link --project-ref seu_project_ref
```

O `project_ref` está na URL do projeto: `https://seu_project_ref.supabase.co`

### 6. Aplicar Migrações

```bash
supabase db push
```

### 7. Configurar Variáveis de Ambiente

#### Produção

```bash
supabase secrets set TELEGRAM_BOT_TOKEN=seu_token_do_bot
supabase secrets set TELEGRAM_SECRET_TOKEN=seu_secret_token
```

#### Local

Para testar localmente, exporte as variáveis no terminal antes de usar os comandos de teste:

```bash
# Obter as keys do Supabase local
supabase status

# Exportar no terminal (copie do output do supabase status)
export SUPABASE_ANON_KEY="sua_anon_key_aqui"
export TELEGRAM_SECRET_TOKEN="seu_secret_token_aqui"

# Agora pode testar
make dev-test-start
make dev-test-gasto
```

**Resumo das variáveis:**

| Variável | Produção | Local | Como configurar |
|----------|----------|-------|-----------------|
| `TELEGRAM_BOT_TOKEN` | Supabase Secrets | Supabase Secrets | `supabase secrets set` |
| `TELEGRAM_SECRET_TOKEN` | Supabase Secrets | Supabase Secrets | `supabase secrets set` |
| `SUPABASE_ANON_KEY` | Automático | `supabase status` | Exportar no shell |
| `SUPABASE_URL` | Automático | Automático | Definido pelo Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Automático | Automático | Definido pelo Supabase |

**Importante:** O `secret_token` deve conter apenas letras, números, underscores e hífens.

### 8. Deploy da Edge Function

```bash
supabase functions deploy bot-core --no-verify-jwt
```

### 9. Configurar Webhook no Telegram

```bash
curl -X POST "https://api.telegram.org/botSEU_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://seu_project_ref.supabase.co/functions/v1/bot-core", "secret_token": "seu_secret_token"}'
```

### 10. Verificar Webhook

```bash
curl "https://api.telegram.org/botSEU_TOKEN/getWebhookInfo"
```

Resposta esperada:
```json
{
  "ok": true,
  "result": {
    "url": "https://seu_project_ref.supabase.co/functions/v1/bot-core",
    "pending_update_count": 0
  }
}
```

### 11. Configurar Comandos no BotFather

1. Procure **@BotFather** no Telegram
2. Envie `/setcommands`
3. Selecione seu bot
4. Cole:

```
start - Iniciar o bot e ver boas-vindas
gasto - Adicionar despesa
receita - Adicionar receita
saldo - Ver saldo do mês
extrato - Ver extrato do mês
grupo - Gerenciar grupos
categoria - Gerenciar categorias
ajuda - Ver comandos disponíveis
```

## Comandos

| Comando | Descrição | Exemplo |
|---------|-----------|---------|
| `/start` | Registro inicial | `/start` |
| `/gasto` | Adicionar despesa | `/gasto 50 alimentação` |
| `/receita` | Adicionar receita | `/receita 3000 salário` |
| `/saldo` | Saldo do mês | `/saldo` |
| `/extrato` | Extrato do mês | `/extrato` |
| `/grupo` | Gerenciar grupos | `/grupo Nubank` |
| `/categoria` | Gerenciar categorias | `/categoria Viagem` |
| `/ajuda` | Lista de comandos | `/ajuda` |

### Comandos Rápidos

```
/gasto 50 alimentação --grupo Pessoal
/gasto 100 vestuário --data 2024-01-15 --tags #presente
/receita 3000 salário --grupo Nubank
```

### Wizard Conversacional

Envie uma mensagem livre e o bot guia você:

```
Usuário: "gastei 30 no almoço"
Bot: "Qual grupo? [Pessoal] [Nubank]"
Usuário: "Pessoal"
Bot: "Categoria?"
Usuário: "Alimentação"
Bot: "Tags? (ex: #trabalho)"
Usuário: "#trabalho"
Bot: "✅ R$30,00 - Despesa - Alimentação - Pessoal #trabalho"
```

## Desenvolvimento Local

### Iniciar Supabase Local

```bash
supabase start
```

### Testar Edge Function

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/bot-core \
  -H "Content-Type: application/json" \
  -H "apikey: sua_anon_key" \
  -H "X-Telegram-Bot-Api-Secret-Token: seu_secret_token" \
  -d '{"update_id": 1, "message": {"message_id": 1, "from": {"id": 123, "first_name": "Test"}, "chat": {"id": 123, "type": "private"}, "date": 1234567890, "text": "/start"}}'
```

### Parar Supabase

```bash
supabase stop
```

## Troubleshooting

### Erro 401 Unauthorized

O secret token no Telegram não bate com o do Supabase:

```bash
# Atualizar secret no Supabase
supabase secrets set TELEGRAM_SECRET_TOKEN=novo_token

# Atualizar webhook no Telegram
curl -X POST "https://api.telegram.org/botSEU_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://seu_project_ref.supabase.co/functions/v1/bot-core", "secret_token": "novo_token"}'

# Redeploy
supabase functions deploy bot-core --no-verify-jwt
```

### Bot não responde

1. Verifique o webhook: `curl "https://api.telegram.org/botSEU_TOKEN/getWebhookInfo"`
2. Verifique se `pending_update_count` está em 0
3. Verifique os logs no Supabase Dashboard > Edge Functions > bot-core

### Erro de permissão no banco

Verifique se as migrations foram aplicadas:

```bash
supabase db push
```

## Licença

MIT
