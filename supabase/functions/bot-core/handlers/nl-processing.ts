import type { DeepSeekResponse, InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { getOrCreateUser, getCategories, resolveCategoryForNL } from "../services/database.ts";
import { parseDateBR } from "../utils/formatting.ts";
import { setWizardState } from "./wizard.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
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
  natural: DeepSeekResponse,
  sessionSeq: number
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
      const categories = await getCategories(supabase, user.id, natural.intent);
      const keyboard: InlineKeyboard = [];
      let row: { text: string; callback_data: string }[] = [];
      for (const c of categories) {
        row.push({ text: c.name, callback_data: truncateCallbackData(`nl_cat_${c.name}`, sessionSeq) });
        if (row.length === 3) {
          keyboard.push(row);
          row = [];
        }
      }
      if (row.length > 0) keyboard.push(row);
      keyboard.push([{ text: "⏭️ Sem categoria", callback_data: truncateCallbackData("nl_cat_none", sessionSeq) }]);

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
      [{ text: "📅 Esse mês", callback_data: addSession("nl_period_this_month", sessionSeq) }],
      [{ text: "📅 Mês passado", callback_data: addSession("nl_period_last_month", sessionSeq) }],
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

  await executeNaturalLanguageAction(supabase, userId, chatId, natural, sessionSeq);
}

async function handleNLWithGroupCheck(
  supabase: any,
  telegramId: number,
  userId: number,
  chatId: number,
  type: "expense" | "income",
  natural: DeepSeekResponse,
  resolvedCategory: string | null,
): Promise<void> {
  const { count: groupCount } = await supabase
    .from("groups")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  if (groupCount && groupCount > 1) {
    const sessionSeq = await getSessionSeq(supabase, userId);
    const { data: groups } = await supabase
      .from("groups")
      .select("name")
      .eq("user_id", userId)
      .order("name");
    const keyboard: InlineKeyboard = [];
    if (groups) {
      let row: { text: string; callback_data: string }[] = [];
      for (const g of groups) {
        row.push({ text: g.name, callback_data: truncateCallbackData(`nl_grp_${g.name}`, sessionSeq) });
        if (row.length === 2) {
          keyboard.push(row);
          row = [];
        }
      }
      if (row.length > 0) keyboard.push(row);
    }
    keyboard.push([{ text: "⏭️ Pular", callback_data: truncateCallbackData("nl_grp_skip", sessionSeq) }]);
    await setWizardState(supabase, userId, `nl_${type}_group`, {
      amount: natural.amount,
      category: resolvedCategory,
      description: natural.category,
      date: natural.date,
      type,
    });
    await sendTelegramMessageWithKeyboard(chatId, "Em que grupo?", keyboard);
    return;
  }

  const args = [natural.amount!.toString()];
  if (natural.date) {
    const dateBR = parseDateBR(natural.date) || natural.date;
    args.push("--data", dateBR);
  }
  if (resolvedCategory) args.push(resolvedCategory);
  if (natural.tag) args.push(natural.tag.startsWith("#") ? natural.tag : `#${natural.tag}`);
  await handleTransaction(type, supabase, telegramId, chatId, args, natural.category || undefined);
}

export async function executeNaturalLanguageAction(
  supabase: any,
  userId: number,
  chatId: number,
  natural: DeepSeekResponse,
  sessionSeq?: number
): Promise<void> {
  if ((natural.intent === "expense" || natural.intent === "income") && natural.amount) {
    const user = await getOrCreateUser(supabase, userId);
    if (!user) return;

    let category = natural.category;

    if (category) {
      const resolved = await resolveCategoryForNL(supabase, user.id, category, natural.intent);
      if (resolved) {
        if (resolved.name !== category) {
          await sendTelegramMessage(chatId, `💡 Usei a categoria *${resolved.name}* para "${category}"`);
        }
        category = resolved.name;
      } else if (category.includes(" ")) {
        // Multi-word means DeepSeek hallucinated — show category picker
        category = null;
      }
    }

    if (category === null && natural.category && natural.category.includes(" ")) {
      const categories = await getCategories(supabase, user.id, natural.intent);
      const keyboard: InlineKeyboard = [];
      let row: { text: string; callback_data: string }[] = [];
      const seq = sessionSeq || await getSessionSeq(supabase, user.id);
      for (const c of categories) {
        row.push({ text: c.name, callback_data: truncateCallbackData(`nl_cat_${c.name}`, seq) });
        if (row.length === 3) {
          keyboard.push(row);
          row = [];
        }
      }
      if (row.length > 0) keyboard.push(row);
      keyboard.push([{ text: "⏭️ Sem categoria", callback_data: truncateCallbackData("nl_cat_none", seq) }]);

      await setWizardState(supabase, user.id, `nl_${natural.intent}_category`, {
        intent: natural.intent,
        amount: natural.amount,
        date: natural.date,
      });
      await sendTelegramMessageWithKeyboard(chatId, "Em que categoria?", keyboard);
      return;
    }

    await handleNLWithGroupCheck(supabase, userId, user.id, chatId, natural.intent, natural, category);
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
