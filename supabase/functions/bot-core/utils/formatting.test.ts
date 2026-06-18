import {
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { sanitizeMarkdown } from "./formatting.ts";

Deno.test("sanitizeMarkdown: empty string returns empty string", () => {
  assertEquals(sanitizeMarkdown(""), "");
});

Deno.test("sanitizeMarkdown: normal text without special chars returns unchanged", () => {
  const text = "Hello World 123";
  assertEquals(sanitizeMarkdown(text), text);
});

Deno.test("sanitizeMarkdown: text with * escapes asterisks", () => {
  assertEquals(sanitizeMarkdown("bold*text"), "bold\\*text");
  assertEquals(sanitizeMarkdown("*"), "\\*");
  assertEquals(sanitizeMarkdown("**bold**"), "\\*\\*bold\\*\\*");
});

Deno.test("sanitizeMarkdown: text with _ escapes underscores", () => {
  assertEquals(sanitizeMarkdown("italic_text"), "italic\\_text");
  assertEquals(sanitizeMarkdown("_"), "\\_");
  assertEquals(sanitizeMarkdown("__underline__"), "\\_\\_underline\\_\\_");
});

Deno.test("sanitizeMarkdown: text with backticks escapes code markers", () => {
  assertEquals(sanitizeMarkdown("code`here"), "code\\`here");
  assertEquals(sanitizeMarkdown("`"), "\\`");
  assertEquals(sanitizeMarkdown("`code`"), "\\`code\\`");
});

Deno.test("sanitizeMarkdown: text with brackets escapes [ and ]", () => {
  assertEquals(sanitizeMarkdown("[link]"), "\\[link\\]");
  assertEquals(sanitizeMarkdown("["), "\\[");
  assertEquals(sanitizeMarkdown("]"), "\\]");
  assertEquals(sanitizeMarkdown("[text](url)"), "\\[text\\](url)");
});

Deno.test("sanitizeMarkdown: text with backslash escapes it", () => {
  assertEquals(sanitizeMarkdown("back\\slash"), "back\\\\slash");
  assertEquals(sanitizeMarkdown("\\"), "\\\\");
  assertEquals(sanitizeMarkdown("\\\\"), "\\\\\\\\");
});

Deno.test("sanitizeMarkdown: mixed special characters all escaped", () => {
  const input = "*bold* _italic_ `code` [link] back\\slash";
  const expected = "\\*bold\\* \\_italic\\_ \\`code\\` \\[link\\] back\\\\slash";
  assertEquals(sanitizeMarkdown(input), expected);
});

Deno.test("sanitizeMarkdown: text with emoji and special chars", () => {
  const input = "🚀 *importante* _urgente_";
  const expected = "🚀 \\*importante\\* \\_urgente\\_";
  assertEquals(sanitizeMarkdown(input), expected);
});

Deno.test("sanitizeMarkdown: Category names with accents and special chars", () => {
  // Common category patterns that appear in the bot
  assertEquals(sanitizeMarkdown("Alimentação"), "Alimentação");
  assertEquals(sanitizeMarkdown("Casa *importante*"), "Casa \\*importante\\*");
  assertEquals(sanitizeMarkdown("Transporte [uber]"), "Transporte \\[uber\\]");
  assertEquals(sanitizeMarkdown("Freela_dev"), "Freela\\_dev");
});

Deno.test("sanitizeMarkdown: does not double-escape already-escaped text", () => {
  // Already-escaped: the backslash should be escaped, producing \\*
  assertEquals(sanitizeMarkdown("\\*not bold\\*"), "\\\\\\*not bold\\\\\\*");
});

Deno.test("sanitizeMarkdown: long text with many special characters", () => {
  const input = "Tag: #ifood | Valor: R$ 50,00 *importante* [ver mais] `codigo` _fim_";
  const expected = "Tag: #ifood | Valor: R$ 50,00 \\*importante\\* \\[ver mais\\] \\`codigo\\` \\_fim\\_";
  assertEquals(sanitizeMarkdown(input), expected);
});
