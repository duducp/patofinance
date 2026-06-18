import { InlineKeyboard } from "../types/index.ts";
import { TELEGRAM_BOT_TOKEN } from "../config.ts";

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function callTelegramAPI(method: string, body: Record<string, unknown>): Promise<number | null> {
  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      if ((errorText.includes("parse") || errorText.includes("markdown")) && "parse_mode" in body) {
        const { parse_mode: _parse_mode, ...cleanBody } = body as { parse_mode?: string; [key: string]: unknown };
        const retry = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cleanBody),
        });
        if (retry.ok) {
          const data = await retry.json();
          return data.result?.message_id ?? null;
        }
        console.error(`Telegram API error (${method}):`, await retry.text());
      } else if (!errorText.includes("message is not modified")) {
        console.error(`Telegram API error (${method}):`, errorText);
      }
      return null;
    }
    const data = await response.json();
    return data.result?.message_id ?? null;
  } catch (error) {
    console.error(`Error calling Telegram API (${method}):`, error);
    return null;
  }
}

export function sendTelegramMessage(chatId: number, text: string): Promise<number | null> {
  return callTelegramAPI("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

export function sendTelegramMessageWithKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineKeyboard
): Promise<number | null> {
  return callTelegramAPI("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

export function editTelegramMessageWithKeyboard(
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard
): Promise<number | null> {
  return callTelegramAPI("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
    if (!response.ok) {
      console.error("Telegram answerCallbackQuery error:", await response.text());
    }
  } catch (error) {
    console.error("Error calling answerCallbackQuery:", error);
  }
}

export async function deleteTelegramMessage(chatId: number, messageId: number): Promise<void> {
  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    if (!response.ok) {
      console.error("Telegram deleteMessage error:", await response.text());
    }
  } catch (error) {
    console.error("Error calling deleteMessage:", error);
  }
}
