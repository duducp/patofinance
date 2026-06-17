const SESSION_PREFIX = "s";

export function addSession(callbackData: string, sessionSeq: number, maxLength: number = 64): string {
  if (sessionSeq <= 0) return callbackData;
  const prefix = `${SESSION_PREFIX}${sessionSeq}_`;
  const available = maxLength - prefix.length;
  if (available <= 0) return callbackData.substring(0, maxLength);
  const truncated = callbackData.length > available
    ? callbackData.substring(0, available)
    : callbackData;
  return `${prefix}${truncated}`;
}

export function removeSession(encoded: string): { data: string; seq: number } | null {
  if (!encoded.startsWith(SESSION_PREFIX)) {
    return { data: encoded, seq: 0 };
  }
  const underscoreIdx = encoded.indexOf("_", 1);
  if (underscoreIdx < 2 || underscoreIdx > 7) return null;
  const seq = parseInt(encoded.substring(1, underscoreIdx), 10);
  if (isNaN(seq) || seq < 0) return null;
  return { data: encoded.substring(underscoreIdx + 1), seq };
}

export async function incrementSessionSeq(supabase: any, userId: number): Promise<number> {
  const { data: current } = await supabase
    .from("user_sessions")
    .select("session_seq")
    .eq("user_id", userId)
    .maybeSingle();

  const newSeq = (current?.session_seq || 0) + 1;

  await supabase.from("user_sessions").upsert({
    user_id: userId,
    session_seq: newSeq,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });

  return newSeq;
}

export async function getSessionSeq(supabase: any, userId: number): Promise<number> {
  const { data } = await supabase
    .from("user_sessions")
    .select("session_seq")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.session_seq || 0;
}

export async function validateCallbackSession(
  supabase: any,
  userId: number,
  callbackSeq: number
): Promise<boolean> {
  const currentSeq = await getSessionSeq(supabase, userId);
  if (callbackSeq === 0) return currentSeq === 0;
  return callbackSeq === currentSeq;
}
