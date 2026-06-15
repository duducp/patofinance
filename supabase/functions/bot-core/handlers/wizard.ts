import { WizardState } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { getOrCreateCategory, getOrCreateGroup, sendSimilarityWarning, getAllUserTags } from "../services/database.ts";
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
  supabase: any,
  messageId?: number
): Promise<void> {
  if (step.step_key === "category") {
    // Filter categories by transaction type based on wizard
    const wizardType = step.wizard_name === "receita" ? "income" : step.wizard_name === "gasto" ? "expense" : undefined;
    let catQuery = supabase
      .from("categories")
      .select("name")
      .eq("user_id", userId);
    if (wizardType) {
      catQuery = catQuery.or(`transaction_type.eq.${wizardType},transaction_type.is.null`);
    }
    const { data: categories } = await catQuery.order("name");
    const keyboard: { text: string; callback_data: string }[][] = [];
    if (categories && categories.length > 0) {
      let row: { text: string; callback_data: string }[] = [];
      for (const c of categories) {
        row.push({ text: c.name, callback_data: c.name });
        if (row.length === 3) {
          keyboard.push(row);
          row = [];
        }
      }
      if (row.length > 0) keyboard.push(row);
    }
    keyboard.push([{ text: "✏️ Nova categoria", callback_data: "wizard_new_category" }]);
    await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
  } else if (step.step_key === "group") {
    const { data: groups } = await supabase
      .from("groups")
      .select("name")
      .eq("user_id", userId)
      .order("name");
    const keyboard: { text: string; callback_data: string }[][] = [];
    if (groups && groups.length > 0) {
      let row: { text: string; callback_data: string }[] = [];
      for (const g of groups) {
        row.push({ text: g.name, callback_data: g.name });
        if (row.length === 3) {
          keyboard.push(row);
          row = [];
        }
      }
      if (row.length > 0) keyboard.push(row);
    }
    keyboard.push([{ text: "✏️ Novo grupo", callback_data: "wizard_new_group" }]);
    await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
  } else if (step.step_key === "tags") {
    // Get current selected tags from wizard state
    const { data: wizardData } = await supabase
      .from("wizard_states")
      .select("data")
      .eq("user_id", userId)
      .single();
    const currentTags: string[] = wizardData?.data?.tags
      ? (Array.isArray(wizardData.data.tags) ? wizardData.data.tags : [wizardData.data.tags])
      : [];

    const allTags = await getAllUserTags(supabase, userId);
    const tagSet = new Set(allTags.map((t: string) => t.startsWith("#") ? t : `#${t}`));

    let prompt = step.prompt;
    if (currentTags.length > 0) {
      prompt += `\n\n✅ Selecionadas: ${currentTags.join(" ")}`;
    } else {
      prompt += "\n\n💡 Clique nas tags para selecionar ou digite uma nova.";
    }

    const keyboard: { text: string; callback_data: string }[][] = [];
    if (tagSet.size > 0) {
      let row: { text: string; callback_data: string }[] = [];
      for (const tag of tagSet) {
        const isSelected = currentTags.includes(tag);
        row.push({ text: isSelected ? `✅ ${tag}` : tag, callback_data: `wiz_tag_${tag}` });
        if (row.length === 2) {
          keyboard.push(row);
          row = [];
        }
      }
      if (row.length > 0) keyboard.push(row);
    }
    keyboard.push([
      { text: "✅ Concluir", callback_data: "wiz_done_tags" },
      { text: "⏭️ Pular", callback_data: "wizard_skip_tags" },
    ]);
    if (messageId) {
      await editTelegramMessageWithKeyboard(chatId, messageId, prompt, keyboard);
    } else {
      await sendTelegramMessageWithKeyboard(chatId, prompt, keyboard);
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
  } else if (step.input_type === "select") {
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
  // Check for similar existing categories
  if (data.category) {
    await sendSimilarityWarning(supabase, userId, chatId, "category", data.category);
  }

  const categoryId = data.category ? await getOrCreateCategory(supabase, userId, data.category) : null;

  // Check for similar existing groups
  if (data.group) {
    await sendSimilarityWarning(supabase, userId, chatId, "group", data.group);
  }

  const groupId = await getOrCreateGroup(supabase, userId, data.group || null);
  const tags = Array.isArray(data.tags)
    ? data.tags.map((t: string) => t.startsWith("#") ? t : `#${t}`).filter((t: string) => t)
    : data.tags
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

export async function getCurrentWizardStep(
  supabase: any,
  userId: number
): Promise<{ state: any; currentStep: any } | null> {
  const { data: state } = await supabase.from("wizard_states").select("*").eq("user_id", userId).single();
  if (!state) return null;
  const underscoreIndex = state.step.indexOf("_");
  const wizardName = state.step.substring(0, underscoreIndex);
  const stepKey = state.step.substring(underscoreIndex + 1);
  const { data: currentStep } = await supabase.from("wizard_steps").select("*").eq("wizard_name", wizardName).eq("step_key", stepKey).single();
  if (!currentStep) return null;
  return { state, currentStep };
}

export async function advanceWizardToNextStep(
  supabase: any,
  userId: number,
  chatId: number,
  currentStep: any,
  newStateData: Record<string, any>
): Promise<void> {
  const { data: nextStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", currentStep.wizard_name)
    .gt("step_order", currentStep.step_order)
    .order("step_order")
    .limit(1)
    .single();

  if (nextStep) {
    await supabase.from("wizard_states").update({
      step: `${nextStep.wizard_name}_${nextStep.step_key}`,
      data: newStateData,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", userId);
    await sendWizardStepMessage(chatId, nextStep, userId, supabase);
  } else {
    await completeWizard(supabase, userId, chatId, newStateData);
  }
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
    await setWizardState(supabase, userId, `${wizardName}_tags`, { ...state.data, date: parsed, type });
    const { data: tagsStep } = await supabase
      .from("wizard_steps")
      .select("*")
      .eq("wizard_name", wizardName)
      .eq("step_key", "tags")
      .single();
    if (tagsStep) {
      await sendWizardStepMessage(chatId, tagsStep, userId, supabase);
    } else {
      await completeWizard(supabase, userId, chatId, { ...state.data, date: parsed, type });
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
    const cmd = type === "expense" ? "/despesa" : "/receita";
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

  // For tags step, accumulate instead of replace
  if (stepKey === "tags") {
    const currentTags: string[] = state.data?.tags
      ? (Array.isArray(state.data.tags) ? state.data.tags : [state.data.tags])
      : [];
    const newTags = input.split(" ").filter((t: string) => t.trim());
    const formattedTags = newTags.map((t: string) => t.startsWith("#") ? t : `#${t}`);
    const accumulatedTags = [...currentTags, ...formattedTags];

    // Check for similar existing tags
    for (const tag of newTags) {
      await sendSimilarityWarning(supabase, userId, chatId, "tag", tag);
    }

    await setWizardState(supabase, userId, state.step, {
      ...state.data,
      tags: accumulatedTags,
    });
    await sendWizardStepMessage(chatId, currentStep, userId, supabase);
    return;
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
