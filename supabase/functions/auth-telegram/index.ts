import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.ts";

interface LinkCodePayload {
  code: string;
}

interface SuccessResponse {
  ok: true;
  session: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  user: {
    id: number;
    auth_id: string;
    is_new: boolean;
  };
}

interface ErrorResponse {
  ok: false;
  error: string;
}

type ApiResponse = SuccessResponse | ErrorResponse;

// ── CORS headers ──────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: ApiResponse, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ── Rate limiting (per-IP, in-memory) ─────────────────────
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return false;
}

// ── Main handler (exported for testing) ──────────────────

export async function handleAuthTelegram(
  req: Request,
  supabase: any,
): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, "Content-Length": "0" },
    });
  }

  // Only accept POST
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  // Rate limit by IP
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
  if (isRateLimited(ip)) {
    return jsonResponse({ ok: false, error: "Muitas tentativas. Aguarde 1 minuto." }, 429);
  }

  try {
    const { code } = await req.json() as LinkCodePayload;

    // Validate input
    if (!code || typeof code !== "string") {
      return jsonResponse({ ok: false, error: "Código é obrigatório." }, 400);
    }

    const cleanCode = code.toUpperCase().trim();
    if (cleanCode.length !== 6 || !/^[A-Z0-9]{6}$/.test(cleanCode)) {
      return jsonResponse({ ok: false, error: "Código inválido. Deve ter 6 caracteres alfanuméricos." }, 400);
    }

    // Look up the code (must be unused and not expired)
    const { data: link } = await supabase
      .from("link_codes")
      .select("id, user_id, auth_id, direction, expires_at")
      .eq("code", cleanCode)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (!link) {
      return jsonResponse({ ok: false, error: "Código inválido ou expirado. Gere um novo no Telegram." }, 401);
    }

    // Mark code as used immediately
    await supabase
      .from("link_codes")
      .update({ used: true })
      .eq("id", link.id);

    // Get the user record
    const { data: user } = await supabase
      .from("users")
      .select("id, auth_id")
      .eq("id", link.user_id)
      .single();

    if (!user) {
      return jsonResponse({ ok: false, error: "Usuário não encontrado." }, 404);
    }

    let authId = user.auth_id;
    let isNew = false;

    // If user doesn't have an auth_id yet, create one in auth.users
    if (!authId) {
      const { data: authUser, error: createError } = await supabase.auth.admin.createUser({
        email: `telegram_${user.id}@pato.app`,
        email_confirm: true,
        user_metadata: { telegram_user_id: user.id },
      });

      if (createError || !authUser?.user?.id) {
        console.error("Error creating auth user:", createError);
        return jsonResponse({ ok: false, error: "Erro ao criar conta de acesso." }, 500);
      }

      authId = authUser.user.id;
      isNew = true;

      // Save auth_id to users table
      await supabase
        .from("users")
        .update({ auth_id: authId })
        .eq("id", user.id);
    }

    // Generate a magic link / session for the user
    const { data: magicLink, error: linkError } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: `telegram_${user.id}@pato.app`,
    });

    if (linkError || !magicLink) {
      console.error("Error generating session:", linkError);
      return jsonResponse({ ok: false, error: "Erro ao gerar sessão." }, 500);
    }

    // The magic link URL contains the tokens — extract the hash fragment
    const sessionUrl = magicLink.properties?.action_link || "";
    const hashFragment = sessionUrl.split("#")[1] || "";

    // Parse the hash fragment into an object
    const params = new URLSearchParams(hashFragment);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const expiresIn = params.get("expires_in") || "3600";

    if (!accessToken || !refreshToken) {
      return jsonResponse({ ok: false, error: "Erro ao obter tokens de acesso." }, 500);
    }

    return jsonResponse({
      ok: true,
      session: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: parseInt(expiresIn, 10),
      },
      user: {
        id: user.id,
        auth_id: authId,
        is_new: isNew,
      },
    }, 200);
  } catch (error) {
    console.error("Error in auth-telegram:", error);
    return jsonResponse({ ok: false, error: "Erro interno do servidor." }, 500);
  }
}

// ── Serve wrapper (only when run directly, not during tests) ─

if (import.meta.main) {
  serve(async (req: Request): Promise<Response> => {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
    return handleAuthTelegram(req, supabase);
  });
}
