import { buildQueryExpensesFilters } from "./queries.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("buildQueryExpensesFilters always filters expenses", () => {
  const filters = buildQueryExpensesFilters(null);

  assertEquals(filters, { type: "expense", limit: 10 });
});

Deno.test("buildQueryExpensesFilters keeps expense type when category is present", () => {
  const filters = buildQueryExpensesFilters("Alimentação");

  assertEquals(filters, { type: "expense", limit: null });
});
