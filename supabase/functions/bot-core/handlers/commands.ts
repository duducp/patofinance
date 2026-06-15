import type { InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { requireUser, getOrCreateUser, getOrCreateCategory, getOrCreateGroup, normalizeString, suggestSimilarCategories, suggestSimilarGroups, sendSimilarityWarning, getAllUserTags } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, getTodayISOBR } from "../utils/formatting.ts";
import { getDateRange } from "../utils/date-helpers.ts";
import { parseCommand } from "../utils/command-parsing.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { getSummaryData, formatSummaryMessage } from "./queries.ts";
import { getWizardState, setWizardState, handleTransactionWizard } from "./wizard.ts";

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
    `/gasto - Registrar despesa\n` +
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
    const keyboard: InlineKeyboard = [[{ text: "📋 Todas as contas", callback_data: "balance_grp_all" }]];
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

  const keyboard: InlineKeyboard = [];
  if (groupId) {
    keyboard.push([{ text: "📋 Todas as contas", callback_data: "balance_grp_all" }]);
  }
  keyboard.push([{ text: "📁 Filtrar por grupo", callback_data: "balance_shwgrp" }]);

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
    await setWizardState(supabase, user.id, `${type === "expense" ? "gasto" : "receita"}_amount`);
    return;
  }

  const parsed = parseCommand(args);

  if (!parsed.amount) {
    const cmd = type === "expense" ? "/gasto" : "/receita";
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

export async function handleStatement(supabase: any, userId: number, chatId: number, page: number = 0, typeFilter: StatementFilter = "all"): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const { start: startOfMonth, end: endOfMonth, label: monthName } = getDateRange(null, null);

  // Build base query for count
  let countQuery = supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);

  if (typeFilter !== "all") {
    countQuery = countQuery.eq("type", typeFilter);
  }

  const { count: totalCount } = await countQuery;

  if (!totalCount || totalCount === 0) {
    const filterName = typeFilter === "income" ? "receitas" : typeFilter === "expense" ? "despesas" : "transações";
    await sendTelegramMessage(chatId, `📋 Nenhuma ${filterName} encontrada este mês.`);
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
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);

  if (typeFilter !== "all") {
    dataQuery = dataQuery.eq("type", typeFilter);
  }

  const { data: transactions } = await dataQuery
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + STATEMENT_PAGE_SIZE - 1);

  if (!transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, "📋 Nenhuma transação encontrada nesta página.");
    return;
  }

  const totalPages = Math.ceil(totalCount / STATEMENT_PAGE_SIZE);
  const startItem = offset + 1;
  const endItem = offset + transactions.length;
  let message = `📋 *Extrato - ${monthName}*\n`;
  message += `🔽 ${statementFilterLabel(typeFilter)}\n`;
  message += `📄 Página ${page + 1} de ${totalPages} (${startItem}-${endItem} de ${totalCount})\n\n`;

  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    const emoji = t.type === "income" ? "📈" : "📉";
    const category = t.categories?.name || "Sem categoria";
    const group = t.groups?.name || "Sem grupo";
    const tags = t.tags?.length ? ` ${t.tags.join(" ")}` : "";

    message += `${emoji} \`#${t.id}\` ${formatDateBR(t.transaction_date)} - *${formatCurrencyBR(Number(t.amount))}*\n`;
    message += `   ${category} | ${group}${tags}\n`;

    if (i < transactions.length - 1) {
      message += "\n";
    }
  }

  message += "\n💡 Use o \`#ID\` com \`/editar ID\` ou \`/excluir ID\`\n";

  const currentSuffix = statementFilterSuffix(typeFilter);

  // Build filter buttons + pagination keyboard
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
      callback_data: `statement_${statementFilterSuffix(opt.filter)}_0`,
    });
  }
  keyboard.push(filterRow);

  // Pagination row
  const navButtons: InlineKeyboard[0] = [];
  if (page > 0) {
    navButtons.push({ text: "◀️ Anterior", callback_data: `statement_${currentSuffix}_${page - 1}` });
  }
  if (page + 1 < totalPages) {
    navButtons.push({ text: "Próximo ▶️", callback_data: `statement_${currentSuffix}_${page + 1}` });
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
  const keyboard: InlineKeyboard = [];
  if (groupId) {
    keyboard.push([{ text: "📋 Todas as contas", callback_data: "summary_grp_all" }]);
  }
  keyboard.push([{ text: "📁 Filtrar por grupo", callback_data: "summary_shwgrp" }]);

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

  const keyboard: InlineKeyboard = [
    [
      { text: "✏️ Editar valor", callback_data: `edit_amount_${transaction.id}` },
      { text: "🏷️ Editar categoria", callback_data: `edit_category_${transaction.id}` },
    ],
    [
      { text: "📁 Editar grupo", callback_data: `edit_group_${transaction.id}` },
      { text: "🔖 Editar tags", callback_data: `edit_tags_${transaction.id}` },
    ],
    [
      { text: "📅 Editar data", callback_data: `edit_date_${transaction.id}` },
      { text: "❌ Excluir", callback_data: `confirm_delete_${transaction.id}` },
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

  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Sim, excluir", callback_data: `confirm_delete_${transaction.id}` },
      { text: "❌ Não, manter", callback_data: "cancel_delete" },
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
    const orderQuery = isCategory
      ? supabase.from(table).select(`id, name, ${flagColumn}`).eq("user_id", user.id).order("is_predefined", { ascending: false }).order("name")
      : supabase.from(table).select(`id, name, ${flagColumn}`).eq("user_id", user.id).order("name");
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

    const pluralNoun = isCategory ? "categorias" : "grupos";
    let message = `${icon} *Su${isCategory ? "as" : "s"} ${pluralNoun}:*\n\n`;
    for (const item of items) {
      const count = countMap[item.id] || 0;
      const defaultTag = item[flagColumn] ? ` ⭐ (padrão)` : "";
      message += `• ${item.name}${defaultTag} — ${count} ${count !== 1 ? "transações" : "transação"}\n`;
    }
    message += `\n💡 Para adicionar: \`${cmdRef}\``;

    // Build keyboard with 3 items per row
    const keyboard: InlineKeyboard = [];
    let row: { text: string; callback_data: string }[] = [];
    for (const item of items) {
      row.push({ text: item.name, callback_data: `${cbPrefix}${item.name}` });
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

  // Check for similar names before creating
  const similar = await suggestFn(supabase, user.id, entityName);
  if (similar && similar.length > 0) {
    await setWizardState(supabase, user.id, wizardStep, {
      original_name: entityName,
      suggested_name: similar[0].name,
      similarity: similar[0].similarity,
    });
    const keyboard: InlineKeyboard = [
      [{ text: `✅ Usar "${similar[0].name}"`, callback_data: sugUseCb }],
      [{ text: `✏️ Criar "${entityName}" mesmo assim`, callback_data: sugNewCb }],
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
    message += `• #${tag} — ${count} ${count !== 1 ? "transações" : "transação"}\n`;
  }
  message += "\n💡 Clique em uma tag para ver as transações.";

  // Build keyboard with 3 tags per row
  const keyboard: InlineKeyboard = [];
  let row: { text: string; callback_data: string }[] = [];
  for (const tag of allTags) {
    const displayTag = tag.startsWith("#") ? tag : `#${tag}`;
    row.push({ text: displayTag, callback_data: truncateCallbackData(`tag_sel_${tag}`) });
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

  // Find categories with no transactions
  const { data: categories } = await supabase
    .from("categories")
    .select("id, name")
    .eq("user_id", user.id);

  const { data: catCounts } = await supabase
    .from("transactions")
    .select("category_id")
    .eq("user_id", user.id)
    .not("category_id", "is", null);

  const usedCatIds = new Set((catCounts || []).map((t: any) => t.category_id));
  const unusedCats = (categories || []).filter((c: any) => !usedCatIds.has(c.id));

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

  // Collect all unique tags from transactions
  const rawTags = await getAllUserTags(supabase, user.id);
  const allTags = new Set(rawTags.map((t: string) => t.startsWith("#") ? t : `#${t}`));

  if (unusedCats.length === 0 && unusedGrps.length === 0 && allTags.size === 0) {
    await sendTelegramMessage(chatId, "🧹 Nenhum dado para limpar. Tudo limpo!");
    return;
  }

  let message = "🧹 *Visão geral dos seus dados:*\n\n";

  if (unusedCats.length > 0) {
    message += `🏷️ *Categorias sem transações (${unusedCats.length}):*\n`;
    message += unusedCats.map((c: any) => `   • ${c.name}`).join("\n") + "\n\n";
  }

  if (unusedGrps.length > 0) {
    message += `📁 *Grupos sem transações (${unusedGrps.length}):*\n`;
    message += unusedGrps.map((g: any) => `   • ${g.name}`).join("\n") + "\n\n";
  }

  if (allTags.size > 0) {
    message += `🔖 *Tags em uso (${allTags.size}):*\n`;
    message += Array.from(allTags).sort().map((t) => `   • ${t}`).join("\n") + "\n\n";
  }

  const hasItemsToClean = unusedCats.length > 0 || unusedGrps.length > 0;
  if (!hasItemsToClean) {
    message += "Nenhuma categoria ou grupo órfão para remover.";
    await sendTelegramMessage(chatId, message);
    return;
  }

  message += "Deseja removê-los?";

  const keyboard: InlineKeyboard = [
    [{ text: "✅ Sim, limpar tudo", callback_data: "confirm_cleanup" }],
    [{ text: "❌ Não, cancelar", callback_data: "cancel_cleanup" }],
  ];

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}
