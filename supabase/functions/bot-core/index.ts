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
  PeriodPreset,
  ExtratoFilters,
} from "./types/index.ts";
import { isRateLimited, truncateCallbackData } from "./utils/rate-limiter.ts";
import { incrementSessionSeq, addSession, getSessionSeq } from "./utils/session.ts";
import { formatCurrencyBR, formatDateBR, parseDateBR } from "./utils/formatting.ts";
import { parseNaturalLanguage } from "./services/deepseek.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard } from "./services/telegram.ts";
import { getCategories, sendSimilarityWarning, normalizeString, getAllUserTags } from "./services/database.ts";
import { handleCallbackQuery, handleFilterPanel } from "./handlers/callbacks.ts";
import { handleNaturalLanguageWithFollowUp, executeNaturalLanguageAction } from "./handlers/nl-processing.ts";
import {
  getWizardState,
  setWizardState,
  clearWizardState,
  handleTransactionWizard,
} from "./handlers/wizard.ts";
import {
  handleStart,
  handleHelp,
  handleBalance,
  handleTransaction,
  handleStatement,
  handleSummary,
  handleEdit,
  handleDelete,
  handleGroup,
  handleCategory,
  handleTag,
  handleCleanup,
  handleReset,
} from "./handlers/commands.ts";


async function fetchUserContext(supabase: any, userId: number): Promise<{
  categories: { name: string; transaction_type: string | null }[];
  groups: { name: string; is_default: boolean }[];
  tags: string[];
}> {
  const [categoriesResult, groupsResult, tags] = await Promise.all([
    supabase.from("categories").select("name, transaction_type").eq("user_id", userId),
    supabase.from("groups").select("name, is_default").eq("user_id", userId),
    getAllUserTags(supabase, userId),
  ]);
  return {
    categories: categoriesResult.data || [],
    groups: groupsResult.data || [],
    tags: tags || [],
  };
}

async function handleEntityRename(
  supabase: any,
  userId: number,
  chatId: number,
  table: string,
  oldName: string,
  newName: string,
  label: string
): Promise<"success" | "noop" | "duplicate" | "error"> {
  if (!newName) {
    await sendTelegramMessage(chatId, "✏️ O nome não pode estar vazio. Digite um nome válido:");
    return "noop";
  }
  if (newName.toLowerCase() === oldName.toLowerCase()) {
    await sendTelegramMessage(chatId, "ℹ️ O nome é o mesmo de antes. Nada foi alterado.");
    return "noop";
  }
  const article = label === "categoria" ? "uma" : "um";
  const { error } = await supabase.from(table).update({ name: newName, normalized_name: normalizeString(newName) }).eq("user_id", userId).eq("normalized_name", normalizeString(oldName));
  if (error) {
    if (error.code === "23505") {
      await sendTelegramMessage(chatId, `⚠️ Já existe ${article} ${label} com o nome "${newName}". Escolha outro nome.`);
      return "duplicate";
    }
    await sendTelegramMessage(chatId, "❌ Ops! Algo deu errado ao renomear. Tente novamente.");
    return "error";
  }
  const art = label === "categoria" ? "a" : "o";
  await sendTelegramMessage(chatId, `✅ ${label.charAt(0).toUpperCase() + label.slice(1)} "${oldName}" renomead${art} para "${newName}"!`);
  return "success";
}

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
      .maybeSingle();

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
        normalized_name: normalizeString("Pessoal"),
        is_default: true,
      });

      const { data: predefined } = await supabase
        .from("predefined_categories")
        .select("name, transaction_type");

      if (predefined) {
        const categories = predefined.map((pc: any) => ({
          user_id: newUser.id,
          name: pc.name,
          normalized_name: normalizeString(pc.name),
          is_predefined: true,
          transaction_type: pc.transaction_type || null,
        }));
        await supabase.from("categories").insert(categories);
      }

      // Create fallback category for deleted categories
      await supabase.from("categories").insert({
        user_id: newUser.id,
        name: "Sem categoria",
        normalized_name: "semcategoria",
        is_predefined: true,
      });

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
      } else if (wizardState.step === "edit_description") {
        const transactionId = wizardState.data.transaction_id;
        await supabase.from("transactions").update({ description: text }).eq("id", transactionId).eq("user_id", existingUser.id);
        await clearWizardState(supabase, existingUser.id);
        await sendTelegramMessage(message.chat.id, `✅ Descrição atualizada para "${text}"!`);
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
      } else if (wizardState.step.startsWith("edit_tags_")) {
        const transactionId = wizardState.data.transaction_id;
        const currentTags: string[] = wizardState.data?.tags
          ? (Array.isArray(wizardState.data.tags) ? wizardState.data.tags : [wizardState.data.tags])
          : [];
        const newTags = text.split(" ").filter((t: string) => t.trim());
        const formattedTags = newTags.map((t: string) => t.startsWith("#") ? t : `#${t}`);
        const accumulated = [...currentTags, ...formattedTags];

        // Check for similar existing tags
        for (const tag of newTags) {
          await sendSimilarityWarning(supabase, existingUser.id, message.chat.id, "tag", tag);
        }

        await supabase.from("transactions").update({ tags: accumulated }).eq("id", transactionId).eq("user_id", existingUser.id);
        await clearWizardState(supabase, existingUser.id);
        const tagsStr = accumulated.length > 0 ? accumulated.join(" ") : "—";
        await sendTelegramMessage(message.chat.id, `✅ Tags atualizadas: ${tagsStr}`);
      } else if (wizardState.step === "rename_cat") {
        const result = await handleEntityRename(supabase, existingUser.id, message.chat.id, "categories", wizardState.data.name, text.trim(), "categoria");
        if (result !== "noop") await clearWizardState(supabase, existingUser.id);
      } else if (wizardState.step === "rename_grp") {
        const result = await handleEntityRename(supabase, existingUser.id, message.chat.id, "groups", wizardState.data.name, text.trim(), "grupo");
        if (result !== "noop") await clearWizardState(supabase, existingUser.id);
      } else if (wizardState.step === "nl_expense_amount" || wizardState.step === "nl_income_amount") {
        const amount = parseFloat(text.replace(",", "."));
        if (isNaN(amount) || amount <= 0) {
          await sendTelegramMessage(message.chat.id, "Por favor, informe um valor válido (ex: 50,00 ou 50)");
          return new Response("OK", { status: 200 });
        }

        const intent = wizardState.step === "nl_expense_amount" ? "expense" : "income";
        const category = wizardState.data.category;
        const group = wizardState.data.group;
        const description = wizardState.data.description;
        const tag = wizardState.data.tag;
        const date = wizardState.data.date;

        if (category || description) {
          const natural: DeepSeekResponse = { intent, amount, category, group, description, date, period: null, name: null, tag, limit: null, missingFields: [] };
          await clearWizardState(supabase, existingUser.id);
          await executeNaturalLanguageAction(supabase, message.from.id, message.chat.id, natural);
        } else {
          const categories = await getCategories(supabase, existingUser.id, intent);
          const seq = await getSessionSeq(supabase, existingUser.id);
          const keyboard: InlineKeyboard = categories.map((c) => [
            { text: c.name, callback_data: truncateCallbackData(`nl_cat_${c.name}`, seq) }
          ]);
          keyboard.push([{ text: "⏭️ Sem categoria", callback_data: truncateCallbackData("nl_cat_none", seq) }]);

          await setWizardState(supabase, existingUser.id, `nl_${intent}_category`, {
            intent,
            amount,
            group,
            description,
            tag,
            date,
          });
          await sendTelegramMessageWithKeyboard(message.chat.id, "Em que categoria?", keyboard);
        }
      } else if (wizardState.step === "nl_expense_category" || wizardState.step === "nl_income_category") {
        const intent = wizardState.step === "nl_expense_category" ? "expense" : "income";
        const amount = wizardState.data.amount;
        const group = wizardState.data.group;
        const description = wizardState.data.description;
        const tag = wizardState.data.tag;
        const date = wizardState.data.date;

        const natural: DeepSeekResponse = { intent, amount, category: text, group, description, date, period: null, name: null, tag, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, message.from.id, message.chat.id, natural);
      } else if (wizardState.step.startsWith("nl_") && wizardState.step.endsWith("_period")) {
        const intent = wizardState.step.replace("nl_", "").replace("_period", "") as DeepSeekResponse["intent"];
        const period = text.toLowerCase().includes("passado") ? "last_month" : "this_month";

        const natural: DeepSeekResponse = { intent, amount: null, category: wizardState.data.category, date: null, period, name: null, tag: null, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, message.from.id, message.chat.id, natural);
      } else if (wizardState.step === "nl_create_category_name" || wizardState.step === "nl_create_group_name") {
        const intent = wizardState.step === "nl_create_category_name" ? "create_category" : "create_group";
        const natural: DeepSeekResponse = { intent: intent as "create_category" | "create_group", amount: null, category: null, date: null, period: null, name: text, tag: null, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, message.from.id, message.chat.id, natural);
      } else if (wizardState.step === "nl_ask_type") {
        const lower = text.toLowerCase();
        let type: "expense" | "income" | null = null;
        if (lower.includes("despesa") || lower.includes("gasto") || lower.includes("saída") || lower.includes("gastei") || lower.includes("paguei") || lower.includes("comprei")) {
          type = "expense";
        } else if (lower.includes("receita") || lower.includes("recebi") || lower.includes("ganhei") || lower.includes("entrada") || lower.includes("salário")) {
          type = "income";
        }
        if (type) {
          const args: string[] = [];
          if (wizardState.data?.text) {
            const match = wizardState.data.text.match(/(\d+[,.]?\d*)/);
            if (match) {
              const amount = parseFloat(match[1].replace(",", "."));
              if (!isNaN(amount) && amount > 0) args.push(amount.toString());
            }
            if (wizardState.data.date) {
              args.push("--data", wizardState.data.date);
            }
          }
          await clearWizardState(supabase, existingUser.id);
          await handleTransaction(type, supabase, message.from.id, message.chat.id, args);
        } else {
          const sessionSeq = await getSessionSeq(supabase, existingUser.id);
          const keyboard = [
            [{ text: "💸 Despesa", callback_data: addSession("nl_type_expense", sessionSeq) }],
            [{ text: "💰 Receita", callback_data: addSession("nl_type_income", sessionSeq) }],
          ];
          await sendTelegramMessageWithKeyboard(message.chat.id, "Não entendi. É uma despesa ou receita?", keyboard);
        }
      } else if (wizardState.step === "nl_expense_group" || wizardState.step === "nl_income_group") {
        const type = wizardState.step === "nl_expense_group" ? "expense" : "income";
        const amount = wizardState.data.amount;
        const category = wizardState.data.category;
        const description = wizardState.data.description;
        const tag = wizardState.data.tag;
        const date = wizardState.data.date;
        if (!amount) {
          await sendTelegramMessage(message.chat.id, "❌ Erro ao processar. Tente novamente.");
          await clearWizardState(supabase, existingUser.id);
          return new Response("OK", { status: 200 });
        }
        const args = [amount.toString()];
        if (date) {
          const dateBR = parseDateBR(date) || date;
          args.push("--data", dateBR);
        }
        args.push("--grupo", text.trim());
        if (tag) args.push(tag.startsWith("#") ? tag : `#${tag}`);
        if (category) args.push(category);
        await clearWizardState(supabase, existingUser.id);
        await handleTransaction(type, supabase, message.from.id, message.chat.id, args, description || undefined);
      } else if (wizardState.step === "nl_list_by_tag_name") {
        const tag = text.replace("#", "").trim();
        const natural: DeepSeekResponse = { intent: "list_by_tag", amount: null, category: null, date: null, period: null, name: null, tag, limit: null, missingFields: [] };
        await clearWizardState(supabase, existingUser.id);
        await executeNaturalLanguageAction(supabase, message.from.id, message.chat.id, natural);
      } else if (wizardState.step === "extrato_custom_period") {
        // First text input: start date
        const parsed = parseDateBR(text);
        if (!parsed) {
          await sendTelegramMessage(message.chat.id, "Formato inválido. Use DD/MM/AAAA (ex: 15/01/2024)");
          return new Response("OK", { status: 200 });
        }
        const filters = wizardState.data as any;
        await setWizardState(supabase, existingUser.id, "extrato_custom_period_end", { ...filters, _start: parsed });
        await sendTelegramMessage(message.chat.id, "📅 Informe a data de *fim* (formato: DD/MM/AAAA):");
      } else if (wizardState.step === "extrato_custom_period_end") {
        const parsed = parseDateBR(text);
        if (!parsed) {
          await sendTelegramMessage(message.chat.id, "Formato inválido. Use DD/MM/AAAA (ex: 15/01/2024)");
          return new Response("OK", { status: 200 });
        }
        const data = wizardState.data as any;
        const filters = { ...data } as any;
        delete filters._start;
        filters.period = { start: data._start, end: parsed };
        await clearWizardState(supabase, existingUser.id);
        await handleStatement(supabase, message.from.id, message.chat.id, 0, filters.type || "all", filters);
      } else if (wizardState.step === "reset_confirm") {
        if (text.trim() !== "RESETAR") {
          await sendTelegramMessage(message.chat.id, "❌ Confirmação incorreta. Digite exatamente `RESETAR` para confirmar, ou use `/cancelar` para cancelar.");
          return new Response("OK", { status: 200 });
        }
        const data = wizardState.data as any;
        const internalUserId = data.user_id;
        await supabase.from("wizard_states").delete().eq("user_id", internalUserId);
        await supabase.from("transactions").delete().eq("user_id", internalUserId);
        await supabase.from("categories").delete().eq("user_id", internalUserId);
        await supabase.from("groups").delete().eq("user_id", internalUserId);
        await supabase.from("users").delete().eq("id", internalUserId);
        await sendTelegramMessage(message.chat.id, "✅ *Conta resetada com sucesso!* Todos os seus dados foram apagados.\n\nUse /start para começar de novo.");
      }
      return new Response("OK", { status: 200 });
    }

    if (!text.startsWith("/") && existingUser) {
      const context = await fetchUserContext(supabase, existingUser.id);
      const natural = await parseNaturalLanguage(text, { userId: existingUser.id, context });

      if (natural.intent === null) {
        if (text.match(/\d+[,\.]?\d*/)) {
          const sessionSeq = await incrementSessionSeq(supabase, existingUser.id);
          await setWizardState(supabase, existingUser.id, "nl_ask_type", { text, date: natural.date });
          const keyboard = [
            [{ text: "💸 Despesa", callback_data: addSession("nl_type_expense", sessionSeq) }],
            [{ text: "💰 Receita", callback_data: addSession("nl_type_income", sessionSeq) }],
          ];
          await sendTelegramMessageWithKeyboard(
            message.chat.id,
            "Isso é uma despesa ou uma receita?",
            keyboard
          );
        } else {
          await sendTelegramMessage(
            message.chat.id,
            `🤔 Não entendi. Você pode usar comandos como /despesa ou digitar algo como "gastei 50 no almoço".\n\nUse /ajuda para ver todos os comandos.`
          );
        }
        return new Response("OK", { status: 200 });
      }

      const sessionSeq = await incrementSessionSeq(supabase, existingUser.id);
      await handleNaturalLanguageWithFollowUp(supabase, message.from.id, message.chat.id, natural, sessionSeq);
      return new Response("OK", { status: 200 });
    }

    if (text.startsWith("/")) {
      const [command, ...args] = text.split(" ");

      // Increment session to invalidate old callbacks
      await incrementSessionSeq(supabase, existingUser.id);

      // Check for active wizard on non-wizard commands
      const activeWizard = await getWizardState(supabase, existingUser.id);
      const wizardCommands = ["/despesa", "/gasto", "/receita", "/cancelar", "/resetar"];
      if (activeWizard && !wizardCommands.includes(command.toLowerCase())) {
        await clearWizardState(supabase, existingUser.id);
        await sendTelegramMessage(
          message.chat.id,
          `⚠️ Havia uma operação em andamento que foi cancelada para executar \`${command}\`.\n\nUse \`/cancelar\` se quiser cancelar manualmente antes de outro comando.`
        );
      }

      switch (command.toLowerCase()) {
        case "/start":
          await handleStart(message.chat.id, message.from.first_name);
          break;

        case "/ajuda":
        case "/help":
          await handleHelp(message.chat.id);
          break;

        case "/saldo":
          await handleBalance(supabase, message.from.id, message.chat.id, args);
          break;

        case "/despesa":
        case "/gasto":
          await handleTransaction("expense", supabase, message.from.id, message.chat.id, args);
          break;

        case "/receita":
          await handleTransaction("income", supabase, message.from.id, message.chat.id, args);
          break;

        case "/extrato":
          if (args.length === 0) {
            await handleFilterPanel(supabase, existingUser.id, message.chat.id);
          } else {
            // Parse direct args: --periodo, --grupo, --mes
            let period: string | null = null;
            let groupName: string | null = null;
            let typeFilter: "all" | "income" | "expense" = "all";
            for (let i = 0; i < args.length; i++) {
              if (args[i] === "--periodo" || args[i] === "--mes") {
                period = args[i + 1] || null;
                i++;
              } else if (args[i] === "--grupo") {
                groupName = args[i + 1] || null;
                i++;
              } else if (args[i] === "--tipo" || args[i] === "--type") {
                const t = args[i + 1] || "";
                if (t === "income" || t === "receita") typeFilter = "income";
                else if (t === "expense" || t === "despesa") typeFilter = "expense";
                i++;
              }
            }
            const filters: ExtratoFilters = {
              category_id: null,
              group_id: null,
              tags: [],
              type: typeFilter,
              period: (period as PeriodPreset) || "this_month",
            };
            if (groupName) {
              const { data: group } = await supabase
                .from("groups")
                .select("id")
                .eq("user_id", existingUser.id)
                .ilike("name", groupName)
                .maybeSingle();
              if (group) filters.group_id = group.id;
            }
            await handleStatement(supabase, message.from.id, message.chat.id, 0, typeFilter, filters);
          }
          break;

        case "/resumo":
          await handleSummary(supabase, message.from.id, message.chat.id, args);
          break;

        case "/editar":
          await handleEdit(supabase, message.from.id, message.chat.id, args);
          break;

        case "/excluir":
          await handleDelete(supabase, message.from.id, message.chat.id, args);
          break;

        case "/grupo":
          await handleGroup(supabase, message.from.id, message.chat.id, args);
          break;

        case "/categoria":
          await handleCategory(supabase, message.from.id, message.chat.id, args);
          break;

        case "/tag":
          await handleTag(supabase, message.from.id, message.chat.id, args);
          break;

        case "/resetar":
          await handleReset(supabase, message.from.id, message.chat.id);
          break;

        case "/limpar":
          await handleCleanup(supabase, message.from.id, message.chat.id);
          break;

        case "/cancelar": {
          const hadWizard = await getWizardState(supabase, existingUser.id);
          await clearWizardState(supabase, existingUser.id);
          if (hadWizard) {
            await sendTelegramMessage(message.chat.id, "❌ Operação cancelada. Pode ficar tranquilo!");
          } else {
            await sendTelegramMessage(message.chat.id, "ℹ️ Nenhuma operação em andamento para cancelar.");
          }
          break;
        }

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
