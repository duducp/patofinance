import type { InlineKeyboard, InlineKeyboardButton, ExtratoFilters, PeriodPreset } from "../types/index.ts";
import { sendTelegramMessage, sendTelegramMessageWithKeyboard, editTelegramMessageWithKeyboard } from "../services/telegram.ts";
import { getOrCreateUser, requireUser, getAllUserTags, deduplicateByNormalizedName, userOrNullFilter } from "../services/database.ts";
import { formatCurrencyBR, formatDateBR, getTodayISOBR, getMonthName, getNowBR, sanitizeMarkdown } from "../utils/formatting.ts";
import { addSession, getSessionSeq } from "../utils/session.ts";
import { buildKeyboardGrid } from "../utils/keyboard.ts";
import { setWizardState, getWizardState, clearWizardState } from "./wizard.ts";

// ── Constants ─────────────────────────────────────────────

const STATEMENT_PAGE_SIZE = 30;

export const DEFAULT_FILTERS: ExtratoFilters = {
  category_id: null,
  group_id: null,
  tags: [],
  type: "all",
  period: "this_month",
  status: "all",
};

type StatementFilter = "all" | "income" | "expense" | "future";

type FilterStateData = ExtratoFilters & { _original?: ExtratoFilters };

// ── Period resolution ─────────────────────────────────────

export function resolvePeriod(period: ExtratoFilters["period"]): { start: string; end: string; label: string } {
  const now = getNowBR();
  if (typeof period === "string") {
    switch (period) {
      case "this_month": {
        const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
        return { start, end, label: getMonthName(now) };
      }
      case "last_month": {
        const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const start = last.toISOString().split("T")[0];
        const end = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split("T")[0];
        return { start, end, label: getMonthName(last) };
      }
      case "last_3_months": {
        const start = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().split("T")[0];
        const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
        return { start, end, label: "Últimos 3 meses" };
      }
      case "this_year": {
        return {
          start: `${now.getFullYear()}-01-01`,
          end: `${now.getFullYear()}-12-31`,
          label: `${now.getFullYear()}`,
        };
      }
      case "all": {
        return { start: "2000-01-01", end: "2099-12-31", label: "Todo período" };
      }
    }
  }
  if (period && typeof period === "object") {
    return {
      start: period.start,
      end: period.end,
      label: period.label || `${formatDateBR(period.start)} — ${formatDateBR(period.end)}`,
    };
  }
  // Fallback: current month
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  return { start, end, label: getMonthName(now) };
}

function statementFilterSuffix(filter: StatementFilter): string {
  switch (filter) {
    case "income": return "inc";
    case "expense": return "exp";
    case "future": return "fut";
    default: return "all";
  }
}

// ── Database query builder ────────────────────────────────

function applyFiltersToQuery(
  query: any,
  userId: number,
  periodStart: string,
  periodEnd: string,
  typeFilter?: "all" | "income" | "expense",
  filters?: { category_id?: number | null; group_id?: number | null; tags?: string[]; status?: "all" | "past" | "future" }
): any {
  let q = query
    .eq("user_id", userId)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd);

  if (typeFilter && typeFilter !== "all") {
    q = q.eq("type", typeFilter);
  }
  if (filters?.category_id) {
    q = q.eq("category_id", filters.category_id);
  }
  if (filters?.group_id) {
    q = q.eq("group_id", filters.group_id);
  }
  if (filters?.tags && filters.tags.length > 0) {
    for (const tag of filters.tags) {
      q = q.contains("tags", [tag]);
    }
  }
  if (filters?.status === "past") {
    q = q.lte("transaction_date", getTodayISOBR());
  } else if (filters?.status === "future") {
    q = q.gt("transaction_date", getTodayISOBR());
  }
  return q;
}

// ── Statement display ─────────────────────────────────────

export async function handleStatement(
  supabase: any,
  userId: number,
  chatId: number,
  page: number = 0,
  typeFilter: StatementFilter = "all",
  filters?: ExtratoFilters,
  messageId?: number
): Promise<void> {
  const user = await requireUser(supabase, userId, chatId);
  if (!user) return;

  if (filters) {
    const existingState = await getWizardState(supabase, user.id);
    if (!existingState || existingState.step !== "extrato_filters") {
      await setWizardState(supabase, user.id, "extrato_filters", { ...filters });
    }
  }

  const period = filters?.period || "this_month";
  const { start: periodStart, end: periodEnd, label: periodLabel } = resolvePeriod(period);

  const effectiveTypeFilter = typeFilter === "future" ? "all" : typeFilter;
  const effectiveFilters = typeFilter === "future"
    ? { ...filters, status: "future" as const }
    : filters;

  const countQuery = applyFiltersToQuery(
    supabase.from("transactions").select("id", { count: "exact", head: true }),
    user.id,
    periodStart,
    periodEnd,
    effectiveTypeFilter,
    effectiveFilters,
  );

  const { count: totalCount } = await countQuery;

  if (!totalCount || totalCount === 0) {
    const filterName = typeFilter === "income" ? "receita" : typeFilter === "expense" ? "despesa" : (typeFilter === "future" || filters?.status === "future") ? "agendada" : "transação";
    const noResultMsg = `📋 Nenhuma ${filterName} encontrada${period !== "this_month" ? ` em ${periodLabel}` : " este mês"}.`;
    const sessionSeq = await getSessionSeq(supabase, user.id);
    const keyboard: InlineKeyboard = [[
      { text: "◀️ Voltar", callback_data: addSession("stmt_filter", sessionSeq) },
    ]];
    if (messageId) {
      await editTelegramMessageWithKeyboard(chatId, messageId, noResultMsg, keyboard);
    } else {
      await sendTelegramMessageWithKeyboard(chatId, noResultMsg, keyboard);
    }
    return;
  }

  const offset = page * STATEMENT_PAGE_SIZE;

  const dataQuery = applyFiltersToQuery(
    supabase.from("transactions").select(`
      id,
      type,
      amount,
      description,
      tags,
      transaction_date,
      categories (name),
      groups (name)
    `),
    user.id,
    periodStart,
    periodEnd,
    effectiveTypeFilter,
    effectiveFilters,
  );

  const { data: transactions } = await dataQuery
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + STATEMENT_PAGE_SIZE - 1);

  if (!transactions || transactions.length === 0) {
    const emptyPageMsg = "📋 Nenhuma transação encontrada nesta página.";
    if (messageId) {
      await editTelegramMessageWithKeyboard(chatId, messageId, emptyPageMsg, []);
    } else {
      await sendTelegramMessage(chatId, emptyPageMsg);
    }
    return;
  }

  const totalsQuery = applyFiltersToQuery(
    supabase.from("transactions").select("type, amount"),
    user.id,
    periodStart,
    periodEnd,
    effectiveTypeFilter,
    effectiveFilters,
  );

  const { data: periodData } = await totalsQuery;

  const totalIncome = periodData
    ?.filter((t: any) => t.type === "income")
    ?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;
  const totalExpenses = periodData
    ?.filter((t: any) => t.type === "expense")
    ?.reduce((sum: number, t: any) => sum + Number(t.amount), 0) || 0;

  const totalPages = Math.ceil(totalCount / STATEMENT_PAGE_SIZE);
  const startItem = offset + 1;
  const endItem = offset + transactions.length;
  const showAllTypes = effectiveTypeFilter === "all";

  const incomeTx = transactions.filter((t: any) => t.type === "income");
  const expenseTx = transactions.filter((t: any) => t.type === "expense");

  let message = `📋 *Extrato*   📄 ${page + 1}/${totalPages} (${startItem}–${endItem} de ${totalCount})\n`;

  const filterParts: string[] = [];
  if (filters?.category_id) {
    const cat = transactions.find((t: any) => t.categories?.name)?.categories?.name;
    filterParts.push(cat || "categoria específica");
  }
  if (filters?.group_id) {
    const grp = transactions.find((t: any) => t.groups?.name)?.groups?.name;
    filterParts.push(grp || "grupo específico");
  }
  if (filters?.tags && filters.tags.length > 0) {
    filterParts.push(filters.tags.map((t: string) => t.startsWith("#") ? t : `#${t}`).join(" "));
  }
  if (period !== "this_month") {
    filterParts.push(periodLabel);
  }
  if (!showAllTypes) {
    filterParts.push(typeFilter === "income" ? "📈 Receitas" : typeFilter === "expense" ? "📉 Despesas" : "📉 Despesas");
  }
  if (typeFilter === "future" || filters?.status === "future") {
    filterParts.push("⏳ Agendadas");
  }
  if (filterParts.length > 0) {
    message += `🔽 ${filterParts.join(" · ")}\n`;
  }
  message += "\n";

  const today = getTodayISOBR();

  function appendTxLine(t: any): string {
    const shortDate = formatDateBR(t.transaction_date).slice(0, 5);
    const isFuture = t.transaction_date > today;
    const catName = t.categories?.name;
    const grpName = t.groups?.name || "Pessoal";
    const catPart = catName ? ` - ${sanitizeMarkdown(catName)}` : "";
    const line = `   • #${t.id}  ${shortDate}  ${formatCurrencyBR(Number(t.amount))}  - ${sanitizeMarkdown(grpName)}${catPart}`;
    return isFuture ? `_${line}_\n` : `${line}\n`;
  }

  if (incomeTx.length > 0 && (showAllTypes || typeFilter === "income")) {
    if (showAllTypes) {
      message += `📈 *Receitas*\n`;
    }
    for (const t of incomeTx) {
      message += appendTxLine(t);
    }
    message += `Total: ${formatCurrencyBR(totalIncome)}\n\n`;
  }

  if (expenseTx.length > 0 && (showAllTypes || typeFilter === "expense")) {
    if (showAllTypes) {
      message += `📉 *Despesas*\n`;
    }
    for (const t of expenseTx) {
      message += appendTxLine(t);
    }
    message += `Total: ${formatCurrencyBR(totalExpenses)}\n\n`;
  }

  if (showAllTypes) {
    const balance = totalIncome - totalExpenses;
    const balanceEmoji = balance >= 0 ? "✅" : "⚠️";
    message += `${balanceEmoji} *Saldo: ${formatCurrencyBR(balance)}*`;
  }

  const hasIncome = incomeTx.length > 0;
  const hasExpense = expenseTx.length > 0;
  if (hasIncome && !hasExpense && showAllTypes) {
    message = message.replace(/\n\n$/, "");
  }

  const currentSuffix = typeFilter === "future" || filters?.status === "future" ? "fut" : statementFilterSuffix(typeFilter);

  const sessionSeq = await getSessionSeq(supabase, user.id);
  const keyboard: InlineKeyboard = [];

  const hasActiveFilters = typeFilter !== "all" || (
    filters && (
      filters.category_id != null ||
      filters.group_id != null ||
      (filters.tags && filters.tags.length > 0) ||
      (filters.type && filters.type !== "all") ||
      (filters.status && filters.status !== "all") ||
      (typeof filters.period === "object" || (filters.period && filters.period !== "this_month"))
    )
  );
  const actionRow: InlineKeyboardButton[] = [{ text: "🔍 Filtrar", callback_data: addSession("stmt_filter", sessionSeq) }];
  if (hasActiveFilters) {
    actionRow.push({ text: "🧹 Limpar filtros", callback_data: addSession("stmt_clear", sessionSeq) });
  }
  keyboard.push(actionRow);

  const navButtons: InlineKeyboard[0] = [];
  if (page > 0) {
    navButtons.push({ text: "◀️ Anterior", callback_data: addSession(`statement_${currentSuffix}_${page - 1}`, sessionSeq) });
  }
  if (page + 1 < totalPages) {
    navButtons.push({ text: "Próximo ▶️", callback_data: addSession(`statement_${currentSuffix}_${page + 1}`, sessionSeq) });
  }
  if (navButtons.length > 0) {
    keyboard.push(navButtons);
  }

  if (messageId) {
    await editTelegramMessageWithKeyboard(chatId, messageId, message, keyboard);
  } else {
    await sendTelegramMessageWithKeyboard(chatId, message, keyboard);
  }
}

// ── Filter Panel UI ───────────────────────────────────────

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
    const { data: cat } = await supabase.from("categories").select("name").eq("id", filters.category_id).maybeSingle();
    if (cat) catName = sanitizeMarkdown(cat.name);
  }
  let grpName = "Nenhum";
  if (filters.group_id) {
    const { data: grp } = await supabase.from("groups").select("name").eq("id", filters.group_id).maybeSingle();
    if (grp) grpName = sanitizeMarkdown(grp.name);
  }
  const tagStr = filters.tags.length > 0
    ? filters.tags.map((t: string) => sanitizeMarkdown(t.startsWith("#") ? t : `#${t}`)).join(" ")
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
    `🔄 Status: ${statusLabels[filters.status]}`;

  const keyboard: InlineKeyboard = [
    [{ text: `🏷️ Categoria: ${catName}`, callback_data: addSession("stmt_f_cat", sessionSeq) }],
    [{ text: `📁 Grupo: ${grpName}`, callback_data: addSession("stmt_f_grp", sessionSeq) }],
    [{ text: `🔖 Tags: ${tagStr}`, callback_data: addSession("stmt_f_tag", sessionSeq) }],
    [{ text: `📈 Tipo: ${typeLabels[filters.type]}`, callback_data: addSession("stmt_f_type", sessionSeq) }],
    [{ text: `📅 Período: ${periodStr}`, callback_data: addSession("stmt_f_period", sessionSeq) }],
    [{ text: `🔄 Status: ${statusLabels[filters.status]}`, callback_data: addSession("stmt_f_status", sessionSeq) }],
    [
      { text: "🔍 Aplicar", callback_data: addSession("stmt_f_apply", sessionSeq) },
      { text: "🧹 Limpar", callback_data: addSession("stmt_f_clear", sessionSeq) },
      { text: "🚫 Cancelar", callback_data: addSession("stmt_f_cancel", sessionSeq) },
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
  existingFilters?: ExtratoFilters,
  messageId?: number
): Promise<void> {
  const filters = existingFilters || { ...DEFAULT_FILTERS };
  await setWizardState(supabase, userId, "extrato_filters", filters as any);
  const sessionSeq = await getSessionSeq(supabase, userId);
  await renderFilterPanelMessage(supabase, userId, chatId, filters, sessionSeq, messageId);
}

// ── Generic filter selector ───────────────────────────────

type SelectorOption = {
  label: string;
  value: string;
};
type SelectorConfig = {
  title: string;
  callbackPrefix: string;
  columns?: 2 | 3;
  options: SelectorOption[];
  isSelected: (value: string, filters: ExtratoFilters) => boolean;
  extraButtons?: { text: string; callback: string }[];
  messageSuffix?: string | ((filters: ExtratoFilters) => string);
};

async function showFilterSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number,
  config: SelectorConfig
): Promise<void> {
  const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", userId).maybeSingle();
  const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };

  const keyboard: InlineKeyboard = [];
  if (config.options.length > 0) {
    const grid = buildKeyboardGrid(
      config.options,
      (opt) => ({
        text: config.isSelected(opt.value, filters) ? `✅ ${opt.label}` : opt.label,
        callback_data: addSession(`${config.callbackPrefix}${opt.value}`, sessionSeq),
      }),
      config.columns || 2,
    );
    keyboard.push(...grid);
  }
  if (config.extraButtons) {
    for (const btn of config.extraButtons) {
      keyboard.push([{ text: btn.text, callback_data: addSession(btn.callback, sessionSeq) }]);
    }
  }
  keyboard.push([{ text: "◀️ Voltar", callback_data: addSession("stmt_filter", sessionSeq) }]);

  const suffix = typeof config.messageSuffix === "function"
    ? config.messageSuffix(filters)
    : (config.messageSuffix || "");
  await editTelegramMessageWithKeyboard(chatId, messageId, config.title + suffix, keyboard);
}

export async function showCategorySelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const { data: categories } = await supabase
    .from("categories")
    .select("id, name, normalized_name")
    .or(userOrNullFilter(userId))
    .order("user_id", { ascending: false, nullsFirst: false })
    .order("name");

  const unique = deduplicateByNormalizedName(categories || []);

  await showFilterSelector(supabase, userId, chatId, messageId, sessionSeq, {
    title: "🏷️ *Selecione a categoria:*",
    callbackPrefix: "stmt_f_cat_",
    columns: 3,
    options: unique.map(c => ({ label: c.name, value: String(c.id) })),
    isSelected: (value, flt) => flt.category_id === parseInt(value, 10),
    extraButtons: [{ text: "❌ Limpar", callback: "stmt_f_cat_0" }],
  });
}

export async function showGroupSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const { data: groups } = await supabase
    .from("groups")
    .select("id, name")
    .eq("user_id", userId)
    .order("name");

  await showFilterSelector(supabase, userId, chatId, messageId, sessionSeq, {
    title: "📁 *Selecione o grupo:*",
    callbackPrefix: "stmt_f_grp_",
    columns: 3,
    options: (groups || []).map((g: any) => ({ label: g.name, value: String(g.id) })),
    isSelected: (value, flt) => flt.group_id === parseInt(value, 10),
    extraButtons: [{ text: "❌ Limpar", callback: "stmt_f_grp_0" }],
  });
}

export async function showTagSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  const allTags = await getAllUserTags(supabase, userId);
  const tagSet = [...new Set(allTags)];

  await showFilterSelector(supabase, userId, chatId, messageId, sessionSeq, {
    title: "🔖 *Selecione as tags:*",
    callbackPrefix: "stmt_f_tag_",
    columns: 2,
    options: tagSet.map(tag => ({ label: tag.startsWith("#") ? tag : `#${tag}`, value: tag })),
    isSelected: (value, flt) => (flt.tags || []).includes(value),
    extraButtons: [
      { text: "✅ Concluir", callback: "stmt_f_tag_done" },
      { text: "⏭️ Limpar", callback: "stmt_f_tag_clr" },
    ],
    messageSuffix: (filters) => {
      const selected = filters.tags || [];
      return selected.length > 0
        ? `\n\n✅ Selecionadas: ${selected.map((t: string) => t.startsWith("#") ? t : `#${t}`).join(" ")}`
        : "";
    },
  });
}

export async function showTypeSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  await showFilterSelector(supabase, userId, chatId, messageId, sessionSeq, {
    title: "📈 *Selecione o tipo:*",
    callbackPrefix: "stmt_f_type_",
    columns: 3,
    options: [
      { label: "📋 Todas", value: "all" },
      { label: "📈 Receitas", value: "income" },
      { label: "📉 Despesas", value: "expense" },
    ],
    isSelected: (value, flt) => flt.type === value,
  });
}

export async function showStatusSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  await showFilterSelector(supabase, userId, chatId, messageId, sessionSeq, {
    title: "📆 *Selecione o status:*",
    callbackPrefix: "stmt_f_status_",
    columns: 3,
    options: [
      { label: "📋 Todas", value: "all" },
      { label: "📆 Realizadas", value: "past" },
      { label: "⏳ Agendadas", value: "future" },
    ],
    isSelected: (value, flt) => flt.status === value,
  });
}

export async function showPeriodSelector(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number
): Promise<void> {
  await showFilterSelector(supabase, userId, chatId, messageId, sessionSeq, {
    title: "📅 *Selecione o período:*",
    callbackPrefix: "stmt_f_period_",
    columns: 2,
    options: [
      { label: "Este mês", value: "this_month" },
      { label: "Mês passado", value: "last_month" },
      { label: "Últimos 3 meses", value: "last_3_months" },
      { label: "Este ano", value: "this_year" },
    ],
    isSelected: (value, flt) => flt.period === value,
    extraButtons: [{ text: "📆 Outro período", callback: "stmt_f_period_custom" }],
  });
}

async function updateFilterField(
  supabase: any,
  userId: number,
  chatId: number,
  messageId: number,
  sessionSeq: number,
  selectedValue: string,
  prefix: string,
  setter: (filters: ExtratoFilters, value: any) => void,
  transform?: (value: string) => any,
): Promise<void> {
  const rawValue = selectedValue.replace(prefix, "");
  const value = transform ? transform(rawValue) : rawValue;
  const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", userId).maybeSingle();
  const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
  setter(filters, value);
  await supabase.from("wizard_states").update({
    data: filters,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  }).eq("user_id", userId);
  await renderFilterPanelMessage(supabase, userId, chatId, filters, sessionSeq, messageId);
}

// ── Filter callback router ────────────────────────────────

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

  if (selectedValue === "stmt_filter") {
    const existing = await getWizardState(supabase, user.id);
    const existingFilters = existing?.step === "extrato_filters" ? (existing.data as FilterStateData) : undefined;
    const original = existingFilters?._original || existingFilters || { ...DEFAULT_FILTERS };
    const filterData: FilterStateData = { ...original, _original: { ...original } };
    await handleFilterPanel(supabase, user.id, chatId, filterData, messageId);
    return true;
  }

  if (selectedValue === "stmt_f_cat") {
    await showCategorySelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  if (selectedValue.startsWith("stmt_f_cat_")) {
    await updateFilterField(supabase, user.id, chatId, messageId, sessionSeq, selectedValue, "stmt_f_cat_",
      (f, v) => { f.category_id = v; },
      (v) => parseInt(v, 10) || null);
    return true;
  }

  if (selectedValue === "stmt_f_grp") {
    await showGroupSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  if (selectedValue.startsWith("stmt_f_grp_")) {
    await updateFilterField(supabase, user.id, chatId, messageId, sessionSeq, selectedValue, "stmt_f_grp_",
      (f, v) => { f.group_id = v; },
      (v) => parseInt(v, 10) || null);
    return true;
  }

  if (selectedValue === "stmt_f_tag") {
    await showTagSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  if (selectedValue.startsWith("stmt_f_tag_")) {
    const rest = selectedValue.replace("stmt_f_tag_", "");
    if (rest !== "done" && rest !== "clr") {
      const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).maybeSingle();
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

  if (selectedValue === "stmt_f_tag_done") {
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).maybeSingle();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    await renderFilterPanelMessage(supabase, user.id, chatId, filters, sessionSeq, messageId);
    return true;
  }

  if (selectedValue === "stmt_f_tag_clr") {
    const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).maybeSingle();
    const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
    filters.tags = [];
    await supabase.from("wizard_states").update({
      data: filters,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq("user_id", user.id);
    await showTagSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  if (selectedValue === "stmt_f_type") {
    await showTypeSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  if (selectedValue.startsWith("stmt_f_type_")) {
    await updateFilterField(supabase, user.id, chatId, messageId, sessionSeq, selectedValue, "stmt_f_type_",
      (f, v) => { f.type = v as ExtratoFilters["type"]; });
    return true;
  }

  if (selectedValue === "stmt_f_status") {
    await showStatusSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  if (selectedValue.startsWith("stmt_f_status_")) {
    await updateFilterField(supabase, user.id, chatId, messageId, sessionSeq, selectedValue, "stmt_f_status_",
      (f, v) => { f.status = v as ExtratoFilters["status"]; });
    return true;
  }

  if (selectedValue === "stmt_f_period") {
    await showPeriodSelector(supabase, user.id, chatId, messageId, sessionSeq);
    return true;
  }

  if (selectedValue.startsWith("stmt_f_period_")) {
    const key = selectedValue.replace("stmt_f_period_", "");
    if (key === "custom") {
      const { data: state } = await supabase.from("wizard_states").select("data").eq("user_id", user.id).maybeSingle();
      const filters: ExtratoFilters = state?.data || { ...DEFAULT_FILTERS };
      const promptMsgId = await sendTelegramMessage(chatId, "📅 Informe a data de *início* (formato: DD/MM/AAAA):");
      await setWizardState(supabase, user.id, "extrato_custom_period", {
        ...filters,
        _filterPanelMessageId: messageId,
        _promptMessageId: promptMsgId,
      });
      return true;
    }
    await updateFilterField(supabase, user.id, chatId, messageId, sessionSeq, selectedValue, "stmt_f_period_",
      (f, v) => { f.period = v as PeriodPreset; });
    return true;
  }

  if (selectedValue === "stmt_clear") {
    await clearWizardState(supabase, user.id);
    await handleStatement(supabase, telegramId, chatId, 0, "all", undefined, messageId);
    return true;
  }

  if (selectedValue === "stmt_f_apply") {
    const state = await getWizardState(supabase, user.id);
    if (!state || state.step !== "extrato_filters") {
      await sendTelegramMessage(chatId, "⚠️ Nenhum filtro configurado. Use /extrato para começar.");
      return true;
    }
    const filters = state.data as ExtratoFilters;
    await clearWizardState(supabase, user.id);
    await handleStatement(supabase, telegramId, chatId, 0, filters.type || "all", filters, messageId);
    return true;
  }

  if (selectedValue === "stmt_f_clear") {
    await clearWizardState(supabase, user.id);
    await handleStatement(supabase, telegramId, chatId, 0, "all", undefined, messageId);
    return true;
  }

  if (selectedValue === "stmt_f_cancel") {
    const state = await getWizardState(supabase, user.id);
    const originalFilters = (state?.data as FilterStateData | undefined)?._original;
    await clearWizardState(supabase, user.id);
    await handleStatement(supabase, telegramId, chatId, 0, originalFilters?.type || "all", originalFilters, messageId);
    return true;
  }

  return false;
}
