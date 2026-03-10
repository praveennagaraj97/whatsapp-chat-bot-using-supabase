// Meta WhatsApp Cloud API service
import type { InteractiveListSection, InteractiveReplyButton } from "./types.ts";

const META_API_VERSION = Deno.env.get("META_WHATSAPP_API_VERSION") || "v24.0";
const GRAPH_BASE = Deno.env.get("META_GRAPH_BASE_URL") || "https://graph.facebook.com";

function getBaseUrl(): string {
  const phoneNumberId = Deno.env.get("META_WHATSAPP_PHONE_NUMBER_ID") || "";
  return `${GRAPH_BASE}/${META_API_VERSION}/${phoneNumberId}/messages`;
}

function getAccessToken(): string {
  return Deno.env.get("META_WHATSAPP_TOKEN") || "";
}

async function post(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const resp = await fetch(getBaseUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAccessToken()}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`WhatsApp API error (${resp.status}):`, err);
      return false;
    }
    return true;
  } catch (e) {
    console.error("WhatsApp API request failed:", e);
    return false;
  }
}

export function sendText(to: string, text: string): Promise<boolean> {
  return post({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

export async function sendTyping(messageId: string): Promise<boolean> {
  const phoneNumberId = Deno.env.get("META_WHATSAPP_PHONE_NUMBER_ID") || "";
  try {
    const resp = await fetch(
      `${GRAPH_BASE}/${META_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: {
            type: "text",
          },
        }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export function sendInteractiveButtons(
  to: string,
  bodyText: string,
  buttons: InteractiveReplyButton[],
  headerText?: string,
  footerText?: string,
): Promise<boolean> {
  const interactive: Record<string, unknown> = {
    type: "button",
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: "reply",
        reply: { id: b.id, title: b.title },
      })),
    },
  };
  if (headerText) interactive.header = { type: "text", text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  return post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive,
  });
}

export function sendInteractiveList(
  to: string,
  bodyText: string,
  buttonText: string,
  sections: InteractiveListSection[],
  headerText?: string,
  footerText?: string,
): Promise<boolean> {
  const interactive: Record<string, unknown> = {
    type: "list",
    body: { text: bodyText },
    action: {
      button: buttonText,
      sections: sections.map((section) => ({
        title: section.title,
        rows: section.rows.map((row) => ({
          id: row.id,
          title: row.title.slice(0, 24),
          description: row.description?.slice(0, 72),
        })),
      })),
    },
  };
  if (headerText) interactive.header = { type: "text", text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  return post({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive,
  });
}

/**
 * Get media URL from Meta Cloud API (for audio messages)
 */
export async function getMediaUrl(mediaId: string): Promise<string | null> {
  const phoneNumberId = Deno.env.get("META_WHATSAPP_PHONE_NUMBER_ID") || "";
  try {
    const resp = await fetch(
      `${GRAPH_BASE}/${META_API_VERSION}/${mediaId}?phone_number_id=${phoneNumberId}`,
      {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.url || null;
  } catch {
    return null;
  }
}

/**
 * Fetch audio as base64 from Meta-provided URL
 */
export async function fetchAudioAsBase64(audioUrl: string): Promise<string> {
  const resp = await fetch(audioUrl, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
