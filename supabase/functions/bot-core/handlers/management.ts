import { InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { getOrCreateUser, normalizeString, suggestSimilarCategories, suggestSimilarGroups } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR } from "../utils/formatting.ts";

export async function handleCreateCategory(supabase: any, userId: number, chatId: number, name: string): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const normalizedName = normalizeString(name);

  // Check for exact match (normalized)
  const { data: existing } = await supabase
    .from("categories")
    .select("id")
    .eq("user_id", user.id)
    .eq("normalized_name", normalizedName)
    .maybeSingle();

  if (existing) {
    await sendTelegramMessage(chatId, `⚠️ A categoria "${name}" já existe.`);
    return;
  }

  // Check for similar names
  const similar = await suggestSimilarCategories(supabase, user.id, name);
  if (similar && similar.length > 0) {
    const suggestions = similar.map(s => `• ${s.name} (${(s.similarity * 100).toFixed(0)}%)`).join("\n");
    await sendTelegramMessage(chatId,
      `⚠️ Categoria "${name}" não encontrada, mas encontrei similares:\n${suggestions}\n\n` +
      `Use o nome exato para reutilizar ou /categoria ${name} para criar mesmo assim.`
    );
    return;
  }

  const { error } = await supabase.from("categories").insert({
    user_id: user.id,
    name: name,
    normalized_name: normalizedName,
    is_predefined: false,
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

  // Check for exact match (normalized)
  const { data: existing } = await supabase
    .from("groups")
    .select("id")
    .eq("user_id", user.id)
    .eq("normalized_name", normalizeString(name))
    .maybeSingle();

  if (existing) {
    await sendTelegramMessage(chatId, `⚠️ O grupo "${name}" já existe.`);
    return;
  }

  // Check for similar names
  const similar = await suggestSimilarGroups(supabase, user.id, name);
  if (similar && similar.length > 0) {
    const suggestions = similar.map(s => `• ${s.name} (${(s.similarity * 100).toFixed(0)}%)`).join("\n");
    await sendTelegramMessage(chatId,
      `⚠️ Grupo "${name}" não encontrado, mas encontrei similares:\n${suggestions}\n\n` +
      `Use o nome exato para reutilizar ou /grupo ${name} para criar mesmo assim.`
    );
    return;
  }

  const { error } = await supabase.from("groups").insert({
    user_id: user.id,
    name: name,
    normalized_name: normalizeString(name),
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
    .select("name, is_predefined, transaction_type")
    .eq("user_id", user.id)
    .order("name");

  if (!categories || categories.length === 0) {
    await sendTelegramMessage(chatId, "🏷️ Nenhuma categoria encontrada. Crie uma com `/categoria nome_da_categoria`");
    return;
  }

  const typeLabels: Record<string, string> = {
    expense: "💸",
    income: "💰",
  };

  let message = "🏷️ *Suas categorias:*\n\n";
  for (const c of categories) {
    const defaultTag = c.is_predefined ? " ⭐ (padrão)" : "";
    const typeIcon = c.transaction_type ? ` ${typeLabels[c.transaction_type]}` : "";
    message += `• ${c.name}${defaultTag}${typeIcon}\n`;
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

export async function handleListTransactions(supabase: any, userId: number, chatId: number, limit: number, tag?: string, page: number = 0, messageId?: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const offset = page * limit;
  const fetchLimit = limit + 1;

  // Get total count for pagination info
  let countQuery = supabase
    .from("transactions")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);

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
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + fetchLimit - 1);

  if (tag) {
    countQuery = countQuery.contains("tags", [tag]);
    dataQuery = dataQuery.contains("tags", [tag]);
  }

  const [countResult, { data: transactions, error }] = await Promise.all([
    countQuery,
    dataQuery,
  ]);
  const totalCount = countResult.count;

  if (error || !transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, "📝 Nenhuma transação encontrada.");
    return;
  }

  const hasMore = transactions.length > limit;
  const items = hasMore ? transactions.slice(0, limit) : transactions;

  const totalPages = totalCount ? Math.ceil(totalCount / limit) : 1;
  const tagLabel = tag ? ` com ${tag.startsWith("#") ? tag : `#${tag}`}` : "";
  const pageInfo = totalPages > 1 ? ` (Página ${page + 1} de ${totalPages})` : "";
  let message = `📋 *Últimas transações${tagLabel}${pageInfo}:*\n\n`;

  for (const t of items) {
    const emoji = t.type === "income" ? "📈" : "📉";
    const catName = t.categories?.name || "Sem categoria";
    const dateStr = formatDateBR(t.transaction_date);
    const desc = t.description ? ` — ${t.description}` : "";
    message += `${emoji} ${dateStr} - *${formatCurrencyBR(Number(t.amount))}* | ${catName}${desc}\n`;
  }

  // Build navigation keyboard
  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];
  const navRow: { text: string; callback_data: string }[] = [];

  if (page > 0) {
    const prevCallback = tag
      ? truncateCallbackData(`txlist_t${tag}_p${page - 1}`, sessionSeq)
      : addSession(`txlist_p${page - 1}`, sessionSeq);
    navRow.push({ text: "◀️ Anterior", callback_data: prevCallback });
  }
  if (hasMore) {
    const nextCallback = tag
      ? truncateCallbackData(`txlist_t${tag}_p${page + 1}`, sessionSeq)
      : addSession(`txlist_p${page + 1}`, sessionSeq);
    navRow.push({ text: "▶️ Próximo", callback_data: nextCallback });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }

  if (messageId) {
    await editTelegramMessageWithKeyboard(chatId, messageId, message, keyboard);
  } else if (keyboard.length > 0) {
    await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
  } else {
    await sendTelegramMessage(chatId, message);
  }
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

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [
    [
      { text: "✏️ Editar", callback_data: addSession(`edit_show_${transaction.id}`, sessionSeq) },
      { text: "🗑️ Excluir", callback_data: addSession(`confirm_delete_${transaction.id}`, sessionSeq) },
    ],
  ];

  await sendTelegramMessageWithKeyboard(
    chatId,
    `${emoji} *Última ${typeName}:*\n\n` +
    `🆔 ID: \`${transaction.id}\`\n` +
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

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Sim, excluir", callback_data: addSession(`confirm_delete_${transaction.id}`, sessionSeq) },
      { text: "❌ Não, manter", callback_data: addSession("cancel_delete", sessionSeq) },
    ],
  ];

  await sendTelegramMessageWithKeyboard(
    chatId,
    `${emoji} *Última ${typeName}:*\n\n` +
    `💰 Valor: *${formatCurrencyBR(Number(transaction.amount))}*\n` +
    `🏷️ Categoria: ${catName}\n` +
    `📅 Data: ${formatDateBR(transaction.transaction_date)}\n\n` +
    `Tem certeza de que deseja excluir esta transação?`,
    keyboard
  );
}

export async function handleListByTag(supabase: any, userId: number, chatId: number, tag: string, page: number = 0, messageId?: number): Promise<void> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return;
  }

  const limit = 10;
  const offset = page * limit;
  const fetchLimit = limit + 1;

  // Get total count for pagination info
  const countPromise = supabase
    .from("transactions")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .contains("tags", [tag]);

  const dataPromise = supabase
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
    .range(offset, offset + fetchLimit - 1);

  const [countResult, { data: transactions, error }] = await Promise.all([
    countPromise,
    dataPromise,
  ]);
  const totalCount = countResult.count;

  if (error || !transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, `📝 Nenhuma transação encontrada com a tag #${tag}.`);
    return;
  }

  const hasMore = transactions.length > limit;
  const items = hasMore ? transactions.slice(0, limit) : transactions;

  const totalPages = totalCount ? Math.ceil(totalCount / limit) : 1;
  const pageInfo = totalPages > 1 ? ` (Página ${page + 1} de ${totalPages})` : "";
  const tagDisplay = tag.startsWith("#") ? tag : `#${tag}`;
  let message = `🏷️ *Transações com ${tagDisplay}${pageInfo}:*\n\n`;

  for (const t of items) {
    const emoji = t.type === "income" ? "📈" : "📉";
    const catName = t.categories?.name || "Sem categoria";
    const dateStr = formatDateBR(t.transaction_date);
    const desc = t.description ? ` — ${t.description}` : "";
    message += `${emoji} ${dateStr} - *${formatCurrencyBR(Number(t.amount))}* | ${catName}${desc}\n`;
  }

  // Build navigation keyboard
  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];
  const navRow: { text: string; callback_data: string }[] = [];

  if (page > 0) {
    navRow.push({ text: "◀️ Anterior", callback_data: truncateCallbackData(`txlist_t${tag}_p${page - 1}`, sessionSeq) });
  }
  if (hasMore) {
    navRow.push({ text: "▶️ Próximo", callback_data: truncateCallbackData(`txlist_t${tag}_p${page + 1}`, sessionSeq) });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }

  if (messageId) {
    await editTelegramMessageWithKeyboard(chatId, messageId, message, keyboard);
  } else if (keyboard.length > 0) {
    await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
  } else {
    await sendTelegramMessage(chatId, message);
  }
}
