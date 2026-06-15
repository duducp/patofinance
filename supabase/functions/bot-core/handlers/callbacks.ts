import { InlineKeyboard, DeepSeekResponse, TelegramCallbackQuery } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard, answerCallbackQuery } from "../services/telegram.ts";
import { getOrCreateUser, normalizeString, getAllUserTags } from "../services/database.ts";
import { formatDateBR, getTodayISOBR } from "../utils/formatting.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { getWizardState, setWizardState, clearWizardState, completeWizard, sendWizardStepMessage, getCurrentWizardStep, advanceWizardToNextStep } from "./wizard.ts";
import { executeNaturalLanguageAction } from "./nl-processing.ts";
import { handleStatement, handleBalance, handleSummary, handleEdit, handleGroup, handleCategory } from "./commands.ts";
import { handleListTransactions, handleListByTag } from "./management.ts";

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
    const { data: groups } = await supabase.from("groups").select("name").eq("user_id", user.id).order("name");
    if (groups && groups.length > 0) {
      const keyboard: InlineKeyboard = groups.map((g: any) => [
        { text: g.name, callback_data: `${prefix}_grp_${g.name}` }
      ]);
      keyboard.push([{ text: "📋 Todas as contas", callback_data: `${prefix}_grp_all` }]);
      const title = prefix === "balance" ? "balance" : "summary";
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
    }      // Handle cleanup (clean up unused categories/groups)
    if (selectedValue === "confirm_cleanup") {
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;

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
        .eq("user_id", user.id);
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
            : "all" as const;
          await handleStatement(supabase, telegramId, chatId, page, filter);
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
    if (selectedValue.startsWith("edit_show_")) {
      const transactionId = selectedValue.replace("edit_show_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      await handleEdit(supabase, telegramId, chatId, [transactionId]);
      return;
    }

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

    // Handle edit group selection
    if (selectedValue.startsWith("edit_group_")) {
      const transactionId = selectedValue.replace("edit_group_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: groups } = await supabase.from("groups").select("name").eq("user_id", user.id).order("name");
      if (groups && groups.length > 0) {
        const keyboard: InlineKeyboard = groups.map((g: any) => [
          { text: g.name, callback_data: truncateCallbackData(`edit_group_sel_${transactionId}_${g.name}`) }
        ]);
        await sendTelegramMessageWithKeyboard(chatId, "📁 Selecione o novo grupo:", keyboard);
      } else {
        await sendTelegramMessage(chatId, "📁 Nenhum grupo disponível. Crie um com /grupo");
      }
      return;
    }

    // Handle edit group selection confirm
    if (selectedValue.startsWith("edit_group_sel_")) {
      const rest = selectedValue.replace("edit_group_sel_", "");
      const underscoreIdx = rest.indexOf("_");
      if (underscoreIdx > 0) {
        const transactionId = rest.substring(0, underscoreIdx);
        const groupName = rest.substring(underscoreIdx + 1);
        const user = await getOrCreateUser(supabase, telegramId);
        if (!user) return;
        const { data: group } = await supabase.from("groups").select("id").eq("user_id", user.id).ilike("name", groupName).single();
        if (group) {
          const { error } = await supabase.from("transactions").update({ group_id: group.id }).eq("id", transactionId).eq("user_id", user.id);
          if (error) {
            await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao atualizar o grupo. Tente novamente.");
          } else {
            await sendTelegramMessage(chatId, `✅ Grupo alterado para "${groupName}"!`);
          }
        }
      }
      return;
    }

    // Handle edit tags - show tag selection interface
    if (selectedValue.startsWith("edit_tags_")) {
      const transactionId = selectedValue.replace("edit_tags_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;

      // Get current transaction tags
      const { data: transaction } = await supabase.from("transactions").select("tags").eq("id", transactionId).eq("user_id", user.id).single();
      const currentTags: string[] = transaction?.tags || [];

      // Get existing tags from all user transactions
      const allTags = await getAllUserTags(supabase, user.id);
      const tagSet = new Set(allTags.map((t: string) => t.startsWith("#") ? t : `#${t}`));

      let prompt = `🔖 *Editar tags* (transação \`#${transactionId}\`)\n`;
      if (currentTags.length > 0) {
        prompt += `\nAtuais: ${currentTags.join(" ")}\n`;
      }
      prompt += "\nClique nas tags para alternar ou digite uma nova.";

      const keyboard: InlineKeyboard = [];
      if (tagSet.size > 0) {
        let row: { text: string; callback_data: string }[] = [];
        for (const tag of tagSet) {
          const isSelected = currentTags.includes(tag);
          row.push({ text: isSelected ? `✅ ${tag}` : tag, callback_data: `edit_tag_tog_${transactionId}_${tag}` });
          if (row.length === 2) {
            keyboard.push(row);
            row = [];
          }
        }
        if (row.length > 0) keyboard.push(row);
      }
      keyboard.push([
        { text: "✅ Concluir", callback_data: truncateCallbackData(`edit_tags_done_${transactionId}`) },
        { text: "⏭️ Limpar", callback_data: truncateCallbackData(`edit_tags_clr_${transactionId}`) },
      ]);

      // Store working state
      await setWizardState(supabase, user.id, `edit_tags_${transactionId}`, { tags: currentTags, transaction_id: transactionId });
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
        const user = await getOrCreateUser(supabase, telegramId);
        if (!user) return;

        // Get current working tags from wizard state
        const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
        const currentTags: string[] = state?.data?.tags
          ? (Array.isArray(state.data.tags) ? state.data.tags : [state.data.tags])
          : [];

        // Toggle
        const newTags = currentTags.includes(tag)
          ? currentTags.filter((t: string) => t !== tag)
          : [...currentTags, tag];

        await supabase.from("wizard_states").update({
          data: { tags: newTags, transaction_id: transactionId },
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }).eq("user_id", user.id);

        // Re-send the tag selection message by editing
        const allTags = await getAllUserTags(supabase, user.id);
        const tagSet = new Set(allTags.map((t: string) => t.startsWith("#") ? t : `#${t}`));

        let prompt = `🔖 *Editar tags* (transação \`#${transactionId}\`)\n`;
        if (newTags.length > 0) {
          prompt += `\nSelecionadas: ${newTags.join(" ")}\n`;
        }
        prompt += "\nClique nas tags para alternar ou digite uma nova.";

        const keyboard: InlineKeyboard = [];
        if (tagSet.size > 0) {
          let row: { text: string; callback_data: string }[] = [];
          for (const t of tagSet) {
            const isSelected = newTags.includes(t);
            row.push({ text: isSelected ? `✅ ${t}` : t, callback_data: `edit_tag_tog_${transactionId}_${t}` });
            if (row.length === 2) {
              keyboard.push(row);
              row = [];
            }
          }
          if (row.length > 0) keyboard.push(row);
        }
        keyboard.push([
          { text: "✅ Concluir", callback_data: truncateCallbackData(`edit_tags_done_${transactionId}`) },
          { text: "⏭️ Limpar", callback_data: truncateCallbackData(`edit_tags_clr_${transactionId}`) },
        ]);

        await editTelegramMessageWithKeyboard(chatId, message.message_id, prompt, keyboard);
      }
      return;
    }

    // Handle edit tags done
    if (selectedValue.startsWith("edit_tags_done_")) {
      const transactionId = selectedValue.replace("edit_tags_done_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
      const tags = state?.data?.tags ? (Array.isArray(state.data.tags) ? state.data.tags : [state.data.tags]) : [];
      const formattedTags = tags.map((t: string) => t.startsWith("#") ? t : `#${t}`);
      await supabase.from("transactions").update({ tags: formattedTags }).eq("id", transactionId).eq("user_id", user.id);
      await clearWizardState(supabase, user.id);
      const tagsStr = formattedTags.length > 0 ? formattedTags.join(" ") : "—";
      await sendTelegramMessage(chatId, `✅ Tags atualizadas: ${tagsStr}`);
      return;
    }

    // Handle edit tags clear
    if (selectedValue.startsWith("edit_tags_clr_")) {
      const transactionId = selectedValue.replace("edit_tags_clr_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      await supabase.from("transactions").update({ tags: [] }).eq("id", transactionId).eq("user_id", user.id);
      await clearWizardState(supabase, user.id);
      await sendTelegramMessage(chatId, "✅ Tags removidas!");
      return;
    }

    // Handle wizard new category/group - user wants to type a custom name
    if (selectedValue === "wizard_new_category" || selectedValue === "wizard_new_group") {
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
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
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const userId = user.id;
      const { data: state } = await supabase.from("wizard_states").select("*").eq("user_id", userId).single();
      if (!state) return;

      const currentTags: string[] = state.data?.tags
        ? (Array.isArray(state.data.tags) ? state.data.tags : [state.data.tags])
        : [];

      // Toggle: remove if already selected, add otherwise
      const newTags = currentTags.includes(tag)
        ? currentTags.filter((t: string) => t !== tag)
        : [...currentTags, tag];

      await supabase.from("wizard_states").update({
        data: { ...state.data, tags: newTags },
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }).eq("user_id", userId);

      // Edit the existing message to show updated selection
      const underscoreIndex = state.step.indexOf("_");
      const wizardName = state.step.substring(0, underscoreIndex);
      const stepKey = state.step.substring(underscoreIndex + 1);
      const { data: currentStep } = await supabase.from("wizard_steps").select("*").eq("wizard_name", wizardName).eq("step_key", stepKey).single();
      if (currentStep) {
        await sendWizardStepMessage(chatId, currentStep, userId, supabase, message.message_id);
      }
      return;
    }

    // Handle wizard done tags (confirm multi-selection and advance)
    if (selectedValue === "wiz_done_tags") {
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const wizard = await getCurrentWizardStep(supabase, user.id);
      if (!wizard) return;
      const newStateData = { ...wizard.state.data };
      await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, newStateData);
      return;
    }

    // Handle wizard skip tags
    if (selectedValue === "wizard_skip_tags") {
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const wizard = await getCurrentWizardStep(supabase, user.id);
      if (!wizard) return;
      const newStateData = { ...wizard.state.data, [wizard.currentStep.step_key]: "" };
      await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, newStateData);
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

    // Handle category select - show rename/delete options
    if (selectedValue.startsWith("cat_sel_")) {
      const catName = selectedValue.replace("cat_sel_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: cat } = await supabase.from("categories").select("id, is_predefined").eq("user_id", user.id).ilike("name", catName).single();
      if (!cat) return;
      const keyboard: InlineKeyboard = [];
      if (cat.is_predefined) {
        keyboard.push([{ text: "⭐ Categoria padrão", callback_data: "none" }]);
      } else {
        keyboard.push([{ text: "✏️ Renomear", callback_data: `cat_ren_${catName}` }]);
        keyboard.push([{ text: "❌ Excluir", callback_data: `cat_del_${catName}` }]);
      }
      keyboard.push([{ text: "◀️ Voltar", callback_data: "cat_back" }]);
      await sendTelegramMessageWithKeyboard(chatId, `🏷️ *${catName}*\n\nO que deseja fazer?`, keyboard);
      return;
    }

    // Handle category rename
    if (selectedValue.startsWith("cat_ren_")) {
      const catName = selectedValue.replace("cat_ren_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: cat } = await supabase.from("categories").select("is_predefined").eq("user_id", user.id).ilike("name", catName).single();
      if (!cat || cat.is_predefined) {
        await sendTelegramMessage(chatId, "⭐ Categorias padrão não podem ser renomeadas.");
        return;
      }
      await sendTelegramMessage(chatId, `✏️ Digite o novo nome para *${catName}*:`);
      await setWizardState(supabase, user.id, "rename_cat", { name: catName });
      return;
    }

    // Handle category delete confirm
    if (selectedValue.startsWith("cat_del_")) {
      const catName = selectedValue.replace("cat_del_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const keyboard: InlineKeyboard = [
        [{ text: "✅ Sim, excluir", callback_data: `cat_del_yes_${catName}` }],
        [{ text: "❌ Não, manter", callback_data: "cat_back" }],
      ];
      await sendTelegramMessageWithKeyboard(chatId, `🗑️ Tem certeza de que deseja excluir a categoria *${catName}*?`, keyboard);
      return;
    }

    // Handle category delete confirmed
    if (selectedValue.startsWith("cat_del_yes_")) {
      const catName = selectedValue.replace("cat_del_yes_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: cat } = await supabase.from("categories").select("id, is_predefined").eq("user_id", user.id).ilike("name", catName).single();
      if (!cat || cat.is_predefined) {
        await sendTelegramMessage(chatId, "⭐ Categorias padrão não podem ser excluídas.");
        return;
      }
      // Set category_id to null on affected transactions
      await supabase.from("transactions").update({ category_id: null }).eq("category_id", cat.id).eq("user_id", user.id);
      await supabase.from("categories").delete().eq("id", cat.id).eq("user_id", user.id);
      await sendTelegramMessage(chatId, `✅ Categoria "${catName}" excluída!`);
      return;
    }

    // Handle category back
    if (selectedValue === "cat_back") {
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      await handleCategory(supabase, telegramId, chatId, []);
      return;
    }

    // Handle group select - show rename/delete options
    if (selectedValue.startsWith("grp_sel_")) {
      const grpName = selectedValue.replace("grp_sel_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: grp } = await supabase.from("groups").select("id, is_default").eq("user_id", user.id).ilike("name", grpName).single();
      if (!grp) return;
      const keyboard: InlineKeyboard = [];
      if (grp.is_default) {
        keyboard.push([{ text: "⭐ Grupo padrão", callback_data: "none" }]);
      } else {
        keyboard.push([{ text: "✏️ Renomear", callback_data: `grp_ren_${grpName}` }]);
        keyboard.push([{ text: "❌ Excluir", callback_data: `grp_del_${grpName}` }]);
      }
      keyboard.push([{ text: "◀️ Voltar", callback_data: "grp_back" }]);
      await sendTelegramMessageWithKeyboard(chatId, `📁 *${grpName}*\n\nO que deseja fazer?`, keyboard);
      return;
    }

    // Handle group rename
    if (selectedValue.startsWith("grp_ren_")) {
      const grpName = selectedValue.replace("grp_ren_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: grp } = await supabase.from("groups").select("is_default").eq("user_id", user.id).ilike("name", grpName).single();
      if (!grp || grp.is_default) {
        await sendTelegramMessage(chatId, "⭐ Grupos padrão não podem ser renomeados.");
        return;
      }
      await sendTelegramMessage(chatId, `✏️ Digite o novo nome para *${grpName}*:`);
      await setWizardState(supabase, user.id, "rename_grp", { name: grpName });
      return;
    }

    // Handle group delete confirm
    if (selectedValue.startsWith("grp_del_")) {
      const grpName = selectedValue.replace("grp_del_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const keyboard: InlineKeyboard = [
        [{ text: "✅ Sim, excluir", callback_data: `grp_del_yes_${grpName}` }],
        [{ text: "❌ Não, manter", callback_data: "grp_back" }],
      ];
      await sendTelegramMessageWithKeyboard(chatId, `🗑️ Tem certeza de que deseja excluir o grupo *${grpName}*?`, keyboard);
      return;
    }

    // Handle group delete confirmed
    if (selectedValue.startsWith("grp_del_yes_")) {
      const grpName = selectedValue.replace("grp_del_yes_", "");
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const { data: grp } = await supabase.from("groups").select("id, is_default").eq("user_id", user.id).ilike("name", grpName).single();
      if (!grp || grp.is_default) {
        await sendTelegramMessage(chatId, "⭐ Grupos padrão não podem ser excluídos.");
        return;
      }
      // Set group_id to default on affected transactions
      const { data: defaultGrp } = await supabase.from("groups").select("id").eq("user_id", user.id).eq("is_default", true).single();
      await supabase.from("transactions").update({ group_id: defaultGrp?.id || null }).eq("group_id", grp.id).eq("user_id", user.id);
      await supabase.from("groups").delete().eq("id", grp.id).eq("user_id", user.id);
      await sendTelegramMessage(chatId, `✅ Grupo "${grpName}" excluído!`);
      return;
    }

    // Handle group back
    if (selectedValue === "grp_back") {
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      await handleGroup(supabase, telegramId, chatId, []);
      return;
    }

    // Handle category suggestion - use existing
    if (selectedValue === "cat_sug_use") {
      const state = await getWizardState(supabase, telegramId);
      if (!state || state.step !== "suggest_cat") return;
      await clearWizardState(supabase, telegramId);
      await sendTelegramMessage(chatId, `✅ Usando categoria "${state.data.suggested_name}" — ela já existe.`);
      return;
    }

    // Handle category suggestion - create anyway
    if (selectedValue === "cat_sug_new") {
      const state = await getWizardState(supabase, telegramId);
      if (!state || state.step !== "suggest_cat") return;
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const catName = state.data.original_name;
      const { error } = await supabase.from("categories").insert({
        user_id: user.id,
        name: catName,
        normalized_name: normalizeString(catName),
        is_predefined: false,
      });
      await clearWizardState(supabase, telegramId);
      if (error) {
        await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao criar a categoria.");
      } else {
        await sendTelegramMessage(chatId, `✅ Categoria "${catName}" criada com sucesso!`);
      }
      return;
    }

    // Handle group suggestion - use existing
    if (selectedValue === "grp_sug_use") {
      const state = await getWizardState(supabase, telegramId);
      if (!state || state.step !== "suggest_grp") return;
      await clearWizardState(supabase, telegramId);
      await sendTelegramMessage(chatId, `✅ Usando grupo "${state.data.suggested_name}" — ele já existe.`);
      return;
    }

    // Handle group suggestion - create anyway
    if (selectedValue === "grp_sug_new") {
      const state = await getWizardState(supabase, telegramId);
      if (!state || state.step !== "suggest_grp") return;
      const user = await getOrCreateUser(supabase, telegramId);
      if (!user) return;
      const grpName = state.data.original_name;
      const { error } = await supabase.from("groups").insert({
        user_id: user.id,
        name: grpName,
        normalized_name: normalizeString(grpName),
        is_default: false,
      });
      await clearWizardState(supabase, telegramId);
      if (error) {
        await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao criar o grupo.");
      } else {
        await sendTelegramMessage(chatId, `✅ Grupo "${grpName}" criado com sucesso!`);
      }
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
    const wizard = await getCurrentWizardStep(supabase, user.id);
    if (!wizard) return;
    const newStateData = { ...wizard.state.data, [wizard.currentStep.step_key]: selectedValue };
    await advanceWizardToNextStep(supabase, user.id, chatId, wizard.currentStep, newStateData);
  } catch (error) {
    console.error("Error handling callback query:", error);
    await sendTelegramMessage(callbackQuery.message.chat.id, "❌ Ops! Algo deu errado. Tente novamente.");
  }
}
