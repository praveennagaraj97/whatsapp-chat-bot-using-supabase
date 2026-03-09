// Message queue service using Supabase
import { getSupabaseClient } from './supabase-client.ts';
import type { QueuedMessage, SimplifiedMessage } from './types.ts';

/**
 * Enqueue a message for later processing
 */
export async function enqueueMessage(
  userId: string,
  message: SimplifiedMessage,
): Promise<void> {
  const supabase = getSupabaseClient();

  const entity = {
    user_id: userId,
    type: message.type,
    text: message.text || null,
    audio_url: message.audioUrl || null,
    audio_id: message.audioId || null,
    mime_type: message.mimeType || null,
    location_address: message.location?.address || null,
    location_name: message.location?.name || null,
    location_lat: message.location?.latitude ?? null,
    location_lng: message.location?.longitude ?? null,
    message_id: message.id || null,
    timestamp: message.timestamp,
  };

  const { error } = await supabase.from('queued_messages').insert(entity);

  if (error) {
    console.error('Failed to enqueue message:', error);
  }
}

/**
 * Check if there are queued messages for this user
 */
export async function hasQueuedMessages(userId: string): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { count, error } = await supabase
    .from('queued_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  if (error) return false;
  return (count ?? 0) > 0;
}

/**
 * Drain head batch: fetches oldest N messages, respects maxAudio limit,
 * deletes them, and returns in FIFO order.
 */
export async function drainHeadBatch(
  userId: string,
  maxItems = 20,
  maxAudio = 1,
): Promise<QueuedMessage[]> {
  const supabase = getSupabaseClient();

  // Fetch oldest messages
  const { data: head, error } = await supabase
    .from('queued_messages')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(maxItems);

  if (error || !head || head.length === 0) return [];

  const toDrain: QueuedMessage[] = [];
  let audioCount = 0;

  for (const item of head) {
    if (item.type === 'audio') {
      if (audioCount >= maxAudio) break;
      audioCount += 1;
    }
    toDrain.push(item as QueuedMessage);
  }

  if (toDrain.length === 0) return [];

  // Delete the drained messages
  const ids = toDrain.map((i) => i.id);
  await supabase.from('queued_messages').delete().in('id', ids);

  return toDrain;
}

/**
 * Compose queued messages into a single SimplifiedMessage for AI processing.
 * Handles audio translation for queued audio messages.
 */
export async function composeQueuedMessages(
  original: SimplifiedMessage,
  drained: QueuedMessage[],
  translateAudio: (
    audioUrl: string,
    mimeType: string,
    userId: string,
  ) => Promise<string | null>,
): Promise<SimplifiedMessage> {
  const blocks: string[] = [
    'User sent additional messages while you were processing:',
  ];

  for (const item of drained) {
    if (item.type === 'text') {
      blocks.push(`[TEXT] ${item.text || ''}`.trim());
    } else if (item.type === 'audio' && item.audio_url) {
      try {
        const translated = await translateAudio(
          item.audio_url,
          item.mime_type || 'audio/ogg',
          original.from,
        );
        if (translated && translated.trim().length > 0) {
          blocks.push(`[AUDIO TRANSLATED] ${translated}`.trim());
        }
      } catch (e) {
        console.error(`Queue audio translation failed:`, e);
      }
    } else if (item.type === 'location') {
      const loc = JSON.stringify({
        address: item.location_address || '',
        latitude: item.location_lat,
        longitude: item.location_lng,
      });
      blocks.push(`[LOCATION] ${loc}`.trim());
    }
  }

  return {
    ...original,
    type: 'text',
    text: blocks.join('\n'),
  };
}
