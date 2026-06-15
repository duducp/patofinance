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
    .single();
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
    .ilike("normalized_name", normalizedName)
    .single();
  if (existing) return existing.id;
  const { data: newCategory } = await supabase
    .from("categories")
    .insert({ user_id: userId, name: categoryName, normalized_name: normalizedName })
    .select("id")
    .single();
  return newCategory?.id || null;
}

export async function getOrCreateGroup(supabase: any, userId: number, groupName: string | null): Promise<string | null> {
  if (!groupName) {
    const { data: defaultGroup } = await supabase
      .from("groups")
      .select("id")
      .eq("user_id", userId)
      .eq("is_default", true)
      .single();
    return defaultGroup?.id || null;
  }
  const { data: existing } = await supabase
    .from("groups")
    .select("id")
    .eq("user_id", userId)
    .ilike("name", groupName)
    .single();
  return existing?.id || null;
}
