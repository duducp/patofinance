import { InlineKeyboard } from "../types/index.ts";
import { TELEGRAM_BOT_TOKEN } from "../config.ts";

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function callTelegramAPI(method: string, body: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (errorText.includes("parse") || errorText.includes("markdown")) {
        // Retry without parse_mode
        const { parse_mode, ...cleanBody } = body as { parse_mode?: string; [key: string]: unknown };
        const retry = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cleanBody),
        });
        if (!retry.ok) {
          console.error(`Telegram API error (${method}):`, await retry.text());
        }
      } else if (!errorText.includes("message is not modified")) {
        console.error(`Telegram API error (${method}):`, errorText);
      }
    }
  } catch (error) {
    console.error(`Error calling Telegram API (${method}):`, error);
  }
}

export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  await callTelegramAPI("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

export async function sendTelegramMessageWithKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  await callTelegramAPI("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function editTelegramMessageWithKeyboard(
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  await callTelegramAPI("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  await fetch(`${TELEGRAM_API_BASE}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}
