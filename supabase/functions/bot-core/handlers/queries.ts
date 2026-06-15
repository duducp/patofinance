import { sendTelegramMessage } from "../services/telegram.ts";
import { requireUser } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR } from "../utils/formatting.ts";
import { getDateRange } from "../utils/date-helpers.ts";

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
  let query = supabase
    .from("transactions")
    .select(`id, type, amount, description, tags, transaction_date, categories(name), groups(name)`)
    .eq("user_id", user.id)
    .gte("transaction_date", start)
    .lte("transaction_date", end)
    .order("transaction_date", { ascending: false })
    .limit(10);
  if (category) query = query.ilike("categories.name", `%${category}%`);
  const { data: transactions } = await query;
  if (!transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, `📝 Nenhuma despesa encontrada em ${label}.`);
    return;
  }
  let message = `📝 *Despesas em ${label}*\n\n`;
  let total = 0;
  for (const t of transactions) {
    const catName = t.categories?.name || "Sem categoria";
    message += `📉 ${formatDateBR(t.transaction_date)} - *${formatCurrencyBR(Number(t.amount))}* | ${catName}\n`;
    if (t.type === "expense") total += Number(t.amount);
  }
  message += `\n💰 Total: *${formatCurrencyBR(total)}*`;
  if (category) message += `\n🔍 Categoria: ${category}`;
  await sendTelegramMessage(chatId, message);
}

export async function handleQuerySummary(
  supabase: any,
  userId: number,
  chatId: number,
  period: "this_month" | "last_month" | null
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;
  const { start, end, label } = getDateRange(period, null);
  const { data: transactions } = await supabase
    .from("transactions")
    .select(`id, type, amount, categories(name)`)
    .eq("user_id", user.id)
    .gte("transaction_date", start)
    .lte("transaction_date", end);
  if (!transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, `📊 Nenhuma transação em ${label}.`);
    return;
  }
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
  let message = `📊 *Resumo - ${label}*\n\n`;
  if (incomes.length > 0) {
    message += `📈 *Receitas: ${formatCurrencyBR(totalIncomes)}*\n`;
    for (const [cat, amount] of Object.entries(incomeByCategory).sort((a, b) => b[1] - a[1])) {
      message += `   • ${cat}: ${formatCurrencyBR(amount)}\n`;
    }
    message += "\n";
  }
  if (expenses.length > 0) {
    message += `📉 *Despesas: ${formatCurrencyBR(totalExpenses)}*\n`;
    for (const [cat, amount] of Object.entries(expenseByCategory).sort((a, b) => b[1] - a[1])) {
      message += `   • ${cat}: ${formatCurrencyBR(amount)}\n`;
    }
    message += "\n";
  }
  const balance = totalIncomes - totalExpenses;
  const emoji = balance >= 0 ? "✅" : "⚠️";
  message += `${emoji} *Saldo: ${formatCurrencyBR(balance)}*`;
  await sendTelegramMessage(chatId, message);
}
