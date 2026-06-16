import { DeepSeekResponse } from "../types/index.ts";
import { DEEPSEEK_API_KEY, nlCache, NL_CACHE_TTL, commonPhrases } from "../config.ts";
import { getTodayISOBR } from "../utils/formatting.ts";

interface UserContext {
  categories: { name: string; transaction_type: string | null }[];
  groups: { name: string; is_default: boolean }[];
  tags: string[];
}

function buildSystemPrompt(context?: UserContext): string {
  const today = getTodayISOBR();
  const todayDate = new Date(today + "T12:00:00");
  const yesterdayDate = new Date(todayDate.getTime() - 86400000);
  const tomorrowDate = new Date(todayDate.getTime() + 86400000);
  const yesterday = yesterdayDate.toISOString().split("T")[0];
  const tomorrow = tomorrowDate.toISOString().split("T")[0];
  let prompt = `Você é um assistente que analisa mensagens em português para extrair informações financeiras.
Responda APENAS com JSON válido, sem texto adicional.

Formato esperado:
{"intent":"string|null","amount":number|null,"category":"string|null","group":"string|null","description":"string|null","date":"string|null","period":"this_month|last_month|null","name":"string|null","tag":"string|null","limit":number|null}

Intents:
- "expense": despesa (gastei, gasto, paguei, pago, comprei, compro, debitou, custou, gasolina, ifood, aluguel, conta, fatura, boleto, assinatura, desembolsei, saiu, sangrou, quebrei, ralei, suei, pedi, consumo, comi, almocei, jantei, abasteci, recarreguei)
- "income": receita (recebi, recebo, ganhei, ganho, faturo, faturei, salário, renda, bônus, bonificação, freela, freela, deposito, depositaram, caiu, creditou, lucro, vendi, vendo, investimento, embolsei, bati, puxei, bico, quebra-galho)
- "query_balance": ver saldo (quanto tenho, saldo)
- "query_expenses_month": gastos do mês atual
- "query_expenses_last_month": gastos do mês passado
- "query_expenses_date": gastos de data específica
- "query_expenses_category": gastos por categoria
- "query_summary": resumo por categoria
- "query_extract": extrato detalhado
- "create_category": criar nova categoria
- "create_group": criar novo grupo
- "list_categories": listar categorias
- "list_groups": listar grupos
- "list_tags": listar tags
- "list_transactions": listar transações
- "show_last_transaction": última transação
- "delete_last_transaction": excluir última
- "list_by_tag": listar por tag
- "cleanup": limpar dados não usados
- null: não entendeu

REGRAS IMPORTANTES:
- Identifique a intenção mesmo com erros de digitação (ex: "ganhei" quer dizer "ganhei")
- Palavras que indicam RECEBIMENTO de dinheiro → intent "income": recebi, recebo, ganhei, ganho, salário, renda, bônus, freela, deposito, caiu, creditou, lucro, vendi, faturei, embolsei
- Palavras que indicam GASTO de dinheiro → intent "expense": gastei, paguei, comprei, custou, gasolina, ifood, aluguel, conta, fatura, boleto, assinatura, desembolsei, saiu, pedi, comi, abasteci, transferi, transferir, transferiu, enviei, mandei, puxei, tirei
- Se não houver palavra-chave clara indicando despesa ou receita, retorne intent como null
- category DEVE ser uma palavra (ou no máximo duas) que corresponde EXATAMENTE a uma categoria da lista abaixo
- Analise CADA palavra da frase individualmente. Se uma palavra isolada corresponder a uma categoria, use essa
- NUNCA use a frase inteira como valor de category. Apenas palavras individuais da frase
- palavras de moeda (reais, real, R$, dinheiro, conto, pila, grana), data (ontem, hoje, amanhã), preposições (de, em, no, na, do, da), verbos de ação e nomes próprios NÃO são categorias. Ignore-os.
- amount numérico, date YYYY-MM-DD, period this_month/last_month, name para criar entidade, tag sem #
- group deve ser o nome EXATO de um grupo listado abaixo, se mencionado; se não houver grupo mencionado, null
- description deve guardar o contexto útil da transação quando não for categoria/grupo/tag/data/valor (ex: pessoa, loja, motivo curto)
- limit padrão 10

DATA ATUAL: ${today} (fuso horário: America/Sao_Paulo)
"hoje" = ${today}
"ontem" = ${yesterday}
"amanhã" = ${tomorrow}
Sempre converta "hoje", "ontem" e "amanhã" para a data real no campo "date" em YYYY-MM-DD.
Se o usuário mencionar um dia da semana (ex: "segunda", "terça"), calcule a data relativa a partir de hoje.`;

  if (context?.categories?.length) {
    prompt += `\n\nSUAS CATEGORIAS (use o nome EXATO):\n`;
    for (const c of context.categories) {
      const tipo = c.transaction_type === "expense" ? " [despesa]"
        : c.transaction_type === "income" ? " [receita]"
        : " [despesa e receita]";
      prompt += `- ${c.name}${tipo}\n`;
    }
    prompt += `\nREGRAS DE CATEGORIA POR TIPO:\n`;
    prompt += `- Se intent = "income" → category DEVE ser uma das listadas como [receita] ou [despesa e receita]\n`;
    prompt += `- Se intent = "expense" → category DEVE ser uma das listadas como [despesa] ou [despesa e receita]\n`;
    prompt += `- Analise CADA palavra individualmente. Se UMA palavra da frase corresponder a uma categoria, use essa\n`;
    prompt += `- Se NENHUMA palavra individual corresponder a nenhuma categoria → category = null\n`;
    prompt += `- NUNCA use a frase inteira nem múltiplas palavras como category\n`;
    prompt += `- NUNCA invente categorias. Use APENAS os nomes EXATOS da lista acima.\n`;
    prompt += `\nEXEMPLOS CORRETOS (uma palavra → categoria):\n`;
    prompt += `- "comprei remedio na farmacia" → palavra "remedio" → categoria "Saúde" (se existir)\n`;
    prompt += `- "pedi ifood" → palavra "ifood" → categoria "Alimentação" (se existir)\n`;
    prompt += `- "paguei gasolina" → palavra "gasolina" → categoria "Transporte" (se existir)\n`;
    prompt += `\nEXEMPLOS QUE DEVEM RETORNAR null (nenhuma palavra corresponde):\n`;
    prompt += `- "Transferi 10 pra Angela" → "transferi" é verbo, "Angela" é nome próprio, nenhuma palavra é categoria → category = null\n`;
    prompt += `- "comprei um presente" → "presente" não corresponde a nenhuma categoria → category = null\n`;
    prompt += `- "paguei 10" → nenhuma categoria mencionada → category = null\n`;
  }

  if (context?.groups?.length) {
    prompt += `\nSEUS GRUPOS:\n`;
    for (const g of context.groups) {
      prompt += `- ${g.name}${g.is_default ? " (padrão)" : ""}\n`;
    }
  }

  if (context?.tags?.length) {
    prompt += `\nSUAS TAGS:\n`;
    for (const t of context.tags) {
      prompt += `- ${t}\n`;
    }
  }

  return prompt;
}

function checkCommonPhrase(text: string): DeepSeekResponse | null {
  const normalized = text.toLowerCase().trim().replace(/[?!.,]+$/g, "").replace(/\s+/g, " ");
  for (const [phrase, response] of Object.entries(commonPhrases)) {
    if (normalized === phrase) {
      return { ...response };
    }
  }
  return null;
}

function getCachedResponse(userId: number, text: string): DeepSeekResponse | null {
  const userCache = nlCache.get(userId);
  if (!userCache) return null;
  const cached = userCache.get(text);
  if (cached && Date.now() - cached.timestamp < NL_CACHE_TTL) {
    return { ...cached.response };
  }
  userCache.delete(text);
  if (userCache.size === 0) nlCache.delete(userId);
  return null;
}

function setCachedResponse(userId: number, text: string, response: DeepSeekResponse): void {
  let userCache = nlCache.get(userId);
  if (!userCache) {
    userCache = new Map();
    nlCache.set(userId, userCache);
  }
  userCache.set(text, { response: { ...response }, timestamp: Date.now() });
  if (userCache.size > 100) {
    const entries = [...userCache.entries()];
    const cutoff = Date.now() - NL_CACHE_TTL;
    for (const [key, value] of entries) {
      if (value.timestamp < cutoff) {
        userCache.delete(key);
      }
    }
    if (userCache.size > 100) {
      const sorted = [...userCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = Math.ceil(userCache.size / 2);
      for (let i = 0; i < toDelete; i++) {
        userCache.delete(sorted[i][0]);
      }
    }
  }
}

async function callDeepSeek(
  userMessage: string,
  options?: {
    context?: UserContext;
    history?: { role: "user" | "assistant"; content: string }[];
    maxTokens?: number;
  }
): Promise<string | null> {
  if (!DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY is not set");
    return null;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const systemPrompt = buildSystemPrompt(options?.context);
    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
    ];
    if (options?.history) {
      messages.push(...options.history);
    }
    messages.push({ role: "user", content: userMessage });

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        temperature: 0.1,
        max_tokens: options?.maxTokens || 200,
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
    if (error instanceof Error && error.name === "AbortError") {
      console.error("DeepSeek API timeout");
    } else {
      console.error("Error calling DeepSeek:", error);
    }
    return null;
  }
}

export function parseDeepSeekResponse(raw: string): Partial<DeepSeekResponse> {
  try {
    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      intent: parsed.intent || null,
      amount: typeof parsed.amount === "number" ? parsed.amount : null,
      category: parsed.category || null,
      date: parsed.date || null,
      period: parsed.period || null,
      name: parsed.name || null,
      tag: parsed.tag || null,
      group: parsed.group || null,
      description: parsed.description || null,
      limit: typeof parsed.limit === "number" ? parsed.limit : null,
    };
  } catch (error) {
    console.error("Error parsing DeepSeek response:", error);
    return {};
  }
}

export function buildDeepSeekResponse(parsed: Partial<DeepSeekResponse>): DeepSeekResponse {
  const intent = parsed.intent || null;
  const amount = typeof parsed.amount === "number" ? parsed.amount : null;
  const category = parsed.category || null;
  const date = parsed.date || null;
  const period = parsed.period || null;
  const name = parsed.name || null;
  const tag = parsed.tag || null;
  const group = parsed.group || null;
  const description = parsed.description || null;
  const limit = typeof parsed.limit === "number" ? parsed.limit : null;

  const missingFields: string[] = [];
  if (intent === "expense" || intent === "income") {
    if (!amount) missingFields.push("amount");
    if (!category && !description) missingFields.push("category");
  }
  if (intent === "query_expenses_date" && !date) missingFields.push("date");
  if ((intent === "query_expenses_month" || intent === "query_expenses_last_month" ||
       intent === "query_expenses_category" || intent === "query_summary" || intent === "query_extract") && !period) missingFields.push("period");

  return { intent, amount, category, date, period, name, tag, group, description, limit, missingFields };
}

export async function parseNaturalLanguage(
  text: string,
  options?: {
    userId?: number;
    context?: UserContext;
  }
): Promise<DeepSeekResponse> {
  const defaultResponse: DeepSeekResponse = {
    intent: null, amount: null, category: null, date: null, period: null,
    name: null, tag: null, group: null, description: null, limit: null, missingFields: [],
  };

  const commonResponse = checkCommonPhrase(text);
  if (commonResponse) return commonResponse;

  const cachedResponse = options?.userId ? getCachedResponse(options.userId, text) : null;
  if (cachedResponse) return cachedResponse;

  const raw = await callDeepSeek(text, { context: options?.context });
  if (!raw) return defaultResponse;

  const parsed = parseDeepSeekResponse(raw);
  const result = buildDeepSeekResponse(parsed);

  if (options?.userId) setCachedResponse(options.userId, text, result);

  return result;
}
