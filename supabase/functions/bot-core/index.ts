import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  TELEGRAM_SECRET_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} from "./config.ts";
import type {
  DeepSeekResponse,
  TelegramUpdate,
  InlineKeyboard,
} from "./types/index.ts";
import { isRateLimited } from "./utils/rate-limiter.ts";
import { formatCurrencyBR, formatDateBR, parseDateBR } from "./utils/formatting.ts";
import { parseNaturalLanguage } from "./services/deepseek.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "./services/telegram.ts";
import { getCategories } from "./services/database.ts";
import { handleCallbackQuery } from "./handlers/callbacks.ts";
import { handleNaturalLanguageWithFollowUp, executeNaturalLanguageAction } from "./handlers/nl-processing.ts";
import {
  getWizardState,
  setWizardState,
  clearWizardState,
  handleTransactionWizard,
} from "./handlers/wizard.ts";
import {
  handleStart,
  handleAjuda,
  handleSaldo,
  handleTransaction,
  handleExtrato,
  handleResumo,
  handleEditar,
  handleExcluir,
  handleGrupo,
  handleCategoria,
} from "./handlers/commands.ts";

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const secretToken = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secretToken !== TELEGRAM_SECRET_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const update: TelegramUpdate = await req.json();

    if (update.callback_query) {
      const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
      await handleCallbackQuery(supabase, update.callback_query);
      return new Response("ok");
    }

    if (!update.message) {
      return new Response("OK", { status: 200 });
    }

    const message = update.message;
    const text = message.text || "";

    if (isRateLimited(message.from.id)) {
      await sendTelegramMessage(message.chat.id, "⏳ Aguarde um momento antes de enviar outra mensagem.");
      return new Response("OK", { status: 200 });
    }

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("telegram_id", message.from.id)
      .single();

    if (!existingUser) {
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
        await sendTelegramMessage(message.chat.id, "❌ Ops! Algo deu errado ao criar sua conta. Tente novamente.");
        return new Response("OK", { status: 200 });
      }

      await supabase.from("groups").insert({
        user_id: newUser.id,
        name: "Pessoal",
        is_default: true,
      });

      const { data: predefined } = await supabase
        .from("predefined_categories")
        .select("name");

      if (predefined) {
        const categories = predefined.map((pc: any) => ({
          user_id: newUser.id,
          name: pc.name,
          is_predefined: true,
        }));
        await supabase.from("categories").insert(categories);
      }

      await handleStart(message.chat.id, message.from.first_name);
      return new Response("OK", { status: 200 });
    }

    const wizardState = await getWizardState(supabase, existingUser.id);
    if (wizardState && !text.startsWith("/")) {
      if (wizardState.step.startsWith("gasto_")) {
        await handleTransactionWizard("expense", supabase, existingUser.id, message.chat.id, wizardState, text);
      } else if (wizardState.step.startsWith("receita_")) {
        await handleTransactionWizard("income", supabase, existingUser.id, message.chat.id, wizardState, text);
      } else if (wizardState.step === "edit_amount") {
        const amount = parseFloat(text.replace(",", "."));
        if (isNaN(amount) || amount <= 0) {
          await sendTelegramMessage(message.chat.id, "Por favor, informe um valor válido (ex: 50,00 ou 50)");
          return new Response("OK", { status: 200 });
        }
        const transactionId = wizardState.data.transaction_id;
        await supabase.from("transactions").update({ amount }).eq("id", transactionId).eq("user_id", existingUser.id);
        await clearWizardState(supabase, existingUser.id);
        await sendTelegramMessage(message.chat.id, `✅ Valor atualizado para ${formatCurrencyBR(amount)}!`);
      } else if (wizardState.step === "edit_date") {
        const parsed = parseDateBR(text);
        if (!parsed) {
          await sendTelegramMessage(message.chat.id, "Formato inválido. Use DD/MM/YYYY (ex: 15/01/2024)");
          return new Response("OK", { status: 200 });
        }
        const transactionId = wizardState.data.transaction_id;
        await supabase.from("transactions").update({ transaction_date: parsed }).eq("id", transactionId).eq("user_id", existingUser.id);
        await clearWizardState(supabase, existingUser.id);
        await sendTelegramMessage(message.chat.id, `✅ Data atualizada para ${formatDateBR(parsed)}!`);
      } else if (wizardState.step === "nl_expense_amount" || wizardState.step === "nl_income_amount") {
        const amount = parseFloat(text.replace(",", "."));
        if (isNaN(amount) || amount <= 0) {
          await sendTelegramMessage(message.chat.id, "Por favor, informe um valor válido (ex: 50,00 ou 50)");
          return new Response("OK", { status: 200 });
        }

        const intent = wizardState.step === "nl_expense_amount" ? "expense" : "income";
        const category = wizardState.data.category;
        const date = wizardState.data.date;

        if (category) {
          const natural: DeepSeekResponse = { intent, amount, category, date, period: null, name: null, tag: null, limit: null, missingFields: [] };
          await clearWizardState(supabase, existingUser.id);
          await executeNaturalLanguageAction(supabase, existingUser.id, message.chat.id, natural);
        } else {
          const categories = await getCategories(supabase, existingUser.id);
          const keyboard: InlineKeyboard = categories.map((c) => [
            { text: c.name, callback_data: `nl_cat_${c.name}` }
          ]);
          keyboard.push([{ text: "⏭️ Sem categoria", callback_data: "nl_cat_none" }]);

          await setWizardState(supabase, existingUser.id, `nl_${intent}_category`, {
            intent,
            amount,
            date,
          });
          await sendTelegramMessageWithKeyboard(message.chat.id, "Em que categoria?", keyboard);
        }
      } else if (wizardState.step === "nl_expense_category" || wizardState.step === "nl_income_category") {
        const intent = wizardState.step === "nl_expense_category" ? "expense" : "income";
        const amount = wizardState.data.amount;
        const date = wizardState.data.date;

        const natural: DeepSeekResponse = { intent, amount, category: text, date, period: null, name: null, tag: null, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, existingUser.id, message.chat.id, natural);
      } else if (wizardState.step.startsWith("nl_") && wizardState.step.endsWith("_period")) {
        const intent = wizardState.step.replace("nl_", "").replace("_period", "") as DeepSeekResponse["intent"];
        const period = text.toLowerCase().includes("passado") ? "last_month" : "this_month";

        const natural: DeepSeekResponse = { intent, amount: null, category: wizardState.data.category, date: null, period, name: null, tag: null, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, existingUser.id, message.chat.id, natural);
      } else if (wizardState.step === "nl_create_category_name") {
        const natural: DeepSeekResponse = { intent: "create_category", amount: null, category: null, date: null, period: null, name: text, tag: null, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, existingUser.id, message.chat.id, natural);
      } else if (wizardState.step === "nl_create_group_name") {
        const natural: DeepSeekResponse = { intent: "create_group", amount: null, category: null, date: null, period: null, name: text, tag: null, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, existingUser.id, message.chat.id, natural);
      } else if (wizardState.step === "nl_list_by_tag_name") {
        const tag = text.replace("#", "").trim();
        const natural: DeepSeekResponse = { intent: "list_by_tag", amount: null, category: null, date: null, period: null, name: null, tag, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, existingUser.id, message.chat.id, natural);
      }
      return new Response("OK", { status: 200 });
    }

    if (!text.startsWith("/") && existingUser) {
      const natural = await parseNaturalLanguage(text);

      if (natural.intent === null) {
        await sendTelegramMessage(
          message.chat.id,
          `🤔 Não entendi. Você pode usar comandos como /gasto ou digitar algo como "gastei 50 no almoço".\n\nUse /ajuda para ver todos os comandos.`
        );
        return new Response("OK", { status: 200 });
      }

      await handleNaturalLanguageWithFollowUp(supabase, existingUser.id, message.chat.id, natural);
      return new Response("OK", { status: 200 });
    }

    if (text.startsWith("/")) {
      const [command, ...args] = text.split(" ");

      switch (command.toLowerCase()) {
        case "/start":
          await handleStart(message.chat.id, message.from.first_name);
          break;

        case "/ajuda":
          await handleAjuda(message.chat.id);
          break;

        case "/saldo":
          await handleSaldo(supabase, message.from.id, message.chat.id);
          break;

        case "/gasto":
          await handleTransaction("expense", supabase, message.from.id, message.chat.id, args);
          break;

        case "/receita":
          await handleTransaction("income", supabase, message.from.id, message.chat.id, args);
          break;

        case "/extrato":
          await handleExtrato(supabase, message.from.id, message.chat.id);
          break;

        case "/resumo":
          await handleResumo(supabase, message.from.id, message.chat.id);
          break;

        case "/editar":
          await handleEditar(supabase, message.from.id, message.chat.id);
          break;

        case "/excluir":
          await handleExcluir(supabase, message.from.id, message.chat.id, args);
          break;

        case "/grupo":
          await handleGrupo(supabase, message.from.id, message.chat.id, args);
          break;

        case "/categoria":
          await handleCategoria(supabase, message.from.id, message.chat.id, args);
          break;

        case "/cancelar":
          await clearWizardState(supabase, existingUser.id);
          await sendTelegramMessage(message.chat.id, "❌ Operação cancelada. Pode ficar tranquilo!");
          break;

        default:
          await sendTelegramMessage(
            message.chat.id,
            `🤔 Comando não reconhecido. Use /ajuda para ver todos os comandos disponíveis.`
          );
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Error processing update:", error);
    return new Response("OK", { status: 200 });
  }
});
