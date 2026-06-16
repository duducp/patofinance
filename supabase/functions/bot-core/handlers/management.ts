import { InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { requireUser, normalizeString, suggestSimilarCategories, suggestSimilarGroups, listTransactionsPaginated, TRANSACTION_DETAIL_FIELDS, deduplicateByNormalizedName } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR } from "../utils/formatting.ts";

async function handleCreateEntity(
  type: "category" | "group",
  supabase: any,
  userId: number,
  chatId: number,
  name: string
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const isCategory = type === "category";
  const icon = isCategory ? "🏷️" : "📁";
  const label = isCategory ? "categoria" : "grupo";
  const table = isCategory ? "categories" : "groups";
  const suggestFn = isCategory ? suggestSimilarCategories : suggestSimilarGroups;
  const cmdRef = isCategory ? "/categoria" : "/grupo";

  const normalizedName = normalizeString(name);

  // Check for exact match
  let existsQuery = supabase.from(table).select("id").eq("normalized_name", normalizedName);
  if (isCategory) {
    existsQuery = existsQuery.or(`user_id.eq.${user.id},user_id.is.null`);
  } else {
    existsQuery = existsQuery.eq("user_id", user.id);
  }
  const { data: existing } = await existsQuery.maybeSingle();

  if (existing) {
    await sendTelegramMessage(chatId, `⚠️ ${icon} ${label.charAt(0).toUpperCase() + label.slice(1)} "${name}" já existe.`);
    return;
  }

  // Check for similar names
  const similar = await suggestFn(supabase, user.id, name);
  if (similar && similar.length > 0) {
    const suggestions = similar.map(s => `• ${s.name} (${(s.similarity * 100).toFixed(0)}%)`).join("\n");
    await sendTelegramMessage(chatId,
      `⚠️ ${label.charAt(0).toUpperCase() + label.slice(1)} "${name}" não encontrad${isCategory ? "a" : "o"}, mas encontrei similares:\n${suggestions}\n\n` +
      `Use o nome exato para reutilizar ou ${cmdRef} ${name} para criar mesmo assim.`
    );
    return;
  }

  const insertData: Record<string, any> = {
    user_id: user.id,
    name,
    normalized_name: normalizedName,
  };
  if (isCategory) {
    insertData.is_predefined = false;
  } else {
    insertData.is_default = false;
  }

  const { error } = await supabase.from(table).insert(insertData);

  if (error) {
    await sendTelegramMessage(chatId, `❌ Ops! Algo deu errado ao criar ${isCategory ? "a" : "o"} ${label}. Tente novamente.`);
    return;
  }

  const art = isCategory ? "a" : "o";
  await sendTelegramMessage(chatId, `✅ ${icon} ${label.charAt(0).toUpperCase() + label.slice(1)} "${name}" criad${art} com sucesso!`);
}

export async function handleCreateCategory(supabase: any, userId: number, chatId: number, name: string): Promise<void> {
  return handleCreateEntity("category", supabase, userId, chatId, name);
}

export async function handleCreateGroup(supabase: any, userId: number, chatId: number, name: string): Promise<void> {
  return handleCreateEntity("group", supabase, userId, chatId, name);
}

export async function handleListCategories(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const { data: categories } = await supabase
    .from("categories")
    .select("name, is_predefined, transaction_type, normalized_name, user_id")
    .or(`user_id.eq.${user.id},user_id.is.null`)
    .order("user_id", { ascending: false, nullsFirst: false })
    .order("name");

  if (!categories || categories.length === 0) {
    await sendTelegramMessage(chatId, "🏷️ Nenhuma categoria encontrada. Crie uma com `/categoria nome_da_categoria`");
    return;
  }

  const unique = deduplicateByNormalizedName(categories || []);

  const typeLabels: Record<string, string> = {
    expense: "💸",
    income: "💰",
  };

  let message = "🏷️ *Suas categorias:*\n\n";
  for (const c of unique) {
    const defaultTag = c.is_predefined ? " ⭐ (padrão)" : "";
    const typeIcon = c.transaction_type ? ` ${typeLabels[c.transaction_type]}` : "";
    message += `• ${c.name}${defaultTag}${typeIcon}\n`;
  }
  message += "\n💡 Para criar: `/categoria nome_da_categoria`";
  await sendTelegramMessage(chatId, message);
}

export async function handleListGroups(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

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
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const { transactions: items, totalCount, hasMore } = await listTransactionsPaginated(supabase, user.id, limit, page, tag);

  if (items.length === 0) {
    await sendTelegramMessage(chatId, "📝 Nenhuma transação encontrada.");
    return;
  }

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
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const { data: transaction } = await supabase
    .from("transactions")
    .select(TRANSACTION_DETAIL_FIELDS)
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
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

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
  await handleListTransactions(supabase, userId, chatId, 10, tag, page, messageId);
}
