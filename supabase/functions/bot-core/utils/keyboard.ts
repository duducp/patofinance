import type { InlineKeyboard } from "../types/index.ts";
import { addSession } from "./session.ts";

/**
 * Build an inline keyboard grid with N items per row.
 * Each item is transformed to a button via the `toButton` callback.
 */
export function buildKeyboardGrid(
  items: any[],
  toButton: (item: any, index: number) => { text: string; callback_data: string },
  cols: 2 | 3 = 3,
): InlineKeyboard {
  const keyboard: InlineKeyboard = [];
  let row: { text: string; callback_data: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    row.push(toButton(items[i], i));
    if (row.length === cols) {
      keyboard.push(row);
      row = [];
    }
  }
  if (row.length > 0) keyboard.push(row);
  return keyboard;
}

/**
 * Build the standard edit transaction keyboard.
 * Used in handleDetails.
 */
export function buildEditKeyboard(
  transactionId: string | number,
  sessionSeq: number,
): InlineKeyboard {
  return [
    [
      { text: "✏️ Editar valor", callback_data: addSession(`edit_amount_${transactionId}`, sessionSeq) },
      { text: "🏷️ Editar categoria", callback_data: addSession(`edit_category_${transactionId}`, sessionSeq) },
    ],
    [
      { text: "📁 Editar grupo", callback_data: addSession(`edit_group_${transactionId}`, sessionSeq) },
      { text: "🔖 Editar tags", callback_data: addSession(`edit_tags_${transactionId}`, sessionSeq) },
    ],
    [
      { text: "📝 Editar descrição", callback_data: addSession(`edit_desc_${transactionId}`, sessionSeq) },
      { text: "📅 Editar data", callback_data: addSession(`edit_date_${transactionId}`, sessionSeq) },
    ],
  ];
}
