export interface DeepSeekResponse {
  intent: "expense" | "income" | "query_balance" | "query_expenses_month" | 
          "query_expenses_last_month" | "query_expenses_date" | 
          "query_expenses_category" | "query_summary" | "query_extract" |
          "create_category" | "create_group" | "list_categories" | 
          "list_groups" | "list_tags" | "list_transactions" |
          "show_last_transaction" | "delete_last_transaction" |
          "list_by_tag" | "cleanup" | "next_page" | "previous_page" | null;
  amount: number | null;
  category: string | null;
  date: string | null;
  period: "this_month" | "last_month" | null;
  name: string | null;
  tag: string | null;
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

export type PeriodPreset = "this_month" | "last_month" | "last_3_months" | "this_year";

export interface ExtratoFilters {
  category_id: number | null;
  group_id: number | null;
  tags: string[];
  type: "all" | "income" | "expense";
  period: PeriodPreset | { start: string; end: string };
}
