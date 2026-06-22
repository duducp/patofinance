import { InlineKeyboard, DeepSeekResponse, TelegramCallbackQuery } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard, answerCallbackQuery } from "../services/telegram.ts";
import { getOrCreateUser, normalizeString, deleteTransactionById, userOrNullFilter, getOrCreateCategory, getOrCreateGroup, updateRecurrence } from "../services/database.ts";
import { formatDateBR, parseDateBR, getTodayISOBR } from "../utils/formatting.ts";
import { FREQ_LABELS } from "./wizard.ts";

import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { getWizardState, setWizardState, clearWizardState, sendWizardStepMessage, getCurrentWizardStep, advanceWizardToNextStep, toggleTagInWizardState, buildTagKeyboard, buildCategoryKeyboard, buildGroupKeyboard, buildDateKeyboard, buildStepConfirmation, handleWizardSkip, handleEntityRename, handleEntityDeletePrompt, handleEntityDeleteExecute } from "./wizard.ts";
import { executeNaturalLanguageAction } from "./nl-processing.ts";
import { handleBalance, handleSummary, handleDetails, handleGroup, handleCategory, handleTransaction, showDetailsEditActions, showDetailsMainView } from "./commands.ts";
import { handleRecurrences } from "./recurrences.ts";
import { handleListTransactions, handleListByTag, handleSearch, showDeleteConfirmation } from "./management.ts";
import { handleStatement, handleFilterCallback } from "./statement.ts";
import { addSession, removeSession, validateCallbackSession, getSessionSeq, incrementSessionSeq } from "../utils/session.ts";

/**
 * Remove unused entities (categories or groups) that have no associated transactions.
 */
async function removeUnusedEntities(
  supabase: any,
  userId: number,
  table: string,
  fkColumn: string,
  ownerColumn: number,
  flagColumn: string,
  flagValue: boolean,
): Promise<void> {
  const { data: usedIds } = await supabase
    .from("transactions")
    .select(fkColumn)
    .eq("user_id", userId)
    .not(fkColumn, "is", null);
  const usedSet = new Set((usedIds || []).map((t: any) => t[fkColumn]));
  const { data: allEntities } = await supabase
    .from(table)
    .select("id")
    .eq("user_id", ownerColumn)
    .eq(flagColumn, flagValue);
  const unusedIds = (allEntities || [])
    .filter((e: any) => !usedSet.has(e.id))
    .map((e: any) => e.id);
  if (unusedIds.length > 0) {
    await supabase.from(table).delete().in("id", unusedIds);
  }
}

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
      const { data: tx } = await supabase
        .from("transactions")
        .select("id, recurrence_id, amount, description")
        .eq("id", transactionId)
        .eq("user_id", user.id)
        .single();
      const recId = tx?.recurrence_id;
      const { success } = await deleteTransactionById(supabase, user.id, transactionId);
      if (success) {
        await sendTelegramMessage(chatId, "✅ Transação excluída com sucesso!");
        if (recId) {
          const { handleSkipRecurrence } = await import("./recurrences.ts");
          await handleSkipRecurrence(supabase, telegramId, chatId, recId);
        }
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
      await removeUnusedEntities(supabase, user.id, "categories", "category_id", user.id, "is_predefined", false);
      await removeUnusedEntities(supabase, user.id, "groups", "group_id", user.id, "is_default", false);
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

    // Handle description prompt for transactions
    if (selectedValue.startsWith("tx_desc_sim_")) {
      const txId = selectedValue.replace("tx_desc_sim_", "");
      const state = await getWizardState(supabase, user.id);
      if (!state || state.step !== "tx_ask_desc") return;
      await setWizardState(supabase, user.id, `tx_await_desc_${txId}`, state.data);
      await editTelegramMessageWithKeyboard(chatId, message.message_id, "✏️ Digitando descrição...", []);
      await sendTelegramMessage(chatId, "✏️ Digite a descrição:");
      return;
    }

    if (selectedValue.startsWith("tx_desc_nao_")) {
      const txId = selectedValue.replace("tx_desc_nao_", "");
      const state = await getWizardState(supabase, user.id);
      if (!state || state.step !== "tx_ask_desc") return;
      await clearWizardState(supabase, user.id);
      const { sendTransactionSuccess } = await import("./queries.ts");
      await sendTransactionSuccess(supabase, chatId, user.id, state.data.type, {
        amount: state.data.amount,
        category: state.data.category,
        group: state.data.group,
        date: state.data.date,
        description: "",
        tags: state.data.tags,
        transactionId: parseInt(txId, 10),
      });
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

    // Handle recurrence list pagination
    if (selectedValue.startsWith("rec_page_")) {
      const page = parseInt(selectedValue.replace("rec_page_", ""), 10);
      if (!isNaN(page)) {
        await handleRecurrences(supabase, telegramId, chatId, page, message.message_id);
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
      // Edit the NL category selection message in-place to show the prompt
      await editTelegramMessageWithKeyboard(chatId, message.message_id, "✏️ Digite o nome da nova categoria:", []);
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
      // Edit date keyboard to show "Outra data" as confirmation before sending prompt
      await editTelegramMessageWithKeyboard(chatId, message.message_id, "📅 Alterando data...", []);
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
      await editTelegramMessageWithKeyboard(chatId, message.message_id, "📁 Alterando grupo...", []);
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

      // Edit the action menu in-place to show which field is being changed
      await editTelegramMessageWithKeyboard(chatId, message.message_id, "🔖 Alterando tags...", []);

      // Get current transaction tags
      const { data: transaction } = await supabase.from("transactions").select("tags").eq("id", transactionId).eq("user_id", user.id).single();
      const currentTags: string[] = transaction?.tags || [];

      // Store working state for toggle handler
      await setWizardState(supabase, user.id, `edit_tags_${transactionId}`, { tags: currentTags, transaction_id: transactionId });

      const { keyboard, hasExistingTags } = await buildTagKeyboard(supabase, user.id, sessionSeq, {
        togglePrefix: `edit_tag_tog_${transactionId}_`,
      });

      if (hasExistingTags) {
        keyboard.push([
          { text: "✅ Concluir", callback_data: truncateCallbackData(`edit_tags_done_${transactionId}`, sessionSeq) },
          { text: "⏭️ Limpar", callback_data: truncateCallbackData(`edit_tags_clr_${transactionId}`, sessionSeq) },
        ]);
      } else {
        keyboard.push([
          { text: "✅ Concluir", callback_data: truncateCallbackData(`edit_tags_done_${transactionId}`, sessionSeq) },
        ]);
      }

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

        const { keyboard, hasExistingTags } = await buildTagKeyboard(supabase, user.id, sessionSeq, {
          togglePrefix: `edit_tag_tog_${transactionId}_`,
        });

        if (hasExistingTags) {
          keyboard.push([
            { text: "✅ Concluir", callback_data: truncateCallbackData(`edit_tags_done_${transactionId}`, sessionSeq) },
            { text: "⏭️ Limpar", callback_data: truncateCallbackData(`edit_tags_clr_${transactionId}`, sessionSeq) },
          ]);
        } else {
          keyboard.push([
            { text: "✅ Concluir", callback_data: truncateCallbackData(`edit_tags_done_${transactionId}`, sessionSeq) },
          ]);
        }

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
        await editTelegramMessageWithKeyboard(chatId, message.message_id, "💰 Alterando valor...", []);
        await sendTelegramMessage(chatId, "Informe o novo valor:");
        await setWizardState(supabase, user.id, "edit_amount", { transaction_id: transactionId });
      } else if (action === "description" || action === "desc") {
        await editTelegramMessageWithKeyboard(chatId, message.message_id, "📝 Alterando descrição...", []);
        await sendTelegramMessage(chatId, "Informe a nova descrição:");
        await setWizardState(supabase, user.id, "edit_description", { transaction_id: transactionId });
      } else if (action === "category") {
        await editTelegramMessageWithKeyboard(chatId, message.message_id, "🏷️ Alterando categoria...", []);
        const keyboard = await buildCategoryKeyboard(supabase, user.id, sessionSeq, {
          callbackPrefix: `edit_cat_select_${transactionId}_`,
        });
        if (keyboard.length > 0) {
          await sendTelegramMessageWithKeyboard(chatId, "Escolha a nova categoria:", keyboard);
        } else {
          await sendTelegramMessage(chatId, "Nenhuma categoria disponível. Crie uma com /categoria");
        }
      } else if (action === "date") {
        await editTelegramMessageWithKeyboard(chatId, message.message_id, "📅 Alterando data...", []);
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
      const isCategory = selectedValue === "wizard_new_category";
      const prompt = isCategory
        ? "✏️ Digite o nome da nova categoria:"
        : "✏️ Digite o nome do novo grupo:";

      // Edit the callback message in-place to show the prompt (replaces the keyboard)
      await editTelegramMessageWithKeyboard(chatId, message.message_id, prompt, []);

      // Store the callback message ID as the promptMessageId so advanceWithConfirmation
      // edits THIS message to the confirmation text (e.g., "✅ 🏷️ Categoria: Mercado")
      const key = isCategory ? "_categoryPromptMessageId" : "_groupPromptMessageId";
      const { data: currentState } = await supabase
        .from("wizard_states")
        .select("data")
        .eq("user_id", user.id)
        .maybeSingle();
      if (currentState) {
        await supabase.from("wizard_states").update({
          data: { ...currentState.data, [key]: message.message_id },
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }).eq("user_id", user.id);
      }
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
      await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, sessionSeq, newStateData, message.message_id);
      return;
    }

    // Handle wizard skip (description or tags)
    if (selectedValue === "wizard_skip_description" || selectedValue === "wizard_skip_tags") {
      await handleWizardSkip(supabase, user.id, chatId, sessionSeq, message.message_id);
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
      await handleEntityRename("category", supabase, user.id, chatId, selectedValue.replace("cat_ren_", ""), message.message_id);
      return;
    }
    if (selectedValue.startsWith("grp_ren_")) {
      await handleEntityRename("group", supabase, user.id, chatId, selectedValue.replace("grp_ren_", ""), message.message_id);
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
    if (selectedValue === "cat_back" || selectedValue === "grp_back") {
      await handleEntityBack(
        selectedValue === "cat_back" ? "category" : "group",
        supabase, telegramId, chatId
      );
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
      const stateData = await getWizardState(supabase, user.id);
      if (!stateData) return;
      const underscoreIndex = stateData.step.indexOf("_");
      const currentWizardName = stateData.step.substring(0, underscoreIndex);
      const stepKey = stateData.step.substring(underscoreIndex + 1);

      // Edit the callback message in-place to show the date prompt (replaces date keyboard)
      await editTelegramMessageWithKeyboard(chatId, message.message_id, "📅 Informe a data (formato: DD/MM/YYYY):", []);

      // For start_date (recurrence wizard), keep the original step so
      // handleWizardInput processes the text input.
      // For date steps (gasto/receita), use the _custom_date suffix which
      // handleWizardInput explicitly handles.
      const newStep = stepKey === "start_date"
        ? stateData.step
        : `${currentWizardName}_custom_date`;

      await setWizardState(supabase, user.id, newStep, {
        ...stateData.data,
        _customDatePromptMessageId: message.message_id,
      });
      return;
    }

    // ========== Recurrence callbacks ==========

    // Transform transaction into recurrence
    if (selectedValue.startsWith("rec_transform_")) {
      const transactionId = selectedValue.replace("rec_transform_", "");
      const { data: tx } = await supabase
        .from("transactions")
        .select("*, categories(name), groups(name)")
        .eq("id", transactionId)
        .eq("user_id", user.id)
        .single();
      if (!tx) return;

      // Pre-fill all fields from existing transaction, skip directly to frequency step
      const prefill = {
        type: tx.type,
        amount: tx.amount.toString(),
        description: tx.description || "",
        category: tx.categories?.name || "",
        group: tx.groups?.name || "",
        tags: tx.tags || [],
        start_date: tx.transaction_date || getTodayISOBR(),
      };
      await setWizardState(supabase, user.id, "recorrencia_frequency", prefill);
      const { data: freqStep } = await supabase
        .from("wizard_steps")
        .select("*")
        .eq("wizard_name", "recorrencia")
        .eq("step_key", "frequency")
        .single();
      if (freqStep) {
        await incrementSessionSeq(supabase, user.id);
        const newSeq = await getSessionSeq(supabase, user.id);
        await sendWizardStepMessage(chatId, freqStep, user.id, supabase, newSeq);
      }
      return;
    }

    if (selectedValue === "rec_new") {
      await setWizardState(supabase, user.id, "recorrencia_type", {});
      const { data: nextStep } = await supabase
        .from("wizard_steps")
        .select("*")
        .eq("wizard_name", "recorrencia")
        .eq("step_key", "type")
        .single();
      if (nextStep) {
        await incrementSessionSeq(supabase, user.id);
        const newSeq = await getSessionSeq(supabase, user.id);
        await sendWizardStepMessage(chatId, nextStep, user.id, supabase, newSeq);
      }
      return;
    }

    if (selectedValue === "rec_manage") {
      const { handleManageRecurrences } = await import("./recurrences.ts");
      await handleManageRecurrences(supabase, telegramId, chatId);
      return;
    }

    if (selectedValue.startsWith("rec_txlist_")) {
      const rest = selectedValue.replace("rec_txlist_", "");
      // Format: rec_txlist_{id} or rec_txlist_{id}_p{page}
      const pIdx = rest.lastIndexOf("_p");
      let recId: number, page: number;
      if (pIdx > 0) {
        recId = parseInt(rest.substring(0, pIdx), 10);
        page = parseInt(rest.substring(pIdx + 2), 10) || 0;
      } else {
        recId = parseInt(rest, 10);
        page = 0;
      }
      if (!isNaN(recId)) {
        const { handleRecurrenceTransactions } = await import("./recurrences.ts");
        await handleRecurrenceTransactions(supabase, telegramId, chatId, recId, page, message.message_id);
      }
      return;
    }

    if (selectedValue === "rec_back") {
      await handleRecurrences(supabase, telegramId, chatId);
      return;
    }

    if (selectedValue.startsWith("rec_show_")) {
      const recId = parseInt(selectedValue.replace("rec_show_", ""), 10);
      if (!isNaN(recId)) {
        const { handleRecurrenceDetail } = await import("./recurrences.ts");
        await handleRecurrenceDetail(supabase, telegramId, chatId, recId, message.message_id);
      }
      return;
    }

    // Specific confirm handlers MUST come before generic prompt handlers
    if (selectedValue.startsWith("rec_advance_yes_")) {
      const recId = parseInt(selectedValue.replace("rec_advance_yes_", ""), 10);
      if (!isNaN(recId)) {
        const { handleAdvanceRecurrenceConfirm } = await import("./recurrences.ts");
        await handleAdvanceRecurrenceConfirm(supabase, telegramId, chatId, recId);
      }
      return;
    }

    if (selectedValue.startsWith("rec_advance_") && !selectedValue.startsWith("rec_advance_yes_")) {
      const recId = parseInt(selectedValue.replace("rec_advance_", ""), 10);
      if (!isNaN(recId)) {
        const { handleAdvanceRecurrence } = await import("./recurrences.ts");
        await handleAdvanceRecurrence(supabase, telegramId, chatId, recId);
      }
      return;
    }

    if (selectedValue.startsWith("rec_skip_yes_")) {
      const recId = parseInt(selectedValue.replace("rec_skip_yes_", ""), 10);
      if (!isNaN(recId)) {
        const { handleSkipRecurrenceConfirm } = await import("./recurrences.ts");
        await handleSkipRecurrenceConfirm(supabase, telegramId, chatId, recId);
      }
      return;
    }

    if (selectedValue.startsWith("rec_skip_") && !selectedValue.startsWith("rec_skip_yes_")) {
      const recId = parseInt(selectedValue.replace("rec_skip_", ""), 10);
      if (!isNaN(recId)) {
        const { handleSkipRecurrence } = await import("./recurrences.ts");
        await handleSkipRecurrence(supabase, telegramId, chatId, recId);
      }
      return;
    }

    if (selectedValue.startsWith("rec_archive_yes_")) {
      const recId = parseInt(selectedValue.replace("rec_archive_yes_", ""), 10);
      if (!isNaN(recId)) {
        const { handleArchiveRecurrenceConfirm } = await import("./recurrences.ts");
        await handleArchiveRecurrenceConfirm(supabase, telegramId, chatId, recId);
      }
      return;
    }

    if (selectedValue.startsWith("rec_archive_") && !selectedValue.startsWith("rec_archive_yes_")) {
      const recId = parseInt(selectedValue.replace("rec_archive_", ""), 10);
      if (!isNaN(recId)) {
        const { handleArchiveRecurrence } = await import("./recurrences.ts");
        await handleArchiveRecurrence(supabase, telegramId, chatId, recId);
      }
      return;
    }

    if (selectedValue.startsWith("rec_activate_yes_")) {
      const recId = parseInt(selectedValue.replace("rec_activate_yes_", ""), 10);
      if (!isNaN(recId)) {
        const { handleActivateRecurrenceConfirm } = await import("./recurrences.ts");
        await handleActivateRecurrenceConfirm(supabase, telegramId, chatId, recId);
      }
      return;
    }

    if (selectedValue.startsWith("rec_activate_") && !selectedValue.startsWith("rec_activate_yes_")) {
      const recId = parseInt(selectedValue.replace("rec_activate_", ""), 10);
      if (!isNaN(recId)) {
        const { handleActivateRecurrence } = await import("./recurrences.ts");
        await handleActivateRecurrence(supabase, telegramId, chatId, recId);
      }
      return;
    }

    // rec_edit_field_ and rec_edit_set_* MUST come before generic rec_edit_
    if (selectedValue.startsWith("rec_edit_field_")) {
      const rest = selectedValue.replace("rec_edit_field_", "");
      const underscoreIdx = rest.indexOf("_");
      const field = rest.substring(0, underscoreIdx);
      const recId = parseInt(rest.substring(underscoreIdx + 1), 10);
      if (!isNaN(recId) && field) {
        if (field === "amount" || field === "description" || field === "start_date") {
          const editLabels: Record<string, string> = {
            amount: "💰 Alterando valor...",
            description: "📝 Alterando descrição...",
            start_date: "📅 Alterando data de início...",
          };
          const prompts: Record<string, string> = {
            amount: "💰 Digite o novo valor:",
            description: "📝 Digite a nova descrição:",
            start_date: "📅 Digite a nova data de início (DD/MM/YYYY):",
          };

          // Edit the action menu to show which field is being changed
          await editTelegramMessageWithKeyboard(chatId, message.message_id, editLabels[field], []);

          const msgId = await sendTelegramMessage(chatId, prompts[field]);
          await setWizardState(supabase, user.id, `rec_edit_${field}`, {
            recurrence_id: recId,
            ...(field === "start_date" && msgId ? { _startDatePromptMessageId: msgId } : {}),
          });
        } else if (field === "category" || field === "group" || field === "frequency" || field === "tags") {
          if (field === "category") {
            await editTelegramMessageWithKeyboard(chatId, message.message_id, "🏷️ Alterando categoria...", []);
            const cb = await buildCategoryKeyboard(supabase, user.id, sessionSeq, {
              callbackPrefix: `rec_edit_set_cat_${recId}_`,
            });
            await sendTelegramMessageWithKeyboard(chatId, "🏷️ Selecione a nova categoria:", cb);
          } else if (field === "group") {
            await editTelegramMessageWithKeyboard(chatId, message.message_id, "📁 Alterando grupo...", []);
            const cb = await buildGroupKeyboard(supabase, user.id, sessionSeq, {
              callbackPrefix: `rec_edit_set_grp_${recId}_`,
            });
            if (cb.length > 0) {
              await sendTelegramMessageWithKeyboard(chatId, "📁 Selecione o novo grupo:", cb);
            } else {
              await sendTelegramMessage(chatId, "📁 Nenhum grupo encontrado. Crie um com /grupo");
            }
          } else if (field === "frequency") {
            await editTelegramMessageWithKeyboard(chatId, message.message_id, "🔄 Alterando frequência...", []);
            const { data: stepData } = await supabase
              .from("wizard_steps")
              .select("id")
              .eq("wizard_name", "recorrencia")
              .eq("step_key", "frequency")
              .single();
            if (stepData) {
              const { data: options } = await supabase
                .from("wizard_step_options")
                .select("value, label")
                .eq("step_id", stepData.id)
                .order("sort_order");
              const freqKeyboard: InlineKeyboard = (options || []).map((o: any) => [
                { text: o.label, callback_data: addSession(`rec_edit_set_freqtype_${recId}_${o.value}`, sessionSeq) },
              ]);
              freqKeyboard.push([{ text: "⬅ Voltar", callback_data: addSession(`rec_edit_${recId}`, sessionSeq) }]);
              await sendTelegramMessageWithKeyboard(chatId, "🔄 Selecione a nova frequência:", freqKeyboard);
            }
          } else if (field === "tags") {
            await editTelegramMessageWithKeyboard(chatId, message.message_id, "🔖 Alterando tags...", []);
            const { keyboard, hasExistingTags } = await buildTagKeyboard(supabase, user.id, sessionSeq, {
              togglePrefix: `rec_edit_set_tag_${recId}_`,
            });
            if (hasExistingTags) {
              keyboard.push([
                { text: "✅ Concluir", callback_data: addSession(`rec_edit_set_tag_${recId}_done`, sessionSeq) },
                { text: "🗑️ Limpar tags", callback_data: addSession(`rec_edit_set_tag_${recId}_clr`, sessionSeq) },
              ]);
            } else {
              keyboard.push([
                { text: "✅ Concluir", callback_data: addSession(`rec_edit_set_tag_${recId}_done`, sessionSeq) },
              ]);
            }
            await sendTelegramMessageWithKeyboard(chatId, "🔖 Selecione as tags:", keyboard);
          }
        }
      }
      return;
    }

    if (selectedValue.startsWith("rec_edit_set_cat_")) {
      const rest = selectedValue.replace("rec_edit_set_cat_", "");
      const delimIdx = rest.indexOf("_");
      const recId = parseInt(rest.substring(0, delimIdx), 10);
      const catName = rest.substring(delimIdx + 1);
      if (!isNaN(recId) && catName) {
        const cat = await getOrCreateCategory(supabase, user.id, catName, undefined);
        if (cat) {
          await updateRecurrence(supabase, user.id, recId, { category_id: cat });
          await incrementSessionSeq(supabase, user.id);
          await sendTelegramMessage(chatId, `✅ Categoria alterada para "${catName}"!`);
        }
      }
      return;
    }

    if (selectedValue.startsWith("rec_edit_set_grp_")) {
      const rest = selectedValue.replace("rec_edit_set_grp_", "");
      const delimIdx = rest.indexOf("_");
      const recId = parseInt(rest.substring(0, delimIdx), 10);
      const grpName = rest.substring(delimIdx + 1);
      if (!isNaN(recId) && grpName) {
        const grp = await getOrCreateGroup(supabase, user.id, grpName);
        if (grp) {
          await updateRecurrence(supabase, user.id, recId, { group_id: grp });
          await incrementSessionSeq(supabase, user.id);
          await sendTelegramMessage(chatId, `✅ Grupo alterado para "${grpName}"!`);
        }
      }
      return;
    }

    if (selectedValue.startsWith("rec_edit_set_freqtype_")) {
      const rest = selectedValue.replace("rec_edit_set_freqtype_", "");
      const parts = rest.split("_");
      const recId = parseInt(parts[0], 10);
      const freqType = parts.slice(1).join("_");
      if (!isNaN(recId) && freqType) {
        const confirmLabel = FREQ_LABELS[freqType] || freqType;

        // Edit the frequency keyboard to show confirmation before proceeding
        await editTelegramMessageWithKeyboard(chatId, message.message_id, `✅ 🔄 Frequência: ${confirmLabel}`, []);

        if (freqType === "daily") {
          await updateRecurrence(supabase, user.id, recId, { frequency_type: freqType, frequency_interval: 1, frequency_month: null });
          await incrementSessionSeq(supabase, user.id);
          await sendTelegramMessage(chatId, "✅ Frequência alterada para Diária!");
        } else {
          await setWizardState(supabase, user.id, "rec_edit_freq_detail", { recurrence_id: recId, frequency_type: freqType });
          const prompts: Record<string, string> = {
            weekly: "📅 Qual dia da semana? (0=Dom a 6=Sáb)",
            monthly: "📅 Qual dia do mês? (1 a 31)",
            annual: "📅 Qual dia e mês? (DD/MM)",
            every_x_days: "📅 A cada quantos dias?",
          };
          const msgId = await sendTelegramMessage(chatId, prompts[freqType] || "📅 Informe o detalhe da frequência:");
          await supabase.from("wizard_states").update({
            data: { recurrence_id: recId, frequency_type: freqType, _freqDetailPromptMessageId: msgId },
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          }).eq("user_id", user.id);
        }
      }
      return;
    }

    if (selectedValue.startsWith("rec_edit_set_tag_")) {
      const rest = selectedValue.replace("rec_edit_set_tag_", "");
      if (rest.endsWith("_done")) {
        const recId = parseInt(rest.replace("_done", ""), 10);
        if (!isNaN(recId)) {
          await incrementSessionSeq(supabase, user.id);
          await sendTelegramMessage(chatId, "✅ Tags atualizadas!");
        }
        return;
      }
      if (rest.endsWith("_clr")) {
        const recId = parseInt(rest.replace("_clr", ""), 10);
        if (!isNaN(recId)) {
          const { data: existing } = await supabase.from("recurrences").select("tags").eq("id", recId).eq("user_id", user.id).single();
          const currentTags: string[] = existing?.tags || [];
          if (currentTags.length > 0) {
            await updateRecurrence(supabase, user.id, recId, { tags: [] });
          }
          await incrementSessionSeq(supabase, user.id);
          await sendTelegramMessage(chatId, "🗑️ Tags removidas!");
        }
        return;
      }
      // It's a toggle - format: {recId}_#tagname
      const parts = rest.split("_#");
      const recId = parseInt(parts[0], 10);
      if (!isNaN(recId) && parts.length > 1) {
        const tag = `#${parts.slice(1).join("_#")}`;
        const { data: existing } = await supabase.from("recurrences").select("tags").eq("id", recId).eq("user_id", user.id).single();
        const currentTags: string[] = existing?.tags || [];
        const newTags = currentTags.includes(tag)
          ? currentTags.filter((t: string) => t !== tag)
          : [...currentTags, tag];
        await updateRecurrence(supabase, user.id, recId, { tags: newTags });
        // Re-render the tag keyboard
        const { keyboard, hasExistingTags } = await buildTagKeyboard(supabase, user.id, sessionSeq, {
          togglePrefix: `rec_edit_set_tag_${recId}_`,
        });
        if (hasExistingTags) {
          keyboard.push([
            { text: "✅ Concluir", callback_data: addSession(`rec_edit_set_tag_${recId}_done`, sessionSeq) },
            { text: "🗑️ Limpar tags", callback_data: addSession(`rec_edit_set_tag_${recId}_clr`, sessionSeq) },
          ]);
        } else {
          keyboard.push([
            { text: "✅ Concluir", callback_data: addSession(`rec_edit_set_tag_${recId}_done`, sessionSeq) },
          ]);
        }
        await editTelegramMessageWithKeyboard(chatId, message.message_id, "🔖 Selecione as tags:", keyboard);
      }
      return;
    }

    // Generic rec_edit_ handler (MUST come after specific rec_edit_field_ and rec_edit_set_*)
    if (selectedValue.startsWith("rec_edit_")) {
      const recId = parseInt(selectedValue.replace("rec_edit_", ""), 10);
      if (!isNaN(recId)) {
        const { handleEditRecurrence } = await import("./recurrences.ts");
        await handleEditRecurrence(supabase, telegramId, chatId, recId);
      }
      return;
    }

    // Handle frequency selection for recurrence wizard — intercept BEFORE generic wizard handler
    // because we need to store as `frequency_type` (not `frequency`) and handle sub-steps
    if (selectedValue.startsWith("wiz_frequency_")) {
      const freqWizard = await getCurrentWizardStep(supabase, user.id);
      if (!freqWizard || freqWizard.currentStep.wizard_name !== "recorrencia") return;
      const freq = selectedValue.replace("wiz_frequency_", "");
      const newStateData = { ...freqWizard.state.data, frequency_type: freq, frequency_interval: freq === "daily" ? 1 : undefined };

      if (freq === "daily") {
        await advanceWizardToNextStep(supabase, user.id, chatId, freqWizard.currentStep, sessionSeq, newStateData, message.message_id);
      } else {
        // Edit frequency keyboard to show confirmation before sending detail prompt
        const confirmText = buildStepConfirmation(freqWizard.currentStep, newStateData);
        if (confirmText) {
          await editTelegramMessageWithKeyboard(chatId, message.message_id, confirmText, []);
        }

        await setWizardState(supabase, user.id, "recorrencia_freq_detail", {
          ...freqWizard.state.data,
          frequency_type: freq,
        });
        const prompts: Record<string, string> = {
          weekly: "📅 *Qual dia da semana?*",
          monthly: "📅 *Qual dia do mês?* (1 a 31)",
          annual: "📅 *Qual dia e mês?* (formato: DD/MM)",
          every_x_days: "📅 *A cada quantos dias?*",
        };
        if (freq === "weekly") {
          const days = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
          const kb: InlineKeyboard = [days.map((d, i) => ({
            text: d,
            callback_data: addSession(`wiz_freq_detail_${i}`, sessionSeq),
          }))];
          await sendTelegramMessageWithKeyboard(chatId, prompts[freq]!, kb);
        } else {
          const msgId = await sendTelegramMessage(chatId, prompts[freq]!);
          if (msgId) {
            await supabase.from("wizard_states").update({
              data: { ...freqWizard.state.data, frequency_type: freq, _freqDetailPromptMessageId: msgId },
              expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            }).eq("user_id", user.id);
          }
        }
      }
      return;
    }

    // Handle weekly day-of-week selection during recurrence creation
    if (selectedValue.startsWith("wiz_freq_detail_")) {
      const detail = selectedValue.replace("wiz_freq_detail_", "");
      const freqWizard = await getCurrentWizardStep(supabase, user.id);
      if (!freqWizard || freqWizard.currentStep.wizard_name !== "recorrencia") return;
      const day = parseInt(detail, 10);
      if (!isNaN(day) && day >= 0 && day <= 6) {
        const { data: freqStep } = await supabase
          .from("wizard_steps")
          .select("*")
          .eq("wizard_name", "recorrencia")
          .eq("step_key", "frequency")
          .single();
        if (freqStep) {
          await advanceWizardToNextStep(supabase, user.id, chatId, freqStep, sessionSeq, {
            ...freqWizard.state.data,
            frequency_type: "weekly",
            frequency_interval: day,
          }, message.message_id);
        }
      }
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
      await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, sessionSeq, newStateData, message.message_id);
    }
  } catch (error) {
    console.error("Error handling callback query:", error);
    await sendTelegramMessage(callbackQuery.message.chat.id, "❌ Ops! Algo deu errado. Tente novamente.");
  }
}
