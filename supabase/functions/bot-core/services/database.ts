import { sendTelegramMessage } from "./telegram.ts";
import { getTodayISOBR } from "../utils/formatting.ts";

export function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export async function getOrCreateUser(supabase: any, telegramId: number): Promise<any | null> {
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  return user || null;
}

export async function requireUser(supabase: any, userId: number, chatId: number): Promise<any | null> {
  const user = await getOrCreateUser(supabase, userId);
  if (!user) {
    await sendTelegramMessage(chatId, "Ops! Você ainda não está cadastrado. Use /start para começar.");
    return null;
  }
  return user;
}

export async function getCategories(supabase: any, userId: number, type?: "expense" | "income"): Promise<{ name: string }[]> {
  let query = supabase
    .from("categories")
    .select("name")
    .or(`user_id.eq.${userId},user_id.is.null`);
  if (type) {
    query = query.or(`transaction_type.eq.${type},transaction_type.is.null`);
  }
  const { data } = await query.order("name");
  return data || [];
}

export async function getOrCreateCategory(supabase: any, userId: number, categoryName: string, transactionType?: "expense" | "income" | null): Promise<string | null> {
  const normalizedName = normalizeString(categoryName);
  // Check user's own first, then system categories
  const { data: existing } = await supabase
    .from("categories")
    .select("id, transaction_type")
    .or(`user_id.eq.${userId},user_id.is.null`)
    .eq("normalized_name", normalizedName)
    .order("user_id", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;
  const { data: newCategory } = await supabase
    .from("categories")
    .insert({ user_id: userId, name: categoryName, normalized_name: normalizedName, transaction_type: transactionType || null })
    .select("id")
    .single();
  return newCategory?.id || null;
}

export async function resolveCategoryForNL(
  supabase: any,
  userId: number,
  categoryName: string,
  transactionType?: "expense" | "income"
): Promise<{ id: string; name: string } | null> {
  const normalized = normalizeString(categoryName);
  let exactQuery = supabase
    .from("categories")
    .select("id, name")
    .or(`user_id.eq.${userId},user_id.is.null`)
    .eq("normalized_name", normalized);
  if (transactionType) {
    exactQuery = exactQuery.or(`transaction_type.eq.${transactionType},transaction_type.is.null`);
  }
  const { data: exact } = await exactQuery.maybeSingle();
  if (exact) return exact;

  const similar = await suggestSimilarCategories(supabase, userId, categoryName, 5);
  const candidate = similar?.find((s) => s.similarity >= 0.5);
  if (candidate) {
    let matchQuery = supabase
      .from("categories")
      .select("id, name")
      .or(`user_id.eq.${userId},user_id.is.null`)
      .eq("normalized_name", normalizeString(candidate.name));
    if (transactionType) {
      matchQuery = matchQuery.or(`transaction_type.eq.${transactionType},transaction_type.is.null`);
    }
    const { data: match } = await matchQuery.maybeSingle();
    if (match) return match;
  }
  return null;
}

export async function suggestSimilarCategories(supabase: any, userId: number, query: string, limit: number = 3): Promise<{ name: string; similarity: number }[]> {
  const { data } = await supabase.rpc("suggest_categories", {
    p_user_id: userId,
    p_query: query,
    p_limit: limit,
  });
  return data || [];
}

export async function suggestSimilarGroups(supabase: any, userId: number, query: string, limit: number = 3): Promise<{ name: string; similarity: number }[]> {
  const { data } = await supabase.rpc("suggest_groups", {
    p_user_id: userId,
    p_query: query,
    p_limit: limit,
  });
  return data || [];
}

export async function getAllUserTags(supabase: any, userId: number): Promise<string[]> {
  const { data: transactions } = await supabase
    .from("transactions")
    .select("tags")
    .eq("user_id", userId);
  const tagSet = new Set<string>();
  if (transactions) {
    for (const t of transactions) {
      if (t.tags && Array.isArray(t.tags)) {
        for (const tag of t.tags) {
          tagSet.add(tag);
        }
      }
    }
  }
  return Array.from(tagSet).sort();
}

export async function suggestSimilarTags(supabase: any, userId: number, query: string, limit: number = 3): Promise<{ tag: string; similarity: number }[]> {
  const { data } = await supabase.rpc("suggest_tags", {
    p_user_id: userId,
    p_query: query,
    p_limit: limit,
  });
  return data || [];
}

export async function sendSimilarityWarning(
  supabase: any,
  userId: number,
  chatId: number,
  type: "category" | "group" | "tag",
  query: string
): Promise<void> {
  let similar: { name?: string; tag?: string; similarity: number }[];
  switch (type) {
    case "category":
      similar = await suggestSimilarCategories(supabase, userId, query);
      break;
    case "group":
      similar = await suggestSimilarGroups(supabase, userId, query);
      break;
    case "tag": {
      const clean = query.replace(/^#/, "");
      similar = await suggestSimilarTags(supabase, userId, clean);
      break;
    }
  }
  if (similar.length === 0) return;
  const label = type === "category" ? "categoria" : type === "group" ? "grupo" : "tag";
  const match = similar[0];
  const matchName = match.name || match.tag || "";
  const pct = (match.similarity * 100).toFixed(0);
  await sendTelegramMessage(chatId,
    `💡 Dica: ${label} "${query}" é similar a *${matchName}* (${pct}%). Considere usar ${matchName} em vez de ${query}.`
  );
}

export async function getOrCreateGroup(supabase: any, userId: number, groupName: string | null): Promise<string | null> {
  if (!groupName) {
    const { data: defaultGroup } = await supabase
      .from("groups")
      .select("id")
      .eq("user_id", userId)
      .eq("is_default", true)
      .maybeSingle();
    return defaultGroup?.id || null;
  }
  const normalizedName = normalizeString(groupName);
  const { data: existing } = await supabase
    .from("groups")
    .select("id")
    .eq("user_id", userId)
    .eq("normalized_name", normalizedName)
    .maybeSingle();
  if (existing) return existing.id;
  const { data: newGroup } = await supabase
    .from("groups")
    .insert({ user_id: userId, name: groupName, normalized_name: normalizedName })
    .select("id")
    .maybeSingle();
  return newGroup?.id || null;
}

export async function getOrCreateUncategorizedCategory(supabase: any, _userId: number): Promise<string | null> {
  // Use system "Outros" as fallback for transactions with deleted categories
  const { data: cat } = await supabase
    .from("categories")
    .select("id")
    .is("user_id", null)
    .eq("normalized_name", normalizeString("Outros"))
    .maybeSingle();
  return cat?.id || null;
}

export interface CreateTransactionData {
  userId: number;
  type: "expense" | "income";
  amount: number;
  categoryId: string | null;
  groupId: string | null;
  description?: string;
  tags?: string[];
  transactionDate?: string;
}

export async function createTransaction(
  supabase: any,
  data: CreateTransactionData
): Promise<{ error: any }> {
  return await supabase.from("transactions").insert({
    user_id: data.userId,
    type: data.type,
    amount: data.amount,
    category_id: data.categoryId,
    group_id: data.groupId,
    description: data.description || "",
    tags: data.tags || [],
    transaction_date: data.transactionDate || getTodayISOBR(),
  });
}

/**
 * Apply common ExtratoFilters to a Supabase query builder.
 * Returns the query with all filters applied.
 */
export function applyFiltersToQuery(
  query: any,
  userId: number,
  periodStart: string,
  periodEnd: string,
  typeFilter?: "all" | "income" | "expense",
  filters?: { category_id?: number | null; group_id?: number | null; tags?: string[] }
): any {
  let q = query
    .eq("user_id", userId)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd);

  if (typeFilter && typeFilter !== "all") {
    q = q.eq("type", typeFilter);
  }
  if (filters?.category_id) {
    q = q.eq("category_id", filters.category_id);
  }
  if (filters?.group_id) {
    q = q.eq("group_id", filters.group_id);
  }
  if (filters?.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      q = q.contains("tags", [tag]);
    }
  }
  return q;
}

/**
 * Paginated transaction list with count — used by handleListTransactions and handleListByTag.
 */
export interface PaginatedTransaction {
  id: number;
  type: string;
  amount: number;
  description: string;
  tags: string[];
  transaction_date: string;
  categories?: { name: string } | null;
  groups?: { name: string } | null;
}

export async function listTransactionsPaginated(
  supabase: any,
  userId: number,
  limit: number,
  page: number,
  tag?: string
): Promise<{
  transactions: PaginatedTransaction[];
  totalCount: number;
  hasMore: boolean;
}> {
  const offset = page * limit;
  const fetchLimit = limit + 1;

  let countQuery = supabase
    .from("transactions")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

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
    .eq("user_id", userId)
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + fetchLimit - 1);

  if (tag) {
    countQuery = countQuery.contains("tags", [tag]);
    dataQuery = dataQuery.contains("tags", [tag]);
  }

  const [countResult, { data: transactions }] = await Promise.all([
    countQuery,
    dataQuery,
  ]);

  const totalCount = countResult.count || 0;
  const txList = (transactions || []) as PaginatedTransaction[];
  const hasMore = txList.length > limit;

  return {
    transactions: hasMore ? txList.slice(0, limit) : txList,
    totalCount,
    hasMore,
  };
}
