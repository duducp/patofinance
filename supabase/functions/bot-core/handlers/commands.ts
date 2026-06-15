import type { DeepSeekResponse, InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { requireUser, getOrCreateUser, getCategories, getOrCreateCategory, getOrCreateGroup } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, parseDateBR, getTodayISOBR, getNowBR, getMonthName } from "../utils/formatting.ts";
import { parseCommand } from "../utils/command-parsing.ts";
import { getWizardState, setWizardState, clearWizardState, handleTransactionWizard, sendWizardStepMessage } from "./wizard.ts";

export async function handleStart(chatId: number, firstName: string): Promise<void> {
  await sendTelegramMessage(
    chatId,
    `Olá ${firstName}! 👋\n\n` +
    `Que bom ter você aqui! Sou seu assistente de controle financeiro.\n\n` +
    `Comigo você pode registrar gastos e receitas, ver seu saldo e muito mais!\n\n` +
    `Digite /ajuda para ver tudo que posso fazer por você.`
  );
}

export async function handleAjuda(chatId: number): Promise<void> {
  await sendTelegramMessage(
    chatId,
    `📚 *Comandos Disponíveis:*\n\n` +
    `💰 *Financeiros:*\n` +
    `/gasto - Registrar despesa\n` +
    `/receita - Registrar receita\n` +
    `/saldo - Ver saldo do mês\n` +
    `/extrato - Ver extrato do mês\n` +
    `/resumo - Resumo por categoria\n` +
    `/editar - Editar última transação\n` +
    `/excluir - Excluir uma transação\n\n` +
    `📁 *Organização:*\n` +
    `/grupo - Gerenciar grupos\n` +
    `/categoria - Gerenciar categorias\n\n` +
    `⚙️ *Utilidades:*\n` +
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
    `• "quais tags uso?"\n\n` +
    `📋 *Transações:*\n` +
    `• "últimas 30 transações"\n` +
    `• "qual foi meu último gasto?"\n` +
    `• "apague a última transação"\n` +
    `• "transações com #alimentação"`
  );
}

export async function handleSaldo(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const now = getNowBR();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

  const { data: income } = await supabase
    .from("transactions")
    .select("amount")
    .eq("user_id", user.id)
    .eq("type", "income")
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);

  const { data: expenses } = await supabase
    .from("transactions")
    .select("amount")
    .eq("user_id", user.id)
    .eq("type", "expense")
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);

  const totalIncome = income?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;
  const totalExpenses = expenses?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;
  const balance = totalIncome - totalExpenses;

  const monthName = getMonthName(now);
  const emoji = balance >= 0 ? "✅" : "⚠️";

  await sendTelegramMessage(
    chatId,
    `${emoji} *Saldo - ${monthName}*\n\n` +
    `📈 Entradas: *${formatCurrencyBR(totalIncome)}*\n` +
    `📉 Saídas: *${formatCurrencyBR(totalExpenses)}*\n\n` +
    `💰 *Saldo: ${formatCurrencyBR(balance)}*`
  );
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
    await setWizardState(supabase, user.id, `${type === "expense" ? "gasto" : "receita"}_amount`);
    return;
  }

  const parsed = parseCommand(args);

  if (!parsed.amount) {
    const cmd = type === "expense" ? "/gasto" : "/receita";
    await sendTelegramMessage(chatId, `Por favor, informe o valor. Ex: \`${cmd} 50 alimentação\``);
    return;
  }

  const categoryId = parsed.category ? await getOrCreateCategory(supabase, user.id, parsed.category) : null;
  const groupId = await getOrCreateGroup(supabase, user.id, parsed.group);

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

export async function handleExtrato(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const now = getNowBR();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

  const { data: transactions } = await supabase
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
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth)
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(30);

  if (!transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, "📋 Nenhuma transação encontrada este mês. Que tal registrar um gasto ou receita?");
    return;
  }

  const monthName = getMonthName(now);
  let message = `📋 *Extrato - ${monthName}*\n\n`;

  for (const t of transactions) {
    const emoji = t.type === "income" ? "📈" : "📉";
    const category = t.categories?.name || "Sem categoria";
    const group = t.groups?.name || "Sem grupo";
    const tags = t.tags?.length ? ` ${t.tags.join(" ")}` : "";

    message += `${emoji} ${formatDateBR(t.transaction_date)} - *${formatCurrencyBR(Number(t.amount))}*\n`;
    message += `   ${category} | ${group}${tags}\n`;
  }

  if (transactions.length === 30) {
    message += "\n💡 Mostrando apenas as 30 transações mais recentes.";
  }

  await sendTelegramMessage(chatId, message);
}

export async function handleResumo(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];

  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      type,
      amount,
      categories (name)
    `)
    .eq("user_id", user.id)
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);

  if (!transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, "📊 Nenhuma transação encontrada este mês. Que tal começar registrando um gasto ou receita?");
    return;
  }

  const monthName = getMonthName(now);
  const expenses = transactions.filter((t: any) => t.type === "expense");
  const incomes = transactions.filter((t: any) => t.type === "income");

  const totalExpenses = expenses.reduce((sum: number, t: any) => sum + Number(t.amount), 0);
  const totalIncomes = incomes.reduce((sum: number, t: any) => sum + Number(t.amount), 0);

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

  let message = `📊 *Resumo - ${monthName}*\n\n`;

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

export async function handleEditar(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const { data: lastTransaction } = await supabase
    .from("transactions")
    .select(`
      id,
      type,
      amount,
      description,
      transaction_date,
      categories (name)
    `)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!lastTransaction) {
    await sendTelegramMessage(chatId, "📝 Nenhuma transação encontrada para editar.");
    return;
  }

  const emoji = lastTransaction.type === "income" ? "📈" : "📉";
  const typeName = lastTransaction.type === "income" ? "Receita" : "Despesa";
  const catName = lastTransaction.categories?.name || "Sem categoria";

  const keyboard: InlineKeyboard = [
    [
      { text: "✏️ Editar valor", callback_data: `edit_amount_${lastTransaction.id}` },
      { text: "🏷️ Editar categoria", callback_data: `edit_category_${lastTransaction.id}` },
    ],
    [
      { text: "📅 Editar data", callback_data: `edit_date_${lastTransaction.id}` },
      { text: "❌ Excluir", callback_data: `confirm_delete_${lastTransaction.id}` },
    ],
  ];

  await sendTelegramMessageWithKeyboard(
    chatId,
    `${emoji} *Última ${typeName}:*\n\n` +
    `💰 Valor: *${formatCurrencyBR(Number(lastTransaction.amount))}*\n` +
    `🏷️ Categoria: ${catName}\n` +
    `📅 Data: ${formatDateBR(lastTransaction.transaction_date)}\n\n` +
    `O que deseja fazer?`,
    keyboard
  );
}

export async function handleExcluir(supabase: any, userId: number, chatId: number, args: string[]): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  if (args.length === 0) {
    const { data: lastTransaction } = await supabase
      .from("transactions")
      .select(`
        id,
        type,
        amount,
        description,
        transaction_date,
        categories (name)
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!lastTransaction) {
      await sendTelegramMessage(chatId, "📝 Nenhuma transação encontrada para excluir.");
      return;
    }

    const emoji = lastTransaction.type === "income" ? "📈" : "📉";
    const typeName = lastTransaction.type === "income" ? "Receita" : "Despesa";
    const catName = lastTransaction.categories?.name || "Sem categoria";

    const keyboard: InlineKeyboard = [
      [
        { text: "✅ Sim, excluir", callback_data: `confirm_delete_${lastTransaction.id}` },
        { text: "❌ Não, manter", callback_data: "cancel_delete" },
      ],
    ];

    await sendTelegramMessageWithKeyboard(
      chatId,
      `${emoji} *Última ${typeName}:*\n\n` +
      `💰 Valor: *${formatCurrencyBR(Number(lastTransaction.amount))}*\n` +
      `🏷️ Categoria: ${catName}\n` +
      `📅 Data: ${formatDateBR(lastTransaction.transaction_date)}\n\n` +
      `Tem certeza que deseja excluir esta transação?`,
      keyboard
    );
    return;
  }

  const transactionId = args[0];
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", transactionId)
    .eq("user_id", user.id)
    .single();

  if (!transaction) {
    await sendTelegramMessage(chatId, "❌ Transação não encontrada.");
    return;
  }

  const { error } = await supabase.from("transactions").delete().eq("id", transactionId);

  if (error) {
    await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao excluir. Tente novamente.");
    return;
  }

  await sendTelegramMessage(chatId, "✅ Transação excluída com sucesso!");
}

export async function handleGrupo(supabase: any, userId: number, chatId: number, args: string[]): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  if (args.length === 0) {
    const { data: groups } = await supabase
      .from("groups")
      .select("name, is_default")
      .eq("user_id", user.id)
      .order("name");

    if (!groups || groups.length === 0) {
      await sendTelegramMessage(chatId, "📁 Nenhum grupo encontrado. Crie um com `/grupo nome_do_grupo`");
      return;
    }

    let message = "📁 *Seus grupos:*\n\n";
    for (const g of groups) {
      const defaultTag = g.is_default ? " ⭐ (padrão)" : "";
      message += `• ${g.name}${defaultTag}\n`;
    }
    message += "\n💡 Para adicionar: `/grupo nome_do_grupo`";
    await sendTelegramMessage(chatId, message);
    return;
  }

  const groupName = args.join(" ");

  const { error } = await supabase.from("groups").insert({
    user_id: user.id,
    name: groupName,
    is_default: false,
  });

  if (error) {
    if (error.code === "23505") {
      await sendTelegramMessage(chatId, "⚠️ Já existe um grupo com esse nome. Escolha outro nome.");
    } else {
      await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao criar o grupo. Tente novamente.");
    }
    return;
  }

  await sendTelegramMessage(chatId, `✅ Grupo "${groupName}" criado com sucesso!`);
}

export async function handleCategoria(supabase: any, userId: number, chatId: number, args: string[]): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  if (args.length === 0 || args[0] === "listar") {
    const { data: categories } = await supabase
      .from("categories")
      .select("name, is_predefined")
      .eq("user_id", user.id)
      .order("is_predefined", { ascending: false })
      .order("name");

    if (!categories || categories.length === 0) {
      await sendTelegramMessage(chatId, "🏷️ Nenhuma categoria encontrada. Crie uma com `/categoria nome_da_categoria`");
      return;
    }

    let message = "🏷️ *Suas categorias:*\n\n";
    for (const c of categories) {
      const tag = c.is_predefined ? " ⭐ (padrão)" : "";
      message += `• ${c.name}${tag}\n`;
    }
    message += "\n💡 Para adicionar: `/categoria nome_da_categoria`";
    await sendTelegramMessage(chatId, message);
    return;
  }

  const categoryName = args.join(" ");

  const { error } = await supabase.from("categories").insert({
    user_id: user.id,
    name: categoryName,
    is_predefined: false,
  });

  if (error) {
    if (error.code === "23505") {
      await sendTelegramMessage(chatId, "⚠️ Já existe uma categoria com esse nome. Escolha outro nome.");
    } else {
      await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao criar a categoria. Tente novamente.");
    }
    return;
  }

  await sendTelegramMessage(chatId, `✅ Categoria "${categoryName}" criada com sucesso!`);
}
