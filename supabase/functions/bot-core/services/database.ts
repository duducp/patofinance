import { sendTelegramMessage } from "./telegram.ts";

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

export async function getCategories(supabase: any, userId: number): Promise<{ name: string }[]> {
  const { data } = await supabase
    .from("categories")
    .select("name")
    .eq("user_id", userId)
    .order("name");
  return data || [];
}

export async function getOrCreateCategory(supabase: any, userId: number, categoryName: string): Promise<string | null> {
  const normalizedName = normalizeString(categoryName);
  const { data: existing } = await supabase
    .from("categories")
    .select("id")
    .eq("user_id", userId)
    .eq("normalized_name", normalizedName)
    .maybeSingle();
  if (existing) return existing.id;
  const { data: newCategory } = await supabase
    .from("categories")
    .insert({ user_id: userId, name: categoryName, normalized_name: normalizedName })
    .select("id")
    .single();
  return newCategory?.id || null;
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

export async function getOrCreateUncategorizedCategory(supabase: any, userId: number): Promise<string | null> {
  // Look for existing "Sem categoria" entry
  const { data: existing } = await supabase
    .from("categories")
    .select("id")
    .eq("user_id", userId)
    .eq("normalized_name", "semcategoria")
    .maybeSingle();
  if (existing) return existing.id;

  // Create fallback category
  const { data: newCat } = await supabase
    .from("categories")
    .insert({
      user_id: userId,
      name: "Sem categoria",
      normalized_name: "semcategoria",
      is_predefined: true,
    })
    .select("id")
    .maybeSingle();
  return newCat?.id || null;
}
