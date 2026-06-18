export interface DeepSeekResponse {
  intent: "expense" | "income" | "query_balance" | "query_expenses_month" | 
          "query_expenses_last_month" | "query_expenses_date" | 
          "query_expenses_category" | "query_summary" | "query_extract" |
          "query_future" | "query_search" |
          "create_category" | "create_group" | "list_categories" | 
          "list_groups" | "list_tags" | "list_transactions" |
          "show_last_transaction" | "delete_last_transaction" |
          "list_by_tag" | "cleanup" | null;
  amount: number | null;
  category: string | null;
  date: string | null;
  period: "this_month" | "last_month" | null;
  name: string | null;
  tag: string | null;
  group?: string | null;
  description?: string | null;
  limit: number | null;
  missingFields: string[];
}

export interface TelegramMessage {
  message_id: number;
  from: { id: number; is_bot: boolean; first_name: string; username?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; is_bot: boolean; first_name: string; username?: string };
  message: TelegramMessage;
  data: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

export interface WizardState {
  step: string;
  data: Record<string, any>;
}

export interface ParsedCommand {
  amount: number | null;
  category: string | null;
  group: string | null;
  date: string | null;
  tags: string[];
  period: string | null;
}

export interface PeriodResult {
  start: string;
  end: string;
  label: string;
}

export interface PeriodParseResult {
  start: string | null;
  end: string | null;
  label: string | null;
  type: "expense" | "income" | null;
  group: string | null;
}

export type PeriodPreset = "this_month" | "last_month" | "last_3_months" | "this_year" | "all";

export interface ExtratoFilters {
  category_id: number | null;
  group_id: number | null;
  tags: string[];
  type: "all" | "income" | "expense";
  period: PeriodPreset | { start: string; end: string; label?: string };
  status: "all" | "past" | "future";
}

export type FrequencyType = "daily" | "weekly" | "monthly" | "annual" | "every_x_days";

export interface Recurrence {
  id: number;
  user_id: number;
  type: "expense" | "income";
  amount: number;
  description: string | null;
  category_id: number | null;
  group_id: number | null;
  tags: string[];
  frequency_type: FrequencyType;
  frequency_interval: number | null;
  frequency_month: number | null;
  next_date: string;
  last_processed_date: string | null;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecurrenceWithJoins extends Recurrence {
  categories?: { name: string } | null;
  groups?: { name: string } | null;
}
