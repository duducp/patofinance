import {
  buildDeepSeekResponse,
  parseDeepSeekResponse,
  parseNaturalLanguage,
} from "./deepseek.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

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
