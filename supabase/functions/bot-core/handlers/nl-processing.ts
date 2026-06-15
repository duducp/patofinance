import type { DeepSeekResponse, InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { getOrCreateUser, getCategories } from "../services/database.ts";
import { parseDateBR } from "../utils/formatting.ts";
import { setWizardState } from "./wizard.ts";
import {
  handleTransaction,
  handleBalance,
  handleStatement,
  handleCleanup,
  handleTag,
} from "./commands.ts";
import {
  handleCreateCategory,
  handleCreateGroup,
  handleListCategories,
  handleListGroups,
  handleListTransactions,
  handleShowLastTransaction,
  handleDeleteLastTransaction,
  handleListByTag,
} from "./management.ts";
import {
  handleQueryExpenses,
  handleQuerySummary,
} from "./queries.ts";

export async function handleNaturalLanguageWithFollowUp(
  supabase: any,
  userId: number,
  chatId: number,
  natural: DeepSeekResponse
): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  if (natural.intent === "expense" || natural.intent === "income") {
    if (!natural.amount) {
      const verb = natural.intent === "expense" ? "gastou" : "recebeu";
      await setWizardState(supabase, user.id, `nl_${natural.intent}_amount`, {
        intent: natural.intent,
        category: natural.category,
        date: natural.date,
      });
      await sendTelegramMessage(chatId, `Quanto você ${verb}? Informe o valor:`);
      return;
    }

    if (!natural.category) {
      const categories = await getCategories(supabase, user.id);
      const keyboard: InlineKeyboard = categories.map((c) => [
        { text: c.name, callback_data: `nl_cat_${c.name}` }
      ]);
      keyboard.push([{ text: "⏭️ Sem categoria", callback_data: "nl_cat_none" }]);

      await setWizardState(supabase, user.id, `nl_${natural.intent}_category`, {
        intent: natural.intent,
        amount: natural.amount,
        date: natural.date,
      });
      await sendTelegramMessageWithKeyboard(chatId, "Em que categoria?", keyboard);
      return;
    }
  }

  if (natural.missingFields.includes("period")) {
    const keyboard: InlineKeyboard = [
      [{ text: "📅 Esse mês", callback_data: "nl_period_this_month" }],
      [{ text: "📅 Mês passado", callback_data: "nl_period_last_month" }],
    ];
    await setWizardState(supabase, user.id, `nl_${natural.intent}_period`, {
      intent: natural.intent,
      category: natural.category,
    });
    await sendTelegramMessageWithKeyboard(chatId, "Qual período?", keyboard);
    return;
  }

  if (natural.intent === "create_category" && !natural.name) {
    await setWizardState(supabase, user.id, "nl_create_category_name", {
      intent: natural.intent,
    });
    await sendTelegramMessage(chatId, "Qual o nome da categoria que você quer criar?");
    return;
  }

  if (natural.intent === "create_group" && !natural.name) {
    await setWizardState(supabase, user.id, "nl_create_group_name", {
      intent: natural.intent,
    });
    await sendTelegramMessage(chatId, "Qual o nome do grupo que você quer criar?");
    return;
  }

  if (natural.intent === "list_by_tag" && !natural.tag) {
    await setWizardState(supabase, user.id, "nl_list_by_tag_name", {
      intent: natural.intent,
    });
    await sendTelegramMessage(chatId, "Qual a tag que você quer buscar? Use #nome_da_tag");
    return;
  }

  await executeNaturalLanguageAction(supabase, userId, chatId, natural);
}

export async function executeNaturalLanguageAction(
  supabase: any,
  userId: number,
  chatId: number,
  natural: DeepSeekResponse
): Promise<void> {
  if (natural.intent === "expense" && natural.amount) {
    const args = [natural.amount.toString()];
    if (natural.category) args.push(natural.category);
    if (natural.date) {
      const dateBR = parseDateBR(natural.date) || natural.date;
      args.push("--data", dateBR);
    }
    await handleTransaction("expense", supabase, userId, chatId, args);
    return;
  }

  if (natural.intent === "income" && natural.amount) {
    const args = [natural.amount.toString()];
    if (natural.category) args.push(natural.category);
    if (natural.date) {
      const dateBR = parseDateBR(natural.date) || natural.date;
      args.push("--data", dateBR);
    }
    await handleTransaction("income", supabase, userId, chatId, args);
    return;
  }

  if (natural.intent === "query_balance") {
    await handleBalance(supabase, userId, chatId);
    return;
  }

  if (natural.intent === "query_expenses_month" || natural.intent === "query_expenses_last_month") {
    await handleQueryExpenses(supabase, userId, chatId, natural.period, null, null);
    return;
  }

  if (natural.intent === "query_expenses_date") {
    await handleQueryExpenses(supabase, userId, chatId, null, natural.date, null);
    return;
  }

  if (natural.intent === "query_expenses_category") {
    await handleQueryExpenses(supabase, userId, chatId, natural.period, null, natural.category);
    return;
  }

  if (natural.intent === "query_summary") {
    await handleQuerySummary(supabase, userId, chatId, natural.period);
    return;
  }

  if (natural.intent === "query_extract") {
    await handleStatement(supabase, userId, chatId);
    return;
  }

  if (natural.intent === "create_category" && natural.name) {
    await handleCreateCategory(supabase, userId, chatId, natural.name);
    return;
  }

  if (natural.intent === "create_group" && natural.name) {
    await handleCreateGroup(supabase, userId, chatId, natural.name);
    return;
  }

  if (natural.intent === "list_categories") {
    await handleListCategories(supabase, userId, chatId);
    return;
  }

  if (natural.intent === "list_groups") {
    await handleListGroups(supabase, userId, chatId);
    return;
  }

  if (natural.intent === "list_tags") {
    await handleTag(supabase, userId, chatId, []);
    return;
  }

  if (natural.intent === "list_transactions") {
    const limit = natural.limit || 10;
    await handleListTransactions(supabase, userId, chatId, limit);
    return;
  }

  if (natural.intent === "show_last_transaction") {
    await handleShowLastTransaction(supabase, userId, chatId);
    return;
  }

  if (natural.intent === "delete_last_transaction") {
    await handleDeleteLastTransaction(supabase, userId, chatId);
    return;
  }

  if (natural.intent === "list_by_tag" && natural.tag) {
    await handleListByTag(supabase, userId, chatId, natural.tag);
    return;
  }

  if (natural.intent === "cleanup") {
    await handleCleanup(supabase, userId, chatId);
    return;
  }
}
