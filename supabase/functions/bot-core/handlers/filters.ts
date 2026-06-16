import { InlineKeyboard, ExtratoFilters, PeriodPreset } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { getOrCreateUser, getAllUserTags } from "../services/database.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { setWizardState, getWizardState, clearWizardState } from "./wizard.ts";
import { handleStatement } from "./commands.ts";

export const DEFAULT_FILTERS: ExtratoFilters = {
  category_id: null,
  group_id: null,
  tags: [],
  type: "all",
  period: "this_month",
  status: "all",
};

async function renderFilterPanelMessage(
  supabase: any,
  _userId: number,
  chatId: number,
  filters: ExtratoFilters,
  sessionSeq: number,
  messageId?: number
): Promise<void> {
  let catName = "Nenhuma";
  if (filters.category_id) {
    const { data: cat } = await supabase.from("categories").select("name").eq("id", filters.category_id).single();
    if (cat) catName = cat.name;
  }
  let grpName = "Nenhum";
  if (filters.group_id) {
    const { data: grp } = await supabase.from("groups").select("name").eq("id", filters.group_id).single();
    if (grp) grpName = grp.name;
  }
  const tagStr = filters.tags.length > 0
    ? filters.tags.map((t: string) => t.startsWith("#") ? t : `#${t}`).join(" ")
    : "Nenhuma";
  const typeLabels: Record<string, string> = { all: "Todas", income: "📈 Receitas", expense: "📉 Despesas" };
  const periodLabels: Record<string, string> = {
    this_month: "Este mês",
    last_month: "Mês passado",
    last_3_months: "Últimos 3 meses",
    this_year: "Este ano",
  };
  const periodStr = typeof filters.period === "string"
    ? periodLabels[filters.period] || filters.period
    : `${filters.period.start} — ${filters.period.end}`;

  const statusLabels: Record<string, string> = {
    all: "Todas",
    past: "Realizadas",
    future: "⏳ Agendadas",
  };

  const message =
    `📋 *Filtrar Extrato*\n\n` +
    `🏷️ Categoria: ${catName}\n` +
    `📁 Grupo: ${grpName}\n` +
    `🔖 Tags: ${tagStr}\n` +
    `📈 Tipo: ${typeLabels[filters.type]}\n` +
    `📅 Período: ${periodStr}\n` +
    `📆 Status: ${statusLabels[filters.status]}\n\n` +
    `🔍 [Aplicar Filtros]  ❌ [Limpar]`;

  const keyboard: InlineKeyboard = [
    [{ text: `🏷️ Categoria: ${catName}`, callback_data: addSession("stmt_f_cat", sessionSeq) }],
    [{ text: `📁 Grupo: ${grpName}`, callback_data: addSession("stmt_f_grp", sessionSeq) }],
    [{ text: `🔖 Tags: ${tagStr}`, callback_data: addSession("stmt_f_tag", sessionSeq) }],
    [{ text: `📈 Tipo: ${typeLabels[filters.type]}`, callback_data: addSession("stmt_f_type", sessionSeq) }],
    [{ text: `📅 Período: ${periodStr}`, callback_data: addSession("stmt_f_period", sessionSeq) }],
    [{ text: `📆 Status: ${statusLabels[filters.status]}`, callback_data: addSession("stmt_f_status", sessionSeq) }],
    [
      { text: "🔍 Aplicar", callback_data: addSession("stmt_f_apply", sessionSeq) },
      { text: "❌ Limpar", callback_data: addSession("stmt_f_clear", sessionSeq) },
    ],
  ];

  if (messageId) {
    await editTelegramMessageWithKeyboard(chatId, messageId, message, keyboard);
  } else {
    await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
  }
}

export async function handleFilterPanel(
  supabase: any,
  userId: number,
  chatId: number,
  existingFilters?: ExtratoFilters
): Promise<void> {
  const filters = existingFilters || { ...DEFAULT_FILTERS };
  await setWizardState(supabase, userId, "extrato_filters", filters as any);
  const sessionSeq = await getSessionSeq(supabase, userId);
  await renderFilterPanelMessage(supabase, userId, chatId, filters, sessionSeq);
}

export async function showCategorySelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", userId).single();
  const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };

  const { data: categories } = await supabase
    .from("categories")
    .select("id, name, normalized_name")
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order("user_id", { ascending: false, nullsFirst: false })
    .order("name");

  // Deduplicate: user's own overrides system
  const seen = new Set<string>();
  const unique = (categories || []).filter((c: any) => {
    if (seen.has(c.normalized_name)) return false;
    seen.add(c.normalized_name);
    return true;
  });

  const keyboard: InlineKeyboard = [];
  if (unique.length > 0) {
    let row: { text: string; callback_data: string }[] = [];
    for (const c of unique) {
      const isSelected = filters.category_id === c.id;
      row.push({ text: isSelected ? `✅ ${c.name}` : c.name, callback_data: addSession(`stmt_f_cat_${c.id}`, sessionSeq) });
      if (row.length === 3) {
        keyboard.push(row);
        row = [];
      }
    }
    if (row.length > 0) keyboard.push(row);
  }
  keyboard.push([{ text: "❌ Limpar", callback_data: addSession("stmt_f_cat_0", sessionSeq) }]);
  keyboard.push([{ text: "◀️ Voltar", callback_data: addSession("stmt_filter", sessionSeq) }]);

  await editTelegramMessageWithKeyboard(chatId, messageId, "🏷️ *Selecione a categoria:*", keyboard);
}

export async function showGroupSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", userId).single();
  const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };

  const { data: groups } = await supabase
    .from("groups")
    .select("id, name")
    .eq("user_id", userId)
    .order("name");

  const keyboard: InlineKeyboard = [];
  if (groups) {
    let row: { text: string; callback_data: string }[] = [];
    for (const g of groups) {
      const isSelected = filters.group_id === g.id;
      row.push({ text: isSelected ? `✅ ${g.name}` : g.name, callback_data: addSession(`stmt_f_grp_${g.id}`, sessionSeq) });
      if (row.length === 3) {
        keyboard.push(row);
        row = [];
      }
    }
    if (row.length > 0) keyboard.push(row);
  }
  keyboard.push([{ text: "❌ Limpar", callback_data: addSession("stmt_f_grp_0", sessionSeq) }]);
  keyboard.push([{ text: "◀️ Voltar", callback_data: addSession("stmt_filter", sessionSeq) }]);

  await editTelegramMessageWithKeyboard(chatId, messageId, "📁 *Selecione o grupo:*", keyboard);
}

export async function showTagSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", userId).single();
  const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
  const selectedTags = filters.tags || [];

  const allTags = await getAllUserTags(supabase, userId);
  const tagSet = [...new Set(allTags)];

  const keyboard: InlineKeyboard = [];
  if (tagSet.length > 0) {
    let row: { text: string; callback_data: string }[] = [];
    for (const tag of tagSet) {
      const isSelected = selectedTags.includes(tag);
      const displayTag = tag.startsWith("#") ? tag : `#${tag}`;
      row.push({ text: isSelected ? `✅ ${displayTag}` : displayTag, callback_data: addSession(`stmt_f_tag_${tag}`, sessionSeq) });
      if (row.length === 2) {
        keyboard.push(row);
        row = [];
      }
    }
    if (row.length > 0) keyboard.push(row);
  }
  keyboard.push([
    { text: "✅ Concluir", callback_data: addSession("stmt_f_tag_done", sessionSeq) },
    { text: "⏭️ Limpar", callback_data: addSession("stmt_f_tag_clr", sessionSeq) },
  ]);
  keyboard.push([{ text: "◀️ Voltar", callback_data: addSession("stmt_filter", sessionSeq) }]);

  const selectedStr = selectedTags.length > 0
    ? `\n\n✅ Selecionadas: ${selectedTags.map((t: string) => t.startsWith("#") ? t : `#${t}`).join(" ")}`
    : "";
  await editTelegramMessageWithKeyboard(chatId, messageId, `🔖 *Selecione as tags:*${selectedStr}`, keyboard);
}

export async function showTypeSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", userId).single();
  const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };

  const options: { label: string; type: ExtratoFilters["type"] }[] = [
    { label: "📋 Todas", type: "all" },
    { label: "📈 Receitas", type: "income" },
    { label: "📉 Despesas", type: "expense" },
  ];

  const keyboard: InlineKeyboard = [
    options.map((o) => ({
      text: filters.type === o.type ? `✅ ${o.label}` : o.label,
      callback_data: addSession(`stmt_f_type_${o.type}`, sessionSeq),
    })),
  ];
  keyboard.push([{ text: "◀️ Voltar", callback_data: addSession("stmt_filter", sessionSeq) }]);

  await editTelegramMessageWithKeyboard(chatId, messageId, "📈 *Selecione o tipo:*", keyboard);
}

export async function showStatusSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", userId).single();
  const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };

  const options: { label: string; value: ExtratoFilters["status"] }[] = [
    { label: "📋 Todas", value: "all" },
    { label: "✅ Realizadas", value: "past" },
    { label: "⏳ Agendadas", value: "future" },
  ];

  const keyboard: InlineKeyboard = [
    options.map((o) => ({
      text: filters.status === o.value ? `✅ ${o.label}` : o.label,
      callback_data: addSession(`stmt_f_status_${o.value}`, sessionSeq),
    })),
  ];
  keyboard.push([{ text: "◀️ Voltar", callback_data: addSession("stmt_filter", sessionSeq) }]);

  await editTelegramMessageWithKeyboard(chatId, messageId, "📆 *Selecione o status:*", keyboard);
}

export async function showPeriodSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", userId).single();
  const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };

  const presets: { label: string; key: string }[] = [
    { label: "Este mês", key: "this_month" },
    { label: "Mês passado", key: "last_month" },
    { label: "Últimos 3 meses", key: "last_3_months" },
    { label: "Este ano", key: "this_year" },
  ];

  const keyboard: InlineKeyboard = [];
  let row: { text: string; callback_data: string }[] = [];
  for (const p of presets) {
    const isActive = filters.period === p.key;
    row.push({ text: isActive ? `✅ ${p.label}` : p.label, callback_data: addSession(`stmt_f_period_${p.key}`, sessionSeq) });
    if (row.length === 2) {
      keyboard.push(row);
      row = [];
    }
  }
  if (row.length > 0) keyboard.push(row);
  keyboard.push([{ text: "📆 Outro período", callback_data: addSession("stmt_f_period_custom", sessionSeq) }]);
  keyboard.push([{ text: "◀️ Voltar", callback_data: addSession("stmt_filter", sessionSeq) }]);

  await editTelegramMessageWithKeyboard(chatId, messageId, "📅 *Selecione o período:*", keyboard);
}

export async function handleFilterCallback(
  supabase: any,
  telegramId: number,
  chatId: number,
  selectedValue: string,
  sessionSeq: number,
  messageId: number
): Promise<boolean> {
  const user = await getOrCreateUser(supabase, telegramId);
  if (!user) return true;

  // Open filter panel
  if (selectedValue === "stmt_filter") {
    const existing = await getWizardState(supabase, user.id);
    const existingFilters = existing?.step === "extrato_filters" ? existing.data : undefined;
    await handleFilterPanel(supabase, user.id, chatId, existingFilters as any);
    return true;
  }

  // Open category selector
  if (selectedValue === "stmt_f_cat") {
    await showCategorySelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  // Select category (by ID, 0 = clear)
  if (selectedValue.startsWith("stmt_f_cat_")) {
    const catId = parseInt(selectedValue.replace("stmt_f_cat_", ""), 10);
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    filters.category_id = catId || null;
    await supabase.from("wizard_states").update({
      data: filters,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", user.id);
    await renderFilterPanelMessage(supabase, user.id, chatId, filters, sessionSeq, messageId);
    return true;
  }

  // Open group selector
  if (selectedValue === "stmt_f_grp") {
    await showGroupSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  // Select group (by ID, 0 = clear)
  if (selectedValue.startsWith("stmt_f_grp_")) {
    const grpId = parseInt(selectedValue.replace("stmt_f_grp_", ""), 10);
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    filters.group_id = grpId || null;
    await supabase.from("wizard_states").update({
      data: filters,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", user.id);
    await renderFilterPanelMessage(supabase, user.id, chatId, filters, sessionSeq, messageId);
    return true;
  }

  // Open tag selector
  if (selectedValue === "stmt_f_tag") {
    await showTagSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  // Toggle tag
  if (selectedValue.startsWith("stmt_f_tag_")) {
    const rest = selectedValue.replace("stmt_f_tag_", "");
    if (rest !== "done" && rest !== "clr") {
      const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
      const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
      const tags = filters.tags || [];
      filters.tags = tags.includes(rest) ? tags.filter((t: string) => t !== rest) : [...tags, rest];
      await supabase.from("wizard_states").update({
        data: filters,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }).eq("user_id", user.id);
      await showTagSelector(supabase, user.id, chatId, messageId, sessionSeq);
      return true;
    }
  }

  // Confirm tag selection
  if (selectedValue === "stmt_f_tag_done") {
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    await renderFilterPanelMessage(supabase, user.id, chatId, filters, sessionSeq, messageId);
    return true;
  }

  // Clear tag selection
  if (selectedValue === "stmt_f_tag_clr") {
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    filters.tags = [];
    await supabase.from("wizard_states").update({
      data: filters,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", user.id);
    await showTagSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  // Open type selector
  if (selectedValue === "stmt_f_type") {
    await showTypeSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  // Select type
  if (selectedValue.startsWith("stmt_f_type_")) {
    const type = selectedValue.replace("stmt_f_type_", "") as ExtratoFilters["type"];
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    filters.type = type;
    await supabase.from("wizard_states").update({
      data: filters,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", user.id);
    await renderFilterPanelMessage(supabase, user.id, chatId, filters, sessionSeq, messageId);
    return true;
  }

  // Open status selector
  if (selectedValue === "stmt_f_status") {
    await showStatusSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  // Select status
  if (selectedValue.startsWith("stmt_f_status_")) {
    const status = selectedValue.replace("stmt_f_status_", "") as ExtratoFilters["status"];
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    filters.status = status;
    await supabase.from("wizard_states").update({
      data: filters,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", user.id);
    await renderFilterPanelMessage(supabase, user.id, chatId, filters, sessionSeq, messageId);
    return true;
  }

  // Open period selector
  if (selectedValue === "stmt_f_period") {
    await showPeriodSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  // Select period preset
  if (selectedValue.startsWith("stmt_f_period_")) {
    const key = selectedValue.replace("stmt_f_period_", "");
    if (key === "custom") {
      const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
      const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
      await setWizardState(supabase, user.id, "extrato_custom_period", filters as any);
      await sendTelegramMessage(chatId, "📅 Informe a data de *início* (formato: DD/MM/AAAA):");
      return true;
    }
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).single();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    filters.period = key as PeriodPreset;
    await supabase.from("wizard_states").update({
      data: filters,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", user.id);
    await renderFilterPanelMessage(supabase, user.id, chatId, filters, sessionSeq, messageId);
    return true;
  }

  // Clear filters and reload extrato (called from extrato keyboard)
  if (selectedValue === "stmt_clear") {
    await clearWizardState(supabase, user.id);
    await handleStatement(supabase, telegramId, chatId);
    return true;
  }

  // Apply filters
  if (selectedValue === "stmt_f_apply") {
    const state = await (await import("./wizard.ts")).getWizardState(supabase, user.id);
    if (!state || state.step !== "extrato_filters") {
      await sendTelegramMessage(chatId, "⚠️ Nenhum filtro configurado. Use /extrato para começar.");
      return true;
    }
    const filters = state.data as ExtratoFilters;
    await clearWizardState(supabase, user.id);
    await handleStatement(supabase, telegramId, chatId, 0, filters.type || "all", filters);
    return true;
  }

  // Clear all filters
  if (selectedValue === "stmt_f_clear") {
    await handleFilterPanel(supabase, user.id, chatId);
    return true;
  }

  return false;
}
