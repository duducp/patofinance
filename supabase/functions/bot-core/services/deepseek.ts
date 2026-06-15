import { DeepSeekResponse } from "../types/index.ts";
import { DEEPSEEK_API_KEY, nlCache, NL_CACHE_TTL, commonPhrases } from "../config.ts";

function checkCommonPhrase(text: string): DeepSeekResponse | null {
  const normalized = text.toLowerCase().trim();
  for (const [phrase, response] of Object.entries(commonPhrases)) {
    if (normalized.includes(phrase)) {
      return { ...response };
    }
  }
  return null;
}

function getCachedResponse(text: string): DeepSeekResponse | null {
  const cached = nlCache.get(text);
  if (cached && Date.now() - cached.timestamp < NL_CACHE_TTL) {
    return { ...cached.response };
  }
  nlCache.delete(text);
  return null;
}

function setCachedResponse(text: string, response: DeepSeekResponse): void {
  nlCache.set(text, { response: { ...response }, timestamp: Date.now() });
  if (nlCache.size > 1000) {
    for (const [key, value] of nlCache.entries()) {
      if (Date.now() - value.timestamp > NL_CACHE_TTL) {
        nlCache.delete(key);
      }
    }
  }
}

async function callDeepSeek(prompt: string): Promise<string | null> {
  if (!DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY is not set");
    return null;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: `Você é um assistente que analisa mensagens em português para extrair informações financeiras.
Responda APENAS com JSON válido, sem texto adicional.

Formato esperado:
{"intent":"string|null","amount":number|null,"category":"string|null","date":"string|null","period":"this_month|last_month|null","name":"string|null","tag":"string|null","limit":number|null}

Intents:
- "expense": registrar despesa (gastei, paguei, comprei)
- "income": registrar receita (recebi, ganhei, entrou)
- "query_balance": ver saldo (quanto tenho, saldo)
- "query_expenses_month": gastos do mês atual
- "query_expenses_last_month": gastos do mês passado
- "query_expenses_date": gastos de uma data específica
- "query_expenses_category": gastos por categoria
- "query_summary": resumo por categoria
- "query_extract": extrato detalhado
- "create_category": criar categoria
- "create_group": criar grupo
- "list_categories": listar categorias
- "list_groups": listar grupos
- "list_tags": listar tags
- "list_transactions": listar transações
- "show_last_transaction": última transação
- "delete_last_transaction": excluir última transação
- "list_by_tag": listar por tag
- null: não entendeu

Regras: amount numérico, date YYYY-MM-DD, period this_month/last_month, name para criar entidade, tag sem #, limit padrão 10.`,
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      console.error("DeepSeek API error:", await response.text());
      return null;
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    if (error.name === "AbortError") {
      console.error("DeepSeek API timeout");
    } else {
      console.error("Error calling DeepSeek:", error);
    }
    return null;
  }
}

export async function parseNaturalLanguage(text: string): Promise<DeepSeekResponse> {
  const defaultResponse: DeepSeekResponse = {
    intent: null, amount: null, category: null, date: null, period: null,
    name: null, tag: null, limit: null, missingFields: [],
  };

  const commonResponse = checkCommonPhrase(text);
  if (commonResponse) return commonResponse;

  const cachedResponse = getCachedResponse(text);
  if (cachedResponse) return cachedResponse;

  const response = await callDeepSeek(text);
  if (!response) return defaultResponse;

  try {
    const cleaned = response.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const intent = parsed.intent || null;
    const amount = typeof parsed.amount === "number" ? parsed.amount : null;
    const category = parsed.category || null;
    const date = parsed.date || null;
    const period = parsed.period || null;
    const name = parsed.name || null;
    const tag = parsed.tag || null;
    const limit = typeof parsed.limit === "number" ? parsed.limit : null;

    const missingFields: string[] = [];
    if (intent === "expense" || intent === "income") {
      if (!amount) missingFields.push("amount");
      if (!category) missingFields.push("category");
    }
    if (intent === "query_expenses_date" && !date) missingFields.push("date");
    if ((intent === "query_expenses_month" || intent === "query_expenses_last_month" || 
         intent === "query_summary" || intent === "query_extract") && !period) missingFields.push("period");

    const result: DeepSeekResponse = { intent, amount, category, date, period, name, tag, limit, missingFields };
    setCachedResponse(text, result);
    return result;
  } catch (error) {
    console.error("Error parsing DeepSeek response:", error);
    return defaultResponse;
  }
}
