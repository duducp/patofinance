import { sendTelegramMessage } from "../services/telegram.ts";
import { requireUser } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, getTodayISOBR } from "../utils/formatting.ts";
import { getDateRange } from "../utils/date-helpers.ts";

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
  period: "this_month" | "last_month" | null,
  groupId?: number | null,
  includeFuture?: boolean
): Promise<SummaryData | null> {
  const { start, end, label } = getDateRange(period, null);
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
  if (groupName) message += `📁 Grupo: *${groupName}*\n`;
  message += "\n";
  if (data.incomeByCategory && Object.keys(data.incomeByCategory).length > 0) {
    message += `📈 *Receitas: ${formatCurrencyBR(data.totalIncomes)}*\n`;
    for (const [cat, amount] of Object.entries(data.incomeByCategory).sort((a, b) => b[1] - a[1])) {
      message += `   • ${cat}: ${formatCurrencyBR(amount)}\n`;
    }
    message += "\n";
  }
  if (data.expenseByCategory && Object.keys(data.expenseByCategory).length > 0) {
    message += `📉 *Despesas: ${formatCurrencyBR(data.totalExpenses)}*\n`;
    for (const [cat, amount] of Object.entries(data.expenseByCategory).sort((a, b) => b[1] - a[1])) {
      message += `   • ${cat}: ${formatCurrencyBR(amount)}\n`;
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
  period: "this_month" | "last_month" | null,
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
    const icon = t.type === "income" ? "📈" : "📉";
    message += `${icon} ${formatDateBR(t.transaction_date)} - *${formatCurrencyBR(Number(t.amount))}* | ${catName}${desc}\n`;
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
  period: "this_month" | "last_month" | null
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;
  const [data, futureData] = await Promise.all([
    getSummaryData(supabase, user.id, period),
    getSummaryData(supabase, user.id, period, undefined, true),
  ]);

  // If no transactions at all (past nor future)
  if (!data && !futureData) {
    const { label } = getDateRange(period, null);
    await sendTelegramMessage(chatId, `📊 Nenhuma transação em ${label}.`);
    return;
  }

  // Build message: past summary (if any) + scheduled block (if any)
  let message = "";
  if (data) {
    message = formatSummaryMessage(data);
  }

  if (futureData) {
    const futureTotal = futureData.totalIncomes - futureData.totalExpenses;
    if (message) message += `\n\n`;
    message += `⏳ *Agendados:*\n`;
    if (futureData.totalIncomes > 0) {
      message += `   📈 ${formatCurrencyBR(futureData.totalIncomes)}\n`;
    }
    if (futureData.totalExpenses > 0) {
      message += `   📉 ${formatCurrencyBR(futureData.totalExpenses)}\n`;
    }
    const currentBalance = data ? data.totalIncomes - data.totalExpenses : 0;
    message += `\n📊 *Saldo projetado: ${formatCurrencyBR(currentBalance + futureTotal)}*`;
  }

  await sendTelegramMessage(chatId, message);
}
