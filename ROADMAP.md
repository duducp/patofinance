# Roadmap — Pato Finance

> 📊 Visão geral do desenvolvimento, entregas e próximos passos.

---

## ✅ Já Implementado

### Core Financeiro

- [x] **CRUD de transações** — `/despesa`, `/receita`, `/extrato`, `/detalhes`
- [x] **Edição e exclusão** — Editar valor, categoria, grupo, data, tags; excluir com confirmação
- [x] **Transações futuras/agendadas** — `/agendadas` com suporte a `status: "future"` no filtro
- [x] **Saldo do período** — `/saldo` com projeção de agendados e filtro por grupo
- [x] **Busca textual** — `/buscar` por descrição, valor (`/buscar 150`) ou tag (`/buscar #ifood`)
- [x] **Resumo por categoria** — `/resumo` com agrupamento + projeção de agendados
- [x] **Painel de filtros** — Categoria, grupo, tags, tipo, status (realizada/agendada), período (presets + custom)

### Paginação

- [x] Navegação com ◀️ Anterior / ▶️ Próximo
- [x] Indicador "Página X de Y"
- [x] Proteção de sessão via `session_seq` + `truncateCallbackData`

### Organização

- [x] **Categorias** — Pré-definidas (12 globais) + personalizadas, com tipo (expense/income/both)
- [x] **Grupos** — Contas personalizáveis com `is_default`
- [x] **Tags** — Suporte completo com multiselect nos wizards

### Linguagem Natural (DeepSeek)

- [x] **Common phrases** — 12+ frases mapeadas sem chamada de API
- [x] **Cache por usuário** — `nlCache` com TTL de 5min
- [x] **Wizard de campos faltantes** — Amount → descrição → grupo → categoria → tags
- [x] **Desambiguação de tipo** — Keyboard 💸 Despesa / 💰 Receita quando ambíguo

### Experiência do Usuário

- [x] **Wizard conversacional** — Passo a passo com botões para amount, descrição, grupo, categoria, tags
- [x] **Proteção de sessão** — Callbacks expiram após novo comando
- [x] **Rate limiting** — Previne spam
- [x] **Ajuda contextual** — `/ajuda <comando>` com detalhes de uso
- [x] **Mensagens de erro variadas** — Fallbacks aleatórios para NL não compreendida

### Infraestrutura

- [x] **Separação de contas** — `telegram_accounts` desacoplado de `users`
- [x] **Busca fuzzy** — `pg_trgm` para similaridade em categorias/grupos/tags
- [x] **Índice GIN trigram** — Busca rápida em `transactions.description`
- [x] **Deploy via CLI** — `supabase functions deploy` com `--no-verify-jwt`

### Documentação

- [x] **README.md** — Configuração, comandos, BotFather, linguagem natural, wizard
- [x] **AGENTS.md** — Patterns de código, callbacks, handlers, arquitetura
- [x] **Landing page** — `landing/index.html` com hero, features, comandos, FAQ, CTA
- [x] **Migrações** — 16 migrations com descrições

---

## 🔄 Em Andamento

- [ ] **Refatoração contínua** — Extração de patterns genéricos (showFilterSelector, updateFilterField)
- [ ] **Testes** — Cobertura de testes unitários para handlers e services
- [ ] **Landing page** — Revisão de conteúdo e melhorias de acessibilidade

---

## 📋 Próximas Entregas

### Curto Prazo (prioridade alta)

| Feature | Descrição | Por que |
|---------|-----------|--------|
| **Exportar CSV** | `/exportar` baixa extrato como CSV | Útil para planilhas e declaração |
| **Transações recorrentes** | Agendamento com repetição mensal/semanal | Contas fixas (aluguel, assinaturas) |
| **Orçamentos** | Limite mensal por categoria com alerta | Controle de gastos |

### Médio Prazo

| Feature | Descrição |
|---------|-----------|
| **Gráficos** | `/grafico` com pizza de categorias, barras de evolução mensal |
| **Múltiplas contas por usuário** | Vincular mais de um Telegram ao mesmo perfil |
| **Split de transação** | Ratear um valor entre múltiplas categorias |
| **Anexar recibo** | Associar imagem à transação |
| **Notificações** | Lembrete diário/semanal para registrar gastos |

### Longo Prazo

| Feature | Descrição |
|---------|-----------|
| **Web Dashboard** | Interface web para visualização, além do Telegram |
| **Importação bancária** | OFX/OFD para importar extratos automaticamente |
| **Compartilhamento** | Orçamento familiar compartilhado entre usuários |
| **Multi-moeda** | Suporte a USD, EUR com conversão automática |
| **Metas financeiras** | Definir objetivos de economia com acompanhamento |

---

## 📈 Métricas

| Indicador | Atual | Meta |
|-----------|-------|------|
| Handlers TypeScript | ~15 comandos + ~40 callbacks | — |
| Migrations SQL | 16 | — |
| Testes unitários | 26 | 50+ |
| Cobertura de handlers testados | ~30% | 80%+ |
| Common phrases NL | 12+ | 20+ |

---

## 💡 Como Contribuir

Veja [`AGENTS.md`](AGENTS.md) para guia de desenvolvimento e [`README.md`](README.md) para setup do projeto.

> Última atualização: Junho 2026
