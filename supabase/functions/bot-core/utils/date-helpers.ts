import { getMonthName, formatDateBR, getNowBR } from "./formatting.ts";

export function getDateRange(
  period: "this_month" | "last_month" | null,
  date: string | null
): { start: string; end: string; label: string } {
  const now = getNowBR();
  
  if (date) {
    let targetDate = date;
    if (date === "ontem") {
      const yesterday = new Date(now.getTime() - 86400000);
      targetDate = yesterday.toISOString().split("T")[0];
    } else if (date === "hoje") {
      targetDate = now.toISOString().split("T")[0];
    }
    return { start: targetDate, end: targetDate, label: formatDateBR(targetDate) };
  }
  
  if (period === "last_month") {
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    return {
      start: lastMonth.toISOString().split("T")[0],
      end: endLastMonth.toISOString().split("T")[0],
      label: getMonthName(lastMonth),
    };
  }
  
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  return { start: startOfMonth, end: endOfMonth, label: getMonthName(now) };
}
