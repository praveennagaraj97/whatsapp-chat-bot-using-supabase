// Session management service using Supabase
import { getSupabaseClient } from "./supabase-client.ts";
import type { UserSession } from "./types.ts";

/**
 * Get or create a session for the user
 */
export async function getOrCreateSession(
  userId: string,
): Promise<{ session: UserSession; isNew: boolean }> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("user_sessions")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (data && !error) {
    return { session: data as UserSession, isNew: false };
  }

  // Create new session
  const newSession: Partial<UserSession> = {
    user_id: userId,
    conversation_context: "general",
    is_processing: false,
    is_intro_sent: false,
    pause_auto_replies: false,
  };

  const { data: created, error: createError } = await supabase
    .from("user_sessions")
    .insert(newSession)
    .select()
    .single();

  if (createError) {
    console.error("Failed to create session:", createError);
    throw new Error(`Session creation failed: ${createError.message}`);
  }

  return { session: created as UserSession, isNew: true };
}

/**
 * Update session fields
 */
export async function updateSession(
  userId: string,
  data: Partial<UserSession>,
): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("user_sessions")
    .update(data)
    .eq("user_id", userId);

  if (error) {
    console.error("Failed to update session:", error);
  }
}

/**
 * Delete session
 */
export async function deleteSession(userId: string): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from("user_sessions").delete().eq("user_id", userId);
  await supabase.from("appointments").delete().eq("user_id", userId);
  await supabase.from("chat_messages").delete().eq("user_id", userId);
  await supabase.from("medicine_orders").delete().eq("user_id", userId);
  await supabase.from("queued_messages").delete().eq("user_id", userId);
}

/**
 * Reset session for a new conversation while preserving user info
 */
export async function startNewSession(
  session: UserSession,
): Promise<UserSession> {
  const supabase = getSupabaseClient();

  await supabase.from("user_sessions").delete().eq("user_id", session.user_id);

  const newSession: Partial<UserSession> = {
    user_id: session.user_id,
    user_name: session.user_name,
    user_phone: session.user_phone,
    conversation_context: "general",
    is_processing: false,
    is_intro_sent: true,
    pause_auto_replies: session.pause_auto_replies,
  };

  const { data, error } = await supabase
    .from("user_sessions")
    .insert(newSession)
    .select()
    .single();

  if (error) {
    throw new Error(`Session reset failed: ${error.message}`);
  }

  return data as UserSession;
}

/**
 * Get minutes since last session update
 */
export function getMinutesSinceSessionUpdate(session: UserSession): number {
  if (!session.updated_at) return 0;
  const updated = new Date(session.updated_at).getTime();
  return (Date.now() - updated) / 60_000;
}

/**
 * Get minutes since last user message
 */
export function getMinutesSinceLastMessage(session: UserSession): number {
  if (!session.last_message_timestamp) return 0;
  const lastTs = Number(session.last_message_timestamp) * 1000;
  if (Number.isNaN(lastTs)) return 0;
  return (Date.now() - lastTs) / 60_000;
}

/**
 * Check if session has meaningful data
 */
export function sessionHasData(session: UserSession): boolean {
  return !!(
    session.symptoms ||
    session.doctor_id ||
    session.clinic_id ||
    session.specialization ||
    session.preferred_date ||
    (session.medicine_ids && session.medicine_ids.length > 0)
  );
}
