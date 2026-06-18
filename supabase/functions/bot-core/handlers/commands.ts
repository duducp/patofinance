import type { InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { requireUser, getOrCreateCategory, getOrCreateGroup, normalizeString, suggestSimilarCategories, suggestSimilarGroups, sendSimilarityWarning, getAllUserTags, createTransaction, getTransactionById, findGroupByName, userOrNullFilter } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, getTodayISOBR, sanitizeMarkdown } from "../utils/formatting.ts";
import { getDateRange } from "../utils/date-helpers.ts";
import { parseCommand } from "../utils/command-parsing.ts";
import { resolveCommandPeriod } from "../utils/period-parser.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { buildKeyboardGrid, buildEditKeyboard } from "../utils/keyboard.ts";
import { findHelp } from "../utils/help-texts.ts";

import { getSummaryData, formatSummaryMessage, formatFutureBlock, sendTransactionSuccess } from "./queries.ts";
import { getWizardState, setWizardState, handleTransactionWizard } from "./wizard.ts";
export { handleRecurrences, handleRecurrenceDetail, handleAdvanceRecurrence, handleSkipRecurrence, handleArchiveRecurrence, handleActivateRecurrence, handleEditRecurrence, handleManageRecurrences, handleAdvanceRecurrenceConfirm, handleSkipRecurrenceConfirm, handleArchiveRecurrenceConfirm, handleActivateRecurrenceConfirm } from "./recurrences.ts";

export async function handleStart(chatId: number, firstName: string): Promise<void> {
  await sendTelegramMessage(
    chatId,
    `Olá ${firstName}! 👋\n\n` +
    `Que bom ter você aqui! Sou seu assistente de controle financeiro.\n\n` +
    `Comigo você pode registrar gastos e receitas, ver seu saldo e muito mais!\n\n` +
    `💡 Alguns exemplos:\n` +
    `/despesa 50 mercado — registra uma despesa\n` +
    `/saldo mes passado — saldo do mês anterior\n` +
    `/extrato janeiro 2025 — extrato de janeiro\n` +
    `/resumo ultimo mes — resumo do mês passado\n\n` +
    `Digite /ajuda para ver tudo que posso fazer por você.`
  );
}

export async function handleHelp(chatId: number, args: string[] = []): Promise<void> {
  if (args.length > 0) {
    const text = findHelp(args[0]);
    if (text) {
      await sendTelegramMessage(chatId, text);
      return;
    }
    await sendTelegramMessage(
      chatId,
      `❓ Comando "${args[0]}" não encontrado.\n\nUse \`/ajuda\` para ver todos os comandos disponíveis.`
    );
    return;
  }
  await sendTelegramMessage(
    chatId,
    `📚 *Comandos Disponíveis:*\n\n` +
    `💰 *Financeiros:*\n` +
    `/despesa - Registrar despesa\n` +
    `/receita - Registrar receita\n` +
    `/saldo - Ver saldo (ex: \`/saldo mes passado\` ou \`/saldo --grupo Pessoal\`)\n` +
    `/extrato - Ver extrato (ex: \`/extrato janeiro 2025\` ou \`/extrato --grupo Pessoal\`)\n` +
    `/resumo - Resumo por categoria (ex: \`/resumo ultimo mes\` ou \`/resumo --grupo Pessoal\`)\n` +
    `/agendadas - Listar transações futuras agendadas\n` +
    `/recorrencia - Criar e gerenciar transações recorrentes\n` +
    `/buscar - Buscar transações por palavra-chave (ex: \`/buscar mercado\`)\n\n` +
    `📁 *Organização:*\n` +
    `/grupo - Gerenciar grupos\n` +
    `/categoria - Gerenciar categorias\n` +
    `/tag - Gerenciar tags\n\n` +
    `⚙️ *Utilidades:*\n` +
    `/detalhes - Ver/editar/excluir transação pelo ID (ex: \`/detalhes 42\`)\n` +
    `/limpar - Remover categorias/grupos sem transações\n` +
    `/cancelar - Cancelar operação em andamento\n` +
    `/login - Gerar código de acesso ao dashboard web\n` +
    `/ajuda <comando> - Detalhes de um comando (ex: \`/ajuda extrato\`)\n\n` +
    `💡 *Linguagem Natural:*\n` +
    `Você também pode digitar naturalmente:\n\n` +
    `💰 *Registrar:*\n` +
    `• "gastei 50 no almoço"\n` +
    `• "paguei 25,90 no mercado"\n` +
    `• "recebi 3000 de salário"\n\n` +
    `📊 *Consultar:*\n` +
    `• "quanto tenho?"\n` +
    `• "quanto gastei esse mês?"\n` +
    `• "quanto gastei mês passado?"\n` +
    `• "gastos do dia 15"\n` +
    `• "quanto gastei em alimentação?"\n` +
    `• "resumo do mês"\n` +
    `• "extrato"\n\n` +
    `🏷️ *Gerenciar:*\n` +
    `• "crie a categoria transporte"\n` +
    `• "crie o grupo trabalho"\n` +
    `• "quais categorias tenho?"\n` +
    `• "meus grupos"\n` +
    `• "quais tags uso?"\n` +
    `• "limpe categorias sem uso"\n` +
    `• "limpe grupos sem transações"\n\n` +
    `📋 *Transações:*\n` +
    `• "últimas 30 transações"\n` +
    `• "qual foi meu último gasto?"\n` +
    `• "apague a última transação"\n` +
    `• "transações com #alimentação"\n` +
    `• "agendadas" — lista transações futuras`
  );
}

export async function handleBalance(supabase: any, userId: number, chatId: number, args: string[] = []): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const { period, groupName: resolvedGroup } = await resolveCommandPeriod(args, user.id);

  let startDate: string, endDate: string, monthName: string;
  if (period) {
    startDate = period.start;
    endDate = period.end;
    monthName = period.label;
  } else {
    const range = getDateRange(null, null);
    startDate = range.start;
    endDate = range.end;
    monthName = range.label;
  }

  let groupId: number | null = null;
  let groupName: string | null = null;
  if (resolvedGroup) {
    const group = await findGroupByName(supabase, user.id, resolvedGroup);
    if (group) {
      groupId = group.id;
      groupName = group.name;
    }
  }

  const today = getTodayISOBR();

  // Build income query (only past + today, not future)
  let incomeQuery = supabase
    .from("transactions")
    .select("amount")
    .eq("user_id", user.id)
    .eq("type", "income")
    .gte("transaction_date", startDate)
    .lte("transaction_date", endDate)
    .lte("transaction_date", today);
  if (groupId) incomeQuery = incomeQuery.eq("group_id", groupId);

  // Build expenses query (only past + today, not future)
  let expensesQuery = supabase
    .from("transactions")
    .select("amount")
    .eq("user_id", user.id)
    .eq("type", "expense")
    .gte("transaction_date", startDate)
    .lte("transaction_date", endDate)
    .lte("transaction_date", today);
  if (groupId) expensesQuery = expensesQuery.eq("group_id", groupId);

  const { data: income } = await incomeQuery;
  const { data: expenses } = await expensesQuery;

  const totalIncome = income?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;
  const totalExpenses = expenses?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;

  if (groupId && totalIncome === 0 && totalExpenses === 0) {
    const sessionSeq = await getSessionSeq(supabase, user.id);
    const keyboard: InlineKeyboard = [[{ text: "📋 Todas as contas", callback_data: addSession("balance_grp_all", sessionSeq) }]];
    await sendTelegramMessageWithKeyboard(chatId, `📊 Nenhuma transação no grupo *${groupName}* este mês.`, keyboard);
    return;
  }

  // Second pair of queries for future (scheduled) transactions
  let futureIncomeQuery = supabase
    .from("transactions")
    .select("amount, categories(name)")
    .eq("user_id", user.id)
    .eq("type", "income")
    .gt("transaction_date", today);
  if (groupId) futureIncomeQuery = futureIncomeQuery.eq("group_id", groupId);

  let futureExpenseQuery = supabase
    .from("transactions")
    .select("amount, categories(name)")
    .eq("user_id", user.id)
    .eq("type", "expense")
    .gt("transaction_date", today);
  if (groupId) futureExpenseQuery = futureExpenseQuery.eq("group_id", groupId);

  const [futureIncome, futureExpenses] = await Promise.all([
    futureIncomeQuery,
    futureExpenseQuery,
  ]);

  const totalFutureIncome = futureIncome.data?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;
  const totalFutureExpenses = futureExpenses.data?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;
  const hasFuture = totalFutureIncome > 0 || totalFutureExpenses > 0;

  const balance = totalIncome - totalExpenses;

  const emoji = balance >= 0 ? "✅" : "⚠️";

  let message = `${emoji} *Saldo - ${monthName}*\n`;
  if (groupName) {
    message += `📁 Grupo: *${groupName}*\n`;
  }
  message += `\n📈 Entradas: *${formatCurrencyBR(totalIncome)}*\n` +
    `📉 Saídas: *${formatCurrencyBR(totalExpenses)}*\n\n` +
    `💰 *Saldo atual: ${formatCurrencyBR(balance)}*`;

  if (hasFuture) {
    message += `\n\n${formatFutureBlock(totalFutureIncome, totalFutureExpenses, balance)}`;
  }

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];
  if (groupId) {
    keyboard.push([{ text: "📋 Todas as contas", callback_data: addSession("balance_grp_all", sessionSeq) }]);
  }
  keyboard.push([{ text: "📁 Filtrar por grupo", callback_data: addSession("balance_shwgrp", sessionSeq) }]);

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}

export async function handleTransaction(
  type: "expense" | "income",
  supabase: any,
  userId: number,
  chatId: number,
  args: string[],
  descriptionOverride?: string
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const wizardState = await getWizardState(supabase, user.id);
  if (wizardState) {
    if (type === "expense") {
      await handleTransactionWizard("expense", supabase, user.id, chatId, wizardState, args[0] || "");
    } else {
      await handleTransactionWizard("income", supabase, user.id, chatId, wizardState, args[0] || "");
    }
    return;
  }

  if (args.length === 0) {
    const msg = type === "expense"
      ? "💸 Quanto você gastou? Informe o valor:"
      : "💰 Quanto você recebeu? Informe o valor:";
    const sentMsgId = await sendTelegramMessage(chatId, msg);
    const step = `${type === "expense" ? "gasto" : "receita"}_amount`;
    await setWizardState(supabase, user.id, step, { type });
    if (sentMsgId) {
      await supabase.from("wizard_states").update({
        data: { type, _amountPromptMessageId: sentMsgId },
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }).eq("user_id", user.id);
    }
    return;
  }

  const parsed = parseCommand(args);

  if (!parsed.amount) {
    const cmd = type === "expense" ? "/despesa" : "/receita";
    await sendTelegramMessage(chatId, `Por favor, informe o valor. Ex: \`${cmd} 50 alimentação\``);
    return;
  }

  // Check for similar existing categories
  if (parsed.category) {
    await sendSimilarityWarning(supabase, user.id, chatId, "category", parsed.category);
  }

  const categoryId = parsed.category ? await getOrCreateCategory(supabase, user.id, parsed.category, type) : null;

  // Check for similar existing groups
  if (parsed.group) {
    await sendSimilarityWarning(supabase, user.id, chatId, "group", parsed.group);
  }

  const groupId = await getOrCreateGroup(supabase, user.id, parsed.group);

  // Check for similar existing tags
  for (const tag of parsed.tags) {
    await sendSimilarityWarning(supabase, user.id, chatId, "tag", tag);
  }

  const { error, id } = await createTransaction(supabase, {
    userId: user.id,
    type,
    amount: parsed.amount,
    categoryId,
    groupId,
    description: descriptionOverride || "",
    tags: parsed.tags,
    transactionDate: parsed.date || getTodayISOBR(),
  });

  if (error) {
    const msg = type === "expense"
      ? "❌ Ops! Algo deu errado ao registrar o gasto. Tente novamente."
      : "❌ Ops! Algo deu errado ao registrar a receita. Tente novamente.";
    await sendTelegramMessage(chatId, msg);
    return;
  }

  // If user typed category text but no description override, ask about adding description
  if (parsed.category && !descriptionOverride) {
    const sessionSeq = await getSessionSeq(supabase, user.id);
    await setWizardState(supabase, user.id, "tx_ask_desc", {
      transactionId: id,
      type,
      amount: parsed.amount,
      category: parsed.category,
      group: parsed.group,
      date: parsed.date || getTodayISOBR(),
      tags: parsed.tags,
    });
    const keyboard: InlineKeyboard = [
      [{ text: "✅ Sim, adicionar", callback_data: addSession(`tx_desc_sim_${id}`, sessionSeq) }],
      [{ text: "⏭️ Não", callback_data: addSession(`tx_desc_nao_${id}`, sessionSeq) }],
    ];
    await sendTelegramMessageWithKeyboard(
      chatId,
      "📝 *Deseja adicionar uma descrição?*",
      keyboard
    );
    return;
  }

  await sendTransactionSuccess(supabase, chatId, user.id, type, {
    amount: parsed.amount,
    category: parsed.category,
    group: parsed.group,
    date: parsed.date || getTodayISOBR(),
    description: "",
    tags: parsed.tags,
    transactionId: id,
  });
}

export async function handleSummary(supabase: any, userId: number, chatId: number, args: string[] = []): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const { period, groupName: resolvedGroup } = await resolveCommandPeriod(args, user.id);

  let groupId: number | null = null;
  let groupName: string | null = null;
  if (resolvedGroup) {
    const group = await findGroupByName(supabase, user.id, resolvedGroup);
    if (group) {
      groupId = group.id;
      groupName = group.name;
    }
  }

  const [data, futureData] = await Promise.all([
    getSummaryData(supabase, user.id, period, groupId),
    getSummaryData(supabase, user.id, period, groupId, true),
  ]);

  // If no transactions at all (past nor future)
  if (!data && !futureData) {
    if (groupName) {
      const sessionSeq = await getSessionSeq(supabase, user.id);
      const keyboard: InlineKeyboard = [[{ text: "📋 Todas as contas", callback_data: addSession("summary_grp_all", sessionSeq) }]];
      await sendTelegramMessageWithKeyboard(chatId, `📊 Nenhuma transação no grupo *${groupName}* este mês.`, keyboard);
    } else {
      await sendTelegramMessage(chatId, "📊 Nenhuma transação encontrada este mês. Que tal começar registrando um gasto ou receita?");
    }
    return;
  }

  // Build message: past summary (if any) + scheduled block (if any)
  let message = "";
  if (data) {
    message = formatSummaryMessage(data, groupName || undefined);
  }

  if (futureData) {
    const currentBalance = data ? data.totalIncomes - data.totalExpenses : 0;
    if (message) message += `\n\n`;
    message += formatFutureBlock(futureData.totalIncomes, futureData.totalExpenses, currentBalance);
  }

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];
  if (groupId) {
    keyboard.push([{ text: "📋 Todas as contas", callback_data: addSession("summary_grp_all", sessionSeq) }]);
  }
  keyboard.push([{ text: "📁 Filtrar por grupo", callback_data: addSession("summary_shwgrp", sessionSeq) }]);

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}

export async function handleDetails(
  supabase: any,
  userId: number,
  chatId: number,
  args: string[] = [],
  messageId?: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  if (args.length === 0) {
    const sessionSeq = await getSessionSeq(supabase, user.id);
    await setWizardState(supabase, user.id, "detalhes_ask_id", {});
    const keyboard: InlineKeyboard = [
      [{ text: "📋 Ver extrato", callback_data: addSession("detalhes_show_extrato", sessionSeq) }],
      [{ text: "🚫 Cancelar", callback_data: addSession("cancel_wizard", sessionSeq) }],
    ];
    await sendTelegramMessageWithKeyboard(
      chatId,
      `📋 *Qual transação?*\n\n` +
      `Digite o #ID da transação que deseja ver.\n\n` +
      `💡 Use \`/extrato\` para ver o extrato e encontrar o ID.`,
      keyboard
    );
    return;
  }

  const transactionId = args[0];

  const transaction = await getTransactionById(supabase, user.id, transactionId);

  if (!transaction) {
    await sendTelegramMessage(
      chatId,
      `❌ Transação #${transactionId} não encontrada.\n\n` +
      `Use \`/extrato\` para ver as transações disponíveis.`
    );
    return;
  }

  await showDetailsMainView(supabase, user.id, chatId, transaction.id, messageId);
}

function formatDetailMessage(transaction: any): string {
  const emoji = transaction.type === "income" ? "📈" : "📉";
  const typeName = transaction.type === "income" ? "Receita" : "Despesa";
  const catName = sanitizeMarkdown(transaction.categories?.name || "—");
  const grpName = sanitizeMarkdown(transaction.groups?.name || "Pessoal");
  const tags = transaction.tags?.length ? transaction.tags.map(sanitizeMarkdown).join(" ") : "—";
  const desc = sanitizeMarkdown(transaction.description || "—");
  const date = formatDateBR(transaction.transaction_date);
  const recIndicator = transaction.recurrence_id
    ? `\n🔄 *Recorrência:* #${transaction.recurrence_id}`
    : "";

  return `${emoji} *${typeName} #${transaction.id}:*\n\n` +
    `💰 *Valor:* ${formatCurrencyBR(Number(transaction.amount))}\n` +
    `🏷️ *Categoria:* ${catName}\n` +
    `📁 *Grupo:* ${grpName}\n` +
    `🔖 *Tags:* ${tags}\n` +
    `📅 *Data:* ${date}\n` +
    `📝 *Descrição:* ${desc}` +
    recIndicator;
}

export async function showDetailsMainView(
  supabase: any,
  userId: number,
  chatId: number,
  transactionId: string | number,
  messageId?: number,
): Promise<void> {
  const transaction = await getTransactionById(supabase, userId, transactionId);
  if (!transaction) return;

  const sessionSeq = await getSessionSeq(supabase, userId);
  const keyboard: InlineKeyboard = [];

  if (transaction.recurrence_id) {
    keyboard.push([
      { text: "🔄 Ver recorrência", callback_data: addSession(`rec_show_${transaction.recurrence_id}`, sessionSeq) },
    ]);
  }

  keyboard.push([
    { text: "📝 Editar", callback_data: addSession(`edit_show_actions_${transaction.id}`, sessionSeq) },
    { text: "🗑️ Excluir", callback_data: addSession(`del_prompt_${transaction.id}`, sessionSeq) },
  ]);

  const message = formatDetailMessage(transaction);

  if (messageId) {
    await editTelegramMessageWithKeyboard(chatId, messageId, message, keyboard);
  } else {
    await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
  }
}

export async function showDetailsEditActions(
  supabase: any,
  userId: number,
  chatId: number,
  transactionId: string | number,
  messageId: number,
): Promise<void> {
  const transaction = await getTransactionById(supabase, userId, transactionId);
  if (!transaction) return;

  const sessionSeq = await getSessionSeq(supabase, userId);
  const keyboard: InlineKeyboard = [
    ...buildEditKeyboard(transaction.id, sessionSeq),
    [{ text: "🔙 Voltar", callback_data: addSession(`edit_show_main_${transaction.id}`, sessionSeq) }],
  ];

  await editTelegramMessageWithKeyboard(
    chatId,
    messageId,
    formatDetailMessage(transaction) + "\n\nO que deseja alterar?",
    keyboard,
  );
}

export async function handleEntity(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  args: string[]
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const isCategory = type === "category";
  const table = isCategory ? "categories" : "groups";
  const flagColumn = isCategory ? "is_predefined" : "is_default";
  const icon = isCategory ? "🏷️" : "📁";
  const label = isCategory ? "categoria" : "grupo";
  const cbPrefix = isCategory ? "cat_sel_" : "grp_sel_";
  const suggestFn = isCategory ? suggestSimilarCategories : suggestSimilarGroups;
  const wizardStep = isCategory ? "suggest_cat" : "suggest_grp";
  const sugUseCb = isCategory ? "cat_sug_use" : "grp_sug_use";
  const sugNewCb = isCategory ? "cat_sug_new" : "grp_sug_new";
  const cmdRef = isCategory ? "/categoria nome_da_categoria" : "/grupo nome_do_grupo";

  if (args.length === 0 || (isCategory && args[0] === "listar")) {
    const selectFields = isCategory ? `id, name, ${flagColumn}, transaction_type, normalized_name` : `id, name, ${flagColumn}`;
    let orderQuery;
    if (isCategory) {
      orderQuery = supabase.from(table).select(selectFields)
        .or(userOrNullFilter(user.id));
    } else {
      orderQuery = supabase.from(table).select(selectFields).eq("user_id", user.id);
    }
    orderQuery = orderQuery.order("name");
    const { data: items } = await orderQuery;

    if (!items || items.length === 0) {
      await sendTelegramMessage(chatId, `${icon} Nenhum${isCategory ? "a" : ""} ${label} encontrad${isCategory ? "a" : ""}. Crie um${isCategory ? "a" : ""} com \`${cmdRef}\``);
      return;
    }

    // Get transaction counts
    const fkColumn = isCategory ? "category_id" : "group_id";
    const { data: counts } = await supabase
      .from("transactions")
      .select(`${fkColumn}, id`)
      .eq("user_id", user.id);

    const countMap: Record<number, number> = {};
    if (counts) {
      for (const t of counts) {
        if (t[fkColumn]) {
          countMap[t[fkColumn]] = (countMap[t[fkColumn]] || 0) + 1;
        }
      }
    }

    const typeLabels: Record<string, string> = {
      expense: "💸",
      income: "💰",
    };

    const pluralNoun = isCategory ? "categorias" : "grupos";
    let message = `${icon} *Su${isCategory ? "as" : "s"} ${pluralNoun}:*\n\n`;
    for (const item of items) {
      const count = countMap[item.id] || 0;
      const defaultTag = item[flagColumn] ? ` ⭐ (padrão)` : "";
      const typeIcon = item.transaction_type ? ` ${typeLabels[item.transaction_type]}` : "";
      message += `• ${sanitizeMarkdown(item.name)}${sanitizeMarkdown(defaultTag)}${typeIcon} — ${count} ${count !== 1 ? "transações" : "transação"}\n`;
    }
    message += `\n💡 Para adicionar: \`${cmdRef}\``;

    const sessionSeq = await getSessionSeq(supabase, user.id);
    const keyboard = buildKeyboardGrid(items, (item) => ({
      text: item.name,
      callback_data: addSession(`${cbPrefix}${item.name}`, sessionSeq),
    }), 3);

    await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
    return;
  }

  const entityName = args.join(" ");

  // Check for exact match first (prevents duplicate creation with friendly message)
  const normalized = normalizeString(entityName);
  let existsQuery = supabase
    .from(table)
    .select("id, name, " + flagColumn);
  if (isCategory) {
    existsQuery = existsQuery.or(userOrNullFilter(user.id));
  } else {
    existsQuery = existsQuery.eq("user_id", user.id);
  }
  const { data: existing } = await existsQuery.eq("normalized_name", normalized).maybeSingle();
  if (existing) {
    const defaultTag = existing[flagColumn] ? ` ⭐ (padrão)` : "";
    await sendTelegramMessage(
      chatId,
      `⚠️ ${icon} ${label.charAt(0).toUpperCase() + label.slice(1)} "${sanitizeMarkdown(existing.name)}"${defaultTag} já existe.`
    );
    return;
  }

  // Check for similar names before creating
  const similar = await suggestFn(supabase, user.id, entityName);
  if (similar && similar.length > 0) {
    await setWizardState(supabase, user.id, wizardStep, {
      original_name: entityName,
      suggested_name: similar[0].name,
      similarity: similar[0].similarity,
    });
    const sessionSeq = await getSessionSeq(supabase, user.id);
    const keyboard: InlineKeyboard = [
      [{ text: `✅ Usar "${similar[0].name}"`, callback_data: addSession(sugUseCb, sessionSeq) }],
      [{ text: `✏️ Criar "${entityName}" mesmo assim`, callback_data: addSession(sugNewCb, sessionSeq) }],
    ];
    await sendTelegramMessageWithKeyboard(
      chatId,
      `⚠️ Você quis dizer *${sanitizeMarkdown(similar[0].name)}*? (${(similar[0].similarity * 100).toFixed(0)}% similar)\n\nCaso contrário, confirme para criar *${entityName}* mesmo assim.`,
      keyboard
    );
    return;
  }

  const { error } = await supabase.from(table).insert({
    user_id: user.id,
    name: entityName,
    normalized_name: normalizeString(entityName),
    [flagColumn]: false,
  });

  if (error) {
    if (error.code === "23505") {
      await sendTelegramMessage(chatId, `⚠️ Já existe ${isCategory ? "uma" : "um"} ${label} com esse nome. Escolha outro nome.`);
    } else {
      await sendTelegramMessage(chatId, `❌ Ops! Algo deu errado ao criar ${isCategory ? "a" : "o"} ${label}. Tente novamente.`);
    }
    return;
  }

  const art = isCategory ? "a" : "o";
  await sendTelegramMessage(chatId, `✅ ${icon} ${label.charAt(0).toUpperCase() + label.slice(1)} "${entityName}" criad${art} com sucesso!`);
}

export function handleGroup(supabase: any, userId: number, chatId: number, args: string[]): Promise<void> {
  return handleEntity("group", supabase, userId, chatId, args);
}

export function handleCategory(supabase: any, userId: number, chatId: number, args: string[]): Promise<void> {
  return handleEntity("category", supabase, userId, chatId, args);
}

export async function handleTag(supabase: any, userId: number, chatId: number, _args: string[]): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const allTags = await getAllUserTags(supabase, user.id);

  if (allTags.length === 0) {
    await sendTelegramMessage(chatId, "🏷️ Nenhuma tag encontrada. Adicione tags ao registrar transações.");
    return;
  }

  // Get tag counts
  const { data: transactions } = await supabase
    .from("transactions")
    .select("tags")
    .eq("user_id", user.id);

  const tagCount: Record<string, number> = {};
  if (transactions) {
    for (const t of transactions) {
      if (t.tags && Array.isArray(t.tags)) {
        for (const tag of t.tags) {
          tagCount[tag] = (tagCount[tag] || 0) + 1;
        }
      }
    }
  }

  let message = "🏷️ *Suas tags:*\n\n";
  for (const tag of allTags) {
    const count = tagCount[tag] || 0;
    const displayTag = tag.startsWith("#") ? tag : `#${tag}`;
    message += `• ${sanitizeMarkdown(displayTag)} — ${count} ${count !== 1 ? "transações" : "transação"}\n`;
  }
  message += "\n💡 Clique em uma tag para ver as transações.";

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard = buildKeyboardGrid(allTags, (tag) => ({
    text: tag.startsWith("#") ? tag : `#${tag}`,
    callback_data: addSession(`tag_sel_${tag}`, sessionSeq),
  }), 3);

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}

export async function handleCleanup(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  // Find categories with no transactions (excluding predefined)
  const { data: categories } = await supabase
    .from("categories")
    .select("id, name, is_predefined")
    .eq("user_id", user.id);

  const { data: catCounts } = await supabase
    .from("transactions")
    .select("category_id")
    .eq("user_id", user.id)
    .not("category_id", "is", null);

  const usedCatIds = new Set((catCounts || []).map((t: any) => t.category_id));
  const unusedCats = (categories || []).filter((c: any) => !usedCatIds.has(c.id) && !c.is_predefined);

  // Find groups with no transactions (excluding is_default)
  const { data: groups } = await supabase
    .from("groups")
    .select("id, name, is_default")
    .eq("user_id", user.id);

  const { data: grpCounts } = await supabase
    .from("transactions")
    .select("group_id")
    .eq("user_id", user.id)
    .not("group_id", "is", null);

  const usedGrpIds = new Set((grpCounts || []).map((t: any) => t.group_id));
  const unusedGrps = (groups || []).filter((g: any) => !g.is_default && !usedGrpIds.has(g.id));

  if (unusedCats.length === 0 && unusedGrps.length === 0) {
    await sendTelegramMessage(chatId, "🧹 Nenhuma categoria ou grupo sem uso para remover. Tudo limpo!");
    return;
  }

  let message = "🧹 *Itens sem uso que podem ser removidos:*\n\n";

  if (unusedCats.length > 0) {
    message += `🏷️ *Categorias sem transações (${unusedCats.length}):*\n`;
    message += unusedCats.map((c: any) => `   • ${sanitizeMarkdown(c.name)}`).join("\n") + "\n\n";
  }

  if (unusedGrps.length > 0) {
    message += `📁 *Grupos sem transações (${unusedGrps.length}):*\n`;
    message += unusedGrps.map((g: any) => `   • ${sanitizeMarkdown(g.name)}`).join("\n") + "\n\n";
  }

  message += "Deseja removê-los?";

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [
    [{ text: "✅ Sim, limpar tudo", callback_data: addSession("confirm_cleanup", sessionSeq) }],
    [{ text: "❌ Não, cancelar", callback_data: addSession("cancel_cleanup", sessionSeq) }],
  ];

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}

export async function handleLogin(supabase: any, userId: number, chatId: number, _args: string[] = []): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  // Invalidate all pending codes for this user (security: only one active code at a time)
  await supabase
    .from("link_codes")
    .update({ used: true })
    .eq("user_id", user.id)
    .eq("used", false);

  const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let loginCode = "";
  for (let i = 0; i < 6; i++) {
    loginCode += codeChars[Math.floor(Math.random() * codeChars.length)];
  }

  const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

  const { error: insertError } = await supabase.from("link_codes").insert({
    user_id: user.id,
    auth_id: null,
    code: loginCode,
    expires_at: expiresAt.toISOString(),
  });

  if (insertError) {
    console.error("Error inserting login code:", insertError);
    await sendTelegramMessage(
      chatId,
      "❌ Ops! Algo deu errado ao gerar o código. Tente novamente."
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    `🔑 *Seu código de acesso:* \`${loginCode}\`\n\n` +
    `Acesse o dashboard e insira o código para fazer login.\n` +
    `⏰ Válido por *2 minutos*.`
  );
}

export async function handleReset(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  // Get stats for warning message
  const [txCount, catCount, grpCount] = await Promise.all([
    supabase.from("transactions").select("*", { count: "exact", head: true }).eq("user_id", user.id),
    supabase.from("categories").select("*", { count: "exact", head: true }).eq("user_id", user.id),
    supabase.from("groups").select("*", { count: "exact", head: true }).eq("user_id", user.id),
  ]);

  await setWizardState(supabase, user.id, "reset_confirm", {
    user_id: user.id,
    telegram_id: userId,
  });

  await sendTelegramMessage(
    chatId,
    `⚠️ *RESETAR CONTA*\n\n` +
    `Você está prestes a apagar *todos os seus dados* permanentemente:\n\n` +
    `• ${txCount.count || 0} transações\n` +
    `• ${catCount.count || 0} categorias\n` +
    `• ${grpCount.count || 0} grupos\n\n` +
    `Para confirmar, digite exatamente:\n\n` +
    `\`\`\`\nRESETAR\n\`\`\``
  );
}
