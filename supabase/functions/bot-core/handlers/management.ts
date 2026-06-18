import { InlineKeyboard } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { truncateCallbackData } from "../utils/rate-limiter.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { requireUser, normalizeString, suggestSimilarCategories, suggestSimilarGroups, listTransactionsPaginated, TRANSACTION_DETAIL_FIELDS, deduplicateByNormalizedName, userOrNullFilter } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, sanitizeMarkdown } from "../utils/formatting.ts";

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
    existsQuery = existsQuery.or(userOrNullFilter(user.id));
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

export const handleCreateCategory = (supabase: any, userId: number, chatId: number, name: string): Promise<void> =>
  handleCreateEntity("category", supabase, userId, chatId, name);

export const handleCreateGroup = (supabase: any, userId: number, chatId: number, name: string): Promise<void> =>
  handleCreateEntity("group", supabase, userId, chatId, name);

export async function handleListCategories(supabase: any, userId: number, chatId: number): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const { data: categories } = await supabase
    .from("categories")
    .select("name, is_predefined, transaction_type, normalized_name, user_id")
    .or(userOrNullFilter(user.id))
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
    const emoji = t.type === "income" ? "📈" : "📉";  const catName = sanitizeMarkdown(t.categories?.name || "Sem categoria");
      const dateStr = formatDateBR(t.transaction_date);
      const desc = t.description ? ` — ${sanitizeMarkdown(t.description)}` : "";
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
  const catName = sanitizeMarkdown(transaction.categories?.name || "Sem categoria");
  const groupName = sanitizeMarkdown(transaction.groups?.name || "Sem grupo");
  const tags = transaction.tags && transaction.tags.length > 0 
    ? transaction.tags.map((t: string) => sanitizeMarkdown(`#${t}`)).join(" ") 
    : "Sem tags";

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [
    [
      { text: "✏️ Editar", callback_data: addSession(`edit_show_${transaction.id}`, sessionSeq) },
      { text: "🗑️ Excluir", callback_data: addSession(`del_prompt_${transaction.id}`, sessionSeq) },
    ],
  ];

  await sendTelegramMessageWithKeyboard(
    chatId,
    `${emoji} *Última ${typeName}:*\n\n` +
    `🆔 ID: #${transaction.id}\n` +
    `💰 Valor: *${formatCurrencyBR(Number(transaction.amount))}*\n` +
    `🏷️ Categoria: ${catName}\n` +
    `📁 Grupo: ${groupName}\n` +
    `📅 Data: ${formatDateBR(transaction.transaction_date)}\n` +
    `🏷️ Tags: ${tags}\n` +
    (transaction.description ? `📝 Descrição: ${transaction.description}\n` : ""),
    keyboard
  );
}

/**
 * Show a delete confirmation dialog for a transaction.
  * Used by handleDeleteLastTransaction.
 */
export async function showDeleteConfirmation(
  chatId: number,
  transaction: any,
  sessionSeq: number,
  messageId?: number
): Promise<void> {
  const emoji = transaction.type === "income" ? "📈" : "📉";
  const typeName = transaction.type === "income" ? "Receita" : "Despesa";
  const catName = sanitizeMarkdown(transaction.categories?.name || "Sem categoria");
  const desc = sanitizeMarkdown(transaction.description || "");

  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Sim, excluir", callback_data: addSession(`confirm_delete_${transaction.id}`, sessionSeq) },
      { text: "❌ Não, manter", callback_data: addSession(`cancel_delete_${transaction.id}`, sessionSeq) },
    ],
  ];

  const messageText =
    `${emoji} *${typeName} #${transaction.id}:*\n\n` +
    `💰 Valor: *${formatCurrencyBR(Number(transaction.amount))}*\n` +
    `🏷️ Categoria: ${catName}\n` +
    (desc ? `📝 Descrição: ${desc}\n` : "") +
    `📅 Data: ${formatDateBR(transaction.transaction_date)}\n\n` +
    `Tem certeza de que deseja excluir esta transação?`;

  if (messageId) {
    await editTelegramMessageWithKeyboard(chatId, messageId, messageText, keyboard);
    return;
  }

  await sendTelegramMessageWithKeyboard(chatId, messageText, keyboard);
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
      description,
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

  const sessionSeq = await getSessionSeq(supabase, user.id);
  await showDeleteConfirmation(chatId, transaction, sessionSeq);
}

export async function handleListByTag(supabase: any, userId: number, chatId: number, tag: string, page: number = 0, messageId?: number): Promise<void> {
  await handleListTransactions(supabase, userId, chatId, 10, tag, page, messageId);
}

export async function handleSearch(
  supabase: any,
  userId: number,
  chatId: number,
  term: string,
  page: number = 0,
  messageId?: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const searchLimit = 10;
  const offset = page * searchLimit;
  const fetchLimit = searchLimit + 1;

  const normalized = normalizeString(term);

  // Build search conditions dynamically: description ILIKE + amount + tag
  // Escape % and _ for PostgreSQL LIKE/ILIKE to prevent wildcard injection
  const escapedTerm = term.replace(/[%_]/g, "\\$&");
  const escapedNormalized = normalized.replace(/[%_]/g, "\\$&");
  const searchConditions: string[] = [
    `description.ilike.%${escapedTerm}%`,
    `description.ilike.%${escapedNormalized}%`,
  ];

  // Search by amount if term is numeric
  const searchAmount = parseFloat(term.replace(",", "."));
  if (!isNaN(searchAmount)) {
    searchConditions.push(`amount.eq.${searchAmount}`);
  }

  // Search by tag if term starts with #
  const searchTag = term.startsWith("#") ? term.slice(1) : null;
  if (searchTag) {
    searchConditions.push(`tags.cs.{${searchTag}}`);
    searchConditions.push(`tags.cs.{#${searchTag}}`);
  }

  const { data: transactions, count: totalCount } = await supabase
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
    `, { count: "exact" })
    .eq("user_id", user.id)
    .or(searchConditions.join(","))
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + fetchLimit - 1);

  const txList = (transactions || []);
  const hasMore = txList.length > searchLimit;
  const displayItems = hasMore ? txList.slice(0, searchLimit) : txList;

  if (displayItems.length === 0) {
    await sendTelegramMessage(chatId, `🔍 Nenhuma transação encontrada para "*${term}*".`);
    return;
  }

  const totalPages = Math.ceil((totalCount || 0) / searchLimit);
  const startItem = offset + 1;
  const endItem = offset + displayItems.length;

  let message = `🔍 *Busca: "${term}"*   📄 ${page + 1}/${totalPages} (${startItem}–${endItem} de ${totalCount})\n\n`;

  for (const t of displayItems) {
    const emoji = t.type === "income" ? "📈" : "📉";
    const catName = t.categories?.name || "—";
    const grpName = t.groups?.name || "Pessoal";
    const dateStr = t.transaction_date?.slice(5, 10) || "";
    const tags = t.tags && t.tags.length > 0 ? ` ${t.tags.join(" ")}` : "";
    message += `${emoji} #${t.id}  ${dateStr}  *${formatCurrencyBR(Number(t.amount))}*  - ${grpName} - ${catName}${tags}\n`;
    if (t.description) {
      const truncated = t.description.length > 40 ? t.description.slice(0, 40) + "…" : t.description;
      message += `   └ ${truncated}\n`;
    }
  }

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];

  // Preserve # prefix in callback key so pagination re-detects tag search
  const callbackKey = searchTag ? `#${searchTag}` : normalized;

  const navRow: { text: string; callback_data: string }[] = [];
  if (page > 0) {
    navRow.push({ text: "◀️ Anterior", callback_data: truncateCallbackData(`search_${callbackKey}_p${page - 1}`, sessionSeq) });
  }
  if (hasMore) {
    navRow.push({ text: "▶️ Próximo", callback_data: truncateCallbackData(`search_${callbackKey}_p${page + 1}`, sessionSeq) });
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
