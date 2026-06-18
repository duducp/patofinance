import { PeriodResult, InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { requireUser } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, getTodayISOBR, sanitizeMarkdown } from "../utils/formatting.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { getDateRange } from "../utils/date-helpers.ts";

/**
 * Format the future/scheduled transactions block used in balance, summary, and query.
 */
export function formatFutureBlock(
  totalIncomes: number,
  totalExpenses: number,
  currentBalance: number
): string {
  let block = `⏳ *Agendados:*\n`;
  if (totalIncomes > 0) {
    block += `   📈 ${formatCurrencyBR(totalIncomes)}\n`;
  }
  if (totalExpenses > 0) {
    block += `   📉 ${formatCurrencyBR(totalExpenses)}\n`;
  }
  block += `\n📊 *Saldo projetado: ${formatCurrencyBR(currentBalance + totalIncomes - totalExpenses)}*`;
  return block;
}

export interface SummaryData {
  monthName: string;
  totalIncomes: number;
  totalExpenses: number;
  expenseByCategory: Record<string, number>;
  incomeByCategory: Record<string, number>;
}

/**
 * Fetch and aggregate transactions for summary.
 * @param includeFuture - if true, only future transactions; if false (default), only past+today.
 */
export async function getSummaryData(
  supabase: any,
  userId: number,
  periodResult: PeriodResult | null,
  groupId?: number | null,
  includeFuture?: boolean
): Promise<SummaryData | null> {
  let start: string, end: string, label: string;
  if (periodResult) {
    start = periodResult.start;
    end = periodResult.end;
    label = periodResult.label;
  } else {
    const range = getDateRange(null, null);
    start = range.start;
    end = range.end;
    label = range.label;
  }
  let query = supabase
    .from("transactions")
    .select(`type, amount, categories(name)`)
    .eq("user_id", userId)
    .gte("transaction_date", start)
    .lte("transaction_date", end);
  if (includeFuture) {
    query = query.gt("transaction_date", getTodayISOBR());
  } else {
    query = query.lte("transaction_date", getTodayISOBR());
  }
  if (groupId) query = query.eq("group_id", groupId);
  const { data: transactions } = await query;
  if (!transactions || transactions.length === 0) return null;
  const expenses = transactions.filter((t: any) => t.type === "expense");
  const incomes = transactions.filter((t: any) => t.type === "income");
  const totalIncomes = incomes.reduce((s: number, t: any) => s + Number(t.amount), 0);
  const totalExpenses = expenses.reduce((s: number, t: any) => s + Number(t.amount), 0);
  const expenseByCategory: Record<string, number> = {};
  for (const t of expenses) {
    const cat = t.categories?.name || "Sem categoria";
    expenseByCategory[cat] = (expenseByCategory[cat] || 0) + Number(t.amount);
  }
  const incomeByCategory: Record<string, number> = {};
  for (const t of incomes) {
    const cat = t.categories?.name || "Sem categoria";
    incomeByCategory[cat] = (incomeByCategory[cat] || 0) + Number(t.amount);
  }
  return { monthName: label, totalIncomes, totalExpenses, expenseByCategory, incomeByCategory };
}

export function formatSummaryMessage(data: SummaryData, groupName?: string): string {
  let message = `📊 *Resumo - ${data.monthName}*\n`;
  if (groupName) message += `📁 Grupo: *${sanitizeMarkdown(groupName)}*\n`;
  message += "\n";
  if (data.incomeByCategory && Object.keys(data.incomeByCategory).length > 0) {
    message += `📈 *Receitas: ${formatCurrencyBR(data.totalIncomes)}*\n`;
    for (const [cat, amount] of Object.entries(data.incomeByCategory).sort((a, b) => b[1] - a[1])) {
      message += `   • ${sanitizeMarkdown(cat)}: ${formatCurrencyBR(amount)}\n`;
    }
    message += "\n";
  }
  if (data.expenseByCategory && Object.keys(data.expenseByCategory).length > 0) {
    message += `📉 *Despesas: ${formatCurrencyBR(data.totalExpenses)}*\n`;
    for (const [cat, amount] of Object.entries(data.expenseByCategory).sort((a, b) => b[1] - a[1])) {
      message += `   • ${sanitizeMarkdown(cat)}: ${formatCurrencyBR(amount)}\n`;
    }
    message += "\n";
  }
  const balance = data.totalIncomes - data.totalExpenses;
  const emoji = balance >= 0 ? "✅" : "⚠️";
  message += `${emoji} *Saldo: ${formatCurrencyBR(balance)}*`;
  return message;
}

export async function handleQueryExpenses(
  supabase: any,
  userId: number,
  chatId: number,
  period: string | null,
  date: string | null,
  category: string | null
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;
  const { start, end, label } = getDateRange(period, date);
  const queryFilters = buildQueryExpensesFilters(category);
  let query = supabase
    .from("transactions")
    .select(`id, type, amount, description, tags, transaction_date, categories(name), groups(name)`)
    .eq("user_id", user.id)
    .eq("type", queryFilters.type)
    .gte("transaction_date", start)
    .lte("transaction_date", end)
    .order("transaction_date", { ascending: false });
  // Apply limit after filtering when category filter is active, otherwise at DB level
  if (queryFilters.limit) query = query.limit(queryFilters.limit);
  const { data: transactions } = await query;
  if (!transactions || transactions.length === 0) {
    const msg = category
      ? `📝 Nenhuma transação encontrada em ${label}.`
      : `📝 Nenhuma despesa encontrada em ${label}.`;
    await sendTelegramMessage(chatId, msg);
    return;
  }
  // Filter by category in JavaScript (Supabase JS doesn't support ilike on joined tables)
  const filtered = category
    ? transactions.filter((t: any) => {
        const catName = (t.categories?.name || "").toLowerCase();
        return catName.includes(category.toLowerCase());
      })
    : transactions;
  if (filtered.length === 0) {
    const msg = category
      ? `📝 Nenhuma transação em ${label} com categoria "${category}".`
      : `📝 Nenhuma despesa em ${label} com categoria "${category}".`;
    await sendTelegramMessage(chatId, msg);
    return;
  }
  // Apply JS limit only when category filter was used (DB limit was deferred)
  const limited = category ? filtered.slice(0, 10) : filtered;
  let message = `📝 *Despesas em ${label}*\n\n`;
  let total = 0;
  for (const t of limited) {
    const catName = t.categories?.name || "Sem categoria";
    const desc = t.description ? ` — ${t.description}` : "";
    message += `${formatDateBR(t.transaction_date)} - *${formatCurrencyBR(Number(t.amount))}* | ${sanitizeMarkdown(catName)}${sanitizeMarkdown(desc)}\n`;
    total += Number(t.amount);
  }
  message += `\n💰 Total: *${formatCurrencyBR(total)}*`;
  if (category) message += `\n🔍 Categoria: ${category}`;
  await sendTelegramMessage(chatId, message);
}

export function buildQueryExpensesFilters(category: string | null): { type: "expense"; limit: number | null } {
  return {
    type: "expense",
    limit: category ? null : 10,
  };
}

export async function handleQuerySummary(
  supabase: any,
  userId: number,
  chatId: number,
  period: string | null
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;
  const periodResult = period ? getDateRange(period, null) : null;
  const [data, futureData] = await Promise.all([
    getSummaryData(supabase, user.id, periodResult),
    getSummaryData(supabase, user.id, periodResult, undefined, true),
  ]);

  // If no transactions at all (past nor future)
  if (!data && !futureData) {
    const label = periodResult?.label || getDateRange(null, null).label;
    await sendTelegramMessage(chatId, `📊 Nenhuma transação em ${label}.`);
    return;
  }

  // Build message: past summary (if any) + scheduled block (if any)
  let message = "";
  if (data) {
    message = formatSummaryMessage(data);
  }

  if (futureData) {
    const currentBalance = data ? data.totalIncomes - data.totalExpenses : 0;
    if (message) message += `\n\n`;
    message += formatFutureBlock(futureData.totalIncomes, futureData.totalExpenses, currentBalance);
  }

  await sendTelegramMessage(chatId, message);
}

export async function sendTransactionSuccess(
  supabase: any,
  chatId: number,
  userId: number,
  type: "expense" | "income",
  params: {
    amount: number;
    category?: string | null;
    group?: string | null;
    date: string;
    description?: string | null;
    tags: string[];
    transactionId?: number | null;
  },
): Promise<void> {
  const typeName = type === "expense" ? "Despesa" : "Receita";
  const seq = await getSessionSeq(supabase, userId);
  if (!params.transactionId) return;
  const catName = params.category ? sanitizeMarkdown(params.category) : "Não definida";
  const grpName = params.group ? sanitizeMarkdown(params.group) : "Pessoal";
  const desc = params.description ? sanitizeMarkdown(params.description) : "";
  const tagsStr = params.tags.length > 0 ? params.tags.map(sanitizeMarkdown).join(" ") : "";

  const keyboard: InlineKeyboard = [
    [{ text: "🔍 Ver detalhes", callback_data: addSession(`edit_show_${params.transactionId}`, seq) }],
    [{ text: "🔄 Transformar em recorrência", callback_data: addSession(`rec_transform_${params.transactionId}`, seq) }],
  ];

  let msg = `✅ *${typeName} registrada com sucesso!*\n\n` +
    `🆔 *ID:* #${params.transactionId}\n` +
    `💰 *Valor:* ${formatCurrencyBR(params.amount)}\n`;

  if (desc) {
    msg += `📝 *Descrição:* ${desc}\n`;
  }

  msg += `🏷️ *Categoria:* ${catName}\n` +
    `📁 *Grupo:* ${grpName}\n`;

  if (tagsStr) {
    msg += `🔖 *Tags:* ${tagsStr}\n`;
  }

  msg += `📅 *Data:* ${formatDateBR(params.date)}`;

  await sendTelegramMessageWithKeyboard(chatId, msg, keyboard);
}
