import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

interface TelegramMessage {
  message_id: number;
  from: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  };
  chat: {
    id: number;
    type: string;
  };
  date: number;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
    }),
  });
}

serve(async (req: Request): Promise<Response> => {
  // Validate request method
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Validate secret token
  const secretToken = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secretToken !== TELEGRAM_SECRET_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const update: TelegramUpdate = await req.json();

    if (!update.message) {
      return new Response("OK", { status: 200 });
    }

    const message = update.message;
    const text = message.text || "";

    // Create Supabase client
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // Ensure user exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("telegram_id", message.from.id)
      .single();

    if (!existingUser) {
      // Create user
      const { data: newUser } = await supabase
        .from("users")
        .insert({
          telegram_id: message.from.id,
          username: message.from.username,
          first_name: message.from.first_name,
        })
        .select("id")
        .single();

      // Create default group "Pessoal"
      await supabase.from("groups").insert({
        user_id: newUser!.id,
        name: "Pessoal",
        is_default: true,
      });

      await sendTelegramMessage(
        message.chat.id,
        `Olá ${message.from.first_name}! 👋\n\nBem-vindo ao Bot de Controle Financeiro!\n\nUse /ajuda para ver os comandos disponíveis.`
      );
      return new Response("OK", { status: 200 });
    }

    // Handle commands
    if (text.startsWith("/")) {
      const [command, ...args] = text.split(" ");

      switch (command.toLowerCase()) {
        case "/start":
          await sendTelegramMessage(
            message.chat.id,
            `Olá ${message.from.first_name}! 👋\n\nBem-vindo ao Bot de Controle Financeiro!\n\nUse /ajuda para ver os comandos disponíveis.`
          );
          break;

        case "/ajuda":
          await sendTelegramMessage(
            message.chat.id,
            `📚 *Comandos Disponíveis:*\n\n` +
            `/gasto - Adicionar despesa\n` +
            `/receita - Adicionar receita\n` +
            `/saldo - Ver saldo do mês\n` +
            `/extrato - Ver extrato do mês\n` +
            `/grupo - Gerenciar grupos\n` +
            `/categoria - Gerenciar categorias\n` +
            `/ajuda - Esta mensagem`
          );
          break;

        default:
          await sendTelegramMessage(
            message.chat.id,
            `Comando não reconhecido. Use /ajuda para ver os comandos disponíveis.`
          );
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Error processing update:", error);
    return new Response("OK", { status: 200 }); // Always return 200 to Telegram
  }
});
