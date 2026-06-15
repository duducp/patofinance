import { InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { getOrCreateUser, normalizeString } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR } from "../utils/formatting.ts";

export async function handleCreateCategory(supabase: any, userId: number, chatId: number, name: string): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const normalizedName = normalizeString(name);

  const { data: existing } = await supabase
    .from("categories")
    .select("id")
    .eq("user_id", user.id)
    .ilike("normalized_name", normalizedName)
    .single();

  if (existing) {
    await sendTelegramMessage(chatId, `⚠️ A categoria "${name}" já existe.`);
    return;
  }

  const { error } = await supabase.from("categories").insert({
    user_id: user.id,
    name: name,
    normalized_name: normalizedName,
    is_default: false,
  });

  if (error) {
    await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao criar a categoria.");
    return;
  }

  await sendTelegramMessage(chatId, `✅ Categoria "${name}" criada com sucesso!`);
}

export async function handleCreateGroup(supabase: any, userId: number, chatId: number, name: string): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const { data: existing } = await supabase
    .from("groups")
    .select("id")
    .eq("user_id", user.id)
    .ilike("name", name)
    .single();

  if (existing) {
    await sendTelegramMessage(chatId, `⚠️ O grupo "${name}" já existe.`);
    return;
  }

  const { error } = await supabase.from("groups").insert({
    user_id: user.id,
    name: name,
    is_default: false,
  });

  if (error) {
    await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao criar o grupo.");
    return;
  }

  await sendTelegramMessage(chatId, `✅ Grupo "${name}" criado com sucesso!`);
}

export async function handleListCategories(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const { data: categories } = await supabase
    .from("categories")
    .select("name, is_default")
    .eq("user_id", user.id)
    .order("name");

  if (!categories || categories.length === 0) {
    await sendTelegramMessage(chatId, "🏷️ Nenhuma categoria encontrada. Crie uma com `/categoria nome_da_categoria`");
    return;
  }

  let message = "🏷️ *Suas categorias:*\n\n";
  for (const c of categories) {
    const defaultTag = c.is_default ? " ⭐ (padrão)" : "";
    message += `• ${c.name}${defaultTag}\n`;
  }
  message += "\n💡 Para criar: `/categoria nome_da_categoria`";
  await sendTelegramMessage(chatId, message);
}

export async function handleListGroups(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

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
  message += "\n💡 Para criar: `/grupo nome_do_grupo`";
  await sendTelegramMessage(chatId, message);
}

export async function handleListTags(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const { data: transactions } = await supabase
    .from("transactions")
    .select("tags")
    .eq("user_id", user.id);

  if (!transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, "🏷️ Nenhuma tag encontrada. Adicione tags ao registrar transações.");
    return;
  }

  const allTags = new Set<string>();
  for (const t of transactions) {
    if (t.tags) {
      for (const tag of t.tags) {
        allTags.add(tag);
      }
    }
  }

  if (allTags.size === 0) {
    await sendTelegramMessage(chatId, "🏷️ Nenhuma tag encontrada. Adicione tags ao registrar transações.");
    return;
  }

  let message = "🏷️ *Suas tags:*\n\n";
  for (const tag of Array.from(allTags).sort()) {
    message += `• #${tag}\n`;
  }
  await sendTelegramMessage(chatId, message);
}

export async function handleListTransactions(supabase: any, userId: number, chatId: number, limit: number, tag?: string): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  let query = supabase
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
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (tag) {
    query = query.contains("tags", [tag]);
  }

  const { data: transactions, error } = await query;

  if (error || !transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, "📝 Nenhuma transação encontrada.");
    return;
  }

  const tagLabel = tag ? ` com #${tag}` : "";
  let message = `📋 *Últimas ${transactions.length} transações${tagLabel}:*\n\n`;

  for (const t of transactions) {
    const emoji = t.type === "income" ? "📈" : "📉";
    const catName = t.categories?.name || "Sem categoria";
    const dateStr = formatDateBR(t.transaction_date);
    message += `${emoji} ${dateStr} - *${formatCurrencyBR(Number(t.amount))}* | ${catName}\n`;
  }

  await sendTelegramMessage(chatId, message);
}

export async function handleShowLastTransaction(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

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
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!transaction) {
    await sendTelegramMessage(chatId, "📝 Nenhuma transação encontrada.");
    return;
  }

  const emoji = transaction.type === "income" ? "📈" : "📉";
  const typeName = transaction.type === "income" ? "Receita" : "Despesa";
  const catName = transaction.categories?.name || "Sem categoria";
  const groupName = transaction.groups?.name || "Sem grupo";
  const tags = transaction.tags && transaction.tags.length > 0 
    ? transaction.tags.map((t: string) => `#${t}`).join(" ") 
    : "Sem tags";

  const keyboard: InlineKeyboard = [
    [
      { text: "✏️ Editar", callback_data: `edit_${transaction.id}` },
      { text: "🗑️ Excluir", callback_data: `confirm_delete_${transaction.id}` },
    ],
  ];

  await sendTelegramMessageWithKeyboard(
    chatId,
    `${emoji} *Última ${typeName}:*\n\n` +
    `💰 Valor: *${formatCurrencyBR(Number(transaction.amount))}*\n` +
    `🏷️ Categoria: ${catName}\n` +
    `📁 Grupo: ${groupName}\n` +
    `📅 Data: ${formatDateBR(transaction.transaction_date)}\n` +
    `🏷️ Tags: ${tags}\n` +
    (transaction.description ? `📝 Descrição: ${transaction.description}\n` : ""),
    keyboard
  );
}

export async function handleDeleteLastTransaction(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const { data: transaction } = await supabase
    .from("transactions")
    .select(`
      id,
      type,
      amount,
      categories (name),
      transaction_date
    `)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!transaction) {
    await sendTelegramMessage(chatId, "📝 Nenhuma transação encontrada para excluir.");
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
    `${emoji} *Última ${typeName}:*\n\n` +
    `💰 Valor: *${formatCurrencyBR(Number(transaction.amount))}*\n` +
    `🏷️ Categoria: ${catName}\n` +
    `📅 Data: ${formatDateBR(transaction.transaction_date)}\n\n` +
    `Tem certeza que deseja excluir esta transação?`,
    keyboard
  );
}

export async function handleListByTag(supabase: any, userId: number, chatId: number, tag: string): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const { data: transactions, error } = await supabase
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
    .contains("tags", [tag])
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10);

  if (error || !transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, `📝 Nenhuma transação encontrada com a tag #${tag}.`);
    return;
  }

  let message = `🏷️ *Transações com #${tag}:*\n\n`;

  for (const t of transactions) {
    const emoji = t.type === "income" ? "📈" : "📉";
    const catName = t.categories?.name || "Sem categoria";
    const dateStr = formatDateBR(t.transaction_date);
    message += `${emoji} ${dateStr} - *${formatCurrencyBR(Number(t.amount))}* | ${catName}\n`;
  }

  if (transactions.length === 10) {
    message += "\n💡 Para ver mais, use: `últimas transações com #${tag}`";
  }

  await sendTelegramMessage(chatId, message);
}
