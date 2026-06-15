import { InlineKeyboard } from "../types/index.ts";
import { TELEGRAM_BOT_TOKEN } from "../config.ts";

export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" }),
    });
    if (!response.ok) {
      const error = await response.text();
      if (error.includes("parse") || error.includes("markdown")) {
        const fallback = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: text }),
        });
        if (!fallback.ok) console.error("Telegram API fallback error:", await fallback.text());
      } else {
        console.error("Telegram API error:", error);
      }
    }
  } catch (error) {
    console.error("Error sending Telegram message:", error);
  }
}

export async function sendTelegramMessageWithKeyboard(
  chatId: number,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
    if (!response.ok) {
      const error = await response.text();
      if (error.includes("parse") || error.includes("markdown")) {
        const fallback = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: text,
            reply_markup: { inline_keyboard: keyboard },
          }),
        });
        if (!fallback.ok) console.error("Telegram API fallback error:", await fallback.text());
      } else {
        console.error("Telegram API error:", error);
      }
    }
  } catch (error) {
    console.error("Error sending Telegram message with keyboard:", error);
  }
}

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}
