# Design: Wizard Dinâmico com Inline Keyboards

**Data:** 2026-06-14
**Status:** Aprovado

## Objetivo

Transformar o wizard de texto para **inline keyboards** do Telegram, tornando as perguntas **dinâmicas** baseadas em configuração do banco de dados.

## Seção 1: Banco de Dados

### Nova tabela `wizard_steps`

```sql
CREATE TABLE wizard_steps (
  id BIGSERIAL PRIMARY KEY,
  wizard_name TEXT NOT NULL,          -- 'gasto', 'receita', etc.
  step_order INT NOT NULL,            -- 1, 2, 3...
  step_key TEXT NOT NULL,             -- 'amount', 'category', 'group', 'date', 'tags'
  prompt TEXT NOT NULL,               -- "Qual categoria?"
  input_type TEXT NOT NULL,           -- 'text', 'select', 'date', 'tags'
  options_source TEXT,                -- 'categories', 'groups', 'predefined_categories', NULL
  is_required BOOLEAN DEFAULT TRUE,
  UNIQUE(wizard_name, step_order)
);
```

### Dados iniciais para wizard 'gasto'

```sql
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type, options_source) VALUES
  ('gasto', 1, 'amount', 'Qual o valor?', 'text', NULL),
  ('gasto', 2, 'category', 'Qual categoria?', 'select', 'categories'),
  ('gasto', 3, 'group', 'Qual grupo?', 'select', 'groups'),
  ('gasto', 4, 'date', 'Qual data?', 'date', NULL),
  ('gasto', 5, 'tags', 'Tags? (ex: #trabalho)', 'tags', NULL);
```

## Seção 2: Edge Function - Envio de Mensagens

### Nova função `sendTelegramMessageWithKeyboard`

```typescript
async function sendTelegramMessageWithKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }),
  });
}
```

### Tipos de Inline Keyboard

| Tipo | Exemplo |
|------|---------|
| `text` | Campo de texto livre |
| `select` | Botões: `[Alimentação] [Moradia] [Transporte]` |
| `date` | Botões: `[Hoje] [Ontem] [Outra data]` |
| `tags` | Campo de texto com sugestões |

### Para select

Busca opções do banco:

```typescript
const { data: options } = await supabase
  .from(optionsSource)
  .select("name")
  .eq("user_id", userId)
  .order("name");

const keyboard = options.map(opt => [{ text: opt.name, callback_data: opt.name }]);
```

## Seção 3: Callback Querys

### Novo handler para callback_querys

```typescript
// No main handler, adicionar:
if (update.callback_query) {
  await handleCallbackQuery(supabase, update.callback_query);
  return new Response("ok");
}

async function handleCallbackQuery(supabase: any, callbackQuery: any): Promise<void> {
  const { data, message } = callbackQuery;
  const chatId = message.chat.id;
  const userId = callbackQuery.from.id;
  const selectedValue = data;

  // Buscar estado do wizard
  const { data: state } = await supabase
    .from("wizard_states")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!state) return;

  // Processar seleção e avançar
  const newStateData = { ...state.data, [currentStep.key]: selectedValue };
  const nextStep = getNextStep(state.step);

  if (nextStep) {
    await setWizardState(supabase, userId, nextStep.step_key, newStateData);
    await sendStepMessage(chatId, nextStep, userId, supabase);
  } else {
    // Wizard completo - salvar transação
    await completeWizard(supabase, userId, chatId, newStateData);
  }
}
```

### Fluxo

1. Usuário clica no botão
2. Callback query chega
3. Valor selecionado é salvo no estado
4. Próximo passo é buscado do banco
5. Mensagem com novo inline keyboard é enviada

## Seção 4: Completando o Wizard

### Função `completeWizard`

```typescript
async function completeWizard(
  supabase: any,
  userId: number,
  chatId: number,
  data: any
): Promise<void> {
  // Buscar ou criar categoria
  let categoryId = null;
  const { data: existingCategory } = await supabase
    .from("categories")
    .select("id")
    .eq("user_id", userId)
    .ilike("name", data.category)
    .single();

  if (existingCategory) {
    categoryId = existingCategory.id;
  } else {
    const { data: newCategory } = await supabase
      .from("categories")
      .insert({ user_id: userId, name: data.category })
      .select("id")
      .single();
    categoryId = newCategory?.id;
  }

  // Buscar grupo
  const { data: group } = await supabase
    .from("groups")
    .select("id")
    .eq("user_id", userId)
    .ilike("name", data.group)
    .single();

  // Inserir transação
  const { error } = await supabase.from("transactions").insert({
    user_id: userId,
    group_id: group?.id,
    category_id: categoryId,
    type: "expense",
    amount: data.amount,
    description: data.category,
    tags: data.tags ? data.tags.split(",").map(t => t.trim()) : [],
    transaction_date: data.date || new Date().toISOString().split("T")[0],
  });

  // Limpar estado do wizard
  await clearWizardState(supabase, userId);

  if (error) {
    await sendTelegramMessage(chatId, "Erro ao registrar. Tente novamente.");
    return;
  }

  // Confirmar
  await sendTelegramMessage(
    chatId,
    `✅ *Despesa registrada!*\n\n` +
    `Valor: R$ ${data.amount.toFixed(2)}\n` +
    `Categoria: ${data.category}\n` +
    `Grupo: ${data.group}\n` +
    `Data: ${data.date || new Date().toISOString().split("T")[0]}`
  );
}
```

### Fluxo completo

1. Usuário envia `/gasto` ou mensagem livre
2. Busca primeiro passo do wizard_steps
3. Envia mensagem com inline keyboard
4. Usuário clica → callback query
5. Valor salvo → próximo passo
6. Repete até completar
7. Salva transação e confirma

## Resumo

- **Tabela `wizard_steps`** define passos do wizard
- **Inline keyboards** para seleções
- **Callback querys** processam cliques
- **Wizard 100% dinâmico** - configurável via banco
