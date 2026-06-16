import { parseCommand } from "./command-parsing.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("parseCommand keeps tags separate when they appear after category", () => {
  const parsed = parseCommand(["50", "Alimentação", "#ifood"]);

  assertEquals(parsed.amount, 50);
  assertEquals(parsed.category, "Alimentação");
  assertEquals(parsed.tags, ["#ifood"]);
});

Deno.test("parseCommand keeps group and date separate when they appear after category", () => {
  const parsed = parseCommand([
    "50",
    "Alimentação",
    "--grupo",
    "Trabalho",
    "--data",
    "2026-06-16",
  ]);

  assertEquals(parsed.amount, 50);
  assertEquals(parsed.category, "Alimentação");
  assertEquals(parsed.group, "Trabalho");
  assertEquals(parsed.date, "2026-06-16");
});
