/**
 * whatsapp.js
 * Thin wrapper around the WhatsApp Cloud API (Meta Graph API v19.0).
 * Centralises auth headers and the message-send endpoint in one place.
 */

const BASE_URL = "https://graph.facebook.com/v19.0";

/**
 * Send a plain-text WhatsApp message.
 *
 * @param {string} to   - Recipient phone number (E.164 without "+", e.g. "923001234567")
 * @param {string} body - Message text (supports WhatsApp markdown: *bold*, _italic_)
 */
export async function sendMessage(to, body) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  const res = await fetch(`${BASE_URL}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || JSON.stringify(err);
    console.error(`[WhatsApp] ❌ sendMessage FAILED → ${to} | HTTP ${res.status} | ${msg}`);
    throw new Error(`WhatsApp API error (${res.status}): ${msg}`);
  }

  console.log(`[WhatsApp] ✅ Sent to ${to}`);
}

/**
 * Send a WhatsApp message with interactive quick-reply buttons (up to 3).
 *
 * @param {string} to
 * @param {string} bodyText       - Main message body
 * @param {{ id: string, title: string }[]} buttons - Up to 3 buttons
 */
export async function sendButtonMessage(to, bodyText, buttons) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  const res = await fetch(`${BASE_URL}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || JSON.stringify(err);
    console.error(`[WhatsApp] ❌ sendButtonMessage FAILED → ${to} | HTTP ${res.status} | ${msg}`);
    throw new Error(`WhatsApp API error (${res.status}): ${msg}`);
  }

  console.log(`[WhatsApp] ✅ Buttons sent to ${to}`);
}
