import { DeepSeekResponse } from "./types/index.ts";

export const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
export const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN");
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://kong:8000";
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
export const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY");

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
}
if (!TELEGRAM_SECRET_TOKEN) {
  console.error("TELEGRAM_SECRET_TOKEN is not set");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set");
}

// Cache for common DeepSeek responses (per-user: userId -> text -> response)
export const nlCache = new Map<number, Map<string, { response: DeepSeekResponse; timestamp: number }>>();
export const NL_CACHE_TTL = 300000; // 5 minutes

// Common phrases that don't need API calls
export const commonPhrases: Record<string, DeepSeekResponse> = {
  "quanto tenho": { intent: "query_balance", amount: null, category: null, date: null, period: "this_month", name: null, tag: null, limit: null, missingFields: [] },
  "saldo": { intent: "query_balance", amount: null, category: null, date: null, period: "this_month", name: null, tag: null, limit: null, missingFields: [] },
  "extrato": { intent: "query_extract", amount: null, category: null, date: null, period: "this_month", name: null, tag: null, limit: null, missingFields: [] },
  "resumo": { intent: "query_summary", amount: null, category: null, date: null, period: "this_month", name: null, tag: null, limit: null, missingFields: [] },
  "quais categorias": { intent: "list_categories", amount: null, category: null, date: null, period: null, name: null, tag: null, limit: null, missingFields: [] },
  "meus grupos": { intent: "list_groups", amount: null, category: null, date: null, period: null, name: null, tag: null, limit: null, missingFields: [] },
  "quais tags": { intent: "list_tags", amount: null, category: null, date: null, period: null, name: null, tag: null, limit: null, missingFields: [] },
  "últimas transações": { intent: "list_transactions", amount: null, category: null, date: null, period: null, name: null, tag: null, limit: 10, missingFields: [] },
  "último gasto": { intent: "show_last_transaction", amount: null, category: null, date: null, period: null, name: null, tag: null, limit: null, missingFields: [] },
  "apagar última": { intent: "delete_last_transaction", amount: null, category: null, date: null, period: null, name: null, tag: null, limit: null, missingFields: [] },
  "limpe": { intent: "cleanup", amount: null, category: null, date: null, period: null, name: null, tag: null, limit: null, missingFields: [] },
  "limpar": { intent: "cleanup", amount: null, category: null, date: null, period: null, name: null, tag: null, limit: null, missingFields: [] },
};
