/**
 * Session-based callback protection.
 *
 * Every interactive keyboard gets a session_seq prefix in callback_data.
 * When a new command starts, session_seq increments → old callbacks become invalid.
 *
 * Format: s{SEQ}_{original_data}
 * Example: s5_stmt_filter, s5_stmt_f_cat
 */

const SESSION_PREFIX = "s";
/**
 * Add session prefix to callback data, truncating to fit maxLength if needed.
 */
export function addSession(callbackData: string, sessionSeq: number, maxLength: number = 64): string {
  if (sessionSeq <= 0) return callbackData;
  const prefix = `${SESSION_PREFIX}${sessionSeq}_`;
  const available = maxLength - prefix.length;
  if (available <= 0) return callbackData.substring(0, maxLength); // fallback: no room for prefix
  const truncated = callbackData.length > available
    ? callbackData.substring(0, available)
    : callbackData;
  return `${prefix}${truncated}`;
}

/**
 * Remove session prefix from incoming callback data.
 * Returns null if prefix is malformed.
 */
export function removeSession(encoded: string): { data: string; seq: number } | null {
  if (!encoded.startsWith(SESSION_PREFIX)) {
    return { data: encoded, seq: 0 };
  }
  const underscoreIdx = encoded.indexOf("_", 1);
  if (underscoreIdx < 2 || underscoreIdx > 4) return null;
  const seq = parseInt(encoded.substring(1, underscoreIdx), 10);
  if (isNaN(seq) || seq < 0) return null;
  return { data: encoded.substring(underscoreIdx + 1), seq };
}

/**
 * Increment session_seq for a user.
 * Call this when a new command or natural language interaction starts.
 */
export async function incrementSessionSeq(supabase: any, userId: number): Promise<number> {
  // Read current seq
  const { data: current } = await supabase
    .from("wizard_states")
    .select("session_seq")
    .eq("user_id", userId)
    .maybeSingle();

  const newSeq = (current?.session_seq || 0) + 1;

  // Upsert
  const { data: existing } = await supabase
    .from("wizard_states")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing) {
    await supabase.from("wizard_states").update({ session_seq: newSeq }).eq("user_id", userId);
  } else {
    // Create a minimal wizard state row just to hold session_seq
    await supabase.from("wizard_states").insert({
      user_id: userId,
      step: "",
      data: {},
      session_seq: newSeq,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
  }

  return newSeq;
}

/**
 * Get the current session_seq for a user.
 */
export async function getSessionSeq(supabase: any, userId: number): Promise<number> {
  const { data } = await supabase
    .from("wizard_states")
    .select("session_seq")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.session_seq || 0;
}

/**
 * Validate that an incoming callback's session matches the current session.
 * Returns true if valid, false if expired.
 */
export async function validateCallbackSession(
  supabase: any,
  userId: number,
  callbackSeq: number
): Promise<boolean> {
  const currentSeq = await getSessionSeq(supabase, userId);
  // Legacy callback (no prefix): only allow if user has never issued a command yet
  if (callbackSeq === 0) return currentSeq === 0;
  // New callback with prefix: must match current session
  return callbackSeq === currentSeq;
}
