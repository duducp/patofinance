# Bot de Controle Financeiro via Telegram

<p align="center">
  <img src="picture.png" alt="Finanças Bot" width="128" height="128">
</p>

<p align="center">
  <strong>📊 Gerencie suas finanças pessoais diretamente no Telegram</strong>
</p>

<p align="center">
  Registre gastos e receitas, veja extratos, saldo e resumo por categoria com comandos simples ou linguagem natural. Suporta grupos personalizados, categorias e tags para organizar tudo.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Runtime-Deno-000000?style=flat-square&logo=deno" alt="Deno">
  <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/DB-Supabase-3ECF8E?style=flat-square&logo=supabase" alt="Supabase">
  <img src="https://img.shields.io/badge/AI-DeepSeek-4F6BED?style=flat-square" alt="DeepSeek">
  <img src="https://img.shields.io/badge/License-MIT-brightgreen?style=flat-square" alt="MIT">
  <a href="CI_WORKFLOW_URL"><img src="https://img.shields.io/badge/CI-Passing-success?style=flat-square&logo=githubactions" alt="CI"></a>
</p>

---<!-- CI_WORKFLOW_URL: substitua pela URL do seu workflow, ex: https://github.com/seuusuario/fincance/actions/workflows/ci.yml/badge.svg -->

---

## ✨ About

> Assistente de finanças pessoais — registre gastos e receitas com comandos ou linguagem natural.

## 🎯 Funcionalidades

- **💸 Registrar despesas** — `/gasto 50 mercado` ou "gastei 50 no almoço"
- **💰 Registrar receitas** — `/receita 3000 salário` ou "recebi 3000 de salário"
- **📊 Saldo mensal** — `/saldo` com filtro por grupo
- **📋 Extrato interativo** — `/extrato` com paginação e filtros (receitas/despesas)
- **📈 Resumo por categoria** — `/resumo` com totais agrupados
- **📁 Grupos (contas)** — Organize por conta bancária, cartão de crédito, etc.
- **🏷️ Categorias** — Pré-definidas + personalizadas
- **🔖 Tags livres** — Adicione tags a transações (`#trabalho #presente`)
- **🧹 Limpeza automática** — Remova categorias/grupos sem uso
- **🌐 Linguagem natural** — Digite frases como "quanto gastei esse mês?" ou "últimas 10 transações"

## Arquitetura

```
Telegram → Edge Function (webhook) → Supabase DB → Resposta via Bot API
```

- **Edge Function** — Processa mensagens do Telegram com handlers modulares
- **Supabase DB** — PostgreSQL com 7 tabelas
- **Bot API** — Envia respostas com botões interativos

## Tecnologias

- **Runtime:** Deno (Supabase Edge Functions)
- **Banco:** PostgreSQL + pg_trgm (Supabase)
- **API:** Telegram Bot API
- **Linguagem:** TypeScript
- **IA:** DeepSeek API (para linguagem natural)

## Estrutura do Projeto

```text
fincance/
├── Makefile                 # Comandos de desenvolvimento
├── AGENTS.md                # Guia de desenvolvimento + callbacks
├── CLAUDE.md                # Memory para IA
├── picture.png              # Foto de perfil do bot
├── supabase/
│   ├── config.toml          # Config local (verify_jwt=false)
│   ├── .env.example         # Template de variáveis de ambiente
│   ├── migrations/          # 5 migrations SQL
│   │   ├── 20260614000000_initial_schema.sql
│   │   ├── 20260614000001_add_wizard_steps.sql
│   │   ├── 20260614000002_add_wizard_steps_index_and_timestamps.sql
│   │   ├── 20260615000000_add_tags_step_to_receita_wizard.sql
│   │   └── 20260615000001_add_normalized_name_and_trgm.sql
│   └── functions/bot-core/
│       ├── index.ts         # Entry point + roteamento
│       ├── config.ts        # Env vars + cache NL
│       ├── types/index.ts   # Interfaces TypeScript
│       ├── utils/           # formatting, rate-limiter, dates, command-parsing
│       ├── services/        # database, telegram, deepseek
│       └── handlers/        # commands, callbacks, management, wizard, nl-processing, queries
└── README.md
```

> 💡 Para um guia detalhado de desenvolvimento, consulte [`AGENTS.md`](AGENTS.md).

## Banco de Dados

### Tabelas

| Tabela | Descrição |
|--------|-----------|
| `users` | Usuários do bot (`telegram_id`, `username`) |
| `groups` | Grupos/contas bancárias (`name`, `is_default`) |
| `categories` | Categorias (`name`, `is_predefined`, `normalized_name`) |
| `transactions` | Receitas e despesas (`type`, `amount`, `tags TEXT[]`) |
| `wizard_states` | Estado do wizard conversacional (TTL 10min) |
| `wizard_steps` | Steps configuráveis dos wizards |
| `predefined_categories` | Categorias padrão (semeadas no setup) |

### Extensões

- `pg_trgm` — Similaridade fuzzy entre nomes via trigramas (usado em `suggest_categories`, `suggest_groups`, `suggest_tags`)

### Categorias Pré-definidas

Alimentação · Moradia · Transporte · Saúde · Educação · Lazer · Vestuário · Contas · Outros

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

Todas as variáveis de ambiente estão documentadas em [`supabase/functions/.env.example`](supabase/functions/.env.example).

#### Produção

```bash
supabase secrets set TELEGRAM_BOT_TOKEN=seu_token_do_bot
supabase secrets set TELEGRAM_SECRET_TOKEN=seu_secret_token
supabase secrets set DEEPSEEK_API_KEY=sua_chave_deepseek  # opcional, mas recomendado
```

#### Local

```bash
# Copie o template e preencha
cp supabase/functions/.env.example supabase/functions/.env
# Edite .env com seus valores

# Ou exporte manualmente:
supabase status  # obter SUPABASE_ANON_KEY e SUPABASE_URL

export SUPABASE_ANON_KEY="sua_anon_key_aqui"
export TELEGRAM_SECRET_TOKEN="seu_secret_token_aqui"

make dev-test-start
make dev-test-gasto
```

**Resumo das variáveis:**

| Variável | Obrigatória | Descrição |
|----------|-------------|----------|
| `TELEGRAM_BOT_TOKEN` | ✅ Sim | Token do @BotFather |
| `TELEGRAM_SECRET_TOKEN` | ✅ Sim | Token de verificação do webhook |
| `SUPABASE_URL` | Automático | URL interna do Supabase (`http://kong:8000` local) |
| `SUPABASE_SERVICE_ROLE_KEY` | Automático | Chave service role (bypass RLS) |
| `DEEPSEEK_API_KEY` | ❌ Não | API key para linguagem natural (sem ela, só comandos) |

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
gasto - Registrar despesa (ex: /gasto 50 mercado)
receita - Registrar receita (ex: /receita 3000 salario)
saldo - Ver saldo do mes
extrato - Ver extrato do mes com filtros
resumo - Resumo por categoria
editar - Editar transacao pelo ID
excluir - Excluir transacao pelo ID
categoria - Gerenciar categorias
grupo - Gerenciar grupos
tag - Gerenciar tags
limpar - Remover itens sem uso
cancelar - Cancelar operacao em andamento
ajuda - Ajuda completa
```

### Description (info do bot)

> Gerencie suas finan\u00E7as pessoais diretamente no Telegram. Registre gastos e receitas, veja extratos, saldo e resumo por categoria com comandos simples ou linguagem natural. Suporta grupos personalizados, categorias e tags para organizar tudo.

### About (texto inicial do chat)

> Assistente de finan\u00E7as pessoais \u2014 registre gastos e receitas com comandos ou linguagem natural.

## Comandos

### \ud83d\udcb0 Financeiros

| Comando | Descri\u00E7\u00E3o | Exemplo |
|---------|-----------|---------|
| `/gasto` | Registrar despesa | `/gasto 50 mercado` |
| `/receita` | Registrar receita | `/receita 3000 salario` |
| `/saldo` | Saldo do m\u00EAs | `/saldo` |
| `/extrato` | Extrato com filtros e paginação | `/extrato` |
| `/resumo` | Resumo por categoria | `/resumo` |
| `/editar` | Editar transação pelo ID | `/editar 42` |
| `/excluir` | Excluir transação pelo ID | `/excluir 42` |

### 📁 Organização

| Comando | Descrição | Exemplo |
|---------|-----------|---------|
| `/categoria` | Listar categorias (botões clicáveis) | `/categoria` |
| `/categoria nome` | Criar categoria | `/categoria Transporte` |
| `/grupo` | Listar grupos (botões clicáveis) | `/grupo` |
| `/grupo nome` | Criar grupo | `/grupo Nubank` |
| `/tag` | Listar tags com contagens + botões | `/tag` |

### ⚙️ Utilitários

| Comando | Descrição |
|---------|-----------|
| `/limpar` | Remover categorias/grupos sem transações |
| `/cancelar` | Cancelar operação em andamento |
| `/ajuda` | Ajuda completa |

### 🌐 Linguagem Natural

Com `DEEPSEEK_API_KEY` configurada, você pode digitar frases diretamente:

- `"gastei 50 no almoço"` — registra despesa
- `"recebi 3000 de salário"` — registra receita
- `"quanto tenho?"` — saldo do mês
- `"quanto gastei em alimentação?"` — consulta por categoria
- `"resumo do mês"` — resumo agrupado
- `"últimas 10 transações"` — extrato
- `"crie a categoria transporte"` — criar categoria
- `"transações com #alimentação"` — filtrar por tag
- `"quais tags uso?"` — listar tags
- `"limpe categorias sem uso"` — limpeza

Sem a chave DeepSeek, apenas comandos `/` funcionam.

### Comandos Rápidos

```
/gasto 50 mercado --grupo Pessoal --tags #almoço
/gasto 100 vestuário --data 15/01/2024 --tags #presente
/receita 3000 salário --grupo Nubank
```

### Wizard Conversacional

Envie uma mensagem livre e o bot guia você com botões interativos:

```
Usuário: "gastei 30 no almoço"
Bot: "💸 Quanto você gastou?"
Usuário: "30"
Bot: "📁 Selecione o grupo:"  [Pessoal] [Nubank] [Inter]
Usuário: clica em "Pessoal"
Bot: "🏷️ Selecione a categoria:"  [Alimentação] [Transporte] [✏️ Nova]
Usuário: clica em "Alimentação"
Bot: "🔖 Selecione as tags:"  [#trabalho] [#almoço] [⏭️ Pular]
Usuário: clica em [#almoço] + [✅ Concluir]
Bot: ✅ Despesa registrada! R$ 30,00 · Alimentação · Pessoal  #almoço
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
