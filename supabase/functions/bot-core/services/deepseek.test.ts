import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildDeepSeekResponse,
  parseDeepSeekResponse,
  parseNaturalLanguage,
  buildSystemPrompt,
  buildForceIntentLine,
  buildCategoriesSection,
  buildGroupsSection,
  buildTagsSection,
} from "./deepseek.ts";

function assertNotContains(haystack: string, needle: string): void {
  assert(
    !haystack.includes(needle),
    `Expected string NOT to contain "${needle}", but it was found.`,
  );
}

function assertStartsWith(actual: string, prefix: string): void {
  assert(
    actual.startsWith(prefix),
    `Expected string to start with "${prefix}", got "${actual.slice(0, 100)}"`,
  );
}

// ============================================================
// buildForceIntentLine
// ============================================================

Deno.test("buildForceIntentLine: null/undefined returns empty string", () => {
  assertEquals(buildForceIntentLine(), "");
  assertEquals(buildForceIntentLine(undefined), "");
});

Deno.test("buildForceIntentLine: expense forces DESPESA instruction", () => {
  const result = buildForceIntentLine("expense");
  assertStringIncludes(result, "DESPESA");
  assertStringIncludes(result, 'intent = "expense"');
  assertNotContains(result, "RECEITA");
  assertNotContains(result, 'intent = "income"');
});

Deno.test("buildForceIntentLine: income forces RECEITA instruction", () => {
  const result = buildForceIntentLine("income");
  assertStringIncludes(result, "RECEITA");
  assertStringIncludes(result, 'intent = "income"');
  assertNotContains(result, "DESPESA");
  assertNotContains(result, 'intent = "expense"');
});

// ============================================================
// buildCategoriesSection
// ============================================================

const MOCK_CATEGORIES = [
  { name: "Alimentação", transaction_type: "expense" },
  { name: "Salário", transaction_type: "income" },
  { name: "Outros", transaction_type: null },
  { name: "Moradia", transaction_type: "expense" },
  { name: "Freela", transaction_type: "income" },
];

Deno.test("buildCategoriesSection: empty categories returns header only", () => {
  const result = buildCategoriesSection([]);
  assertStringIncludes(result, "SUAS CATEGORIAS");
  assertNotContains(result, "CATEGORY_TYPE_RULES");
});

Deno.test("buildCategoriesSection: lists all categories with type annotations", () => {
  const result = buildCategoriesSection(MOCK_CATEGORIES);
  assertStringIncludes(result, "Alimentação [despesa]");
  assertStringIncludes(result, "Salário [receita]");
  assertStringIncludes(result, "Outros [despesa e receita]");
  assertStringIncludes(result, "Moradia [despesa]");
  assertStringIncludes(result, "Freela [receita]");
});

Deno.test("buildCategoriesSection: contains category rules and examples", () => {
  const result = buildCategoriesSection(MOCK_CATEGORIES);
  assertStringIncludes(result, "REGRAS DE CATEGORIA POR TIPO:");
  assertStringIncludes(result, "EXEMPLOS CORRETOS");
  assertStringIncludes(result, "EXEMPLOS QUE DEVEM RETORNAR null");
  assertStringIncludes(result, '"remedio" → categoria "Saúde"');
  assertStringIncludes(result, '"ifood" → categoria "Alimentação"');
  assertStringIncludes(result, '"Transferi 10 pra Angela"');
});

Deno.test("buildCategoriesSection: forceIntent=expense filters income categories out", () => {
  const result = buildCategoriesSection(MOCK_CATEGORIES, "expense");
  assertStringIncludes(result, "Alimentação [despesa]");
  assertStringIncludes(result, "Outros [despesa e receita]");
  assertStringIncludes(result, "Moradia [despesa]");
  // Use dash prefix to check category listing (not the word in example/rules text)
  assertNotContains(result, "- Salário");
  assertNotContains(result, "- Freela");
});

Deno.test("buildCategoriesSection: forceIntent=income filters expense categories out", () => {
  const result = buildCategoriesSection(MOCK_CATEGORIES, "income");
  assertStringIncludes(result, "Salário [receita]");
  assertStringIncludes(result, "Outros [despesa e receita]");
  assertStringIncludes(result, "Freela [receita]");
  // Alimentação appears in CATEGORY_CORRECT_EXAMPLES, so check listing only
  assertNotContains(result, "- Alimentação");
  assertNotContains(result, "- Moradia");
});

// ============================================================
// buildGroupsSection
// ============================================================

Deno.test("buildGroupsSection: empty groups returns header only", () => {
  const result = buildGroupsSection([]);
  assertStringIncludes(result, "SEUS GRUPOS");
});

Deno.test("buildGroupsSection: marks default group", () => {
  const result = buildGroupsSection([
    { name: "Pessoal", is_default: true },
    { name: "Trabalho", is_default: false },
  ]);
  assertStringIncludes(result, "Pessoal (padrão)");
  assertStringIncludes(result, "Trabalho");
  assertNotContains(result, "Trabalho (padrão)");
});

Deno.test("buildGroupsSection: lists all groups", () => {
  const result = buildGroupsSection([
    { name: "Pessoal", is_default: false },
    { name: "Trabalho", is_default: false },
    { name: "Viagem", is_default: false },
  ]);
  assertStringIncludes(result, "Pessoal");
  assertStringIncludes(result, "Trabalho");
  assertStringIncludes(result, "Viagem");
});

// ============================================================
// buildTagsSection
// ============================================================

Deno.test("buildTagsSection: empty tags returns header only", () => {
  const result = buildTagsSection([]);
  assertStringIncludes(result, "SUAS TAGS");
});

Deno.test("buildTagsSection: lists each tag", () => {
  const result = buildTagsSection(["ifood", "uber", "mercado"]);
  assertStringIncludes(result, "ifood");
  assertStringIncludes(result, "uber");
  assertStringIncludes(result, "mercado");
});

Deno.test("buildTagsSection: each tag on its own line with dash prefix", () => {
  const result = buildTagsSection(["tag1", "tag2"]);
  assertStringIncludes(result, "- tag1\n");
  assertStringIncludes(result, "- tag2\n");
});

// ============================================================
// buildSystemPrompt — integration tests
// ============================================================

Deno.test("buildSystemPrompt: no context returns base prompt with dates filled", () => {
  const result = buildSystemPrompt();
  // Should NOT contain placeholders
  assertNotContains(result, "TODAY_PLACEHOLDER");
  assertNotContains(result, "YESTERDAY_PLACEHOLDER");
  assertNotContains(result, "TOMORROW_PLACEHOLDER");
  // Should contain base prompt essentials
  assertStringIncludes(result, "Você é um assistente que analisa mensagens em português");
  assertStringIncludes(result, "Formato esperado");
  assertStringIncludes(result, "DATA ATUAL:");
  // Should NOT contain any context sections
  assertNotContains(result, "SUAS CATEGORIAS");
  assertNotContains(result, "SEUS GRUPOS");
  assertNotContains(result, "SUAS TAGS");
  // Should NOT have force intent line
  assertStartsWith(result, "Você");
});

Deno.test("buildSystemPrompt: with full context includes all sections", () => {
  const result = buildSystemPrompt({
    categories: [{ name: "Alimentação", transaction_type: "expense" }],
    groups: [{ name: "Pessoal", is_default: true }],
    tags: ["ifood"],
  });
  assertStringIncludes(result, "SUAS CATEGORIAS (use o nome EXATO)");
  assertStringIncludes(result, "Alimentação");
  assertStringIncludes(result, "SEUS GRUPOS");
  assertStringIncludes(result, "Pessoal (padrão)");
  assertStringIncludes(result, "SUAS TAGS");
  assertStringIncludes(result, "ifood");
});

Deno.test("buildSystemPrompt: forceIntent=expense prepends force line + filters categories", () => {
  const result = buildSystemPrompt(
    {
      categories: [
        { name: "Alimentação", transaction_type: "expense" },
        { name: "Salário", transaction_type: "income" },
        { name: "Outros", transaction_type: null },
      ],
      groups: [],
      tags: [],
    },
    "expense",
  );
  // Force line at the start
  assertStartsWith(result, "IMPORTANTE: Esta transação é do tipo DESPESA.");
  assertStringIncludes(result, 'intent = "expense"');
  // Categories filtered: expense + null only
  assertStringIncludes(result, "Alimentação [despesa]");
  assertStringIncludes(result, "Outros [despesa e receita]");
  // "Salário" appears as income intent keyword in base prompt, check listing only
  assertNotContains(result, "- Salário");
});

Deno.test("buildSystemPrompt: forceIntent=income prepends force line + filters categories", () => {
  const result = buildSystemPrompt(
    {
      categories: [
        { name: "Alimentação", transaction_type: "expense" },
        { name: "Salário", transaction_type: "income" },
        { name: "Outros", transaction_type: null },
      ],
      groups: [],
      tags: [],
    },
    "income",
  );
  assertStartsWith(result, "IMPORTANTE: Esta transação é do tipo RECEITA.");
  assertStringIncludes(result, 'intent = "income"');
  assertStringIncludes(result, "Salário [receita]");
  assertStringIncludes(result, "Outros [despesa e receita]");
  // "Alimentação" appears in CATEGORY_CORRECT_EXAMPLES, check listing only
  assertNotContains(result, "- Alimentação");
});

Deno.test("buildSystemPrompt: dates are valid YYYY-MM-DD", () => {
  const result = buildSystemPrompt();
  const dateMatch = result.match(/DATA ATUAL: (\d{4}-\d{2}-\d{2})/);
  assertEquals(dateMatch !== null, true);
  const dateStr = dateMatch![1];
  const parsed = new Date(dateStr + "T12:00:00");
  assertEquals(parsed.toISOString().split("T")[0], dateStr);

  // hoje = same date
  assertStringIncludes(result, `"hoje" = ${dateStr}`);
});

// ============================================================
// Existing tests (unchanged)
// ============================================================

Deno.test("parseDeepSeekResponse extracts group and description fields", () => {
  const parsed = parseDeepSeekResponse(JSON.stringify({
    intent: "expense",
    amount: 10,
    category: null,
    group: "Trabalho",
    description: "Angela",
    date: "2026-06-16",
    period: null,
    name: null,
    tag: "pix",
    limit: null,
  }));

  assertEquals(parsed.group, "Trabalho");
  assertEquals(parsed.description, "Angela");
});

Deno.test("parseNaturalLanguage does not short-circuit common phrase with modifiers", async () => {
  const parsed = await parseNaturalLanguage("extrato mês passado");

  assertEquals(parsed.intent, null);
  assertEquals(parsed.period, null);
});

Deno.test("buildDeepSeekResponse does not require category when description is present", () => {
  const parsed = buildDeepSeekResponse(parseDeepSeekResponse(JSON.stringify({
    intent: "expense",
    amount: 10,
    category: null,
    description: "Angela",
    date: null,
    period: null,
    name: null,
    tag: null,
    limit: null,
  })));

  assertEquals(parsed.category, null);
  assertEquals(parsed.description, "Angela");
  assertEquals(parsed.missingFields, []);
});
