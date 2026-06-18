import { InlineKeyboard } from "../types/index.ts";
import {
  sendTelegramMessage,
  sendTelegramMessageWithKeyboard,
  editTelegramMessageWithKeyboard,
} from "../services/telegram.ts";
import {
  requireUser,
  getRecurrences,
  getRecurrenceById,
  archiveRecurrence,
  activateRecurrence,
  updateRecurrence,
} from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, sanitizeMarkdown, getTodayISOBR } from "../utils/formatting.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";

function frequencyLabel(r: any): string {
  switch (r.frequency_type) {
    case "daily": return "Diária";
    case "weekly": return `Semanal (${["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][r.frequency_interval]})`;
    case "monthly": return `Mensal (dia ${r.frequency_interval})`;
    case "annual": {
      const months = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
      return `Anual (${r.frequency_interval} de ${months[(r.frequency_month || 1) - 1]})`;
    }
    case "every_x_days": return `A cada ${r.frequency_interval} dias`;
    default: return r.frequency_type;
  }
}

function formatRecurrenceItem(r: any): string {
  const icon = r.type === "expense" ? "💸" : "💰";
  const catName = r.categories?.name ? sanitizeMarkdown(r.categories.name) : "—";
  const grpName = r.groups?.name ? sanitizeMarkdown(r.groups.name) : "—";
  const freq = frequencyLabel(r);
  const nextDate = formatDateBR(r.next_date);
  const lastDate = r.last_processed_date ? formatDateBR(r.last_processed_date) : "Nunca";
  return `${icon} *${formatCurrencyBR(r.amount)}* — ${catName} — ${grpName}\n📅 Próxima: ${nextDate} — Última: ${lastDate}\n🔄 ${freq}`;
}

export async function handleRecurrences(
  supabase: any,
  userId: number,
  chatId: number,
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const items = await getRecurrences(supabase, user.id);

  if (items.length === 0) {
    await sendTelegramMessageWithKeyboard(
      chatId,
      "🔄 *Nenhuma recorrência encontrada.*\n\nCrie uma para começar a automatizar suas transações.",
      [[{ text: "➕ Nova Recorrência", callback_data: "rec_new" }]]
    );
    return;
  }

  let message = "🔄 *Suas recorrências:*\n\n";
  for (const r of items) {
    message += formatRecurrenceItem(r) + "\n\n";
  }
  message += "💡 *Clique em uma recorrência para ver detalhes e ações.*";

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];

  const rows = [];
  for (const r of items) {
    const label = `${r.type === "expense" ? "💸" : "💰"} ${formatCurrencyBR(r.amount)} — ${r.categories?.name || "—"}`;
    rows.push([{
      text: label,
      callback_data: addSession(`rec_show_${r.id}`, sessionSeq),
    }]);
  }

  keyboard.push(
    ...rows,
    [
      { text: "➕ Nova", callback_data: addSession("rec_new", sessionSeq) },
      { text: "✏️ Gerenciar", callback_data: addSession("rec_manage", sessionSeq) },
    ]
  );

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}

export async function handleRecurrenceDetail(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number,
  messageId?: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const message = formatRecurrenceItem(r);

  const keyboard: InlineKeyboard = [
    [
      { text: "✏️ Editar", callback_data: addSession(`rec_edit_${r.id}`, sessionSeq) },
      { text: "⏩ Adiantar", callback_data: addSession(`rec_advance_${r.id}`, sessionSeq) },
    ],
    [
      { text: "⏭️ Pular", callback_data: addSession(`rec_skip_${r.id}`, sessionSeq) },
    ],
  ];

  if (r.is_archived) {
    keyboard.push([
      { text: "✅ Reativar", callback_data: addSession(`rec_activate_${r.id}`, sessionSeq) },
    ]);
  } else {
    keyboard.push([
      { text: "📦 Arquivar", callback_data: addSession(`rec_archive_${r.id}`, sessionSeq) },
    ]);
  }

  keyboard.push([
    { text: "⬅ Voltar", callback_data: addSession("rec_back", sessionSeq) },
  ]);

  if (messageId) {
    await editTelegramMessageWithKeyboard(chatId, messageId, message, keyboard);
  } else {
    await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
  }
}

export async function handleAdvanceRecurrence(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  const sessionSeq = await getSessionSeq(supabase, user.id);

  await sendTelegramMessageWithKeyboard(
    chatId,
    `⏩ *Adiantar recorrência?*\n\n` +
    `💰 Valor: *${formatCurrencyBR(r.amount)}*\n` +
    `📅 Data original: *${formatDateBR(r.next_date)}*\n\n` +
    `Uma transação será criada com a data *${formatDateBR(r.next_date)}* e a próxima ocorrência será avançada.`,
    [
      [
        { text: "✅ Sim, adiantar", callback_data: addSession(`rec_advance_yes_${r.id}`, sessionSeq) },
        { text: "❌ Não", callback_data: addSession(`rec_show_${r.id}`, sessionSeq) },
      ],
    ]
  );
}

export async function handleAdvanceRecurrenceConfirm(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  let categoryId = r.category_id;
  let groupId = r.group_id;
  const warnings: string[] = [];

  if (categoryId) {
    const { data: cat } = await supabase.from("categories").select("id").eq("id", categoryId).maybeSingle();
    if (!cat) {
      warnings.push("categoria não encontrada");
      categoryId = null;
    }
  }
  if (groupId) {
    const { data: grp } = await supabase.from("groups").select("id").eq("id", groupId).maybeSingle();
    if (!grp) {
      warnings.push("grupo não encontrado");
      groupId = null;
    }
  }

  const { error } = await supabase.from("transactions").insert({
    user_id: r.user_id,
    type: r.type,
    amount: r.amount,
    description: r.description || "",
    category_id: categoryId,
    group_id: groupId,
    tags: r.tags || [],
    recurrence_id: r.id,
    transaction_date: r.next_date,
  });

  if (error) {
    await sendTelegramMessage(chatId, "❌ Erro ao criar transação. Tente novamente.");
    return;
  }

  const { data: nextDate } = await supabase.rpc("calculate_next_date", {
    p_current_date: r.next_date,
    p_frequency_type: r.frequency_type,
    p_interval: r.frequency_interval || 1,
    p_month: r.frequency_month || null,
  });

  await updateRecurrence(supabase, user.id, r.id, {
    next_date: nextDate || r.next_date,
    last_processed_date: r.next_date,
  });

  let msg = `✅ *Transação adiantada!*\n\n💰 *${formatCurrencyBR(r.amount)}* criada em *${formatDateBR(r.next_date)}*\n📅 Próxima ocorrência: *${formatDateBR(nextDate || r.next_date)}*`;
  if (warnings.length > 0) {
    msg += `\n\n⚠️ Aviso: ${warnings.join("; ")}`;
  }
  await sendTelegramMessage(chatId, msg);
}

export async function handleSkipRecurrence(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  const { data: nextDate } = await supabase.rpc("calculate_next_date", {
    p_current_date: r.next_date,
    p_frequency_type: r.frequency_type,
    p_interval: r.frequency_interval || 1,
    p_month: r.frequency_month || null,
  });

  const sessionSeq = await getSessionSeq(supabase, user.id);
  await sendTelegramMessageWithKeyboard(
    chatId,
    `⏭️ *Pular ocorrência?*\n\n` +
    `A data passará de *${formatDateBR(r.next_date)}* para *${formatDateBR(nextDate || r.next_date)}* sem criar transação.`,
    [
      [
        { text: "✅ Sim, pular", callback_data: addSession(`rec_skip_yes_${r.id}`, sessionSeq) },
        { text: "❌ Não", callback_data: addSession(`rec_show_${r.id}`, sessionSeq) },
      ],
    ]
  );
}

export async function handleSkipRecurrenceConfirm(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  const { data: nextDate } = await supabase.rpc("calculate_next_date", {
    p_current_date: r.next_date,
    p_frequency_type: r.frequency_type,
    p_interval: r.frequency_interval || 1,
    p_month: r.frequency_month || null,
  });

  await updateRecurrence(supabase, user.id, r.id, {
    next_date: nextDate || r.next_date,
  });

  await sendTelegramMessage(chatId, `✅ Ocorrência pulada. Próxima data: *${formatDateBR(nextDate || r.next_date)}*`);
}

export async function handleArchiveRecurrence(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  const sessionSeq = await getSessionSeq(supabase, user.id);
  await sendTelegramMessageWithKeyboard(
    chatId,
    `📦 *Arquivar recorrência?*\n\n` +
    `Esta recorrência de *${formatCurrencyBR(r.amount)}* (${r.description || r.categories?.name || "—"}) será arquivada e não será mais processada automaticamente.\n\n` +
    `Você pode reativá-la depois em ✏️ Gerenciar.`,
    [
      [
        { text: "✅ Sim, arquivar", callback_data: addSession(`rec_archive_yes_${r.id}`, sessionSeq) },
        { text: "❌ Não", callback_data: addSession(`rec_show_${r.id}`, sessionSeq) },
      ],
    ]
  );
}

export async function handleArchiveRecurrenceConfirm(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const { error } = await archiveRecurrence(supabase, user.id, recurrenceId);
  if (error) {
    await sendTelegramMessage(chatId, "❌ Erro ao arquivar. Tente novamente.");
    return;
  }

  await sendTelegramMessage(chatId, "✅ Recorrência arquivada com sucesso! Use ✏️ Gerenciar para reativar quando quiser.");
}

export async function handleActivateRecurrence(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  const sessionSeq = await getSessionSeq(supabase, user.id);
  await sendTelegramMessageWithKeyboard(
    chatId,
    `✅ *Reativar recorrência?*\n\n` +
    `Esta recorrência de *${formatCurrencyBR(r.amount)}* voltará a ser processada automaticamente.\n` +
    `Próxima data atual: *${formatDateBR(r.next_date)}*\n\n` +
    (r.next_date < getTodayISOBR()
      ? `⚠️ A data já passou. A próxima ocorrência será ajustada para *${formatDateBR(getTodayISOBR())}*.`
      : ""),
    [
      [
        { text: "✅ Sim, reativar", callback_data: addSession(`rec_activate_yes_${r.id}`, sessionSeq) },
        { text: "❌ Não", callback_data: addSession(`rec_show_${r.id}`, sessionSeq) },
      ],
    ]
  );
}

export async function handleActivateRecurrenceConfirm(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  let newNextDate: string | undefined;
  if (r.next_date < getTodayISOBR()) {
    newNextDate = getTodayISOBR();
  }

  const { error } = await activateRecurrence(supabase, user.id, recurrenceId, newNextDate);
  if (error) {
    await sendTelegramMessage(chatId, "❌ Erro ao reativar. Tente novamente.");
    return;
  }

  await sendTelegramMessage(
    chatId,
    `✅ Recorrência reativada! ${newNextDate ? `Próxima ocorrência ajustada para *${formatDateBR(newNextDate)}*.` : ""}`
  );
}

export async function handleEditRecurrence(
  supabase: any,
  userId: number,
  chatId: number,
  recurrenceId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const r = await getRecurrenceById(supabase, user.id, recurrenceId);
  if (!r) {
    await sendTelegramMessage(chatId, "❌ Recorrência não encontrada.");
    return;
  }

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [
    [
      { text: "💰 Valor", callback_data: addSession(`rec_edit_field_amount_${r.id}`, sessionSeq) },
      { text: "📝 Descrição", callback_data: addSession(`rec_edit_field_description_${r.id}`, sessionSeq) },
    ],
    [
      { text: "🏷️ Categoria", callback_data: addSession(`rec_edit_field_category_${r.id}`, sessionSeq) },
      { text: "👥 Grupo", callback_data: addSession(`rec_edit_field_group_${r.id}`, sessionSeq) },
    ],
    [
      { text: "🔄 Frequência", callback_data: addSession(`rec_edit_field_frequency_${r.id}`, sessionSeq) },
      { text: "🔖 Tags", callback_data: addSession(`rec_edit_field_tags_${r.id}`, sessionSeq) },
    ],
    [
      { text: "📅 Data início", callback_data: addSession(`rec_edit_field_start_date_${r.id}`, sessionSeq) },
    ],
    [
      { text: "⬅ Voltar", callback_data: addSession(`rec_show_${r.id}`, sessionSeq) },
    ],
  ];

  await sendTelegramMessageWithKeyboard(
    chatId,
    `✏️ *Editando recorrência:*\n\n${formatRecurrenceItem(r)}`,
    keyboard
  );
}

export async function handleManageRecurrences(
  supabase: any,
  userId: number,
  chatId: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  const items = await getRecurrences(supabase, user.id, true);

  if (items.length === 0) {
    await sendTelegramMessage(chatId, "🔄 *Nenhuma recorrência encontrada.*");
    return;
  }

  let message = "✏️ *Gerenciar recorrências:*\n\n";
  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];

  for (const r of items) {
    const icon = r.type === "expense" ? "💸" : "💰";
    const archived = r.is_archived ? " 📦" : "";
    const catName = r.categories?.name || "—";
    message += `${icon} *${formatCurrencyBR(r.amount)}* — ${catName}${archived ? " 📦 (arquivada)" : ""}\n📅 ${formatDateBR(r.next_date)} — 🔄 ${frequencyLabel(r)}\n\n`;

    keyboard.push([
      { text: `✏️ ${icon} ${formatCurrencyBR(r.amount)} — ${catName}${archived}`, callback_data: addSession(`rec_edit_${r.id}`, sessionSeq) },
    ]);
  }

  message += "\n💡 *Clique para editar uma recorrência.*";

  keyboard.push([
    { text: "⬅ Voltar", callback_data: addSession("rec_back", sessionSeq) },
  ]);

  await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
}
