import { InlineKeyboard, DeepSeekResponse, TelegramCallbackQuery } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, answerCallbackQuery } from "../services/telegram.ts";
import { getOrCreateUser } from "../services/database.ts";
import { formatDateBR, getTodayISOBR } from "../utils/formatting.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { getWizardState, setWizardState, clearWizardState, completeWizard, sendWizardStepMessage } from "./wizard.ts";
import { executeNaturalLanguageAction } from "./nl-processing.ts";

export async function handleCallbackQuery(
  supabase: any,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  try {
    const { data, message } = callbackQuery;
    const chatId = message.chat.id;
    const telegramId = callbackQuery.from.id;
    const selectedValue = data;
    await answerCallbackQuery(callbackQuery.id);

    // Handle delete confirmation
    if (selectedValue.startsWith("confirm_delete_")) {
      const transactionId = selectedValue.replace("confirm_delete_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { error } = await supabase.from("transactions").delete().eq("id", transactionId).eq("user_id", user.id);
      if (error) {
        await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao excluir. Tente novamente.");
      } else {
        await sendTelegramMessage(chatId, "✅ Transação excluída com sucesso!");
      }
      return;
    }

    if (selectedValue === "cancel_delete") {
      await sendTelegramMessage(chatId, "👍 Tudo bem! Transação mantida.");
      return;
    }

    // Handle NL category selection
    if (selectedValue.startsWith("nl_cat_")) {
      const category = selectedValue.replace("nl_cat_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const intent = state.step.includes("expense") ? "expense" : "income";
      const amount = state.data.amount;
      const date = state.data.date;
      const finalCategory = category === "none" ? null : category;
      const natural: DeepSeekResponse = { intent, amount, category: finalCategory, date, period: null, name: null, tag: null, limit: null, missingFields: [] };
      await clearWizardState(supabase, user.id);
      await executeNaturalLanguageAction(supabase, user.id, chatId, natural);
      return;
    }

    // Handle NL period selection
    if (selectedValue.startsWith("nl_period_")) {
      const period = selectedValue.replace("nl_period_", "") as "this_month" | "last_month";
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const intent = state.data.intent || state.step.replace("nl_", "").replace("_period", "");
      const category = state.data.category;
      const natural: DeepSeekResponse = { intent, amount: null, category, date: null, period, name: null, tag: null, limit: null, missingFields: [] };
      await clearWizardState(supabase, user.id);
      await executeNaturalLanguageAction(supabase, user.id, chatId, natural);
      return;
    }

    // Handle edit callbacks
    if (selectedValue.startsWith("edit_")) {
      const [action, transactionId] = selectedValue.replace("edit_", "").split("_");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      if (action === "amount") {
        await sendTelegramMessage(chatId, "Informe o novo valor:");
        await setWizardState(supabase, user.id, "edit_amount", { transaction_id: transactionId });
      } else if (action === "category") {
        const { data: categories } = await supabase.from("categories").select("name").eq("user_id", user.id).order("name");
        if (categories && categories.length > 0) {
          const keyboard: InlineKeyboard = categories.map((c: any) => [
            { text: c.name, callback_data: truncateCallbackData(`edit_cat_select_${transactionId}_${c.name}`) }
          ]);
          await sendTelegramMessageWithKeyboard(chatId, "Escolha a nova categoria:", keyboard);
        } else {
          await sendTelegramMessage(chatId, "Nenhuma categoria disponível. Crie uma com /categoria");
        }
      } else if (action === "date") {
        const today = getTodayISOBR();
        const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
        const keyboard: InlineKeyboard = [
          [{ text: "📅 Hoje", callback_data: truncateCallbackData(`edit_date_select_${transactionId}_${today}`) }],
          [{ text: "📅 Ontem", callback_data: truncateCallbackData(`edit_date_select_${transactionId}_${yesterday}`) }],
          [{ text: "📆 Outra data", callback_data: `edit_date_custom_${transactionId}` }],
        ];
        await sendTelegramMessageWithKeyboard(chatId, "Escolha a nova data:", keyboard);
      }
      return;
    }

    // Handle edit category selection
    if (selectedValue.startsWith("edit_cat_select_")) {
      const parts = selectedValue.replace("edit_cat_select_", "").split("_");
      const transactionId = parts[0];
      const categoryName = parts.slice(1).join("_");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: category } = await supabase.from("categories").select("id").eq("user_id", user.id).ilike("name", categoryName).single();
      if (category) {
        const { error } = await supabase.from("transactions").update({ category_id: category.id }).eq("id", transactionId).eq("user_id", user.id);
        if (error) {
          await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao atualizar. Tente novamente.");
        } else {
          await sendTelegramMessage(chatId, `✅ Categoria atualizada para "${categoryName}"!`);
        }
      }
      return;
    }

    // Handle edit date selection
    if (selectedValue.startsWith("edit_date_select_")) {
      const parts = selectedValue.replace("edit_date_select_", "").split("_");
      const transactionId = parts[0];
      const dateStr = parts.slice(1).join("_");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { error } = await supabase.from("transactions").update({ transaction_date: dateStr }).eq("id", transactionId).eq("user_id", user.id);
      if (error) {
        await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao atualizar. Tente novamente.");
      } else {
        await sendTelegramMessage(chatId, `✅ Data atualizada para ${formatDateBR(dateStr)}!`);
      }
      return;
    }

    if (selectedValue.startsWith("edit_date_custom_")) {
      const transactionId = selectedValue.replace("edit_date_custom_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      await sendTelegramMessage(chatId, "Informe a nova data (formato: DD/MM/YYYY):");
      await setWizardState(supabase, user.id, "edit_date", { transaction_id: transactionId });
      return;
    }

    // Handle custom_date for wizards
    if (selectedValue === "custom_date") {
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const underscoreIndex = state.step.indexOf("_");
      const currentWizardName = state.step.substring(0, underscoreIndex);
      await sendTelegramMessage(chatId, "Informe a data (formato: DD/MM/YYYY):");
      await setWizardState(supabase, user.id, `${currentWizardName}_custom_date`, state.data);
      return;
    }

    // Handle generic wizard selections
    const user = await getOrCreateUser(supabase, telegramId);
    if (!user) return;
    const userId = user.id;
    const { data: state } = await supabase.from("wizard_states").select("*").eq("user_id", userId).single();
    if (!state) return;
    const underscoreIndex = state.step.indexOf("_");
    const wizardName = state.step.substring(0, underscoreIndex);
    const stepKey = state.step.substring(underscoreIndex + 1);
    const { data: currentStep } = await supabase.from("wizard_steps").select("*").eq("wizard_name", wizardName).eq("step_key", stepKey).single();
    if (!currentStep) return;
    const newStateData = { ...state.data, [currentStep.step_key]: selectedValue };
    const { data: nextStep } = await supabase.from("wizard_steps").select("*").eq("wizard_name", currentStep.wizard_name).gt("step_order", currentStep.step_order).order("step_order").limit(1).single();
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
  } catch (error) {
    console.error("Error handling callback query:", error);
    await sendTelegramMessage(callbackQuery.message.chat.id, "❌ Ops! Algo deu errado. Tente novamente.");
  }
}
