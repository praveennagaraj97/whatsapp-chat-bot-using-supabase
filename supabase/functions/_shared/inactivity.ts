// Inactivity message storage
import { getSupabaseClient } from './supabase-client.ts';
import type { SimplifiedMessage } from './types.ts';

/**
 * Store a message during inactivity prompt
 */
export async function setInactivityMessage(
  userId: string,
  message: SimplifiedMessage,
): Promise<void> {
  const supabase = getSupabaseClient();

  // Upsert - replace any existing inactivity message for this user
  await supabase.from('inactivity_messages').upsert(
    {
      user_id: userId,
      type: message.type,
      text: message.text || null,
      audio_url: message.audioUrl || null,
      audio_id: message.audioId || null,
      mime_type: message.mimeType || null,
      message_id: message.id || null,
      timestamp: message.timestamp,
    },
    { onConflict: 'user_id' },
  );
}

/**
 * Get and delete the stored inactivity message
 */
export async function getAndClearInactivityMessage(
  userId: string,
): Promise<SimplifiedMessage | null> {
  const supabase = getSupabaseClient();

  const { data } = await supabase
    .from('inactivity_messages')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (!data) return null;

  // Delete it
  await supabase.from('inactivity_messages').delete().eq('user_id', userId);

  return {
    type: data.type as 'text' | 'audio' | 'location',
    from: userId,
    waId: userId,
    id: data.message_id,
    text: data.text,
    audioUrl: data.audio_url,
    audioId: data.audio_id,
    mimeType: data.mime_type,
    timestamp: data.timestamp,
  };
}
