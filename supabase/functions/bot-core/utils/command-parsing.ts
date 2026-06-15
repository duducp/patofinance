import { ParsedCommand } from "../types/index.ts";

export function parseCommand(args: string[]): ParsedCommand {
  let amount: number | null = null;
  let category: string | null = null;
  let group: string | null = null;
  let date: string | null = null;
  let period: string | null = null;
  const tags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data") {
      date = args[i + 1] || null;
      i++;
    } else if (args[i] === "--grupo") {
      group = args[i + 1] || null;
      i++;
    } else if (args[i] === "--periodo" || args[i] === "--mes") {
      period = args[i + 1] || null;
      i++;
    } else if (args[i].startsWith("#")) {
      tags.push(args[i]);
    } else if (!amount && !isNaN(parseFloat(args[i].replace(",", ".")))) {
      amount = parseFloat(args[i].replace(",", "."));
    } else {
      category = args.slice(i).join(" ");
      break;
    }
  }

  return { amount, category, group, date, tags, period };
}
