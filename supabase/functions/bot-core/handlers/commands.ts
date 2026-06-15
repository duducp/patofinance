import type { InlineKeyboard, ExtratoFilters, PeriodPreset } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { requireUser, getOrCreateUser, getOrCreateCategory, getOrCreateGroup, normalizeString, suggestSimilarCategories, suggestSimilarGroups, sendSimilarityWarning, getAllUserTags } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, getTodayISOBR, getMonthName } from "../utils/formatting.ts";
import { getDateRange } from "../utils/date-helpers.ts";
import { parseCommand } from "../utils/command-parsing.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";

import { getSummaryData, formatSummaryMessage } from "./queries.ts";
import { getWizardState, setWizardState, handleTransactionWizard } from "./wizard.ts";

export function resolvePeriod(period: ExtratoFilters["period"]): { start: string; end: string; label: string } {
  const now = new Date();
  if (typeof period === "string") {
    switch (period) {
      case "this_month": {
        const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
        return { start, end, label: getMonthName(now) };
      }
      case "last_month": {
        const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const start = last.toISOString().split("T")[0];
        const end = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split("T")[0];
        return { start, end, label: getMonthName(last) };
      }
      case "last_3_months": {
        const start = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().split("T")[0];
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
        return { start, end, label: "Últimos 3 meses" };
      }
      case "this_year": {
        return {
          start: `${now.getFullYear()}-01-01`,
          end: `${now.getFullYear()}-12-31`,
          label: `${now.getFullYear()}`,
        };
      }
    }
  }
  return { start: period.start, end: period.end, label: `${period.start} — ${period.end}` };
}

export async function handleStart(chatId: number, firstName: string): Promise<void> {
  await sendTelegramMessage(
    chatId,
    `Olá ${firstName}! 👋\n\n` +
    `Que bom ter você aqui! Sou seu assistente de controle financeiro.\n\n` +
    `Comigo você pode registrar gastos e receitas, ver seu saldo e muito mais!\n\n` +
    `Digite /ajuda para ver tudo que posso fazer por você.`
  );
}

export async function handleHelp(chatId: number): Promise<void> {
  await sendTelegramMessage(
    chatId,
    `📚 *Comandos Disponíveis:*\n\n` +
    `💰 *Financeiros:*\n` +
    `/despesa - Registrar despesa (/gasto também funciona)\n` +
    `/receita - Registrar receita\n` +
    `/saldo - Ver saldo do mês\n` +
    `/extrato - Ver extrato do mês\n` +
    `/resumo - Resumo por categoria\n` +
    `/editar - Editar transação (ex: \`/editar 42\`)\n` +
    `/excluir - Excluir transação (ex: \`/excluir 42\`)\n\n` +
    `📁 *Organização:*\n` +
    `/grupo - Gerenciar grupos\n` +
    `/categoria - Gerenciar categorias\n` +
    `/tag - Gerenciar tags\n\n` +
    `⚙️ *Utilidades:*\n` +
    `/limpar - Remover categorias/grupos sem transações\n` +
    `/cancelar - Cancelar operação em andamento\n` +
    `/ajuda - Esta mensagem\n\n` +
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
    `• "transações com #alimentação"`
  );
}

export async function handleBalance(supabase: any, userId: number, chatId: number, args: string[] = []): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const { start: startOfMonth, end: endOfMonth, label: monthName } = getDateRange(null, null);

  // Determine group filter
  let groupId: number | null = null;
  let groupName: string | null = null;
  if (args.length > 0) {
    const searchName = args.join(" ");
    const { data: group } = await supabase
      .from("groups")
      .select("id, name")
      .eq("user_id", user.id)
      .ilike("name", searchName)
      .maybeSingle();
    if (group) {
      groupId = group.id;
      groupName = group.name;
    }
  }

  // Build income query
  let incomeQuery = supabase
    .from("transactions")
    .select("amount")
    .eq("user_id", user.id)
    .eq("type", "income")
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);
  if (groupId) incomeQuery = incomeQuery.eq("group_id", groupId);

  // Build expenses query
  let expensesQuery = supabase
    .from("transactions")
    .select("amount")
    .eq("user_id", user.id)
    .eq("type", "expense")
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);
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

  const balance = totalIncome - totalExpenses;

  const emoji = balance >= 0 ? "✅" : "⚠️";

  let message = `${emoji} *Saldo - ${monthName}*\n`;
  if (groupName) {
    message += `📁 Grupo: *${groupName}*\n`;
  }
  message += `\n📈 Entradas: *${formatCurrencyBR(totalIncome)}*\n` +
    `📉 Saídas: *${formatCurrencyBR(totalExpenses)}*\n\n` +
    `💰 *Saldo: ${formatCurrencyBR(balance)}*`;

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
  args: string[]
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
    await sendTelegramMessage(chatId, msg);
    await setWizardState(supabase, user.id, `${type === "expense" ? "gasto" : "receita"}_amount`, { type });
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

  const categoryId = parsed.category ? await getOrCreateCategory(supabase, user.id, parsed.category) : null;

  // Check for similar existing groups
  if (parsed.group) {
    await sendSimilarityWarning(supabase, user.id, chatId, "group", parsed.group);
  }

  const groupId = await getOrCreateGroup(supabase, user.id, parsed.group);

  // Check for similar existing tags
  for (const tag of parsed.tags) {
    await sendSimilarityWarning(supabase, user.id, chatId, "tag", tag);
  }

  const { error } = await supabase.from("transactions").insert({
    user_id: user.id,
    group_id: groupId,
    category_id: categoryId,
    type,
    amount: parsed.amount,
    description: parsed.category,
    tags: parsed.tags,
    transaction_date: parsed.date || getTodayISOBR(),
  });

  if (error) {
    const msg = type === "expense"
      ? "❌ Ops! Algo deu errado ao registrar o gasto. Tente novamente."
      : "❌ Ops! Algo deu errado ao registrar a receita. Tente novamente.";
    await sendTelegramMessage(chatId, msg);
    return;
  }

  const typeName = type === "expense" ? "Despesa" : "Receita";
  await sendTelegramMessage(
    chatId,
    `✅ *${typeName} registrada com sucesso!*\n\n` +
    `💰 Valor: *${formatCurrencyBR(parsed.amount)}*\n` +
    `🏷️ Categoria: ${parsed.category || "Não definida"}\n` +
    `📁 Grupo: ${parsed.group || "Pessoal"}\n` +
    `📅 Data: ${formatDateBR(parsed.date || getTodayISOBR())}` +
    (parsed.tags.length > 0 ? `\n🔖 Tags: ${parsed.tags.join(" ")}` : "")
  );
}

const STATEMENT_PAGE_SIZE = 10;

type StatementFilter = "all" | "income" | "expense";

function statementFilterLabel(filter: StatementFilter): string {
  switch (filter) {
    case "income": return "📈 Receitas";
    case "expense": return "📉 Despesas";
    default: return "📋 Todas";
  }
}

function statementFilterSuffix(filter: StatementFilter): string {
  switch (filter) {
    case "income": return "inc";
    case "expense": return "exp";
    default: return "all";
  }
}

function parseStatementFilter(suffix: string): StatementFilter {
  switch (suffix) {
    case "inc": return "income";
    case "exp": return "expense";
    default: return "all";
  }
}

export async function handleStatement(
  supabase: any,
  userId: number,
  chatId: number,
  page: number = 0,
  typeFilter: StatementFilter = "all",
  filters?: ExtratoFilters
): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  // Resolve period — from filters or default to current month
  const period = filters?.period || "this_month";
  const { start: periodStart, end: periodEnd, label: periodLabel } = resolvePeriod(period);

  // Build base query for count
  let countQuery = supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd);

  if (typeFilter !== "all") {
    countQuery = countQuery.eq("type", typeFilter);
  }
  if (filters?.category_id) {
    countQuery = countQuery.eq("category_id", filters.category_id);
  }
  if (filters?.group_id) {
    countQuery = countQuery.eq("group_id", filters.group_id);
  }
  if (filters?.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      countQuery = countQuery.contains("tags", [tag]);
    }
  }

  const { count: totalCount } = await countQuery;

  if (!totalCount || totalCount === 0) {
    const filterName = typeFilter === "income" ? "receitas" : typeFilter === "expense" ? "despesas" : "transações";
    await sendTelegramMessage(chatId, `📋 Nenhuma ${filterName} encontrada${period !== "this_month" ? ` em ${periodLabel}` : " este mês"}.`);
    return;
  }

  const offset = page * STATEMENT_PAGE_SIZE;

  // Build data query
  let dataQuery = supabase
    .from("transactions")
    .select(`
      id,
      type,
      amount,
      description,
      tags,
      transaction_date,
      categories (name),
      groups (name)
    `)
    .eq("user_id", user.id)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd);

  if (typeFilter !== "all") {
    dataQuery = dataQuery.eq("type", typeFilter);
  }
  if (filters?.category_id) {
    dataQuery = dataQuery.eq("category_id", filters.category_id);
  }
  if (filters?.group_id) {
    dataQuery = dataQuery.eq("group_id", filters.group_id);
  }
  if (filters?.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      dataQuery = dataQuery.contains("tags", [tag]);
    }
  }

  const { data: transactions } = await dataQuery
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + STATEMENT_PAGE_SIZE - 1);

  if (!transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, "📋 Nenhuma transação encontrada nesta página.");
    return;
  }

  // Fetch totals for the period (independent of pagination)
  let totalsQuery = supabase
    .from("transactions")
    .select("type, amount")
    .eq("user_id", user.id)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd);

  if (typeFilter !== "all") {
    totalsQuery = totalsQuery.eq("type", typeFilter);
  }
  if (filters?.category_id) {
    totalsQuery = totalsQuery.eq("category_id", filters.category_id);
  }
  if (filters?.group_id) {
    totalsQuery = totalsQuery.eq("group_id", filters.group_id);
  }
  if (filters?.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      totalsQuery = totalsQuery.contains("tags", [tag]);
    }
  }

  const { data: periodData } = await totalsQuery;

  const totalIncome = periodData
    ?.filter((t: any) => t.type === "income")
    ?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;
  const totalExpenses = periodData
    ?.filter((t: any) => t.type === "expense")
    ?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;

  const totalPages = Math.ceil(totalCount / STATEMENT_PAGE_SIZE);
  const startItem = offset + 1;
  const endItem = offset + transactions.length;
  const showAllTypes = typeFilter === "all";

  // Separate transactions by type for grouped display
  const incomeTx = transactions.filter((t: any) => t.type === "income");
  const expenseTx = transactions.filter((t: any) => t.type === "expense");

  // Build header
  let message = `📋 *Extrato*   📄 ${page + 1}/${totalPages} (${startItem}–${endItem} de ${totalCount})\n`;

  // Filter summary line (show non-default filters)
  const filterParts: string[] = [];
  if (filters?.category_id) {
    const cat = transactions.find((t: any) => t.categories?.name)?.categories?.name;
    filterParts.push(cat || "categoria específica");
  }
  if (filters?.group_id) {
    const grp = transactions.find((t: any) => t.groups?.name)?.groups?.name;
    filterParts.push(grp || "grupo específico");
  }
  if (filters?.tags && filters.tags.length > 0) {
    filterParts.push(filters.tags.map((t: string) => t.startsWith("#") ? t : `#${t}`).join(" "));
  }
  if (period !== "this_month") {
    filterParts.push(periodLabel);
  }
  if (!showAllTypes) {
    filterParts.push(typeFilter === "income" ? "📈 Receitas" : "📉 Despesas");
  }
  if (filterParts.length > 0) {
    message += `🔽 ${filterParts.join(" · ")}\n`;
  }
  message += "\n";

  // Helper to format a single transaction line
  function appendTxLine(t: any): string {
    const shortDate = formatDateBR(t.transaction_date).slice(0, 5);
    const catName = t.categories?.name || "—";
    const grpName = t.groups?.name || "Pessoal";
    const tags = t.tags?.length ? ` ${t.tags.join(" ")}` : "";
    return `• \`#${t.id}\`  ${shortDate}  *${formatCurrencyBR(Number(t.amount))}*   ${catName} · ${grpName}${tags}\n`;
  }

  // Income section
  if (incomeTx.length > 0 && (showAllTypes || typeFilter === "income")) {
    if (showAllTypes) {
      message += `📈 *Receitas*\n`;
    }
    for (const t of incomeTx) {
      message += appendTxLine(t);
    }
    message += `Total: ${formatCurrencyBR(totalIncome)}\n\n`;
  }

  // Expense section
  if (expenseTx.length > 0 && (showAllTypes || typeFilter === "expense")) {
    if (showAllTypes) {
      message += `📉 *Despesas*\n`;
    }
    for (const t of expenseTx) {
      message += appendTxLine(t);
    }
    message += `Total: ${formatCurrencyBR(totalExpenses)}\n\n`;
  }

  // Overall balance (only when showing all and both types have data or one has data)
  if (showAllTypes) {
    const balance = totalIncome - totalExpenses;
    const balanceEmoji = balance >= 0 ? "✅" : "⚠️";
    message += `${balanceEmoji} *Saldo: ${formatCurrencyBR(balance)}*`;
  }

  // If we only have one section, no need for extra blank line at the end
  const hasIncome = incomeTx.length > 0;
  const hasExpense = expenseTx.length > 0;
  if (hasIncome && !hasExpense && showAllTypes) {
    message = message.replace(/\n\n$/, "");
  }

  const currentSuffix = statementFilterSuffix(typeFilter);

  // Build keyboard
  const sessionSeq = await getSessionSeq(supabase, user.id);

  // Build keyboard
  const keyboard: InlineKeyboard = [];

  // Filter row
  const filterRow: InlineKeyboard[0] = [];
  const filterOptions: { label: string; filter: StatementFilter }[] = [
    { label: "📈 Receitas", filter: "income" },
    { label: "📉 Despesas", filter: "expense" },
    { label: "📋 Todas", filter: "all" },
  ];
  for (const opt of filterOptions) {
    const isActive = typeFilter === opt.filter;
    filterRow.push({
      text: isActive ? `✅ ${opt.label}` : opt.label,
      callback_data: addSession(`statement_${statementFilterSuffix(opt.filter)}_0`, sessionSeq),
    });
  }
  keyboard.push(filterRow);

  // 🔍 Novo filtro button (only when not using quick-filter from results)
  keyboard.push([{ text: "🔍 Novo filtro", callback_data: addSession("stmt_filter", sessionSeq) }]);

  // Pagination row
  const navButtons: InlineKeyboard[0] = [];
  if (page > 0) {
    navButtons.push({ text: "◀️ Anterior", callback_data: addSession(`statement_${currentSuffix}_${page - 1}`, sessionSeq) });
  }
  if (page + 1 < totalPages) {
    navButtons.push({ text: "Próximo ▶️", callback_data: addSession(`statement_${currentSuffix}_${page + 1}`, sessionSeq) });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}

export async function handleSummary(supabase: any, userId: number, chatId: number, args: string[] = []): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  // Determine group filter
  let groupId: number | null = null;
  let groupName: string | null = null;
  if (args.length > 0) {
    const searchName = args.join(" ");
    const { data: group } = await supabase
      .from("groups")
      .select("id, name")
      .eq("user_id", user.id)
      .ilike("name", searchName)
      .maybeSingle();
    if (group) {
      groupId = group.id;
      groupName = group.name;
    }
  }

  const data = await getSummaryData(supabase, user.id, null, groupId);
  if (!data) {
    if (groupName) {
      const keyboard: InlineKeyboard = [[{ text: "📋 Todas as contas", callback_data: "summary_grp_all" }]];
      await sendTelegramMessageWithKeyboard(chatId, `📊 Nenhuma transação no grupo *${groupName}* este mês.`, keyboard);
    } else {
      await sendTelegramMessage(chatId, "📊 Nenhuma transação encontrada este mês. Que tal começar registrando um gasto ou receita?");
    }
    return;
  }

  const message = formatSummaryMessage(data, groupName || undefined);
  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];
  if (groupId) {
    keyboard.push([{ text: "📋 Todas as contas", callback_data: addSession("summary_grp_all", sessionSeq) }]);
  }
  keyboard.push([{ text: "📁 Filtrar por grupo", callback_data: addSession("summary_shwgrp", sessionSeq) }]);

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}

export async function handleEdit(supabase: any, userId: number, chatId: number, args: string[] = []): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  if (args.length === 0) {
    await sendTelegramMessage(
      chatId,
      `📝 *Como editar uma transação:*\n\n` +
      `1️⃣ Use \`/extrato\` para ver o extrato do mês\n` +
      `2️⃣ Identifique o \`#ID\` da transação que deseja editar\n` +
      `3️⃣ Digite \`/editar ID\` (ex: \`/editar 42\`)\n\n` +
      `💡 Exemplo: \`/editar 42\``
    );
    return;
  }

  const transactionId = args[0];

  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      type,
      amount,
      description,
      tags,
      transaction_date,
      categories (name),
      groups (name)
    `)
    .eq("id", transactionId)
    .eq("user_id", user.id)
    .single();

  if (!transaction) {
    await sendTelegramMessage(
      chatId,
      `❌ Transação \`#${transactionId}\` não encontrada.\n\n` +
      `Use \`/extrato\` para ver as transações disponíveis.`
    );
    return;
  }

  const emoji = transaction.type === "income" ? "📈" : "📉";
  const typeName = transaction.type === "income" ? "Receita" : "Despesa";
  const catName = transaction.categories?.name || "Sem categoria";
  const groupName = transaction.groups?.name || "Sem grupo";
  const tags = transaction.tags?.length ? transaction.tags.join(" ") : "—";

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [
    [
      { text: "✏️ Editar valor", callback_data: addSession(`edit_amount_${transaction.id}`, sessionSeq) },
      { text: "🏷️ Editar categoria", callback_data: addSession(`edit_category_${transaction.id}`, sessionSeq) },
    ],
    [
      { text: "📁 Editar grupo", callback_data: addSession(`edit_group_${transaction.id}`, sessionSeq) },
      { text: "🔖 Editar tags", callback_data: addSession(`edit_tags_${transaction.id}`, sessionSeq) },
    ],
    [
      { text: "📅 Editar data", callback_data: addSession(`edit_date_${transaction.id}`, sessionSeq) },
      { text: "❌ Excluir", callback_data: addSession(`confirm_delete_${transaction.id}`, sessionSeq) },
    ],
  ];

  await sendTelegramMessageWithKeyboard(
    chatId,
    `${emoji} *${typeName} \`#${transaction.id}\`:*\n\n` +
    `💰 Valor: *${formatCurrencyBR(Number(transaction.amount))}*\n` +
    `🏷️ Categoria: ${catName}\n` +
    `📁 Grupo: ${groupName}\n` +
    `🔖 Tags: ${tags}\n` +
    `📅 Data: ${formatDateBR(transaction.transaction_date)}\n\n` +
    `O que deseja fazer?`,
    keyboard
  );
}

export async function handleDelete(supabase: any, userId: number, chatId: number, args: string[] = []): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  if (args.length === 0) {
    await sendTelegramMessage(
      chatId,
      `🗑️ *Como excluir uma transação:*\n\n` +
      `1️⃣ Use \`/extrato\` para ver o extrato do mês\n` +
      `2️⃣ Identifique o \`#ID\` da transação que deseja excluir\n` +
      `3️⃣ Digite \`/excluir ID\` (ex: \`/excluir 42\`)\n\n` +
      `💡 Exemplo: \`/excluir 42\``
    );
    return;
  }

  const transactionId = args[0];

  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      type,
      amount,
      description,
      transaction_date,
      categories (name)
    `)
    .eq("id", transactionId)
    .eq("user_id", user.id)
    .single();

  if (!transaction) {
    await sendTelegramMessage(
      chatId,
      `❌ Transação \`#${transactionId}\` não encontrada.\n\n` +
      `Use \`/extrato\` para ver as transações disponíveis.`
    );
    return;
  }

  const emoji = transaction.type === "income" ? "📈" : "📉";
  const typeName = transaction.type === "income" ? "Receita" : "Despesa";
  const catName = transaction.categories?.name || "Sem categoria";

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Sim, excluir", callback_data: addSession(`confirm_delete_${transaction.id}`, sessionSeq) },
      { text: "❌ Não, manter", callback_data: addSession("cancel_delete", sessionSeq) },
    ],
  ];

  await sendTelegramMessageWithKeyboard(
    chatId,
    `${emoji} *${typeName} \`#${transaction.id}\`:*\n\n` +
    `💰 Valor: *${formatCurrencyBR(Number(transaction.amount))}*\n` +
    `🏷️ Categoria: ${catName}\n` +
    `📅 Data: ${formatDateBR(transaction.transaction_date)}\n\n` +
    `Tem certeza de que deseja excluir esta transação?`,
    keyboard
  );
}

export async function handleEntity(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  args: string[]
): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

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
    const selectFields = isCategory ? `id, name, ${flagColumn}, transaction_type` : `id, name, ${flagColumn}`;
    const orderQuery = isCategory
      ? supabase.from(table).select(selectFields).eq("user_id", user.id).order("is_predefined", { ascending: false }).order("name")
      : supabase.from(table).select(selectFields).eq("user_id", user.id).order("name");
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
      message += `• ${item.name}${defaultTag}${typeIcon} — ${count} ${count !== 1 ? "transações" : "transação"}\n`;
    }
    message += `\n💡 Para adicionar: \`${cmdRef}\``;

    const sessionSeq = await getSessionSeq(supabase, user.id);
    // Build keyboard with 3 items per row
    const keyboard: InlineKeyboard = [];
    let row: { text: string; callback_data: string }[] = [];
    for (const item of items) {
      row.push({ text: item.name, callback_data: addSession(`${cbPrefix}${item.name}`, sessionSeq) });
      if (row.length === 3) {
        keyboard.push(row);
        row = [];
      }
    }
    if (row.length > 0) keyboard.push(row);

    await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
    return;
  }

  const entityName = args.join(" ");

  // Check for exact match first (prevents duplicate creation with friendly message)
  const normalized = normalizeString(entityName);
  const { data: existing } = await supabase
    .from(table)
    .select("id, name, " + flagColumn)
    .eq("user_id", user.id)
    .eq("normalized_name", normalized)
    .maybeSingle();
  if (existing) {
    const defaultTag = existing[flagColumn] ? ` ⭐ (padrão)` : "";
    await sendTelegramMessage(
      chatId,
      `⚠️ ${icon} ${label.charAt(0).toUpperCase() + label.slice(1)} "${existing.name}"${defaultTag} já existe.`
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
      `⚠️ Você quis dizer *${similar[0].name}*? (${(similar[0].similarity * 100).toFixed(0)}% similar)\n\nCaso contrário, confirme para criar *${entityName}* mesmo assim.`,
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

export async function handleGroup(supabase: any, userId: number, chatId: number, args: string[]): Promise<void> {
  return handleEntity("group", supabase, userId, chatId, args);
}

export async function handleCategory(supabase: any, userId: number, chatId: number, args: string[]): Promise<void> {
  return handleEntity("category", supabase, userId, chatId, args);
}

export async function handleTag(supabase: any, userId: number, chatId: number, args: string[]): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

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
    message += `• ${displayTag} — ${count} ${count !== 1 ? "transações" : "transação"}\n`;
  }
  message += "\n💡 Clique em uma tag para ver as transações.";

  const sessionSeq = await getSessionSeq(supabase, user.id);
  // Build keyboard with 3 tags per row
  const keyboard: InlineKeyboard = [];
  let row: { text: string; callback_data: string }[] = [];
  for (const tag of allTags) {
    const displayTag = tag.startsWith("#") ? tag : `#${tag}`;
    row.push({ text: displayTag, callback_data: addSession(`tag_sel_${tag}`, sessionSeq) });
    if (row.length === 3) {
      keyboard.push(row);
      row = [];
    }
  }
  if (row.length > 0) keyboard.push(row);

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}

export async function handleCleanup(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

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
    message += unusedCats.map((c: any) => `   • ${c.name}`).join("\n") + "\n\n";
  }

  if (unusedGrps.length > 0) {
    message += `📁 *Grupos sem transações (${unusedGrps.length}):*\n`;
    message += unusedGrps.map((g: any) => `   • ${g.name}`).join("\n") + "\n\n";
  }

  message += "Deseja removê-los?";

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [
    [{ text: "✅ Sim, limpar tudo", callback_data: addSession("confirm_cleanup", sessionSeq) }],
    [{ text: "❌ Não, cancelar", callback_data: addSession("cancel_cleanup", sessionSeq) }],
  ];

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}
