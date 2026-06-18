import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { handleAuthTelegram } from "./index.ts";

// ── Helpers ────────────────────────────────────────────────

let requestCounter = 0;

function uniqueIp(): string {
  requestCounter++;
  return `10.0.0.${requestCounter}`;
}

function postRequest(
  body: unknown,
  ip?: string,
): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip ?? uniqueIp() },
    body: JSON.stringify(body),
  });
}

function optionsRequest(): Request {
  return new Request("http://localhost", { method: "OPTIONS" });
}

function getRequest(): Request {
  return new Request("http://localhost", { method: "GET" });
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

// ── Mock Supabase ──────────────────────────────────────────

interface MockConfig {
  linkCode?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
  createAuthUser?: { data: Record<string, unknown> | null; error: Record<string, unknown> | null };
  generateLink?: { data: Record<string, unknown> | null; error: Record<string, unknown> | null };
}

function createMockSupabase(config: MockConfig): any {
  // Track calls for assertions
  const calls: string[] = [];

  // Connection-level mock (supabase.auth.admin.createUser etc.)
  const adminHandler = {
    get(_: unknown, prop: string) {
      calls.push(`auth.admin.${prop}`);
      if (prop === "createUser") {
        return (_args: unknown) =>
          Promise.resolve(
            config.createAuthUser ?? {
              data: {
                user: { id: "auth-123-created" },
              },
              error: null,
            },
          );
      }
      if (prop === "generateLink") {
        return (_args: unknown) =>
          Promise.resolve(
            config.generateLink ?? {
              data: {
                properties: {
                  action_link:
                    "https://project.supabase.co/auth/confirm#access_token=abc123&refresh_token=def456&expires_in=3600",
                },
              },
              error: null,
            },
          );
      }
      return () => Promise.resolve({ data: null, error: null });
    },
  };

  const adminProxy = new Proxy({}, adminHandler);

  // Shared `.then`-able proxy for update/delete chains
  function mutationThenable(result: unknown) {
    const thenFn = (resolve: (v: unknown) => void) => resolve(result);
    return {
      eq: (...args: unknown[]) => {
        calls.push(`eq(${args.join(", ")})`);
        return { eq: (...args2: unknown[]) => { calls.push(`eq(${args2.join(", ")})`); return Promise.resolve(result); } };
      },
      then: thenFn,
    };
  }

  // Builder chain — returned by .from().select().eq()...
  function builderChain(finalResult: unknown) {
    const handler = {
      get(_: unknown, prop: string) {
        if (prop === "then") return undefined;

        if (prop === "maybeSingle" || prop === "single") {
          calls.push(prop);
          return () => Promise.resolve({ data: finalResult, error: null });
        }

        return (...args: unknown[]) => {
          calls.push(`${prop}(${args.map(String).join(", ")})`);
          if (prop === "update" || prop === "delete") {
            return mutationThenable({ data: null, error: null });
          }
          return builderChain(finalResult);
        };
      },
    };
    return new Proxy({}, handler);
  }

  // Top-level supabase object
  const supabaseHandler = {
    get(_: unknown, prop: string) {
      if (prop === "auth") {
        return {
          admin: adminProxy,
        };
      }
      if (prop === "from") {
        return (tableName: string) => {
          calls.push(`from(${tableName})`);
          let result: unknown = null;
          if (tableName === "link_codes") result = config.linkCode ?? null;
          if (tableName === "users") result = config.user ?? null;
          return builderChain(result);
        };
      }
      return undefined;
    },
  };

  const supabase = new Proxy({}, supabaseHandler);
  (supabase as any).__calls = calls;
  return supabase;
}

// ── Tests ──────────────────────────────────────────────────

Deno.test("OPTIONS returns 204 with CORS headers", async () => {
  const supabase = createMockSupabase({});
  const res = await handleAuthTelegram(optionsRequest(), supabase);

  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
});

Deno.test("GET returns 405", async () => {
  const supabase = createMockSupabase({});
  const res = await handleAuthTelegram(getRequest(), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 405);
  assertEquals(body.ok, false);
  assertEquals(body.error, "Method not allowed");
});

Deno.test("missing code returns 400", async () => {
  const supabase = createMockSupabase({});
  const res = await handleAuthTelegram(postRequest({}), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 400);
  assertEquals(body.error, "Código é obrigatório.");
});

Deno.test("non-string code returns 400", async () => {
  const supabase = createMockSupabase({});
  const res = await handleAuthTelegram(postRequest({ code: 123 }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 400);
  assertEquals(body.error, "Código é obrigatório.");
});

Deno.test("code too short returns 400", async () => {
  const supabase = createMockSupabase({});
  const res = await handleAuthTelegram(postRequest({ code: "ABC" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 400);
  assertEquals(body.error, "Código inválido. Deve ter 6 caracteres alfanuméricos.");
});

Deno.test("code too long returns 400", async () => {
  const supabase = createMockSupabase({});
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEFG" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 400);
  assertEquals(body.error, "Código inválido. Deve ter 6 caracteres alfanuméricos.");
});

Deno.test("code with special chars returns 400", async () => {
  const supabase = createMockSupabase({});
  const res = await handleAuthTelegram(postRequest({ code: "ABC!@#" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 400);
  assertEquals(body.error, "Código inválido. Deve ter 6 caracteres alfanuméricos.");
});

Deno.test("code with lowercase is normalized to uppercase before validation", async () => {
  // All lowercase should be valid (6 chars, all alphanumeric)
  const supabase = createMockSupabase({
    linkCode: null, // Will return 401, but that's after format validation
  });
  const res = await handleAuthTelegram(postRequest({ code: "abcdef" }), supabase);

  // Should pass format validation and reach link lookup
  assertEquals(res.status, 401);
  const body = await parseJson(res);
  assertEquals(body.error, "Código inválido ou expirado. Gere um novo no Telegram.");
});

Deno.test("valid code not found in DB returns 401", async () => {
  const supabase = createMockSupabase({ linkCode: null });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 401);
  assertEquals(body.error, "Código inválido ou expirado. Gere um novo no Telegram.");
});

Deno.test("valid code + user not found returns 404", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: null },
    user: null,
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 404);
  assertEquals(body.error, "Usuário não encontrado.");
});

Deno.test("valid code + user has auth_id → generates session", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 200);
  assertEquals(body.ok, true);

  // Session tokens
  const session = body.session as Record<string, unknown>;
  assertExists(session);
  assertEquals(session.access_token, "abc123");
  assertEquals(session.refresh_token, "def456");
  assertEquals(session.expires_in, 3600);

  // User info
  const user = body.user as Record<string, unknown>;
  assertEquals(user.id, 42);
  assertEquals(user.auth_id, "existing-auth-456");
  assertEquals(user.is_new, false);
});

Deno.test("valid code + user without auth_id → creates auth user + session (is_new=true)", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: null },
    user: { id: 42, auth_id: null },
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 200);
  assertEquals(body.ok, true);

  const user = body.user as Record<string, unknown>;
  assertEquals(user.id, 42);
  assertEquals(user.is_new, true);
  // auth_id should be the newly created one
  assertEquals(user.auth_id, "auth-123-created");
});

Deno.test("creating auth user fails → returns 500", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: null },
    user: { id: 42, auth_id: null },
    createAuthUser: {
      data: null,
      error: { message: "Email already registered" },
    },
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 500);
  assertEquals(body.error, "Erro ao criar conta de acesso.");
});

Deno.test("createUser returns no user.id → returns 500", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: null },
    user: { id: 42, auth_id: null },
    createAuthUser: {
      data: { user: null },
      error: null,
    },
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 500);
  assertEquals(body.error, "Erro ao criar conta de acesso.");
});

Deno.test("generateLink fails → returns 500", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
    generateLink: {
      data: null,
      error: { message: "Failed to generate link" },
    },
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 500);
  assertEquals(body.error, "Erro ao gerar sessão.");
});

Deno.test("magic link missing action_link → returns 500", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
    generateLink: {
      data: { properties: {} },
      error: null,
    },
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 500);
  assertEquals(body.error, "Erro ao obter tokens de acesso.");
});

Deno.test("magic link has no hash fragment → returns 500", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
    generateLink: {
      data: { properties: { action_link: "https://project.supabase.co/auth/confirm" } },
      error: null,
    },
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 500);
  assertEquals(body.error, "Erro ao obter tokens de acesso.");
});

Deno.test("uppercases lowercase codes before querying", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
  });
  const res = await handleAuthTelegram(postRequest({ code: "abcdef" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 200);
  assertEquals(body.ok, true);
});

Deno.test("code with leading/trailing spaces is trimmed", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
  });
  const res = await handleAuthTelegram(postRequest({ code: "  ABCDEF  " }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 200);
  assertEquals(body.ok, true);
});

Deno.test("rate limiting: 10 requests from same IP → 429 on 11th", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
  });

  // Send 10 successful requests from same IP
  for (let i = 0; i < 10; i++) {
    const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }, "127.0.0.1"), supabase);
    assertEquals(res.status, 200);
  }

  // 11th should be rate limited
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }, "127.0.0.1"), supabase);
  assertEquals(res.status, 429);
  const body = await parseJson(res);
  assertEquals(body.error, "Muitas tentativas. Aguarde 1 minuto.");
});

Deno.test("rate limiting: different IPs have separate rate limits", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
  });

  // 10 requests from IP A
  for (let i = 0; i < 10; i++) {
    const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }, "1.1.1.1"), supabase);
    assertEquals(res.status, 200);
  }

  // IP A should be blocked
  const blockedA = await handleAuthTelegram(postRequest({ code: "ABCDEF" }, "1.1.1.1"), supabase);
  assertEquals(blockedA.status, 429);

  // IP B should NOT be blocked (separate counter)
  const okB = await handleAuthTelegram(postRequest({ code: "ABCDEF" }, "2.2.2.2"), supabase);
  assertEquals(okB.status, 200);
});

Deno.test("x-real-ip fallback works when x-forwarded-for is missing", async () => {
  const supabase = createMockSupabase({
    linkCode: null,
    user: null,
  });

  const req = new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": "3.3.3.3" },
    body: JSON.stringify({ code: "ABCDEF" }),
  });

  // Should not throw — uses x-real-ip as fallback
  const res = await handleAuthTelegram(req, supabase);
  assertEquals(res.status, 401);
});

Deno.test("success response includes all required fields", async () => {
  const supabase = createMockSupabase({
    linkCode: { id: 1, user_id: 42, auth_id: "existing-auth-456" },
    user: { id: 42, auth_id: "existing-auth-456" },
    generateLink: {
      data: {
        properties: {
          action_link:
            "https://project.supabase.co/auth/confirm#access_token=abc&refresh_token=def&expires_in=7200&token_type=bearer",
        },
      },
      error: null,
    },
  });
  const res = await handleAuthTelegram(postRequest({ code: "ABCDEF" }), supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 200);
  assertEquals(body.ok, true);

  const session = body.session as Record<string, unknown>;
  assertEquals(session.access_token, "abc");
  assertEquals(session.refresh_token, "def");
  assertEquals(session.expires_in, 7200);

  const user = body.user as Record<string, unknown>;
  assertEquals(user.id, 42);
  assertEquals(user.auth_id, "existing-auth-456");
  assertEquals(user.is_new, false);
});

Deno.test("malformed JSON body returns 500 (caught by try/catch)", async () => {
  const supabase = createMockSupabase({});
  const req = new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": uniqueIp() },
    body: "{invalid json!!!}",
  });
  const res = await handleAuthTelegram(req, supabase);
  const body = await parseJson(res);

  assertEquals(res.status, 500);
  assertEquals(body.error, "Erro interno do servidor.");
});
