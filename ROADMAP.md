# ROADMAP — Pato Finance

Features futuras organizadas por prioridade e esforço estimado.

---

## 🚀 Prioridade Alta

### 1. Gráficos visuais (`/grafico`)

Gerar imagens PNG com gráficos de pizza (despesas por categoria) e barras (receita vs despesa ao longo do tempo).

**Abordagens:**
- **QuickChart.io** — API gratuita, implementação rápida (minutos), ~100 chamadas/dia free
- **Satori + resvg-wasm** — 0 dependência externa, mais complexo, roda 100% na Edge Function

**Arquivos:**
- `handlers/graph.ts` — handler do comando
- `services/chart.ts` — engine de renderização
- `utils/chart-template.tsx` — templates visuais (pizza, barras)
- `services/telegram.ts` — adicionar `sendTelegramPhoto()`

**Esforço:** 2–4h (QuickChart) / 6–10h (Satori+WASM)

---

### 2. Exportar dados (`/exportar`)

Gerar arquivo CSV com todas as transações do usuário.

**Fluxo:**
1. Query: `SELECT * FROM transactions WHERE user_id = ? ORDER BY transaction_date DESC`
2. Converter pra CSV (cabeçalho + linhas)
3. Enviar como arquivo via `sendDocument` da API do Telegram

**Detalhes:**
- Incluir nome da categoria e grupo (joins)
- Opção de filtro por período: `/exportar`, `/exportar 2025`, `/exportar janeiro 2025`
- Suporte a `--grupo` flag

**Esforço:** 1–2h

---

### 3. Testes automatizados

Cobertura de testes para as áreas críticas sem teste:

| Arquivo | O que testar | Testes existentes |
|---------|-------------|-------------------|
| `services/database.ts` | `getOrCreateUser`, `createTransaction`, `resolveCategoryForNL`, `normalizeString` | 0 |
| `handlers/callbacks.ts` | Roteamento de callbacks (cada prefixo) | 0 |
| `handlers/wizard.ts` | `advanceWizardToNextStep`, `completeWizard` | 0 |
| `handlers/statement.ts` | `resolvePeriod`, `applyFiltersToQuery` | 0 |
| `utils/formatting.ts` | `formatCurrencyBR`, `formatDateBR`, `parseDateBR` | 0 |
| `utils/date-helpers.ts` | `getDateRange`, `getNowBR` | 0 |

**Esforço:** 4–8h (completo) / 1–2h (só database.ts)

---

## 📊 Prioridade Média

### 4. Transações recorrentes

Permite criar transações que se repetem automaticamente (aluguel, salário, assinaturas).

**Migration SQL:**
```sql
ALTER TABLE transactions ADD COLUMN is_recurring BOOLEAN DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN recurring_interval TEXT;  -- 'monthly', 'weekly', 'yearly'
ALTER TABLE transactions ADD COLUMN recurring_end_date DATE;
ALTER TABLE transactions ADD COLUMN recurring_parent_id BIGINT REFERENCES transactions(id);
```

**Implementação:**
- Flag `--recorrente` no `/despesa` e `/receita`
- Edge Function cron (Supabase Cron) rodando todo dia 1º que duplica transações com `is_recurring = true` e `transaction_date` no mês passado
- Tratar fim da recorrência (não duplicar se passou `recurring_end_date`)
- Exibir ícone 🔄 nas transações recorrentes no extrato

**Esforço:** 4–6h (incluindo cron)

---

### 5. Orçamento mensal

Definir limites de gasto por categoria e receber alertas.

**Migration SQL:**
```sql
CREATE TABLE budgets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  category_id BIGINT REFERENCES categories(id) ON DELETE CASCADE,
  month DATE NOT NULL,  -- primeiro dia do mês (ex: 2026-06-01)
  limit_amount DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, category_id, month)
);
```

**Comandos:**
- `/orcamento` — lista orçamentos do mês
- `/orcamento alimentacao 800` — define orçamento de R$ 800 para Alimentação
- `/orcamento alimentacao --limpar` — remove orçamento

**Alertas:**
- Quando gasto atingir 80% do limite → notificação no Telegram
- Quando gasto atingir 100% → notificação "⚠️ Você estourou o orçamento de Alimentação!"

**Esforço:** 6–8h

---

### 6. Busca textual (`/buscar`)

Buscar transações por texto na descrição ou tags.

**Fluxo:**
```sql
SELECT * FROM transactions
WHERE user_id = ?
  AND (description ILIKE '%termo%' OR tags::text ILIKE '%termo%')
ORDER BY transaction_date DESC
LIMIT 20;
```

**Comando:** `/buscar ifood`, `/buscar #trabalho`

**Melhoria futura:** Usar pg_trgm + GIN index na `description` para busca fuzzy.

**Esforço:** 1–2h

---

### 7. Dashboard web

Transformar a landing page estática em um dashboard funcional conectado ao mesmo banco.

**Componentes:**
- Login via Telegram (deep link com `start` parameter)
- Visualização de extrato com os mesmos filtros do bot
- Gráficos interativos (Chart.js no frontend)
- Edição de transações

**Arquitetura:**
```
Frontend (HTML/JS) → Supabase REST API → Dados do usuário
```
Usar o `telegram_id` como chave de autenticação (passado via URL: `?user=123`).

**Esforço:** 10–20h

---

## 🔮 Prioridade Baixa (Ideias Futuras)

### 8. Múltiplas moedas

Suporte a USD, EUR, etc. com conversão automática.

**Migration:** Adicionar `currency TEXT DEFAULT 'BRL'` na `transactions`.
**Comando:** `/despesa 50 --usd`, `/despesa 50 --eur`
**API de câmbio:** AwesomeAPI (bruta, gratuita).

**Esforço:** 3–4h

---

### 9. Backup e restauração

Exportar tudo (transações + categorias + grupos) em JSON e importar de volta.

**Comandos:**
- `/backup` — gera JSON com todos os dados do usuário
- `/restore` — anexa o arquivo JSON para restaurar

**Esforço:** 2–3h

---

### 10. Notificações push mensais

Resumo automático no início de cada mês: "📊 Fechamento de Maio: R$ 4.200 de receita, R$ 3.100 de despesa."

**Implementação:** Edge Function cron (Supabase Cron) no dia 1º de cada mês.

**Esforço:** 2h (+ custo de execução do cron)

---

### 11. Suporte a grupos/compartilhamento

Permitir que dois usuários compartilhem um grupo (ex: casal dividindo contas).

**Migration:**
```sql
CREATE TABLE group_members (
  group_id BIGINT REFERENCES groups(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  PRIMARY KEY (group_id, user_id)
);
```

**Esforço:** 8–12h

---

### 12. Fotos/comprovantes em transações

Anexar foto do comprovante a uma transação.

- Usar `sendPhoto` + `caption` com o ID da transação
- O bot salva o `file_id` do Telegram na transação

**Migration:** `ALTER TABLE transactions ADD COLUMN photo_file_id TEXT;`

**Esforço:** 3–4h

---

## 📋 Resumo

| # | Feature | Esforço | Impacto |
|---|---------|---------|---------|
| 1 | Gráficos | 2–10h | ⭐⭐⭐ |
| 2 | Exportar CSV | 1–2h | ⭐⭐ |
| 3 | Testes | 4–8h | ⭐⭐⭐ (qualidade) |
| 4 | Transações recorrentes | 4–6h | ⭐⭐⭐ |
| 5 | Orçamento mensal | 6–8h | ⭐⭐⭐ |
| 6 | Busca textual | 1–2h | ⭐⭐ |
| 7 | Dashboard web | 10–20h | ⭐⭐⭐⭐⭐ |
| 8 | Múltiplas moedas | 3–4h | ⭐ |
| 9 | Backup/restore | 2–3h | ⭐⭐ |
| 10 | Notificações mensais | 2h | ⭐⭐ |
| 11 | Compartilhamento | 8–12h | ⭐⭐⭐ |
| 12 | Fotos comprovantes | 3–4h | ⭐ |
