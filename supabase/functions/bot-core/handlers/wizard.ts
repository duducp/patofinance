import { WizardState } from "../types/index.ts";
import { InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { getOrCreateCategory, getOrCreateGroup, sendSimilarityWarning, getAllUserTags, deduplicateByNormalizedName, userOrNullFilter, typeOrNullFilter } from "../services/database.ts";
import { parseDateBR, getTodayISOBR } from "../utils/formatting.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { sendTransactionSuccess } from "./queries.ts";
import { buildKeyboardGrid } from "../utils/keyboard.ts";

export async function getWizardState(supabase: any, userId: number): Promise<WizardState | null> {
  const { data } = await supabase
    .from("wizard_states")
    .select("step, data, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data || !data.step) return null;
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
    .maybeSingle();
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
  sessionSeq: number,
  messageId?: number
): Promise<void> {
  if (step.step_key === "category") {
    const wizardType = step.wizard_name === "receita" ? "income" : step.wizard_name === "gasto" ? "expense" : undefined;
    const keyboard = await buildCategoryKeyboard(supabase, userId, sessionSeq, {
      callbackPrefix: "wiz_cat_",
      wizardType,
      extraButtons: [[{ text: "✏️ Nova categoria", callback_data: addSession("wizard_new_category", sessionSeq) }]],
    });
    await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
  } else if (step.step_key === "group") {
    const keyboard = await buildGroupKeyboard(supabase, userId, sessionSeq, {
      callbackPrefix: "wiz_grp_",
      extraButtons: [[{ text: "✏️ Novo grupo", callback_data: addSession("wizard_new_group", sessionSeq) }]],
    });
    await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
  } else if (step.step_key === "tags") {
    const { keyboard, currentTags } = await buildTagKeyboard(supabase, userId, sessionSeq, {
      togglePrefix: "wiz_tag_",
      extraButtons: [
        [
          { text: "✅ Concluir", callback_data: addSession("wiz_done_tags", sessionSeq) },
          { text: "⏭️ Pular", callback_data: addSession("wizard_skip_tags", sessionSeq) },
        ],
      ],
    });

    let prompt = step.prompt;
    if (currentTags.length > 0) {
      prompt += `\n\n✅ Selecionadas: ${currentTags.join(" ")}`;
    } else {
      prompt += "\n\n💡 Clique nas tags para selecionar ou digite uma nova.";
    }

    if (messageId) {
      await editTelegramMessageWithKeyboard(chatId, messageId, prompt, keyboard);
    } else {
      await sendTelegramMessageWithKeyboard(chatId, prompt, keyboard);
    }
  } else if (step.step_key === "description") {
    const keyboard: InlineKeyboard = [
      [{ text: "⏭️ Pular (opcional)", callback_data: addSession("wizard_skip_description", sessionSeq) }],
    ];
    await sendTelegramMessageWithKeyboard(chatId, step.prompt, keyboard);
  } else if (step.step_key === "date") {
    const keyboard = buildDateKeyboard({
      todayCallback: (date) => addSession(`wiz_date_${date}`, sessionSeq),
      yesterdayCallback: (date) => addSession(`wiz_date_${date}`, sessionSeq),
      customCallback: addSession("custom_date", sessionSeq),
    });
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

  const categoryId = data.category ? await getOrCreateCategory(supabase, userId, data.category, type) : null;

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
  const desc = data.description || data.category || "";
  const { data: inserted, error } = await supabase
    .from("transactions")
    .insert({
      user_id: userId,
      group_id: groupId,
      category_id: categoryId,
      type,
      amount,
      description: desc,
      tags,
      transaction_date: date,
    })
    .select("id")
    .single();
  if (error) {
    await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao registrar. Tente novamente.");
    return;
  }
  const txId = inserted?.id;
  await sendTransactionSuccess(supabase, chatId, userId, type, {
    amount,
    category: data.category,
    group: data.group,
    date,
    description: data.description,
    tags,
    transactionId: txId,
  });
}

/**
 * Toggle a tag in the wizard state and return the new tags array.
 * Shared by both edit_tag_tog_ and wiz_tag_ handlers.
 */
export async function toggleTagInWizardState(
  supabase: any,
  userId: number,
  tag: string
): Promise<string[]> {
  const { data: state } = await supabase
    .from("wizard_states")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();

  const currentTags: string[] = state?.data?.tags
    ? (Array.isArray(state.data.tags) ? state.data.tags : [state.data.tags])
    : [];

  const newTags = currentTags.includes(tag)
    ? currentTags.filter((t: string) => t !== tag)
    : [...currentTags, tag];

  await supabase.from("wizard_states").update({
    data: { ...state?.data, tags: newTags },
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  }).eq("user_id", userId);

  return newTags;
}

/**
 * Build a tag selection keyboard with ✅ indicators for selected tags.
 * Reads current tags from wizard state. Returns the keyboard and current tags.
 */
export async function buildTagKeyboard(
  supabase: any,
  userId: number,
  sessionSeq: number,
  options: {
    togglePrefix: string;
    extraButtons?: { text: string; callback_data: string }[][];
  },
): Promise<{ keyboard: InlineKeyboard; currentTags: string[] }> {
  const { data: state } = await supabase
    .from("wizard_states")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();

  const currentTags: string[] = state?.data?.tags
    ? (Array.isArray(state.data.tags) ? state.data.tags : [state.data.tags])
    : [];

  const allTags = await getAllUserTags(supabase, userId);
  const tagSet = new Set(allTags.map((t: string) => t.startsWith("#") ? t : `#${t}`));

  const keyboard: InlineKeyboard = [];
  if (tagSet.size > 0) {
    const grid = buildKeyboardGrid(
      [...tagSet],
      (tag) => ({
        text: currentTags.includes(tag) ? `✅ ${tag}` : tag,
        callback_data: addSession(`${options.togglePrefix}${tag}`, sessionSeq),
      }),
      2,
    );
    keyboard.push(...grid);
  }

  if (options.extraButtons) {
    for (const row of options.extraButtons) {
      keyboard.push(row);
    }
  }

  return { keyboard, currentTags };
}

/**
 * Build a category selection keyboard grid.
 * Queries categories, deduplicates by normalized_name, optionally filters by type.
 */
export async function buildCategoryKeyboard(
  supabase: any,
  userId: number,
  sessionSeq: number,
  options: {
    callbackPrefix: string;
    extraButtons?: { text: string; callback_data: string }[][];
    wizardType?: "expense" | "income";
  },
): Promise<InlineKeyboard> {
  let catQuery = supabase
    .from("categories")
    .select("name, normalized_name")
    .or(userOrNullFilter(userId))
    .order("user_id", { ascending: false, nullsFirst: false })
    .order("name");
  if (options.wizardType) {
    catQuery = catQuery.or(typeOrNullFilter(options.wizardType));
  }
  const { data: categories } = await catQuery;
  const unique = deduplicateByNormalizedName(categories || []);

  const keyboard: InlineKeyboard = [];
  if (unique.length > 0) {
    const grid = buildKeyboardGrid(unique, (c) => ({
      text: c.name,
      callback_data: addSession(`${options.callbackPrefix}${c.name}`, sessionSeq),
    }), 3);
    keyboard.push(...grid);
  }

  if (options.extraButtons) {
    for (const row of options.extraButtons) {
      keyboard.push(row);
    }
  }

  return keyboard;
}

/**
 * Build a group selection keyboard grid.
 * Queries groups for the user, builds grid with callback prefix.
 */
export async function buildGroupKeyboard(
  supabase: any,
  userId: number,
  sessionSeq: number,
  options: {
    callbackPrefix: string;
    extraButtons?: { text: string; callback_data: string }[][];
  },
): Promise<InlineKeyboard> {
  const { data: groups } = await supabase
    .from("groups")
    .select("name")
    .eq("user_id", userId)
    .order("name");

  const keyboard: InlineKeyboard = [];
  if (groups && groups.length > 0) {
    const grid = buildKeyboardGrid(groups, (g) => ({
      text: g.name,
      callback_data: addSession(`${options.callbackPrefix}${g.name}`, sessionSeq),
    }), 3);
    keyboard.push(...grid);
  }

  if (options.extraButtons) {
    for (const row of options.extraButtons) {
      keyboard.push(row);
    }
  }

  return keyboard;
}

/**
 * Build a date selection keyboard (today / yesterday / other date).
 * The caller provides callback builders for each option.
 */
export function buildDateKeyboard(
  options: {
    todayCallback: (date: string) => string;
    yesterdayCallback: (date: string) => string;
    customCallback: string;
  },
): InlineKeyboard {
  const today = getTodayISOBR();
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  return [
    [
      { text: "📅 Hoje", callback_data: options.todayCallback(today) },
      { text: "📅 Ontem", callback_data: options.yesterdayCallback(yesterday) },
    ],
    [{ text: "📆 Outra data", callback_data: options.customCallback }],
  ];
}

/**
 * Build a delete confirmation keyboard (✅ Sim, excluir / ❌ Não, manter).
 * Shared by showDeleteConfirmation and handleEntityDeletePrompt.
 */
export function buildDeleteConfirmKeyboard(
  confirmCallback: string,
  cancelCallback: string,
): InlineKeyboard {
  return [
    [
      { text: "✅ Sim, excluir", callback_data: confirmCallback },
      { text: "❌ Não, manter", callback_data: cancelCallback },
    ],
  ];
}

/**
 * Handle a wizard skip action: set the current step's value to empty and advance.
 * Shared by wizard_skip_description and wizard_skip_tags handlers.
 */
export async function handleWizardSkip(
  supabase: any,
  userId: number,
  chatId: number,
  sessionSeq: number,
): Promise<void> {
  const wizard = await getCurrentWizardStep(supabase, userId);
  if (!wizard) return;
  const newStateData = { ...wizard.state.data, [wizard.currentStep.step_key]: "" };
  await advanceWizardToNextStep(supabase, userId, chatId, wizard.currentStep, sessionSeq, newStateData);
}

export async function getCurrentWizardStep(
  supabase: any,
  userId: number
): Promise<{ state: any; currentStep: any } | null> {
  const { data: state } = await supabase.from("wizard_states").select("*").eq("user_id", userId).maybeSingle();
  if (!state) return null;
  const underscoreIndex = state.step.indexOf("_");
  const wizardName = state.step.substring(0, underscoreIndex);
  const stepKey = state.step.substring(underscoreIndex + 1);
  const { data: currentStep } = await supabase.from("wizard_steps").select("*").eq("wizard_name", wizardName).eq("step_key", stepKey).maybeSingle();
  if (!currentStep) return null;
  return { state, currentStep };
}

export async function advanceWizardToNextStep(
  supabase: any,
  userId: number,
  chatId: number,
  currentStep: any,
  sessionSeq: number,
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
    await sendWizardStepMessage(chatId, nextStep, userId, supabase, sessionSeq);
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
      const tagsSessionSeq = await getSessionSeq(supabase, userId);
      await sendWizardStepMessage(chatId, tagsStep, userId, supabase, tagsSessionSeq);
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
    const tagsSessionSeq = await getSessionSeq(supabase, userId);
    await sendWizardStepMessage(chatId, currentStep, userId, supabase, tagsSessionSeq);
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
    const nextSessionSeq = await getSessionSeq(supabase, userId);
    await sendWizardStepMessage(chatId, nextStep, userId, supabase, nextSessionSeq);
  } else {
    const finalData = type === "income"
      ? { ...state.data, [stepKey]: value, type: "income" }
      : { ...state.data, [stepKey]: value };
    await completeWizard(supabase, userId, chatId, finalData);
  }
}
