import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN");
// For local development, use the internal Supabase URL
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "http://kong:8000";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "your_service_role_key_here";

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

async function handleSaldo(
  supabase: any,
  userId: number,
  chatId: number
): Promise<void> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split("T")[0];
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .split("T")[0];

  // Get user's internal ID
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("telegram_id", userId)
    .single();

  if (!user) {
    await sendTelegramMessage(chatId, "Usuário não encontrado.");
    return;
  }

  // Get total income
  const { data: income } = await supabase
    .from("transactions")
    .select("amount")
    .eq("user_id", user.id)
    .eq("type", "income")
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);

  // Get total expenses
  const { data: expenses } = await supabase
    .from("transactions")
    .select("amount")
    .eq("user_id", user.id)
    .eq("type", "expense")
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth);

  const totalIncome = income?.reduce((sum, t) => sum + Number(t.amount), 0) || 0;
  const totalExpenses = expenses?.reduce((sum, t) => sum + Number(t.amount), 0) || 0;
  const balance = totalIncome - totalExpenses;

  const monthName = now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  await sendTelegramMessage(
    chatId,
    `💰 *Saldo - ${monthName}*\n\n` +
    `Entradas: R$ ${totalIncome.toFixed(2)}\n` +
    `Saídas: R$ ${totalExpenses.toFixed(2)}\n` +
    `*Saldo: R$ ${balance.toFixed(2)}*`
  );
}

interface ParsedCommand {
  amount: number | null;
  category: string | null;
  group: string | null;
  date: string | null;
  tags: string[];
}

function parseCommand(args: string[]): ParsedCommand {
  const result: ParsedCommand = {
    amount: null,
    category: null,
    group: null,
    date: null,
    tags: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--grupo" && i + 1 < args.length) {
      result.group = args[++i];
    } else if (arg === "--data" && i + 1 < args.length) {
      result.date = args[++i];
    } else if (arg === "--tags" && i + 1 < args.length) {
      // Collect all remaining tags
      while (i + 1 < args.length && args[i + 1].startsWith("#")) {
        result.tags.push(args[++i]);
      }
    } else if (arg.startsWith("#")) {
      result.tags.push(arg);
    } else if (!result.amount && !isNaN(parseFloat(arg))) {
      result.amount = parseFloat(arg);
    } else if (!result.category) {
      result.category = arg;
    }
  }

  return result;
}

async function handleGasto(
  supabase: any,
  userId: number,
  chatId: number,
  args: string[]
): Promise<void> {
  if (args.length === 0) {
    // Start wizard
    await sendTelegramMessage(chatId, "Quanto você gastou?");
    // TODO: Implement wizard state management
    return;
  }

  const parsed = parseCommand(args);

  if (!parsed.amount) {
    await sendTelegramMessage(chatId, "Por favor, informe o valor. Ex: /gasto 50 alimentação");
    return;
  }

  // Get user's internal ID
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("telegram_id", userId)
    .single();

  if (!user) {
    await sendTelegramMessage(chatId, "Usuário não encontrado.");
    return;
  }

  // Get or create category
  let categoryId = null;
  if (parsed.category) {
    const { data: existingCategory } = await supabase
      .from("categories")
      .select("id")
      .eq("user_id", user.id)
      .ilike("name", parsed.category)
      .single();

    if (existingCategory) {
      categoryId = existingCategory.id;
    } else {
      const { data: newCategory } = await supabase
        .from("categories")
        .insert({ user_id: user.id, name: parsed.category })
        .select("id")
        .single();
      categoryId = newCategory?.id;
    }
  }

  // Get group
  let groupId = null;
  if (parsed.group) {
    const { data: group } = await supabase
      .from("groups")
      .select("id")
      .eq("user_id", user.id)
      .ilike("name", parsed.group)
      .single();
    groupId = group?.id;
  } else {
    // Use default group
    const { data: defaultGroup } = await supabase
      .from("groups")
      .select("id")
      .eq("user_id", user.id)
      .eq("is_default", true)
      .single();
    groupId = defaultGroup?.id;
  }

  // Create transaction
  const { error } = await supabase.from("transactions").insert({
    user_id: user.id,
    group_id: groupId,
    category_id: categoryId,
    type: "expense",
    amount: parsed.amount,
    description: parsed.category,
    tags: parsed.tags,
    transaction_date: parsed.date || new Date().toISOString().split("T")[0],
  });

  if (error) {
    await sendTelegramMessage(chatId, "Erro ao registrar gasto. Tente novamente.");
    return;
  }

  await sendTelegramMessage(
    chatId,
    `✅ *Despesa registrada!*\n\n` +
    `Valor: R$ ${parsed.amount.toFixed(2)}\n` +
    `Categoria: ${parsed.category || "Não definida"}\n` +
    `Grupo: ${parsed.group || "Pessoal"}\n` +
    `Data: ${parsed.date || new Date().toISOString().split("T")[0]}`
  );
}

async function handleExtrato(
  supabase: any,
  userId: number,
  chatId: number
): Promise<void> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .split("T")[0];
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .split("T")[0];

  // Get user's internal ID
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("telegram_id", userId)
    .single();

  if (!user) {
    await sendTelegramMessage(chatId, "Usuário não encontrado.");
    return;
  }

  // Get transactions with category and group names
  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      id,
      type,
      amount,
      description,
      tags,
      transaction_date,
      categories (name),
      groups (name)
    `)
    .eq("user_id", user.id)
    .gte("transaction_date", startOfMonth)
    .lte("transaction_date", endOfMonth)
    .order("transaction_date", { ascending: false });

  if (!transactions || transactions.length === 0) {
    await sendTelegramMessage(chatId, "Nenhuma transação encontrada neste mês.");
    return;
  }

  const monthName = now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  let message = `📋 *Extrato - ${monthName}*\n\n`;

  for (const t of transactions) {
    const emoji = t.type === "income" ? "📈" : "📉";
    const category = t.categories?.name || "Sem categoria";
    const group = t.groups?.name || "Sem grupo";
    const tags = t.tags?.length ? ` ${t.tags.join(" ")}` : "";

    message += `${emoji} ${t.transaction_date} - R$ ${Number(t.amount).toFixed(2)}\n`;
    message += `   ${category} | ${group}${tags}\n`;
  }

  await sendTelegramMessage(chatId, message);
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
      const { data: newUser, error: userError } = await supabase
        .from("users")
        .insert({
          telegram_id: message.from.id,
          username: message.from.username,
          first_name: message.from.first_name,
        })
        .select("id")
        .single();

      if (userError || !newUser) {
        console.error("Error creating user:", userError);
        await sendTelegramMessage(
          message.chat.id,
          "Erro ao criar usuário. Tente novamente."
        );
        return new Response("OK", { status: 200 });
      }

      // Create default group "Pessoal"
      await supabase.from("groups").insert({
        user_id: newUser.id,
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

        case "/saldo":
          await handleSaldo(supabase, message.from.id, message.chat.id);
          break;

        case "/gasto":
          await handleGasto(supabase, message.from.id, message.chat.id, args);
          break;

        case "/extrato":
          await handleExtrato(supabase, message.from.id, message.chat.id);
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
