// Chat history persistence
import { getSupabaseClient } from './supabase-client.ts';

/**
 * Save a received message to chat history
 */
export async function saveReceivedMessage(
  userId: string,
  message: string,
  contentType = 'text',
  timestamp?: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from('chat_messages').insert({
    user_id: userId,
    role: 'user',
    content_type: contentType,
    message,
    whatsapp_timestamp: timestamp || String(Math.floor(Date.now() / 1000)),
  });
}

/**
 * Save a sent (assistant) message to chat history
 */
export async function saveSentMessage(
  userId: string,
  message: string,
  contentType = 'text',
): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from('chat_messages').insert({
    user_id: userId,
    role: 'assistant',
    content_type: contentType,
    message,
    whatsapp_timestamp: String(Math.floor(Date.now() / 1000)),
  });
}

/**
 * Get recent chat history for context
 */
export async function getRecentHistory(
  userId: string,
  limit = 10,
): Promise<Array<{ role: string; message: string }>> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from('chat_messages')
    .select('role, message')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return (data || []).reverse();
}
