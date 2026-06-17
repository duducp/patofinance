import { PeriodResult } from "../types/index.ts";
import { parseCommandPeriod } from "../services/deepseek.ts";
import { getDateRange } from "./date-helpers.ts";

export async function resolveCommandPeriod(
  args: string[],
  userId?: number
): Promise<{
  period: PeriodResult | null;
  groupName: string | null;
  typeFilter: "all" | "income" | "expense";
}> {
  let groupName: string | null = null;
  const remainingArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grupo") {
      groupName = args[i + 1] || null;
      if (groupName) i++;
    } else {
      remainingArgs.push(args[i]);
    }
  }

  const text = remainingArgs.join(" ");
  if (!text.trim()) {
    return { period: null, groupName, typeFilter: "all" };
  }

  const result = await parseCommandPeriod(text, userId);
  if (!result || (!result.start && !result.type && !result.group)) {
    return { period: null, groupName, typeFilter: "all" };
  }

  if (result.group && !groupName) {
    groupName = result.group;
  }

  let period: PeriodResult | null = null;
  if (result.start && result.end) {
    period = {
      start: result.start,
      end: result.end,
      label: result.label || `${result.start} — ${result.end}`,
    };
  } else if (result.label && !result.start) {
    console.warn(`resolveCommandPeriod: NL returned label "${result.label}" without dates for "${text}" — falling back to current month`);
    period = getDateRange(null, null);
    period = { ...period, label: result.label };
  }

  let typeFilter: "all" | "income" | "expense" = "all";
  if (result.type === "income" || result.type === "expense") {
    typeFilter = result.type;
  }

  return { period, groupName, typeFilter };
}
