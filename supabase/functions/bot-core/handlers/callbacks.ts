import { InlineKeyboard, DeepSeekResponse, TelegramCallbackQuery } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard, answerCallbackQuery } from "../services/telegram.ts";
import { getOrCreateUser, normalizeString, getOrCreateUncategorizedCategory, deleteTransactionById, userOrNullFilter } from "../services/database.ts";
import { formatDateBR, parseDateBR } from "../utils/formatting.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { getWizardState, setWizardState, clearWizardState, sendWizardStepMessage, getCurrentWizardStep, advanceWizardToNextStep, toggleTagInWizardState, buildTagKeyboard, buildCategoryKeyboard, buildGroupKeyboard, buildDateKeyboard } from "./wizard.ts";
import { executeNaturalLanguageAction } from "./nl-processing.ts";
import { handleBalance, handleSummary, handleDetails, handleGroup, handleCategory, handleTransaction, showDetailsEditActions, showDetailsMainView } from "./commands.ts";
import { handleListTransactions, handleListByTag, handleSearch, showDeleteConfirmation } from "./management.ts";
import { handleStatement, handleFilterCallback } from "./statement.ts";
import { addSession, removeSession, validateCallbackSession, getSessionSeq, incrementSessionSeq } from "../utils/session.ts";

async function handleGroupFilterCallback(
  supabase: any,
  telegramId: number,
  chatId: number,
  prefix: "balance" | "summary",
  selectedValue: string
): Promise<void> {
  if (selectedValue === `${prefix}_shwgrp`) {
    const user = await getOrCreateUser(supabase, telegramId);
    if (!user) return;
    const sessionSeq = await getSessionSeq(supabase, user.id);
    const keyboard = await buildGroupKeyboard(supabase, user.id, sessionSeq, {
      callbackPrefix: `${prefix}_grp_`,
      extraButtons: [
        [{ text: "📋 Todas as contas", callback_data: addSession(`${prefix}_grp_all`, sessionSeq) }],
      ],
    });
    const title = prefix === "balance" ? "saldo" : "resumo";
    if (keyboard.length > 0) {
      await sendTelegramMessageWithKeyboard(chatId, `📁 *Filtrar ${title} por grupo:*`, keyboard);
    }
    return;
  }

  if (selectedValue.startsWith(`${prefix}_grp_`)) {
    const groupName = selectedValue.replace(`${prefix}_grp_`, "");
    const user = await getOrCreateUser(supabase, telegramId);
    if (!user) return;
    const handler = prefix === "balance" ? handleBalance : handleSummary;
    if (groupName === "all") {
      await handler(supabase, telegramId, chatId);
    } else {
      await handler(supabase, telegramId, chatId, [groupName]);
    }
    return;
  }
}

// ========== Shared entity (category/group) callback handlers ==========

async function handleEntityDeletePrompt(
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

  const keyboard: InlineKeyboard = [
    [{ text: "✅ Sim, excluir", callback_data: addSession(`${cbYesPrefix}${entityName}`, sessionSeq) }],
    [{ text: "❌ Não, manter", callback_data: addSession(cbBack, sessionSeq) }],
  ];
  await sendTelegramMessageWithKeyboard(
    chatId,
    `🗑️ Tem certeza de que deseja excluir ${isCategory ? "a categoria" : "o grupo"} *${entityName}*?\n\n${txCount || 0} ${(txCount || 0) !== 1 ? "transações" : "transação"} ${(txCount || 0) !== 1 ? "serão reatribuídas" : "será reatribuída"} para "${fallbackName}".`,
    keyboard
  );
}

async function handleEntityDeleteExecute(
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

  // Reassign affected transactions
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

async function handleEntitySuggestion(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  action: "use" | "new"
): Promise<void> {
  const isCategory = type === "category";
  const table = isCategory ? "categories" : "groups";
  const stepName = isCategory ? "suggest_cat" : "suggest_grp";
  const flagColumn = isCategory ? "is_predefined" : "is_default";
  const icon = isCategory ? "🏷️" : "📁";
  const label = isCategory ? "categoria" : "grupo";

  const state = await getWizardState(supabase, userId);
  if (!state || state.step !== stepName) return;

  if (action === "use") {
    await clearWizardState(supabase, userId);
    await sendTelegramMessage(chatId, `✅ Usando ${label} "${state.data.suggested_name}" — ${isCategory ? "ela" : "ele"} já existe.`);
    return;
  }

  // action === "new" — create anyway
  const entityName = state.data.original_name;
  const { error } = await supabase.from(table).insert({
    user_id: userId,
    name: entityName,
    normalized_name: normalizeString(entityName),
    [flagColumn]: false,
  });
  await clearWizardState(supabase, userId);
  if (error) {
    await sendTelegramMessage(chatId, `❌ Ops! Algo deu errado ao criar ${isCategory ? "a" : "o"} ${label}.`);
  } else {
    await sendTelegramMessage(chatId, `✅ ${icon} ${label.charAt(0).toUpperCase() + label.slice(1)} "${entityName}" criad${isCategory ? "a" : "o"} com sucesso!`);
  }
}

async function handleEntitySelect(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  entityName: string,
  sessionSeq: number
): Promise<void> {
  const isCategory = type === "category";
  const table = isCategory ? "categories" : "groups";
  const flagColumn = isCategory ? "is_predefined" : "is_default";
  const icon = isCategory ? "🏷️" : "📁";
  const cbRename = isCategory ? "cat_ren_" : "grp_ren_";
  const cbDelete = isCategory ? "cat_del_" : "grp_del_";
  const cbBack = isCategory ? "cat_back" : "grp_back";

  let query = supabase.from(table).select("id, " + flagColumn);
  if (isCategory) {
    query = query.or(userOrNullFilter(userId));
  } else {
    query = query.eq("user_id", userId);
  }
  const { data: entity } = await query.ilike("name", entityName).maybeSingle();
  if (!entity) return;

  const keyboard: InlineKeyboard = [];
  if (entity[flagColumn]) {
    keyboard.push([{ text: `⭐ ${isCategory ? "Categoria" : "Grupo"} padrão`, callback_data: "none" }]);
  } else {
    keyboard.push([{ text: "✏️ Renomear", callback_data: addSession(`${cbRename}${entityName}`, sessionSeq) }]);
    keyboard.push([{ text: "🗑️ Excluir", callback_data: addSession(`${cbDelete}${entityName}`, sessionSeq) }]);
  }
  keyboard.push([{ text: "◀️ Voltar", callback_data: addSession(cbBack, sessionSeq) }]);
  await sendTelegramMessageWithKeyboard(chatId, `${icon} *${entityName}*\n\nO que deseja fazer?`, keyboard);
}

async function handleEntityRename(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  entityName: string
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
  await sendTelegramMessage(chatId, `✏️ Digite o novo nome para *${entityName}*:`);
  await setWizardState(supabase, userId, wizardStep, { name: entityName });
}

async function handleEntityBack(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number
): Promise<void> {
  const handler = type === "category" ? handleCategory : handleGroup;
  await handler(supabase, userId, chatId, []);
}

export async function handleCancelWizard(
  supabase: any,
  userId: number,
  chatId: number
): Promise<void> {
  const hadWizard = await getWizardState(supabase, userId);
  await clearWizardState(supabase, userId);
  if (hadWizard) {
    await sendTelegramMessage(chatId, "❌ Operação cancelada. Pode ficar tranquilo!");
  } else {
    await sendTelegramMessage(chatId, "ℹ️ Nenhuma operação em andamento para cancelar.");
  }
}

export async function handleCallbackQuery(
  supabase: any,
  callbackQuery: TelegramCallbackQuery
): Promise<void> {
  try {
    const { data, message } = callbackQuery;
    const chatId = message.chat.id;
    const telegramId = callbackQuery.from.id;
    await answerCallbackQuery(callbackQuery.id);

    // Extract and validate session from callback data
    const decoded = removeSession(data);
    if (!decoded) {
      await sendTelegramMessage(chatId, "⏰ Este botão expirou. Execute o comando novamente.");
      return;
    }
    const selectedValue = decoded.data;
    const user = await getOrCreateUser(supabase, telegramId);
    if (!user) return;
    const isValid = await validateCallbackSession(supabase, user.id, decoded.seq);
    if (!isValid) {
      await sendTelegramMessage(chatId, "⏰ Este botão expirou pois você iniciou uma nova conversa. Execute o comando novamente.");
      return;
    }
    const sessionSeq = decoded.seq;

    // Handle delete confirmation
    if (selectedValue.startsWith("del_prompt_")) {
      const transactionId = selectedValue.replace("del_prompt_", "");
      const { data: transaction } = await supabase
        .from("transactions")
        .select("id, type, amount, categories(name), transaction_date, description")
        .eq("id", transactionId)
        .eq("user_id", user.id)
        .single();
      if (transaction) {
        const sessionSeq = await getSessionSeq(supabase, user.id);
        await showDeleteConfirmation(chatId, transaction, sessionSeq, message.message_id);
      }
      return;
    }

    if (selectedValue.startsWith("confirm_delete_")) {
      const transactionId = selectedValue.replace("confirm_delete_", "");
      const { success } = await deleteTransactionById(supabase, user.id, transactionId);
      if (success) {
        await sendTelegramMessage(chatId, "✅ Transação excluída com sucesso!");
      } else {
        await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao excluir. Tente novamente.");
      }
      return;
    }

    if (selectedValue.startsWith("cancel_delete_")) {
      const transactionId = selectedValue.replace("cancel_delete_", "");
      await showDetailsMainView(supabase, user.id, chatId, transactionId, message.message_id);
      return;
    }

    // Handle cleanup (clean up unused categories/groups)
    if (selectedValue === "confirm_cleanup") {
      // Find and delete unused categories
      const { data: catCounts } = await supabase
        .from("transactions")
        .select("category_id")
        .eq("user_id", user.id)
        .not("category_id", "is", null);
      const usedCatIds = new Set((catCounts || []).map((t: any) => t.category_id));
      const { data: allCats } = await supabase
        .from("categories")
        .select("id")
        .eq("user_id", user.id)
        .eq("is_predefined", false);
      const unusedCatIds = (allCats || []).filter((c: any) => !usedCatIds.has(c.id)).map((c: any) => c.id);
      if (unusedCatIds.length > 0) {
        await supabase.from("categories").delete().in("id", unusedCatIds);
      }

      // Find and delete unused non-default groups
      const { data: grpCounts } = await supabase
        .from("transactions")
        .select("group_id")
        .eq("user_id", user.id)
        .not("group_id", "is", null);
      const usedGrpIds = new Set((grpCounts || []).map((t: any) => t.group_id));
      const { data: allGrps } = await supabase
        .from("groups")
        .select("id")
        .eq("user_id", user.id)
        .eq("is_default", false);
      const unusedGrpIds = (allGrps || []).filter((g: any) => !usedGrpIds.has(g.id)).map((g: any) => g.id);
      if (unusedGrpIds.length > 0) {
        await supabase.from("groups").delete().in("id", unusedGrpIds);
      }

      await sendTelegramMessage(chatId, "🧹 Itens sem uso removidos com sucesso!");
      return;
    }

    if (selectedValue === "cancel_cleanup") {
      await sendTelegramMessage(chatId, "👍 Nenhum item foi removido.");
      return;
    }

    if (selectedValue === "cancel_edit") {
      await sendTelegramMessage(chatId, "👍 Beleza! Edição cancelada.");
      return;
    }

    if (selectedValue === "cancel_details") {
      await sendTelegramMessage(chatId, "👍 Beleza!");
      return;
    }

    if (selectedValue === "cancel_wizard") {
      if (telegramId) {
        const user = await getOrCreateUser(supabase, telegramId);
        if (user) await handleCancelWizard(supabase, user.id, chatId);
      }
      return;
    }

    if (selectedValue === "detalhes_show_extrato") {
      if (telegramId) {
        const user = await getOrCreateUser(supabase, telegramId);
        if (user) {
          await handleCancelWizard(supabase, user.id, chatId);
          await handleStatement(supabase, telegramId, chatId);
        }
      }
      return;
    }

    // ========== Statement filter panel ==========
    if (selectedValue.startsWith("stmt_")) {
      const handled = await handleFilterCallback(supabase, telegramId, chatId, selectedValue, sessionSeq, message.message_id);
      if (handled) return;
    }

    // Handle statement navigation (filter + pagination)
    if (selectedValue.startsWith("statement_")) {
      // Format: statement_{filterSuffix}_{page}
      const rest = selectedValue.replace("statement_", "");
      const underscoreIndex = rest.lastIndexOf("_");
      if (underscoreIndex > 0) {
        const filterSuffix = rest.substring(0, underscoreIndex);
        const pageStr = rest.substring(underscoreIndex + 1);
        const page = parseInt(pageStr, 10);
        if (!isNaN(page)) {
          const filter = filterSuffix === "inc" ? "income" as const
            : filterSuffix === "exp" ? "expense" as const
            : filterSuffix === "fut" ? "future" as const
            : "all" as const;
          await handleStatement(supabase, telegramId, chatId, page, filter, undefined, message.message_id);
        }
      }
      return;
    }

    // Handle list transactions pagination
    if (selectedValue.startsWith("txlist_p")) {
      const page = parseInt(selectedValue.replace("txlist_p", ""), 10);
      if (!isNaN(page)) {
        await handleListTransactions(supabase, telegramId, chatId, 10, undefined, page, message.message_id);
      }
      return;
    }

    // Handle list by tag pagination
    if (selectedValue.startsWith("txlist_t")) {
      // Format: txlist_t{tag}_p{page}
      const lastPIndex = selectedValue.lastIndexOf("_p");
      if (lastPIndex > 0) {
        const page = parseInt(selectedValue.substring(lastPIndex + 2), 10);
        const tag = selectedValue.substring(8, lastPIndex); // after "txlist_t"
        if (!isNaN(page)) {
          await handleListByTag(supabase, telegramId, chatId, tag, page, message.message_id);
        }
      }
      return;
    }

    // Handle search pagination
    if (selectedValue.startsWith("search_")) {
      // Format: search_{normalizedTerm}_p{page}
      const lastPIndex = selectedValue.lastIndexOf("_p");
      if (lastPIndex > 0) {
        const page = parseInt(selectedValue.substring(lastPIndex + 2), 10);
        const term = selectedValue.substring(7, lastPIndex); // after "search_"
        if (!isNaN(page)) {
          await handleSearch(supabase, telegramId, chatId, term, page, message.message_id);
        }
      }
      return;
    }

    // Handle NL type selection (when intent was null)
    if (selectedValue === "nl_type_expense" || selectedValue === "nl_type_income") {
      const type = selectedValue === "nl_type_expense" ? "expense" : "income";
      const state = await getWizardState(supabase, user.id);
      const args: string[] = [];
      if (state?.data?.text) {
        const match = state.data.text.match(/(\d+[,.]?\d*)/);
        if (match) {
          const amount = parseFloat(match[1].replace(",", "."));
          if (!isNaN(amount) && amount > 0) args.push(amount.toString());
        }
        if (state.data.date) {
          args.push("--data", state.data.date);
        }
      }
      await clearWizardState(supabase, user.id);
      await handleTransaction(type, supabase, telegramId, chatId, args);
      return;
    }

    // Handle NL new category creation (must be before generic nl_cat_)
    if (selectedValue === "nl_create_cat") {
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const intent = state.step.includes("expense") ? "expense" : "income";
      await supabase
        .from("wizard_states")
        .update({ step: `nl_creating_category_${intent}`, data: state.data })
        .eq("user_id", user.id);
      await sendTelegramMessage(chatId, "✏️ Digite o nome da nova categoria:");
      return;
    }

    // Handle NL category selection
    if (selectedValue.startsWith("nl_cat_")) {
      const category = selectedValue.replace("nl_cat_", "");
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const intent = state.step.includes("expense") ? "expense" : "income";
      const amount = state.data.amount;
      const group = state.data.group;
      const description = state.data.description;
      const tag = state.data.tag;
      const date = state.data.date;
      const finalCategory = category === "none" ? null : category;
      const natural: DeepSeekResponse = { intent, amount, category: finalCategory, group, description, date, period: null, name: null, tag, limit: null, missingFields: [] };
      await clearWizardState(supabase, user.id);
      await executeNaturalLanguageAction(supabase, telegramId, chatId, natural);
      return;
    }

    // Handle NL group selection
    if (selectedValue.startsWith("nl_grp_")) {
      const groupName = selectedValue.replace("nl_grp_", "");
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const type = state.data.type || "expense";
      const amount = state.data.amount;
      const category = state.data.category;
      const description = state.data.description;
      const tag = state.data.tag;
      const date = state.data.date;
      if (!amount) return;
      const args = [amount.toString()];
      if (date) {
        const dateBR = parseDateBR(date) || date;
        args.push("--data", dateBR);
      }
      if (groupName !== "skip") args.push("--grupo", groupName);
      if (tag) args.push(tag.startsWith("#") ? tag : `#${tag}`);
      if (category) args.push(category);
      await clearWizardState(supabase, user.id);
      await handleTransaction(type, supabase, telegramId, chatId, args, description || undefined);
      return;
    }

    // Handle NL period selection
    if (selectedValue.startsWith("nl_period_")) {
      const period = selectedValue.replace("nl_period_", "") as "this_month" | "last_month";
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const intent = state.data.intent || state.step.replace("nl_", "").replace("_period", "");
      const category = state.data.category;
      const natural: DeepSeekResponse = { intent, amount: null, category, date: null, period, name: null, tag: null, limit: null, missingFields: [] };
      await clearWizardState(supabase, user.id);
      await executeNaturalLanguageAction(supabase, telegramId, chatId, natural);
      return;
    }

    // Handle edit show actions (MUST come before edit_show_)
    if (selectedValue.startsWith("edit_show_actions_")) {
      const transactionId = selectedValue.replace("edit_show_actions_", "");
      await showDetailsEditActions(supabase, user.id, chatId, transactionId, message.message_id);
      return;
    }

    // Handle edit show main (MUST come before edit_show_)
    if (selectedValue.startsWith("edit_show_main_")) {
      const transactionId = selectedValue.replace("edit_show_main_", "");
      await showDetailsMainView(supabase, user.id, chatId, transactionId, message.message_id);
      return;
    }

    // Handle edit callbacks (specific prefixes MUST come before generic edit_)
    if (selectedValue.startsWith("edit_show_")) {
      const transactionId = selectedValue.replace("edit_show_", "");
      await handleDetails(supabase, telegramId, chatId, [transactionId]);
      return;
    }

    // Handle edit category selection (MUST come before edit_)
    if (selectedValue.startsWith("edit_cat_select_")) {
      const parts = selectedValue.replace("edit_cat_select_", "").split("_");
      const transactionId = parts[0];
      const categoryName = parts.slice(1).join("_");
        const { data: category } = await supabase.from("categories").select("id").or(userOrNullFilter(user.id)).ilike("name", categoryName).maybeSingle();
      if (category) {
        const { error } = await supabase.from("transactions").update({ category_id: category.id }).eq("id", transactionId).eq("user_id", user.id);
        if (error) {
          await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao atualizar. Tente novamente.");
        } else {
          await sendTelegramMessage(chatId, `✅ Categoria atualizada para "${categoryName}"!`);
          await incrementSessionSeq(supabase, user.id);
        }
      }
      return;
    }

    // Handle edit date selection (MUST come before edit_)
    if (selectedValue.startsWith("edit_date_select_")) {
      const parts = selectedValue.replace("edit_date_select_", "").split("_");
      const transactionId = parts[0];
      const dateStr = parts.slice(1).join("_");
      const { error } = await supabase.from("transactions").update({ transaction_date: dateStr }).eq("id", transactionId).eq("user_id", user.id);
      if (error) {
        await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao atualizar. Tente novamente.");
      } else {
        await sendTelegramMessage(chatId, `✅ Data atualizada para ${formatDateBR(dateStr)}!`);
        await incrementSessionSeq(supabase, user.id);
      }
      return;
    }

    // Handle edit date custom (MUST come before edit_)
    if (selectedValue.startsWith("edit_date_custom_")) {
      const transactionId = selectedValue.replace("edit_date_custom_", "");
      await sendTelegramMessage(chatId, "Informe a nova data (formato: DD/MM/YYYY):");
      await setWizardState(supabase, user.id, "edit_date", { transaction_id: transactionId });
      return;
    }

    // Handle edit group selection confirm (MUST come before generic edit_)
    if (selectedValue.startsWith("edit_group_sel_")) {
      const rest = selectedValue.replace("edit_group_sel_", "");
      const underscoreIdx = rest.indexOf("_");
      if (underscoreIdx > 0) {
        const transactionId = rest.substring(0, underscoreIdx);
        const groupName = rest.substring(underscoreIdx + 1);
        const { data: group } = await supabase.from("groups").select("id").eq("user_id", user.id).ilike("name", groupName).single();
        if (group) {
          const { error } = await supabase.from("transactions").update({ group_id: group.id }).eq("id", transactionId).eq("user_id", user.id);
          if (error) {
            await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao atualizar o grupo. Tente novamente.");
          } else {
            await sendTelegramMessage(chatId, `✅ Grupo alterado para "${groupName}"!`);
            await incrementSessionSeq(supabase, user.id);
          }
        }
      }
      return;
    }

    // Handle edit group selection
    if (selectedValue.startsWith("edit_group_")) {
      const transactionId = selectedValue.replace("edit_group_", "");
      const keyboard = await buildGroupKeyboard(supabase, user.id, sessionSeq, {
        callbackPrefix: `edit_group_sel_${transactionId}_`,
      });
      if (keyboard.length > 0) {
        await sendTelegramMessageWithKeyboard(chatId, "📁 Selecione o novo grupo:", keyboard);
      } else {
        await sendTelegramMessage(chatId, "📁 Nenhum grupo disponível. Crie um com /grupo");
      }
      return;
    }

    // Handle edit tags done (MUST come before edit_tags_)
    if (selectedValue.startsWith("edit_tags_done_")) {
      const transactionId = selectedValue.replace("edit_tags_done_", "");
      const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
      const tags = state?.data?.tags ? (Array.isArray(state.data.tags) ? state.data.tags : [state.data.tags]) : [];
      const formattedTags = tags.map((t: string) => t.startsWith("#") ? t : `#${t}`);
      await supabase.from("transactions").update({ tags: formattedTags }).eq("id", transactionId).eq("user_id", user.id);
      await clearWizardState(supabase, user.id);
      await incrementSessionSeq(supabase, user.id);
      const tagsStr = formattedTags.length > 0 ? formattedTags.join(" ") : "—";
      await sendTelegramMessage(chatId, `✅ Tags atualizadas: ${tagsStr}`);
      return;
    }

    // Handle edit tags clear (MUST come before edit_tags_)
    if (selectedValue.startsWith("edit_tags_clr_")) {
      const transactionId = selectedValue.replace("edit_tags_clr_", "");
      await supabase.from("transactions").update({ tags: [] }).eq("id", transactionId).eq("user_id", user.id);
      await clearWizardState(supabase, user.id);
      await incrementSessionSeq(supabase, user.id);
      await sendTelegramMessage(chatId, "✅ Tags removidas!");
      return;
    }

    // Handle edit tags - show tag selection interface
    if (selectedValue.startsWith("edit_tags_")) {
      const transactionId = selectedValue.replace("edit_tags_", "");

      // Get current transaction tags
      const { data: transaction } = await supabase.from("transactions").select("tags").eq("id", transactionId).eq("user_id", user.id).single();
      const currentTags: string[] = transaction?.tags || [];

      // Store working state for toggle handler
      await setWizardState(supabase, user.id, `edit_tags_${transactionId}`, { tags: currentTags, transaction_id: transactionId });

      const { keyboard } = await buildTagKeyboard(supabase, user.id, sessionSeq, {
        togglePrefix: `edit_tag_tog_${transactionId}_`,
        extraButtons: [
          [
            { text: "✅ Concluir", callback_data: truncateCallbackData(`edit_tags_done_${transactionId}`, sessionSeq) },
            { text: "⏭️ Limpar", callback_data: truncateCallbackData(`edit_tags_clr_${transactionId}`, sessionSeq) },
          ],
        ],
      });

      let prompt = `🔖 *Editar tags* (transação #${transactionId})\n`;
      if (currentTags.length > 0) {
        prompt += `\nAtuais: ${currentTags.join(" ")}\n`;
      }
      prompt += "\nClique nas tags para alternar ou digite uma nova.";

      await sendTelegramMessageWithKeyboard(chatId, prompt, keyboard);
      return;
    }

    // Handle edit tag toggle
    if (selectedValue.startsWith("edit_tag_tog_")) {
      const rest = selectedValue.replace("edit_tag_tog_", "");
      const underscoreIdx = rest.indexOf("_");
      if (underscoreIdx > 0) {
        const transactionId = rest.substring(0, underscoreIdx);
        const tag = rest.substring(underscoreIdx + 1);

        const newTags = await toggleTagInWizardState(supabase, user.id, tag);

        const { keyboard } = await buildTagKeyboard(supabase, user.id, sessionSeq, {
          togglePrefix: `edit_tag_tog_${transactionId}_`,
          extraButtons: [
            [
              { text: "✅ Concluir", callback_data: truncateCallbackData(`edit_tags_done_${transactionId}`, sessionSeq) },
              { text: "⏭️ Limpar", callback_data: truncateCallbackData(`edit_tags_clr_${transactionId}`, sessionSeq) },
            ],
          ],
        });

        let prompt = `🔖 *Editar tags* (transação #${transactionId})\n`;
        if (newTags.length > 0) {
          prompt += `\nSelecionadas: ${newTags.join(" ")}\n`;
        }
        prompt += "\nClique nas tags para alternar ou digite uma nova.";

        await editTelegramMessageWithKeyboard(chatId, message.message_id, prompt, keyboard);
      }
      return;
    }

    // Handle edit amount/category/date (generic - keep last among edit_ handlers)
    if (selectedValue.startsWith("edit_")) {
      const [action, transactionId] = selectedValue.replace("edit_", "").split("_");
      if (action === "amount") {
        await sendTelegramMessage(chatId, "Informe o novo valor:");
        await setWizardState(supabase, user.id, "edit_amount", { transaction_id: transactionId });
      } else if (action === "description" || action === "desc") {
        await sendTelegramMessage(chatId, "Informe a nova descrição:");
        await setWizardState(supabase, user.id, "edit_description", { transaction_id: transactionId });
      } else if (action === "category") {
        const keyboard = await buildCategoryKeyboard(supabase, user.id, sessionSeq, {
          callbackPrefix: `edit_cat_select_${transactionId}_`,
        });
        if (keyboard.length > 0) {
          await sendTelegramMessageWithKeyboard(chatId, "Escolha a nova categoria:", keyboard);
        } else {
          await sendTelegramMessage(chatId, "Nenhuma categoria disponível. Crie uma com /categoria");
        }
      } else if (action === "date") {
        const keyboard = buildDateKeyboard({
          todayCallback: (date) => truncateCallbackData(`edit_date_select_${transactionId}_${date}`, sessionSeq),
          yesterdayCallback: (date) => truncateCallbackData(`edit_date_select_${transactionId}_${date}`, sessionSeq),
          customCallback: addSession(`edit_date_custom_${transactionId}`, sessionSeq),
        });
        await sendTelegramMessageWithKeyboard(chatId, "Escolha a nova data:", keyboard);
      }
      return;
    }

    // Handle wizard new category/group - user wants to type a custom name
    if (selectedValue === "wizard_new_category" || selectedValue === "wizard_new_group") {
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const prompt = selectedValue === "wizard_new_category"
        ? "✏️ Digite o nome da nova categoria:"
        : "✏️ Digite o nome do novo grupo:";
      await sendTelegramMessage(chatId, prompt);
      // Keep the same step so the typed name is picked up by handleTransactionWizard
      return;
    }

    // Handle wizard tag toggle (multi-select)
    if (selectedValue.startsWith("wiz_tag_")) {
      const tag = selectedValue.replace("wiz_tag_", "");

      await toggleTagInWizardState(supabase, user.id, tag);

      // Re-render the wizard step message to show updated selection
      const { data: state } = await supabase.from("wizard_states").select("*").eq("user_id", user.id).maybeSingle();
      if (!state) return;
      const underscoreIndex = state.step.indexOf("_");
      const wizardName = state.step.substring(0, underscoreIndex);
      const stepKey = state.step.substring(underscoreIndex + 1);
      const { data: currentStep } = await supabase.from("wizard_steps").select("*").eq("wizard_name", wizardName).eq("step_key", stepKey).maybeSingle();
      if (currentStep) {
        await sendWizardStepMessage(chatId, currentStep, user.id, supabase, sessionSeq, message.message_id);
      }
      return;
    }

    // Handle wizard done tags (confirm multi-selection and advance)
    if (selectedValue === "wiz_done_tags") {
      const wizard = await getCurrentWizardStep(supabase, user.id);
      if (!wizard) return;
      const newStateData = { ...wizard.state.data };
      await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, sessionSeq, newStateData);
      return;
    }

    // Handle wizard skip description
    if (selectedValue === "wizard_skip_description") {
      const wizard = await getCurrentWizardStep(supabase, user.id);
      if (!wizard) return;
      const newStateData = { ...wizard.state.data, [wizard.currentStep.step_key]: "" };
      await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, sessionSeq, newStateData);
      return;
    }

    // Handle wizard skip tags
    if (selectedValue === "wizard_skip_tags") {
      const wizard = await getCurrentWizardStep(supabase, user.id);
      if (!wizard) return;
      const newStateData = { ...wizard.state.data, [wizard.currentStep.step_key]: "" };
      await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, sessionSeq, newStateData);
      return;
    }

    // Handle tag selection - show transactions with this tag
    if (selectedValue.startsWith("tag_sel_")) {
      const tag = selectedValue.replace("tag_sel_", "");
      await handleListByTag(supabase, telegramId, chatId, tag, 0, message.message_id);
      return;
    }

    // Handle balance/summary group filter
    if (selectedValue === "balance_shwgrp" || selectedValue.startsWith("balance_grp_")) {
      await handleGroupFilterCallback(supabase, telegramId, chatId, "balance", selectedValue);
      return;
    }

    if (selectedValue === "summary_shwgrp" || selectedValue.startsWith("summary_grp_")) {
      await handleGroupFilterCallback(supabase, telegramId, chatId, "summary", selectedValue);
      return;
    }

    // Handle category/group: select
    if (selectedValue.startsWith("cat_sel_")) {
      await handleEntitySelect("category", supabase, user.id, chatId, selectedValue.replace("cat_sel_", ""), sessionSeq);
      return;
    }
    if (selectedValue.startsWith("grp_sel_")) {
      await handleEntitySelect("group", supabase, user.id, chatId, selectedValue.replace("grp_sel_", ""), sessionSeq);
      return;
    }

    // Handle category/group: rename
    if (selectedValue.startsWith("cat_ren_")) {
      await handleEntityRename("category", supabase, user.id, chatId, selectedValue.replace("cat_ren_", ""));
      return;
    }
    if (selectedValue.startsWith("grp_ren_")) {
      await handleEntityRename("group", supabase, user.id, chatId, selectedValue.replace("grp_ren_", ""));
      return;
    }

    // Handle category/group: delete confirmed (MUST come before generic _del_)
    if (selectedValue.startsWith("cat_del_yes_")) {
      await handleEntityDeleteExecute("category", supabase, user.id, chatId, selectedValue.replace("cat_del_yes_", ""));
      return;
    }
    if (selectedValue.startsWith("grp_del_yes_")) {
      await handleEntityDeleteExecute("group", supabase, user.id, chatId, selectedValue.replace("grp_del_yes_", ""));
      return;
    }

    // Handle category/group: delete confirm prompt (generic, keep last)
    if (selectedValue.startsWith("cat_del_")) {
      await handleEntityDeletePrompt("category", supabase, user.id, chatId, selectedValue.replace("cat_del_", ""), sessionSeq);
      return;
    }
    if (selectedValue.startsWith("grp_del_")) {
      await handleEntityDeletePrompt("group", supabase, user.id, chatId, selectedValue.replace("grp_del_", ""), sessionSeq);
      return;
    }

    // Handle category/group: back
    if (selectedValue === "cat_back") {
      await handleEntityBack("category", supabase, user.id, chatId);
      return;
    }
    if (selectedValue === "grp_back") {
      await handleEntityBack("group", supabase, user.id, chatId);
      return;
    }

    // Handle category/group: suggestion use/create
    if (selectedValue === "cat_sug_use") {
      await handleEntitySuggestion("category", supabase, user.id, chatId, "use");
      return;
    }
    if (selectedValue === "cat_sug_new") {
      await handleEntitySuggestion("category", supabase, user.id, chatId, "new");
      return;
    }
    if (selectedValue === "grp_sug_use") {
      await handleEntitySuggestion("group", supabase, user.id, chatId, "use");
      return;
    }
    if (selectedValue === "grp_sug_new") {
      await handleEntitySuggestion("group", supabase, user.id, chatId, "new");
      return;
    }

    // Handle custom_date for wizards
    if (selectedValue === "custom_date") {
      const state = await getWizardState(supabase, user.id);
      if (!state) return;
      const underscoreIndex = state.step.indexOf("_");
      const currentWizardName = state.step.substring(0, underscoreIndex);
      await sendTelegramMessage(chatId, "Informe a data (formato: DD/MM/YYYY):");
      await setWizardState(supabase, user.id, `${currentWizardName}_custom_date`, state.data);
      return;
    }

    // Handle generic wizard selections — only process if callback matches current step
    const wizard = await getCurrentWizardStep(supabase, user.id);
    if (!wizard) return;
    const stepKey = wizard.currentStep.step_key;
    const prefix = `wiz_${stepKey}_`;
    if (selectedValue.startsWith(prefix)) {
      const value = selectedValue.replace(prefix, "");
      const newStateData = { ...wizard.state.data, [stepKey]: value };
      await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, sessionSeq, newStateData);
    }
  } catch (error) {
    console.error("Error handling callback query:", error);
    await sendTelegramMessage(callbackQuery.message.chat.id, "❌ Ops! Algo deu errado. Tente novamente.");
  }
}
