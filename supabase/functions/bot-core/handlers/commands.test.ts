import {
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { handleLogin } from "./commands.ts";

// ── Mock supabase client ──────────────────────────────────

interface CallTrace {
  method: string;
  args: unknown[];
}

function createMockSupabase(
  tables: Record<string, unknown | null>,
  traces: CallTrace[],
): any {
  function chain(terminalResult: unknown) {
    const handler = {
      get(_: unknown, prop: string) {
        if (prop === "then") return undefined;

        return (...args: unknown[]) => {
          traces.push({ method: prop, args });

          // Terminal methods
          if (prop === "maybeSingle" || prop === "single") {
            return Promise.resolve({ data: terminalResult, error: null });
          }

          // Mutation methods: need to be thenable AND chainable
          if (prop === "insert") {
            return Promise.resolve({ data: null, error: null });
          }
          if (prop === "update" || prop === "delete") {
            const thenHandler = {
              get(_target: unknown, thenProp: string) {
                if (thenProp === "then") {
                  return (resolve: (v: unknown) => void) =>
                    resolve({ data: null, error: null });
                }
                if (thenProp === "eq") {
                  return (...eqArgs: unknown[]) => {
                    traces.push({ method: "eq", args: eqArgs });
                    return new Proxy({}, thenHandler);
                  };
                }
                return undefined;
              },
            };
            return new Proxy({}, thenHandler);
          }

          // .from() sets the current table
          if (prop === "from") {
            const tableName = String(args[0]);
            const result = tables[tableName] ?? null;
            return chain(result);
          }

          // Builder methods
          return chain(terminalResult);
        };
      },
    };
    return new Proxy({}, handler);
  }

  return chain(null);
}

// ── Tests: handleLogin — generate code (no args) ──────────

Deno.test("handleLogin (no args) generates a 6-char code from safe charset", async () => {
  const traces: CallTrace[] = [];
  const supabase = createMockSupabase(
    { telegram_accounts: { user_id: 42 } },
    traces,
  );

  await handleLogin(supabase, 123, 456);

  const inserts = traces.filter((t) => t.method === "insert");
  assertEquals(inserts.length >= 1, true, "Expected at least one insert call");

  const insertArgs = inserts[0].args[0] as Record<string, unknown>;
  assertEquals(typeof insertArgs?.code, "string");
  assertEquals(String(insertArgs?.code).length, 6);

  assertEquals(insertArgs?.user_id, 42);
  assertEquals(insertArgs?.auth_id, null);
});

Deno.test("handleLogin (no args) code uses safe charset (no I/O/0/1)", async () => {
  const traces: CallTrace[] = [];
  const codes = new Set<string>();

  for (let i = 0; i < 50; i++) {
    const supabase = createMockSupabase(
      { telegram_accounts: { user_id: 42 } },
      traces,
    );
    await handleLogin(supabase, 123, 456);
  }

  const inserts = traces.filter((t) => t.method === "insert");
  for (const ins of inserts) {
    const code = String((ins.args[0] as Record<string, unknown>)?.code ?? "");
    assertEquals(code.length, 6);
    for (const ch of code) {
      assertEquals(
        "IO01".includes(ch),
        false,
        `Code contains unsafe char "${ch}"`,
      );
    }
    assertEquals(
      /^[A-Z0-9]+$/.test(code),
      true,
      `Code "${code}" has invalid chars`,
    );
    codes.add(code);
  }

  assertEquals(codes.size > 1, true, "Should generate different codes");
});

Deno.test("handleLogin (no args) sets correct expires_at (2 min from now)", async () => {
  const traces: CallTrace[] = [];
  const supabase = createMockSupabase(
    { telegram_accounts: { user_id: 42 } },
    traces,
  );
  const before = Date.now();

  await handleLogin(supabase, 123, 456);

  const inserts = traces.filter((t) => t.method === "insert");
  const insertArgs = inserts[0].args[0] as Record<string, unknown>;
  const expiresAt = new Date(insertArgs?.expires_at as string).getTime();
  const diffMs = expiresAt - before;

  assertEquals(diffMs > 80_000, true, `Expiry too short: ${diffMs}ms`);
  assertEquals(diffMs < 200_000, true, `Expiry too long: ${diffMs}ms`);
});

Deno.test("handleLogin (no args) invalidates previous pending codes", async () => {
  const traces: CallTrace[] = [];
  const supabase = createMockSupabase(
    { telegram_accounts: { user_id: 42 } },
    traces,
  );

  await handleLogin(supabase, 123, 456);

  // Should update pending codes first (set used=true)
  const updates = traces.filter((t) => t.method === "update");
  assertEquals(updates.length >= 1, true, "Should update existing pending codes to invalidate");
  const updateArgs = updates[0].args[0] as Record<string, unknown>;
  assertEquals(updateArgs.used, true, "Should set used=true to invalidate");

  const eqCalls = traces.filter((t) => t.method === "eq");
  const userEq = eqCalls.find((c) => c.args[0] === "user_id");
  assertEquals(userEq !== undefined, true, "Should filter by user_id");
  assertEquals(userEq!.args[1], 42, "Should filter by current user");

  const usedEq = eqCalls.find((c) => c.args[0] === "used");
  assertEquals(usedEq !== undefined, true, "Should filter by used=false");
  assertEquals(usedEq!.args[1], false, "Should only invalidate unused codes");

  // Should still insert the new code
  const inserts = traces.filter((t) => t.method === "insert");
  assertEquals(inserts.length >= 1, true, "Should have inserted a new code");

  // Update should come before insert
  const updateIndex = traces.findIndex((t) => t.method === "update");
  const insertIndex = traces.findIndex((t) => t.method === "insert");
  assertEquals(updateIndex < insertIndex, true, "Update should come before insert");
});

Deno.test("handleLogin (no args) smoke test", async () => {
  const traces: CallTrace[] = [];
  const supabase = createMockSupabase(
    { telegram_accounts: { user_id: 42 } },
    traces,
  );

  await handleLogin(supabase, 123, 456);

  const inserts = traces.filter((t) => t.method === "insert");
  assertEquals(inserts.length >= 1, true, "Should have inserted a code");
});

