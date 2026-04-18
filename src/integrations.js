/**
 * integrations.js
 * Outbound integrations — fires events to external systems when key things happen.
 *
 * Supported:
 *  - Slack      → POST to Slack Incoming Webhook URL
 *  - Webhook    → POST JSON to any CRM / custom endpoint
 *  - Google Sheets → append row via Google Apps Script Web App URL
 *  - Email      → send via any SMTP-compatible service (uses fetch to a relay)
 *
 * Each integration is enabled/disabled via the toggles object below.
 * Toggle state can be changed at runtime via the dashboard or POST /integrations/toggle.
 */

// ─── Toggle state (runtime — reset on server restart) ───────────────────────
export const integrationState = {
  slack:   !!process.env.SLACK_WEBHOOK_URL,
  sheets:  !!process.env.GOOGLE_SHEETS_URL,
  webhook: !!process.env.OUTBOUND_WEBHOOK_URL,
  email:   !!process.env.EMAIL_WEBHOOK_URL,
};

// ─── Fire all enabled integrations for an event ──────────────────────────────

/**
 * Called when a message is escalated to a human agent.
 */
export async function onEscalation({ customerPhone, customerName, category, sentiment, reason, message, agentName }) {
  const payload = {
    event: "escalation",
    timestamp: new Date().toISOString(),
    customer: { phone: customerPhone, name: customerName },
    category,
    sentiment,
    reason,
    message,
    assignedAgent: agentName,
  };

  await Promise.allSettled([
    integrationState.slack   && notifySlack(`🔔 *Escalation — ${category.toUpperCase()}*\n*Customer:* ${customerName} (+${customerPhone})\n*Sentiment:* ${sentiment}\n*Reason:* ${reason}\n*Message:* "${message}"\n*Agent:* ${agentName}`),
    integrationState.webhook && postWebhook(payload),
    integrationState.sheets  && appendSheet({ ...payload, type: "escalation" }),
    integrationState.email   && sentiment === "frustrated" && sendEmailAlert(payload),
  ]);
}

/**
 * Called when a customer rates their experience.
 */
export async function onRating({ customerPhone, customerName, score }) {
  const payload = {
    event: "rating",
    timestamp: new Date().toISOString(),
    customer: { phone: customerPhone, name: customerName },
    score,
  };

  const stars = "⭐".repeat(score);
  await Promise.allSettled([
    integrationState.slack   && score <= 2 && notifySlack(`⚠️ *Low Rating: ${score}/5 ${stars}*\n*Customer:* ${customerName} (+${customerPhone})`),
    integrationState.webhook && postWebhook(payload),
    integrationState.sheets  && appendSheet({ ...payload, type: "rating" }),
  ]);
}

/**
 * Called when an FAQ is answered automatically.
 */
export async function onFaqAnswered({ customerPhone, customerName, category, message, reply }) {
  const payload = {
    event: "faq_answered",
    timestamp: new Date().toISOString(),
    customer: { phone: customerPhone, name: customerName },
    category,
    message,
    reply,
  };

  await Promise.allSettled([
    integrationState.webhook && postWebhook(payload),
    integrationState.sheets  && appendSheet({ ...payload, type: "faq" }),
  ]);
}

// ─── Integration helpers ──────────────────────────────────────────────────────

async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  console.log("[Integration] Slack notified");
}

async function postWebhook(payload) {
  const url = process.env.OUTBOUND_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log("[Integration] Webhook fired →", url);
}

async function appendSheet(row) {
  const url = process.env.GOOGLE_SHEETS_URL;
  if (!url) return;
  // Google Apps Script Web App — accepts POST with JSON row data
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(row),
  });
  console.log("[Integration] Google Sheet updated");
}

async function sendEmailAlert(payload) {
  const url = process.env.EMAIL_WEBHOOK_URL;
  if (!url) return;
  // Relay service (e.g. Make.com / Zapier webhook → Gmail)
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: `⚠️ Frustrated Customer — ${payload.customer.name}`,
      body: `Customer ${payload.customer.name} (+${payload.customer.phone}) is frustrated.\n\nMessage: ${payload.message}\nReason: ${payload.reason}`,
      ...payload,
    }),
  });
  console.log("[Integration] Email alert sent");
}
