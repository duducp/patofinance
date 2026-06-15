import { WizardState } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { getOrCreateCategory, getOrCreateGroup } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, parseDateBR, getTodayISOBR } from "../utils/formatting.ts";

export async function getWizardState(supabase: any, userId: number): Promise<WizardState | null> {
  const { data } = await supabase
    .from("wizard_states")
    .select("step, data, expires_at")
    .eq("user_id", userId)
    .single();
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) {
    await supabase.from("wizard_states").delete().eq("user_id", userId);
    return null;
  }
  return { step: data.step, data: data.data || {} };
}

export async function setWizardState(
  supabase: any,
  userId: number,
  step: string,
  data: Record<string, any> = {}
): Promise<void> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data: existing } = await supabase
    .from("wizard_states")
    .select("user_id")
    .eq("user_id", userId)
    .single();
  if (existing) {
    await supabase
      .from("wizard_states")
      .update({ step, data, expires_at: expiresAt })
      .eq("user_id", userId);
  } else {
    await supabase
      .from("wizard_states")
      .insert({ user_id: userId, step, data, expires_at: expiresAt });
  }
}

export async function clearWizardState(supabase: any, userId: number): Promise<void> {
  await supabase.from("wizard_states").delete().eq("user_id", userId);
}

export async function sendWizardStepMessage(
  chatId: number,
  step: any,
  userId: number,
  supabase: any
): Promise<void> {
  if (step.input_type === "select") {
    const { data: options } = await supabase
      .from("wizard_step_options")
      .select("value, label")
      .eq("step_id", step.id)
      .order("sort_order");
    if (options && options.length > 0) {
      const keyboard = options.map((o: any) => [{ text: o.label, callback_data: o.value }]);
      await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
    } else {
      await sendTelegramMessage(chatId, step.prompt);
    }
  } else if (step.step_key === "date") {
    const today = getTodayISOBR();
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const keyboard = [
      [{ text: "📅 Hoje", callback_data: today }],
      [{ text: "📅 Ontem", callback_data: yesterday }],
      [{ text: "📆 Outra data", callback_data: "custom_date" }],
    ];
    await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
  } else if (step.step_key === "tags") {
    await sendTelegramMessage(chatId, step.prompt);
  } else {
    await sendTelegramMessage(chatId, step.prompt);
  }
}

export async function completeWizard(
  supabase: any,
  userId: number,
  chatId: number,
  data: Record<string, any>
): Promise<void> {
  await clearWizardState(supabase, userId);
  const type = data.type || "expense";
  const amount = parseFloat(data.amount);
  if (isNaN(amount) || amount <= 0) {
    await sendTelegramMessage(chatId, "❌ Valor inválido. Tente novamente.");
    return;
  }
  const categoryId = data.category ? await getOrCreateCategory(supabase, userId, data.category) : null;
  const groupId = await getOrCreateGroup(supabase, userId, data.group || null);
  const tags = data.tags
    ? data.tags.split(" ").filter((t: string) => t).map((t: string) => t.startsWith("#") ? t : `#${t}`)
    : [];
  const date = data.date || getTodayISOBR();
  const { error } = await supabase.from("transactions").insert({
    user_id: userId,
    group_id: groupId,
    category_id: categoryId,
    type,
    amount,
    description: data.category || "",
    tags,
    transaction_date: date,
  });
  if (error) {
    await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao registrar. Tente novamente.");
    return;
  }
  const typeName = type === "expense" ? "Despesa" : "Receita";
  await sendTelegramMessage(
    chatId,
    `✅ *${typeName} registrada com sucesso!*\n\n` +
    `💰 Valor: *${formatCurrencyBR(amount)}*\n` +
    `🏷️ Categoria: ${data.category || "Não definida"}\n` +
    `📁 Grupo: ${data.group || "Pessoal"}\n` +
    `📅 Data: ${formatDateBR(date)}` +
    (tags.length > 0 ? `\n🔖 Tags: ${tags.join(" ")}` : "")
  );
}

export async function handleTransactionWizard(
  type: "expense" | "income",
  supabase: any,
  userId: number,
  chatId: number,
  state: WizardState,
  input: string
): Promise<void> {
  const wizardName = type === "expense" ? "gasto" : "receita";
  const prefix = `${wizardName}_`;

  if (state.step === `${wizardName}_custom_date`) {
    const parsed = parseDateBR(input);
    if (!parsed) {
      await sendTelegramMessage(chatId, "Formato inválido. Use DD/MM/YYYY (ex: 15/01/2024)");
      return;
    }
    if (type === "expense") {
      await setWizardState(supabase, userId, `${wizardName}_tags`, { ...state.data, date: parsed });
      const { data: tagsStep } = await supabase
        .from("wizard_steps")
        .select("*")
        .eq("wizard_name", wizardName)
        .eq("step_key", "tags")
        .single();
      if (tagsStep) {
        await sendWizardStepMessage(chatId, tagsStep, userId, supabase);
      } else {
        await completeWizard(supabase, userId, chatId, { ...state.data, date: parsed });
      }
    } else {
      await completeWizard(supabase, userId, chatId, { ...state.data, date: parsed, type: "income" });
    }
    return;
  }

  const stepKey = state.step.replace(prefix, "");
  const { data: currentStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", wizardName)
    .eq("step_key", stepKey)
    .single();

  if (!currentStep) {
    const cmd = type === "expense" ? "/gasto" : "/receita";
    await sendTelegramMessage(chatId, `❌ Ops! Algo deu errado com o wizard. Tente novamente com ${cmd}`);
    return;
  }

  let value = input;
  if (currentStep.input_type === "text" && stepKey === "amount") {
    const amount = parseFloat(input.replace(",", "."));
    if (isNaN(amount) || amount <= 0) {
      await sendTelegramMessage(chatId, "Por favor, informe um valor válido (ex: 50,00 ou 50)");
      return;
    }
    value = amount.toString();
  }

  const { data: nextStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", wizardName)
    .gt("step_order", currentStep.step_order)
    .order("step_order")
    .limit(1)
    .single();

  if (nextStep) {
    await setWizardState(supabase, userId, `${wizardName}_${nextStep.step_key}`, {
      ...state.data,
      [stepKey]: value,
    });
    await sendWizardStepMessage(chatId, nextStep, userId, supabase);
  } else {
    const finalData = type === "income"
      ? { ...state.data, [stepKey]: value, type: "income" }
      : { ...state.data, [stepKey]: value };
    await completeWizard(supabase, userId, chatId, finalData);
  }
}
