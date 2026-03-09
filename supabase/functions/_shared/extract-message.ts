// WhatsApp message extraction and validation utilities
import type { SimplifiedMessage, WhatsAppWebhookPayload } from './types.ts';

/**
 * Extract a valid WhatsApp message from the webhook payload.
 * Returns the most recent text/audio/location message, or null if none found.
 */
export function extractValidWhatsappMessage(
  payload: WhatsAppWebhookPayload,
): SimplifiedMessage | null {
  const allMessages: SimplifiedMessage[] = [];

  payload.entry?.forEach((entry) => {
    entry.changes?.forEach((change) => {
      const from = change.value?.messages?.[0]?.from;
      const waId = change.value?.contacts?.[0]?.wa_id;
      const profileName = change.value?.contacts?.[0]?.profile?.name;

      if (!from || !waId) return;

      change.value?.messages?.forEach((message) => {
        const { type, timestamp } = message;

        if (type === 'text') {
          allMessages.push({
            type,
            from,
            waId,
            timestamp,
            id: message.id,
            text: message.text?.body || '',
            profileName,
          });
        }

        if (type === 'interactive') {
          const replyType = message.interactive?.type;
          if (replyType === 'list_reply' && message.interactive?.list_reply) {
            allMessages.push({
              type: 'text',
              from,
              waId,
              timestamp,
              id: message.id,
              text: message.interactive.list_reply.id || '',
              profileName,
            });
          }
          if (
            replyType === 'button_reply' &&
            message.interactive?.button_reply
          ) {
            allMessages.push({
              type: 'text',
              from,
              waId,
              timestamp,
              id: message.id,
              text: message.interactive.button_reply.id || '',
              profileName,
            });
          }
        }

        if (type === 'audio') {
          allMessages.push({
            type,
            from,
            waId,
            timestamp,
            id: message.id,
            audioId: message.audio?.id,
            mimeType: message.audio?.mime_type,
            profileName,
          });
        }

        if (type === 'location') {
          allMessages.push({
            type,
            from,
            waId,
            timestamp,
            id: message.id,
            location: {
              address: message.location?.address || '',
              latitude: message.location?.latitude || 0,
              longitude: message.location?.longitude || 0,
              name: message.location?.name || '',
            },
            profileName,
          });
        }
      });
    });
  });

  if (allMessages.length === 0) return null;

  return allMessages.sort(
    (a, b) => Number(b.timestamp) - Number(a.timestamp),
  )[0];
}
