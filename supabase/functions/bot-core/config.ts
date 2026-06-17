import { DeepSeekResponse, PeriodParseResult } from "./types/index.ts";

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
export const periodCache = new Map<number, Map<string, { response: PeriodParseResult; timestamp: number }>>();
export const NL_CACHE_TTL = 300000; // 5 minutes
