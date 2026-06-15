# Dynamic Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform wizard from text-based to inline keyboard with dynamic steps from database.

**Architecture:** Add `wizard_steps` table, modify Edge Function to use inline keyboards and handle callback queries, make wizard steps configurable via database.

**Tech Stack:** Deno, Supabase Edge Functions, Telegram Bot API, PostgreSQL

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/20260614000001_add_wizard_steps.sql` | Create | Add wizard_steps table with seed data |
| `supabase/functions/bot-core/index.ts` | Modify | Add inline keyboard support, callback query handling |

---

### Task 1: Create Migration for wizard_steps Table

**Files:**
- Create: `supabase/migrations/20260614000001_add_wizard_steps.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Create wizard_steps table
CREATE TABLE wizard_steps (
  id BIGSERIAL PRIMARY KEY,
  wizard_name TEXT NOT NULL,
  step_order INT NOT NULL,
  step_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  input_type TEXT NOT NULL CHECK (input_type IN ('text', 'select', 'date', 'tags')),
  options_source TEXT,
  is_required BOOLEAN DEFAULT TRUE,
  UNIQUE(wizard_name, step_order)
);

-- Insert default steps for 'gasto' wizard
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type, options_source) VALUES
  ('gasto', 1, 'amount', 'Qual o valor?', 'text', NULL),
  ('gasto', 2, 'category', 'Qual categoria?', 'select', 'categories'),
  ('gasto', 3, 'group', 'Qual grupo?', 'select', 'groups'),
  ('gasto', 4, 'date', 'Qual data?', 'date', NULL),
  ('gasto', 5, 'tags', 'Tags? (ex: #trabalho)', 'tags', NULL);

-- Insert default steps for 'receita' wizard
INSERT INTO wizard_steps (wizard_name, step_order, step_key, prompt, input_type, options_source) VALUES
  ('receita', 1, 'amount', 'Qual o valor?', 'text', NULL),
  ('receita', 2, 'category', 'Qual categoria?', 'select', 'categories'),
  ('receita', 3, 'group', 'Qual grupo?', 'select', 'groups'),
  ('receita', 4, 'date', 'Qual data?', 'date', NULL);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON wizard_steps TO service_role;
GRANT USAGE, SELECT ON SEQUENCE wizard_steps_id_seq TO service_role;
```

- [ ] **Step 2: Apply migration locally**

Run: `make dev-db-push`
Expected: Migration applied successfully

- [ ] **Step 3: Verify table exists**

Run: `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "\d wizard_steps"`
Expected: Table with columns id, wizard_name, step_order, step_key, prompt, input_type, options_source, is_required

- [ ] **Step 4: Verify seed data**

Run: `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "SELECT * FROM wizard_steps ORDER BY wizard_name, step_order;"`
Expected: 9 rows (5 for gasto, 4 for receita)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260614000001_add_wizard_steps.sql
git commit -m "feat: add wizard_steps table with default steps"
```

---

### Task 2: Add Inline Keyboard Types and Helper Function

**Files:**
- Modify: `supabase/functions/bot-core/index.ts:11-25` (after interfaces)

- [ ] **Step 1: Add InlineKeyboardButton and InlineKeyboard types**

```typescript
interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

type InlineKeyboard = InlineKeyboardButton[][];
```

- [ ] **Step 2: Add sendTelegramMessageWithKeyboard function**

Add after the `sendTelegramMessage` function (around line 42):

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

- [ ] **Step 3: Test locally**

Run: `make dev-deploy && make dev-test-start`
Expected: Bot responds with /start message (no regression)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/bot-core/index.ts
git commit -m "feat: add inline keyboard types and helper function"
```

---

### Task 3: Add Callback Query Handler

**Files:**
- Modify: `supabase/functions/bot-core/index.ts` (main handler)

- [ ] **Step 1: Add callback_query check in main handler**

Find the main handler (around line 700) and add before the message check:

```typescript
// Handle callback queries (inline keyboard clicks)
if (update.callback_query) {
  await handleCallbackQuery(supabase, update.callback_query);
  return new Response("ok");
}
```

- [ ] **Step 2: Add handleCallbackQuery function**

Add before the `handleGastoWizard` function:

```typescript
async function handleCallbackQuery(
  supabase: any,
  callbackQuery: any
): Promise<void> {
  const { data, message } = callbackQuery;
  const chatId = message.chat.id;
  const userId = callbackQuery.from.id;
  const selectedValue = data;

  // Answer callback query to remove loading state
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  });

  // Get current wizard state
  const { data: state } = await supabase
    .from("wizard_states")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!state) return;

  // Get current step info
  const { data: currentStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", state.step.replace("gasto_", "").replace("receita_", ""))
    .eq("step_key", state.step.split("_").pop())
    .single();

  if (!currentStep) return;

  // Update state with selected value
  const newStateData = { ...state.data, [currentStep.step_key]: selectedValue };

  // Get next step
  const { data: nextStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", currentStep.wizard_name)
    .gt("step_order", currentStep.step_order)
    .order("step_order")
    .limit(1)
    .single();

  if (nextStep) {
    // Update wizard state
    await supabase
      .from("wizard_states")
      .update({
        step: `${nextStep.wizard_name}_${nextStep.step_key}`,
        data: newStateData,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      .eq("user_id", userId);

    // Send next step message
    await sendWizardStepMessage(chatId, nextStep, userId, supabase);
  } else {
    // Wizard complete - save transaction
    await completeWizard(supabase, userId, chatId, newStateData);
  }
}
```

- [ ] **Step 3: Add sendWizardStepMessage function**

Add after the `handleCallbackQuery` function:

```typescript
async function sendWizardStepMessage(
  chatId: number,
  step: any,
  userId: number,
  supabase: any
): Promise<void> {
  if (step.input_type === "select") {
    // Fetch options from database
    const { data: options } = await supabase
      .from(step.options_source)
      .select("name")
      .eq("user_id", userId)
      .order("name");

    if (options && options.length > 0) {
      const keyboard: InlineKeyboard = options.map(opt => [
        { text: opt.name, callback_data: opt.name }
      ]);
      await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
    } else {
      await sendTelegramMessage(chatId, step.prompt + "\n\n(Nenhuma opção disponível. Crie primeiro.)");
    }
  } else if (step.input_type === "date") {
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const keyboard: InlineKeyboard = [
      [{ text: "Hoje", callback_data: today }],
      [{ text: "Ontem", callback_data: yesterday }],
      [{ text: "Outra data", callback_data: "custom_date" }],
    ];
    await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
  } else if (step.input_type === "tags") {
    await sendTelegramMessage(chatId, step.prompt + "\n\nExemplo: #trabalho #casa");
  } else {
    await sendTelegramMessage(chatId, step.prompt);
  }
}
```

- [ ] **Step 4: Test locally**

Run: `make dev-deploy && make dev-test-gasto`
Expected: Bot responds (may show "no options" since we need to create categories first)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/bot-core/index.ts
git commit -m "feat: add callback query handler for inline keyboards"
```

---

### Task 4: Add completeWizard Function

**Files:**
- Modify: `supabase/functions/bot-core/index.ts` (after sendWizardStepMessage)

- [ ] **Step 1: Add completeWizard function**

```typescript
async function completeWizard(
  supabase: any,
  userId: number,
  chatId: number,
  data: any
): Promise<void> {
  // Get or create category
  let categoryId = null;
  if (data.category) {
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
  }

  // Get group
  let groupId = null;
  if (data.group) {
    const { data: group } = await supabase
      .from("groups")
      .select("id")
      .eq("user_id", userId)
      .ilike("name", data.group)
      .single();
    groupId = group?.id;
  }

  // Parse tags
  let tags: string[] = [];
  if (data.tags) {
    tags = data.tags.split(/[\s,]+/).filter(t => t.startsWith("#")).map(t => t.replace("#", ""));
  }

  // Insert transaction
  const { error } = await supabase.from("transactions").insert({
    user_id: userId,
    group_id: groupId,
    category_id: categoryId,
    type: data.amount > 0 ? "expense" : "income",
    amount: Math.abs(data.amount),
    description: data.category,
    tags: tags,
    transaction_date: data.date || new Date().toISOString().split("T")[0],
  });

  // Clear wizard state
  await supabase
    .from("wizard_states")
    .delete()
    .eq("user_id", userId);

  if (error) {
    await sendTelegramMessage(chatId, "Erro ao registrar. Tente novamente.");
    return;
  }

  // Confirm
  const type = data.amount > 0 ? "Despesa" : "Receita";
  await sendTelegramMessage(
    chatId,
    `✅ *${type} registrada!*\n\n` +
    `Valor: R$ ${Math.abs(data.amount).toFixed(2)}\n` +
    `Categoria: ${data.category || "Não definida"}\n` +
    `Grupo: ${data.group || "Pessoal"}\n` +
    `Data: ${data.date || new Date().toISOString().split("T")[0]}` +
    (tags.length > 0 ? `\nTags: ${tags.map(t => `#${t}`).join(" ")}` : "")
  );
}
```

- [ ] **Step 2: Test locally**

Run: `make dev-deploy && make dev-test-gasto`
Expected: Bot processes the command

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/bot-core/index.ts
git commit -m "feat: add completeWizard function for saving transactions"
```

---

### Task 5: Modify handleGastoWizard to Use Dynamic Steps

**Files:**
- Modify: `supabase/functions/bot-core/index.ts:294-449` (handleGastoWizard function)

- [ ] **Step 1: Replace handleGastoWizard function**

```typescript
async function handleGastoWizard(
  supabase: any,
  userId: number,
  chatId: number,
  state: WizardState,
  input: string
): Promise<void> {
  // Get current step info
  const stepKey = state.step.replace("gasto_", "");
  const { data: currentStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", "gasto")
    .eq("step_key", stepKey)
    .single();

  if (!currentStep) {
    await sendTelegramMessage(chatId, "Erro ao processar wizard.");
    return;
  }

  // Validate and store input
  let value = input;

  if (currentStep.input_type === "text" && stepKey === "amount") {
    const amount = parseFloat(input);
    if (isNaN(amount) || amount <= 0) {
      await sendTelegramMessage(chatId, "Por favor, informe um valor válido.");
      return;
    }
    value = amount.toString();
  }

  // Get next step
  const { data: nextStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", "gasto")
    .gt("step_order", currentStep.step_order)
    .order("step_order")
    .limit(1)
    .single();

  if (nextStep) {
    // Update state and send next step
    await setWizardState(supabase, userId, `gasto_${nextStep.step_key}`, {
      ...state.data,
      [stepKey]: value,
    });
    await sendWizardStepMessage(chatId, nextStep, userId, supabase);
  } else {
    // Wizard complete
    await completeWizard(supabase, userId, chatId, {
      ...state.data,
      [stepKey]: value,
    });
  }
}
```

- [ ] **Step 2: Test locally**

Run: `make dev-deploy && make dev-test-gasto`
Expected: Bot asks for amount, then category with inline keyboard

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/bot-core/index.ts
git commit -m "refactor: use dynamic wizard steps from database"
```

---

### Task 6: Deploy to Production

**Files:**
- None (deployment only)

- [ ] **Step 1: Apply migration to production**

Run: `make prod-db-push`
Expected: Migration applied successfully

- [ ] **Step 2: Deploy Edge Function**

Run: `make prod-deploy`
Expected: Function deployed successfully

- [ ] **Step 3: Test in Telegram**

Send `/gasto` to bot
Expected: Bot asks for amount, then shows inline keyboard for category selection

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: production deployment adjustments"
```

---

## Summary

| Task | Description | Status |
|------|-------------|--------|
| 1 | Create wizard_steps table migration | |
| 2 | Add inline keyboard types and helper | |
| 3 | Add callback query handler | |
| 4 | Add completeWizard function | |
| 5 | Modify handleGastoWizard to use dynamic steps | |
| 6 | Deploy to production | |
