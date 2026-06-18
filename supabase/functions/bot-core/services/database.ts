import { sendTelegramMessage } from "./telegram.ts";
import { getTodayISOBR } from "../utils/formatting.ts";

/**
 * Build a safe .or() filter string for "user_id = X OR user_id IS NULL".
 * Uses explicit String() conversion to ensure type safety.
 */
export function userOrNullFilter(userId: number): string {
  return "user_id.eq." + String(userId) + ",user_id.is.null";
}

/**
 * Build a safe .or() filter string for "transaction_type = X OR transaction_type IS NULL".
 */
export function typeOrNullFilter(type: string): string {
  return "transaction_type.eq." + type + ",transaction_type.is.null";
}

export function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export async function getOrCreateUser(supabase: any, telegramId: number): Promise<any | null> {
  const { data: account } = await supabase
    .from("telegram_accounts")
    .select("user_id")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (!account) return null;
  return { id: account.user_id };
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
    .or(userOrNullFilter(userId));
  if (type) {
    query = query.or(typeOrNullFilter(type));
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
    .or(userOrNullFilter(userId))
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
    .or(userOrNullFilter(userId))
    .eq("normalized_name", normalized);
  if (transactionType) {
    exactQuery = exactQuery.or(typeOrNullFilter(transactionType));
  }
  const { data: exact } = await exactQuery.maybeSingle();
  if (exact) return exact;

  const similar = await suggestSimilarCategories(supabase, userId, categoryName, 5);
  const candidate = similar?.find((s) => s.similarity >= 0.5);
  if (candidate) {
    let matchQuery = supabase
      .from("categories")
      .select("id, name")
      .or(userOrNullFilter(userId))
      .eq("normalized_name", normalizeString(candidate.name));
    if (transactionType) {
      matchQuery = matchQuery.or(typeOrNullFilter(transactionType));
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

export interface CreateTransactionResult {
  error: any;
  id?: number;
}

export async function createTransaction(
  supabase: any,
  data: CreateTransactionData
): Promise<CreateTransactionResult> {
  const { data: inserted, error } = await supabase
    .from("transactions")
    .insert({
      user_id: data.userId,
      type: data.type,
      amount: data.amount,
      category_id: data.categoryId,
      group_id: data.groupId,
      description: data.description || "",
      tags: data.tags || [],
      transaction_date: data.transactionDate || getTodayISOBR(),
    })
    .select("id")
    .single();
  return { error, id: inserted?.id };
}

/**
 * Deduplicate categories (or any items with normalized_name) when joining
 * system categories (user_id=NULL) and user-created categories.
 * User's own category overrides system one with same normalized_name.
 */
export function deduplicateByNormalizedName(items: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const item of items) {
    if (seen.has(item.normalized_name)) continue;
    seen.add(item.normalized_name);
    result.push(item);
  }
  return result;
}

/**
 * Standard transaction select fields for detail/edit views.
 */
export const TRANSACTION_DETAIL_FIELDS = `
      id,
      type,
      amount,
      description,
      tags,
      transaction_date,
      categories (name),
      groups (name)
    `;

/**
 * Delete a transaction by ID, ensuring it belongs to the user.
 * Returns an object with success flag and error (if any).
 */
export async function deleteTransactionById(
  supabase: any,
  userId: number,
  transactionId: string | number
): Promise<{ success: boolean; error?: any }> {
  const { error } = await supabase
    .from("transactions")
    .delete()
    .eq("id", transactionId)
    .eq("user_id", userId);
  return { success: !error, error };
}

/**
 * Fetch a single transaction by ID with category and group joins.
 * Returns null if not found or not owned by the user.
 */
export async function getTransactionById(
  supabase: any,
  userId: number,
  transactionId: string | number,
  selectFields: string = TRANSACTION_DETAIL_FIELDS
): Promise<any | null> {
  const { data } = await supabase
    .from("transactions")
    .select(selectFields)
    .eq("id", transactionId)
    .eq("user_id", userId)
    .single();
  return data || null;
}

/**
 * Find a group by name for a user.
 * Returns { id, name } or null.
 */
export async function findGroupByName(
  supabase: any,
  userId: number,
  name: string
): Promise<{ id: number; name: string } | null> {
  const { data } = await supabase
    .from("groups")
    .select("id, name")
    .eq("user_id", userId)
    .ilike("name", name)
    .maybeSingle();
  return data || null;
}

/**
 * Transfer all user data from one user to another (used by /vincular flow).
 * Handles deduplication of categories and groups by name.
 * Updates telegram_accounts link and deletes the old user entry.
 *
 * @returns An object with success flag and optional error message.
 */
export async function transferUserData(
  supabase: any,
  oldUserId: number,
  newUserId: number,
  telegramId: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    // 1. Transfer transactions
    await supabase
      .from("transactions")
      .update({ user_id: newUserId })
      .eq("user_id", oldUserId);

    // 2. Transfer categories with dedup
    const { data: oldCats } = await supabase
      .from("categories")
      .select("id, name, transaction_type, is_predefined")
      .eq("user_id", oldUserId);

    if (oldCats && oldCats.length > 0) {
      const { data: newCats } = await supabase
        .from("categories")
        .select("name")
        .eq("user_id", newUserId);
      const existingNames = new Set((newCats || []).map((c: any) => c.name.toLowerCase()));

      for (const cat of oldCats) {
        if (!existingNames.has(cat.name.toLowerCase())) {
          await supabase
            .from("categories")
            .update({ user_id: newUserId })
            .eq("id", cat.id);
        } else {
          // Reassign orphan transactions to matching category
          const { data: matchCat } = await supabase
            .from("categories")
            .select("id")
            .eq("user_id", newUserId)
            .eq("normalized_name", normalizeString(cat.name))
            .maybeSingle();
          if (matchCat) {
            await supabase
              .from("transactions")
              .update({ category_id: matchCat.id })
              .eq("category_id", cat.id);
          }
          await supabase.from("categories").delete().eq("id", cat.id);
        }
      }
    }

    // 3. Transfer groups with dedup
    const { data: oldGrps } = await supabase
      .from("groups")
      .select("id, name, is_default")
      .eq("user_id", oldUserId);

    if (oldGrps && oldGrps.length > 0) {
      const { data: newGrps } = await supabase
        .from("groups")
        .select("name")
        .eq("user_id", newUserId);
      const existingGrpNames = new Set((newGrps || []).map((g: any) => g.name.toLowerCase()));

      for (const grp of oldGrps) {
        if (!existingGrpNames.has(grp.name.toLowerCase())) {
          await supabase
            .from("groups")
            .update({ user_id: newUserId })
            .eq("id", grp.id);
        } else {
          // Reassign orphan transactions to matching group
          const { data: matchGrp } = await supabase
            .from("groups")
            .select("id")
            .eq("user_id", newUserId)
            .eq("normalized_name", normalizeString(grp.name))
            .maybeSingle();
          if (matchGrp) {
            await supabase
              .from("transactions")
              .update({ group_id: matchGrp.id })
              .eq("group_id", grp.id);
          }
          await supabase.from("groups").delete().eq("id", grp.id);
        }
      }
    }

    // 4. Update telegram_accounts to point to new user
    await supabase
      .from("telegram_accounts")
      .update({ user_id: newUserId })
      .eq("telegram_id", telegramId);

    // 5. Delete old user (cascade cleans up wizard_states)
    await supabase.from("users").delete().eq("id", oldUserId);

    return { success: true };
  } catch (err) {
    console.error("Error transferring user data:", err);
    return { success: false, error: String(err) };
  }
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
