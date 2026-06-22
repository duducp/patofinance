import { WizardState } from "../types/index.ts";
import { InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard, deleteTelegramMessage } from "../services/telegram.ts";
import { getOrCreateCategory, getOrCreateGroup, sendSimilarityWarning, getAllUserTags, deduplicateByNormalizedName, userOrNullFilter, typeOrNullFilter, getOrCreateUncategorizedCategory, createRecurrence } from "../services/database.ts";
import { parseDateBR, getTodayISOBR, formatCurrencyBR, formatDateBR, sanitizeMarkdown } from "../utils/formatting.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { sendTransactionSuccess } from "./queries.ts";
import { buildKeyboardGrid } from "../utils/keyboard.ts";

// ========== Shared Constants ==========

/** Simple frequency type labels (without detail). Used by edit flows. */
export const FREQ_LABELS: Record<string, string> = {
  daily: "Diária",
  weekly: "Semanal",
  monthly: "Mensal",
  annual: "Anual",
  every_x_days: "A cada X dias",
};

const DAYS_OF_WEEK = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

// ========== State Management ==========

/**
 * Read the current wizard state for a user.
 * Returns null if no state exists or if it has expired (auto-clears expired states).
 */
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

/**
 * Create or update wizard state for a user with a 10-minute expiry.
 * Upserts: inserts if no state exists, updates if it does.
 */
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

// ========== Internal Helpers ==========

/**
 * Store a messageId reference in the wizard state (used for editing prompts in-place).
 */
async function storePromptMessageId(
  supabase: any,
  userId: number,
  key: string,
  messageId: number
): Promise<void> {
  const { data: state } = await supabase
    .from("wizard_states")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (state) {
    await supabase.from("wizard_states").update({
      data: { ...state.data, [key]: messageId },
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", userId);
  }
}

/**
 * Query the next wizard step after the current one.
 */
async function getNextWizardStep(
  supabase: any,
  wizardName: string,
  currentStepOrder: number
): Promise<any> {
  const { data: nextStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", wizardName)
    .gt("step_order", currentStepOrder)
    .order("step_order")
    .limit(1)
    .maybeSingle();
  return nextStep;
}

/**
 * Advance wizard with visual confirmation: edit prompt, delete user msg,
 * set state, send next step. Shared across all text-input steps.
 */
async function advanceWithConfirmation(
  supabase: any,
  userId: number,
  chatId: number,
  wizardName: string,
  currentStep: any,
  state: WizardState,
  stepKey: string,
  value: string,
  confirmText: string | null,
  promptMessageId: number | undefined,
  userMessageId: number | undefined,
  completeFn: (supabase: any, userId: number, chatId: number, data: Record<string, any>) => Promise<void>,
): Promise<void> {
  const nextStep = await getNextWizardStep(supabase, wizardName, currentStep.step_order);
  if (nextStep) {
    await setWizardState(supabase, userId, `${wizardName}_${nextStep.step_key}`, {
      ...state.data,
      [stepKey]: value,
    });
    if (confirmText && promptMessageId) {
      await editTelegramMessageWithKeyboard(chatId, promptMessageId, confirmText, []);
    }
    if (userMessageId) {
      await deleteTelegramMessage(chatId, userMessageId);
    }
    const nextSessionSeq = await getSessionSeq(supabase, userId);
    await sendWizardStepMessage(chatId, nextStep, userId, supabase, nextSessionSeq);
  } else {
    await completeFn(supabase, userId, chatId, {
      ...state.data,
      [stepKey]: value,
    });
  }
}

/**
 * Build a labeled confirmation string for a freq detail step.
 */
function buildFreqDetailConfirm(freqType: string, day: number, month?: number): string {
  if (freqType === "every_x_days") return `✅ 🔄 Frequência: A cada ${day} dias`;
  if (freqType === "monthly") return `✅ 🔄 Frequência: Mensal (dia ${day})`;
  if (freqType === "annual") {
    return `✅ 🔄 Frequência: Anual (${day} de ${MONTHS[(month || 1) - 1]})`;
  }
  return "";
}

/**
 * After frequency detail input, advance to tags step or complete.
 */
async function advanceFreqDetailToTags(
  supabase: any,
  userId: number,
  chatId: number,
  state: WizardState,
  extraData: Record<string, any>,
  freqDetailPromptMessageId: number | undefined,
  userMessageId: number | undefined,
): Promise<void> {
  if (freqDetailPromptMessageId && extraData._confirmText) {
    await editTelegramMessageWithKeyboard(chatId, freqDetailPromptMessageId, extraData._confirmText, []);
  }
  if (userMessageId) {
    await deleteTelegramMessage(chatId, userMessageId);
  }
  delete extraData._confirmText;

  await setWizardState(supabase, userId, "recorrencia_tags", {
    ...state.data,
    ...extraData,
  });
  const { data: tagsStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", "recorrencia")
    .eq("step_key", "tags")
    .single();
  if (tagsStep) {
    const seq = await getSessionSeq(supabase, userId);
    await sendWizardStepMessage(chatId, tagsStep, userId, supabase, seq);
  } else {
    await completeRecurrenceWizard(supabase, userId, chatId, {
      ...state.data,
      ...extraData,
    });
  }
}

// ========== Step Senders ==========

/**
 * Send a new wizard step message or edit an existing one, then store the message ID
 * for future editing if this is a new message.
 * Handles both keyboard and text-only prompts.
 */
async function sendOrEditStep(
  chatId: number,
  messageId: number | undefined,
  prompt: string,
  keyboard: InlineKeyboard,
  supabase: any,
  userId: number,
  storeKey?: string,
): Promise<void> {
  const sentMessageId = messageId
    ? (await editTelegramMessageWithKeyboard(chatId, messageId, prompt, keyboard), null)
    : keyboard.length > 0
      ? await sendTelegramMessageWithKeyboard(chatId, prompt, keyboard)
      : await sendTelegramMessage(chatId, prompt);
  if (sentMessageId && storeKey) {
    await storePromptMessageId(supabase, userId, storeKey, sentMessageId);
  }
}

async function sendCategoryStep(
  chatId: number, step: any, userId: number, supabase: any, sessionSeq: number, messageId?: number
): Promise<void> {
  const wizardType = step.wizard_name === "receita" ? "income" : step.wizard_name === "gasto" ? "expense" : undefined;
  const keyboard = await buildCategoryKeyboard(supabase, userId, sessionSeq, {
    callbackPrefix: "wiz_category_",
    wizardType,
    extraButtons: [[{ text: "✏️ Nova categoria", callback_data: addSession("wizard_new_category", sessionSeq) }]],
  });
  await sendOrEditStep(chatId, messageId, step.prompt, keyboard, supabase, userId, "_categoryPromptMessageId");
}

async function sendGroupStep(
  chatId: number, step: any, userId: number, supabase: any, sessionSeq: number, messageId?: number
): Promise<void> {
  const keyboard = await buildGroupKeyboard(supabase, userId, sessionSeq, {
    callbackPrefix: "wiz_group_",
    extraButtons: [[{ text: "✏️ Novo grupo", callback_data: addSession("wizard_new_group", sessionSeq) }]],
  });
  await sendOrEditStep(chatId, messageId, step.prompt, keyboard, supabase, userId, "_groupPromptMessageId");
}

async function sendTagsStep(
  chatId: number, step: any, userId: number, supabase: any, sessionSeq: number, messageId?: number
): Promise<void> {
  const { keyboard, currentTags, hasExistingTags } = await buildTagKeyboard(supabase, userId, sessionSeq, {
    togglePrefix: "wiz_tag_",
  });

  // Add accumulated tags (typed by user) that aren't in DB yet as toggle buttons
  // Check by comparing against existing button text (stripping ✅ prefix)
  if (currentTags.length > 0) {
    const keyboardTags = new Set<string>();
    for (const row of keyboard) {
      for (const btn of row) {
        keyboardTags.add(btn.text.replace("✅ ", ""));
      }
    }
    for (const tag of currentTags) {
      if (!keyboardTags.has(tag)) {
        keyboard.push([{
          text: `✅ ${tag}`,
          callback_data: addSession(`wiz_tag_${tag}`, sessionSeq),
        }]);
      }
    }
  }

  const hasContent = hasExistingTags || currentTags.length > 0;

  if (hasContent) {
    keyboard.push([
      { text: "✅ Concluir", callback_data: addSession("wiz_done_tags", sessionSeq) },
      { text: "⏭️ Pular", callback_data: addSession("wizard_skip_tags", sessionSeq) },
    ]);
  } else {
    keyboard.push([
      { text: "⏭️ Pular", callback_data: addSession("wizard_skip_tags", sessionSeq) },
    ]);
  }

  let prompt = step.prompt;
  if (hasContent) {
    prompt += "\n\n💡 Clique nas tags para alternar ou digite uma nova.";
  } else {
    prompt += "\n\n💡 Digite uma ou mais tags para criar.\nExemplo: `#mercado #alimentacao`";
  }

  await sendOrEditStep(chatId, messageId, prompt, keyboard, supabase, userId, "_tagsPromptMessageId");
}

async function sendDescriptionStep(
  chatId: number, step: any, userId: number, supabase: any, sessionSeq: number, messageId?: number
): Promise<void> {
  const keyboard: InlineKeyboard = [
    [{ text: "⏭️ Pular", callback_data: addSession("wizard_skip_description", sessionSeq) }],
  ];
  await sendOrEditStep(chatId, messageId, step.prompt, keyboard, supabase, userId, "_descPromptMessageId");
}

async function sendDateStep(
  chatId: number, step: any, _userId: number, supabase: any, sessionSeq: number, messageId?: number, prefix = "wiz_date_"
): Promise<void> {
  const keyboard = buildDateKeyboard({
    todayCallback: (date) => addSession(`${prefix}${date}`, sessionSeq),
    yesterdayCallback: (date) => addSession(`${prefix}${date}`, sessionSeq),
    customCallback: addSession("custom_date", sessionSeq),
  });
  await sendOrEditStep(chatId, messageId, step.prompt, keyboard, supabase, _userId);
}

async function sendTypeStep(
  chatId: number, step: any, _userId: number, _supabase: any, sessionSeq: number, messageId?: number
): Promise<void> {
  const keyboard: InlineKeyboard = [
    [{ text: "💸 Despesa", callback_data: addSession("wiz_type_expense", sessionSeq) }],
    [{ text: "💰 Receita", callback_data: addSession("wiz_type_income", sessionSeq) }],
  ];
  await sendOrEditStep(chatId, messageId, step.prompt, keyboard, _supabase, _userId);
}

async function sendAmountStep(
  chatId: number, step: any, userId: number, supabase: any, _sessionSeq: number, messageId?: number
): Promise<void> {
  await sendOrEditStep(chatId, messageId, step.prompt, [], supabase, userId, "_amountPromptMessageId");
}

async function sendGenericSelectStep(
  chatId: number, step: any, _userId: number, supabase: any, sessionSeq: number, messageId?: number
): Promise<void> {
  const { data: options } = await supabase
    .from("wizard_step_options")
    .select("value, label")
    .eq("step_id", step.id)
    .order("sort_order");
  const keyboard: InlineKeyboard = (options && options.length > 0)
    ? options.map((o: any) => [{ text: o.label, callback_data: addSession(`wiz_${step.step_key}_${o.value}`, sessionSeq) }])
    : [];
  await sendOrEditStep(chatId, messageId, step.prompt, keyboard, supabase, _userId);
}

async function sendDefaultStep(
  chatId: number, step: any, _userId: number, _supabase: any, _sessionSeq: number, messageId?: number
): Promise<void> {
  await sendOrEditStep(chatId, messageId, step.prompt, [], _supabase, _userId);
}

// ========== Tag & Keyboard Builders ==========

/**
 * Toggle a tag in the wizard state and return the new tags array.
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
 */
export async function buildTagKeyboard(
  supabase: any,
  userId: number,
  sessionSeq: number,
  options: {
    togglePrefix: string;
    extraButtons?: { text: string; callback_data: string }[][];
  },
): Promise<{ keyboard: InlineKeyboard; currentTags: string[]; hasExistingTags: boolean }> {
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
  const hasExistingTags = tagSet.size > 0;

  const keyboard: InlineKeyboard = [];
  if (hasExistingTags) {
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

  return { keyboard, currentTags, hasExistingTags };
}

/**
 * Build a category selection keyboard grid.
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

// ========== Step Rendering ==========

/**
 * Render a wizard step: dispatch to the appropriate step sender.
 */
export function sendWizardStepMessage(
  chatId: number,
  step: any,
  userId: number,
  supabase: any,
  sessionSeq: number,
  messageId?: number
): Promise<void> {
  switch (step.step_key) {
    case "category":
      return sendCategoryStep(chatId, step, userId, supabase, sessionSeq, messageId);
    case "group":
      return sendGroupStep(chatId, step, userId, supabase, sessionSeq, messageId);
    case "tags":
      return sendTagsStep(chatId, step, userId, supabase, sessionSeq, messageId);
    case "description":
      return sendDescriptionStep(chatId, step, userId, supabase, sessionSeq, messageId);
    case "date":
      return sendDateStep(chatId, step, userId, supabase, sessionSeq, messageId);
    case "start_date":
      return sendDateStep(chatId, step, userId, supabase, sessionSeq, messageId, "wiz_start_date_");
    case "type":
      return sendTypeStep(chatId, step, userId, supabase, sessionSeq, messageId);
    case "amount":
      return sendAmountStep(chatId, step, userId, supabase, sessionSeq, messageId);
    default:
      if (step.input_type === "select") {
        return sendGenericSelectStep(chatId, step, userId, supabase, sessionSeq, messageId);
      }
      return sendDefaultStep(chatId, step, userId, supabase, sessionSeq, messageId);
  }
}

// ========== Completion Functions ==========

/**
 * Format tags array for DB insertion: ensure # prefix, filter empty.
 */
function formatTags(tags: any): string[] {
  if (Array.isArray(tags)) {
    return tags.map((t: string) => t.startsWith("#") ? t : `#${t}`).filter((t: string) => t);
  }
  if (tags) {
    return tags.split(" ").filter((t: string) => t).map((t: string) => t.startsWith("#") ? t : `#${t}`);
  }
  return [];
}

/**
 * Finalize a wizard: insert the transaction.
 */
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

  if (data.category) {
    await sendSimilarityWarning(supabase, userId, chatId, "category", data.category);
  }

  const categoryId = data.category ? await getOrCreateCategory(supabase, userId, data.category, type) : null;

  if (data.group) {
    await sendSimilarityWarning(supabase, userId, chatId, "group", data.group);
  }

  const groupId = await getOrCreateGroup(supabase, userId, data.group || null);
  const tags = formatTags(data.tags);
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

  await sendTransactionSuccess(supabase, chatId, userId, type, {
    amount,
    category: data.category,
    group: data.group,
    date,
    description: data.description,
    tags,
    transactionId: inserted?.id,
  });
}

/**
 * Build success message for recurrence creation.
 */
function buildRecurrenceSuccessMsg(recurrenceId: number | null, data: Record<string, any>): string {
  const type = data.type || "expense";
  const amount = parseFloat(data.amount);
  const icon = type === "expense" ? "💸" : "💰";
  const desc = data.description || "";
  const hasDesc = desc && desc.trim().length > 0;
  const safeDesc = hasDesc ? sanitizeMarkdown(desc) : "";
  const tags = formatTags(data.tags);
  const tagsStr = tags.length > 0 ? tags.map((t: string) => sanitizeMarkdown(t)).join(" ") : null;
  const freqLabelsMap: Record<string, string> = {
    daily: "Diária",
    weekly: `Semanal (dia ${DAYS_OF_WEEK[data.frequency_interval || 0]})`,
    monthly: `Mensal (dia ${data.frequency_interval})`,
    annual: "Anual",
    every_x_days: `A cada ${data.frequency_interval} dias`,
  };
  const startDate = data.start_date || getTodayISOBR();

  let msg = `🔄 *Recorrência criada com sucesso!*\n\n`;
  if (recurrenceId) msg += `🆔 *ID:* #${recurrenceId}\n`;
  msg += `${icon} *Valor:* ${formatCurrencyBR(isNaN(amount) ? 0 : amount)}\n`;
  if (hasDesc) msg += `📝 *Descrição:* ${safeDesc}\n`;
  msg += `🏷️ *Categoria:* ${data.category || "—"}\n`;
  msg += `📁 *Grupo:* ${data.group || "Pessoal"}\n`;
  msg += `🔄 *Frequência:* ${freqLabelsMap[data.frequency_type] || data.frequency_type}\n`;
  if (tagsStr) msg += `🔖 *Tags:* ${tagsStr}\n`;
  msg += `📅 *Primeira ocorrência:* ${formatDateBR(startDate)}`;
  return msg;
}

/**
 * Finalize a recurrence wizard: create the recurrence record.
 */
export async function completeRecurrenceWizard(
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

  const categoryId = data.category ? await getOrCreateCategory(supabase, userId, data.category, type) : null;
  const groupId = await getOrCreateGroup(supabase, userId, data.group || null);
  const tags = formatTags(data.tags);
  const startDate = data.start_date || getTodayISOBR();
  const desc = data.description || "";

  const { error, id: recurrenceId } = await createRecurrence(supabase, {
    userId,
    type,
    amount,
    description: desc,
    categoryId,
    groupId,
    tags,
    frequencyType: data.frequency_type,
    frequencyInterval: data.frequency_interval || null,
    frequencyMonth: data.frequency_month || null,
    nextDate: startDate,
  });

  if (error) {
    await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao criar a recorrência. Tente novamente.");
    return;
  }

  const sessionSeq = await getSessionSeq(supabase, userId);
  const msg = buildRecurrenceSuccessMsg(recurrenceId ?? null, data);

  const successKeyboard: InlineKeyboard = [];
  if (recurrenceId) {
    successKeyboard.push([{ text: "🔍 Ver Detalhes", callback_data: addSession(`rec_show_${recurrenceId}`, sessionSeq) }]);
  }
  successKeyboard.push([{ text: "📋 Ver Recorrências", callback_data: addSession("rec_back", sessionSeq) }]);

  await sendTelegramMessageWithKeyboard(chatId, msg, successKeyboard);
}

// ========== Confirmation Builders ==========

/**
 * Build a confirmation text for the step just completed.
 */
export function buildStepConfirmation(
  step: any,
  newStateData: Record<string, any>
): string | null {
  const value = newStateData[step.step_key];
  if (!value && value !== 0) {
    if (step.step_key === "description") return "✅ 📝 Descrição: Nenhuma descrição informada";
    if (step.step_key === "tags") return "✅ 🔖 Tags: Nenhuma tag";
    return null;
  }

  const confirmLabels: Record<string, string> = {
    category: "🏷️ Categoria selecionada",
    group: "📁 Grupo selecionado",
    date: "📅 Data selecionada",
    start_date: "📅 Data de início",
    type: "📋 Tipo",
    frequency: "🔄 Frequência",
    description: "📝 Descrição",
    tags: "🔖 Tags",
    amount: "💰 Valor",
  };

  const label = confirmLabels[step.step_key];
  if (!label) return null;

  let displayValue: string;
  if (step.step_key === "type") {
    displayValue = value === "expense" ? "💸 Despesa" : "💰 Receita";
  } else if (step.step_key === "date" || step.step_key === "start_date") {
    displayValue = formatDateBR(value);
  } else if (step.step_key === "frequency") {
    const freqValue = newStateData.frequency_type || value;
    displayValue = FREQ_LABELS[freqValue] || freqValue;
    // Build detailed label if intervals available
    if (newStateData.frequency_interval !== undefined) {
      if (freqValue === "weekly") {
        displayValue = `Semanal (${DAYS_OF_WEEK[newStateData.frequency_interval || 0]})`;
      } else if (freqValue === "monthly") {
        displayValue = `Mensal (dia ${newStateData.frequency_interval || "?"})`;
      } else if (freqValue === "annual") {
        displayValue = `Anual (${newStateData.frequency_interval || "?"} de ${MONTHS[(newStateData.frequency_month || 1) - 1]})`;
      } else if (freqValue === "every_x_days") {
        displayValue = `A cada ${newStateData.frequency_interval} dias`;
      }
    }
  } else if (step.step_key === "tags") {
    const tags = Array.isArray(value) ? value : [];
    displayValue = tags.length > 0 ? tags.join(" ") : "Nenhuma tag";
  } else if (step.step_key === "amount") {
    const num = parseFloat(value);
    displayValue = isNaN(num) ? String(value) : formatCurrencyBR(num);
  } else {
    displayValue = String(value);
  }

  return `✅ ${label}: ${displayValue}`;
}

/**
 * Build a date selection keyboard.
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
 * Build a delete confirmation keyboard.
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

// ========== Wizard Actions ==========

/**
 * Handle a wizard skip action: set step value to empty and advance.
 */
export async function handleWizardSkip(
  supabase: any,
  userId: number,
  chatId: number,
  sessionSeq: number,
  messageId?: number
): Promise<void> {
  const wizard = await getCurrentWizardStep(supabase, userId);
  if (!wizard) return;
  const newStateData = { ...wizard.state.data, [wizard.currentStep.step_key]: "" };
  await advanceWizardToNextStep(supabase, userId, chatId, wizard.currentStep, sessionSeq, newStateData, messageId);
}

// ========== Entity Management ==========

/**
 * Start a rename wizard for a category or group.
 */
export async function handleEntityRename(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  entityName: string,
  messageId: number
): Promise<void> {
  const isCategory = type === "category";
  const table = isCategory ? "categories" : "groups";
  const flagColumn = isCategory ? "is_predefined" : "is_default";
  const label = isCategory ? "categoria" : "grupo";

  const { data: entity } = await supabase
    .from(table)
    .select(flagColumn)
    .eq("user_id", userId)
    .ilike("name", entityName)
    .single();

  if (!entity || entity[flagColumn]) {
    const labelCapitalized = label.charAt(0).toUpperCase() + label.slice(1);
    await sendTelegramMessage(chatId, `⭐ ${labelCapitalized}s padrão não podem ser renomead${isCategory ? "as" : "os"}.`);
    return;
  }

  const wizardStep = isCategory ? "rename_cat" : "rename_grp";
  // Edit the entity action menu in-place to show the rename prompt (removes the buttons)
  await editTelegramMessageWithKeyboard(chatId, messageId, `✏️ Digite o novo nome para *${entityName}*:`, []);
  await setWizardState(supabase, userId, wizardStep, { name: entityName });
}

/**
 * Show a delete confirmation prompt for a category or group.
 */
export async function handleEntityDeletePrompt(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  entityName: string,
  sessionSeq: number
): Promise<void> {
  const isCategory = type === "category";
  const table = isCategory ? "categories" : "groups";
  const cbYesPrefix = isCategory ? "cat_del_yes_" : "grp_del_yes_";
  const cbBack = isCategory ? "cat_back" : "grp_back";
  const fallbackName = isCategory ? "Sem categoria" : "Pessoal";

  const { data: entity } = await supabase
    .from(table)
    .select("id")
    .eq("user_id", userId)
    .ilike("name", entityName)
    .single();
  if (!entity) return;

  const fkColumn = isCategory ? "category_id" : "group_id";
  const { count: txCount } = await supabase
    .from("transactions")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq(fkColumn, entity.id);

  const keyboard = buildDeleteConfirmKeyboard(
    addSession(`${cbYesPrefix}${entityName}`, sessionSeq),
    addSession(cbBack, sessionSeq),
  );
  await sendTelegramMessageWithKeyboard(
    chatId,
    `🗑️ Tem certeza de que deseja excluir ${isCategory ? "a categoria" : "o grupo"} *${entityName}*?\n\n${txCount || 0} ${(txCount || 0) !== 1 ? "transações" : "transação"} ${(txCount || 0) !== 1 ? "serão reatribuídas" : "será reatribuída"} para "${fallbackName}".`,
    keyboard
  );
}

/**
 * Execute entity deletion: reassign transactions to fallback, then delete.
 */
export async function handleEntityDeleteExecute(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  entityName: string
): Promise<void> {
  const isCategory = type === "category";
  const table = isCategory ? "categories" : "groups";
  const flagColumn = isCategory ? "is_predefined" : "is_default";
  const icon = isCategory ? "🏷️" : "📁";
  const label = isCategory ? "categoria" : "grupo";
  const fallbackName = isCategory ? "Sem categoria" : "Pessoal";

  const { data: entity } = await supabase
    .from(table)
    .select("id, " + flagColumn)
    .eq("user_id", userId)
    .ilike("name", entityName)
    .single();

  if (!entity || entity[flagColumn]) {
    const labelCapitalized = label.charAt(0).toUpperCase() + label.slice(1);
    await sendTelegramMessage(chatId, `⭐ ${labelCapitalized}s padrão não podem ser excluíd${isCategory ? "as" : "os"}.`);
    return;
  }

  const fkColumn = isCategory ? "category_id" : "group_id";
  const { count: txCount } = await supabase
    .from("transactions")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq(fkColumn, entity.id);

  let fallbackId: string | null = null;
  if (isCategory) {
    fallbackId = await getOrCreateUncategorizedCategory(supabase, userId);
  } else {
    const { data: defaultGrp } = await supabase.from("groups").select("id").eq("user_id", userId).eq("is_default", true).single();
    fallbackId = defaultGrp?.id || null;
  }
  const updateField = isCategory ? { category_id: fallbackId } : { group_id: fallbackId };
  await supabase.from("transactions").update(updateField).eq(fkColumn, entity.id).eq("user_id", userId);
  await supabase.from(table).delete().eq("id", entity.id).eq("user_id", userId);

  await sendTelegramMessage(
    chatId,
    `✅ ${icon} ${label.charAt(0).toUpperCase() + label.slice(1)} "${entityName}" excluíd${isCategory ? "a" : "o"}! ${txCount || 0} ${(txCount || 0) !== 1 ? "transações" : "transação"} ${(txCount || 0) !== 1 ? "reatribuídas" : "reatribuída"} para "${fallbackName}".`
  );
}

// ========== Step Resolution & Navigation ==========

/**
 * Read the current wizard state and resolve the corresponding wizard_step row.
 */
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

/**
 * Move to the next wizard step: confirm current step editorially, find next,
 * update state, render it. If no next step, finalize the wizard.
 */
export async function advanceWizardToNextStep(
  supabase: any,
  userId: number,
  chatId: number,
  currentStep: any,
  sessionSeq: number,
  newStateData: Record<string, any>,
  messageId?: number
): Promise<void> {
  if (messageId) {
    const confirmText = buildStepConfirmation(currentStep, newStateData);
    if (confirmText) {
      await editTelegramMessageWithKeyboard(chatId, messageId, confirmText, []);
    }
  }

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
  } else if (currentStep.wizard_name === "recorrencia") {
    await completeRecurrenceWizard(supabase, userId, chatId, newStateData);
  } else {
    await completeWizard(supabase, userId, chatId, newStateData);
  }
}

// ========== Text Input Handlers ==========

/**
 * Parse and validate amount from user input.
 */
function parseAmount(input: string): number | null {
  const amount = parseFloat(input.replace(",", "."));
  if (isNaN(amount) || amount <= 0) return null;
  return amount;
}

/**
 * Handle tag input: accumulate tags in wizard state and re-render.
 */
async function handleTagsInput(
  supabase: any,
  userId: number,
  chatId: number,
  state: WizardState,
  input: string,
  _wizardName: string,
  currentStep: any,
  userMessageId?: number
): Promise<void> {
  const tagsPromptMessageId = state.data?._tagsPromptMessageId as number | undefined;
  const currentTags: string[] = state.data?.tags
    ? (Array.isArray(state.data.tags) ? state.data.tags : [state.data.tags])
    : [];
  const newTags = input.split(" ").filter((t: string) => t.trim());
  const formattedTags = newTags.map((t: string) => t.startsWith("#") ? t : `#${t}`);
  // Dedup: only add tags not already in currentTags, also dedup within same input
  const existingSet = new Set(currentTags);
  const uniqueNewTags = formattedTags.filter((t: string) => {
    if (existingSet.has(t)) return false;
    existingSet.add(t); // prevent duplicates within the same input
    return true;
  });
  const accumulatedTags = [...currentTags, ...uniqueNewTags];

  for (const tag of newTags) {
    await sendSimilarityWarning(supabase, userId, chatId, "tag", tag);
  }

  await setWizardState(supabase, userId, state.step, {
    ...state.data,
    tags: accumulatedTags,
  });
  const tagsSessionSeq = await getSessionSeq(supabase, userId);
  await sendWizardStepMessage(chatId, currentStep, userId, supabase, tagsSessionSeq, tagsPromptMessageId);
  if (userMessageId) {
    await deleteTelegramMessage(chatId, userMessageId);
  }
}

// ========== Wizard Input Router ==========

/**
 * Route text input through any wizard (gasto/receita/recorrencia).
 * Deduces wizard name and type from the state.step prefix.
 */
export async function handleWizardInput(
  supabase: any,
  userId: number,
  chatId: number,
  state: WizardState,
  input: string,
  userMessageId?: number
): Promise<void> {
  // Deduce wizard name from state step: "gasto_amount" → "gasto", "recorrencia_tags" → "recorrencia"
  const underscoreIndex = state.step.indexOf("_");
  const wizardName = state.step.substring(0, underscoreIndex);

  // Determine type and completion function
  let type: "expense" | "income" | undefined;
  let completeFn: (supabase: any, userId: number, chatId: number, data: Record<string, any>) => Promise<void>;

  if (wizardName === "recorrencia") {
    completeFn = completeRecurrenceWizard;
  } else {
    type = wizardName === "receita" ? "income" : "expense";
    completeFn = completeWizard;
  }

  // ========== Special case: custom date (gasto/receita only) ==========
  if (wizardName !== "recorrencia" && state.step === `${wizardName}_custom_date`) {
    const parsed = parseDateBR(input);
    if (!parsed) {
      await sendTelegramMessage(chatId, "Formato inválido. Use DD/MM/YYYY (ex: 15/01/2024)");
      return;
    }
    const customDatePromptMessageId = state.data?._customDatePromptMessageId as number | undefined;
    if (customDatePromptMessageId) {
      await editTelegramMessageWithKeyboard(chatId, customDatePromptMessageId, `✅ 📅 Data: ${formatDateBR(parsed)}`, []);
    }
    if (userMessageId) {
      await deleteTelegramMessage(chatId, userMessageId);
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
      await completeFn(supabase, userId, chatId, { ...state.data, date: parsed, type });
    }
    return;
  }

  // ========== Special case: recurrence frequency detail ==========
  if (wizardName === "recorrencia" && state.step === "recorrencia_freq_detail") {
    const freqDetailPromptMessageId = state.data?._freqDetailPromptMessageId as number | undefined;
    const freqType = state.data.frequency_type;
    const value = input.trim();

    if (freqType === "weekly") {
      await sendTelegramMessage(chatId, "Por favor, selecione o dia da semana nos botões acima.");
      return;
    }

    if (freqType === "every_x_days") {
      const interval = parseInt(value, 10);
      if (isNaN(interval) || interval < 1) {
        await sendTelegramMessage(chatId, "Informe um número válido de dias (ex: 15).");
        return;
      }
      return await advanceFreqDetailToTags(supabase, userId, chatId, state, {
        frequency_interval: interval,
        _confirmText: buildFreqDetailConfirm(freqType, interval),
      }, freqDetailPromptMessageId, userMessageId);
    }

    if (freqType === "monthly") {
      const day = parseInt(value, 10);
      if (isNaN(day) || day < 1 || day > 31) {
        await sendTelegramMessage(chatId, "Informe um dia válido (1 a 31).");
        return;
      }
      return await advanceFreqDetailToTags(supabase, userId, chatId, state, {
        frequency_interval: day,
        _confirmText: buildFreqDetailConfirm(freqType, day),
      }, freqDetailPromptMessageId, userMessageId);
    }

    if (freqType === "annual") {
      const parts = value.split(/[\/\s-]+/);
      const day = parseInt(parts[0], 10);
      if (isNaN(day) || day < 1 || day > 31) {
        await sendTelegramMessage(chatId, "Informe um dia válido (1 a 31). Ex: 15/01");
        return;
      }
      const month = parts[1] ? parseInt(parts[1], 10) : NaN;
      if (isNaN(month) || month < 1 || month > 12) {
        await sendTelegramMessage(chatId, "Informe um mês válido (1 a 12). Ex: 15/01");
        return;
      }
      return await advanceFreqDetailToTags(supabase, userId, chatId, state, {
        frequency_interval: day,
        frequency_month: month,
        _confirmText: buildFreqDetailConfirm(freqType, day, month),
      }, freqDetailPromptMessageId, userMessageId);
    }
    return;
  }

  // ========== Special case: recurrence start date ==========
  if (wizardName === "recorrencia" && state.step === "recorrencia_start_date") {
    const parsed = parseDateBR(input);
    if (!parsed) {
      await sendTelegramMessage(chatId, "Formato inválido. Use DD/MM/YYYY (ex: 15/01/2024)");
      return;
    }
    const customDatePromptMessageId = state.data?._customDatePromptMessageId as number | undefined;
    if (customDatePromptMessageId) {
      await editTelegramMessageWithKeyboard(chatId, customDatePromptMessageId, `✅ 📅 Data de início: ${formatDateBR(parsed)}`, []);
    }
    if (userMessageId) {
      await deleteTelegramMessage(chatId, userMessageId);
    }
    await completeFn(supabase, userId, chatId, {
      ...state.data,
      start_date: parsed,
    });
    return;
  }

  // ========== Standard steps (amount, description, category, group, tags, etc.) ==========
  const prefix = `${wizardName}_`;
  const stepKey = state.step.replace(prefix, "");
  const { data: currentStep } = await supabase
    .from("wizard_steps")
    .select("*")
    .eq("wizard_name", wizardName)
    .eq("step_key", stepKey)
    .single();

  if (!currentStep) {
    const cmd = wizardName === "recorrencia" ? "/recorrencia" : type === "expense" ? "/despesa" : "/receita";
    await sendTelegramMessage(chatId, `❌ Ops! Algo deu errado com o wizard. Tente novamente com ${cmd}`);
    return;
  }

  let value = input;
  let confirmText: string | null = null;
  let promptMessageId: number | undefined;

  if (stepKey === "amount") {
    const amount = parseAmount(input);
    if (amount === null) {
      await sendTelegramMessage(chatId, "Por favor, informe um valor válido (ex: 50,00 ou 50)");
      return;
    }
    value = amount.toString();
    promptMessageId = state.data?._amountPromptMessageId as number | undefined;
    confirmText = `✅ 💰 Valor: ${formatCurrencyBR(amount)}`;
    return await advanceWithConfirmation(supabase, userId, chatId, wizardName, currentStep, state, stepKey, value, confirmText, promptMessageId, userMessageId, completeFn);
  }

  if (stepKey === "tags") {
    return await handleTagsInput(supabase, userId, chatId, state, input, wizardName, currentStep, userMessageId);
  }

  if (stepKey === "category") {
    promptMessageId = state.data?._categoryPromptMessageId as number | undefined;
    confirmText = `✅ 🏷️ Categoria: ${value}`;
    return await advanceWithConfirmation(supabase, userId, chatId, wizardName, currentStep, state, stepKey, value, confirmText, promptMessageId, userMessageId, completeFn);
  }

  if (stepKey === "group") {
    promptMessageId = state.data?._groupPromptMessageId as number | undefined;
    confirmText = `✅ 📁 Grupo: ${value}`;
    return await advanceWithConfirmation(supabase, userId, chatId, wizardName, currentStep, state, stepKey, value, confirmText, promptMessageId, userMessageId, completeFn);
  }

  if (stepKey === "description") {
    promptMessageId = state.data?._descPromptMessageId as number | undefined;
    confirmText = `✅ 📝 Descrição: ${sanitizeMarkdown(value)}`;
    return await advanceWithConfirmation(supabase, userId, chatId, wizardName, currentStep, state, stepKey, value, confirmText, promptMessageId, userMessageId, completeFn);
  }

  // Fallthrough for unknown steps
  const nextStep = await getNextWizardStep(supabase, wizardName, currentStep.step_order);
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
    await completeFn(supabase, userId, chatId, finalData);
  }
}
