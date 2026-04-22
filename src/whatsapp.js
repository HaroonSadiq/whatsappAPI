/**
 * whatsapp.js
 * Thin wrapper around the WhatsApp Cloud API (Meta Graph API v21.0).
 * Centralises auth headers and the message-send endpoint in one place.
 */

const BASE_URL = "https://graph.facebook.com/v21.0";

function getCredentials() {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) {
    throw new Error(
      "Missing WhatsApp credentials. Ensure PHONE_NUMBER_ID and WHATSAPP_TOKEN are set in your environment."
    );
  }
  return { phoneNumberId, token };
}

function isValidE164(phone) {
  return /^\d{10,15}$/.test(phone);
}

function sanitizePhone(phone) {
  const cleaned = String(phone).replace(/\D/g, '');
  if (!isValidE164(cleaned)) {
    throw new Error(`Invalid phone number format: ${phone}. Expected 10-15 digits.`);
  }
  return cleaned;
}

/**
 * Send a plain-text WhatsApp message.
 *
 * @param {string} to   - Recipient phone number (E.164 without "+", e.g. "923001234567")
 * @param {string} body - Message text (supports WhatsApp markdown: *bold*, _italic_)
 */
export async function sendMessage(to, body) {
  const { phoneNumberId, token } = getCredentials();
  const recipient = sanitizePhone(to);

  const res = await fetch(`${BASE_URL}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "text",
      text: { body: String(body).slice(0, 4096) },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || JSON.stringify(err);
    console.error(`[WhatsApp] ❌ sendMessage FAILED → ${recipient} | HTTP ${res.status} | ${msg}`);
    throw new Error(`WhatsApp API error (${res.status}): ${msg}`);
  }

  console.log(`[WhatsApp] ✅ Sent to ${recipient}`);
}

/**
 * Send a WhatsApp message with interactive quick-reply buttons (up to 3).
 *
 * @param {string} to
 * @param {string} bodyText       - Main message body
 * @param {{ id: string, title: string }[]} buttons - Up to 3 buttons
 */
export async function sendButtonMessage(to, bodyText, buttons) {
  const { phoneNumberId, token } = getCredentials();
  const recipient = sanitizePhone(to);

  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) {
    throw new Error("Buttons must be an array of 1–3 items");
  }

  const res = await fetch(`${BASE_URL}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) },
          })),
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || JSON.stringify(err);
    console.error(`[WhatsApp] ❌ sendButtonMessage FAILED → ${recipient} | HTTP ${res.status} | ${msg}`);
    throw new Error(`WhatsApp API error (${res.status}): ${msg}`);
  }

  console.log(`[WhatsApp] ✅ Buttons sent to ${recipient}`);
}
