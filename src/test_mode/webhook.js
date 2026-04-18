import { sendMessage } from "../whatsapp.js";
import {
  generateId, findOpenSessionByCustomer, createSession,
  enqueueSession, logMessage, findAvailableAgentByCategory,
  getCustomer
} from "./store.js";
import { BASE_URL } from "./config.js";

async function safeSend(to, text) {
  try {
    await sendMessage(to, text);
  } catch (err) {
    console.error(`[TEST_MODE] Failed to send WhatsApp message to ${to}:`, err.message);
  }
}

/**
 * TEST_MODE webhook handler.
 * Replaces the normal conversation flow when TEST_MODE=true.
 */
export async function handleTestModeWebhook(req, res) {
  res.sendStatus(200); // Ack immediately

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg || msg.type !== "text") return;

  const customerPhone = msg.from;
  const text = msg.text.body.trim();

  // If customer already has an open session, redirect to link
  const openSession = findOpenSessionByCustomer(customerPhone);
  if (openSession) {
    await safeSend(customerPhone,
      `You have an active support session. Please continue here:\n${BASE_URL}/support/${openSession.session_id}`
    );
    return;
  }

  // Create new support session
  const sessionId = generateId("sess_");
  const supportLink = `${BASE_URL}/support/${sessionId}`;
  const nowIso = new Date().toISOString();
  const customer = getCustomer(customerPhone);

  createSession({
    session_id: sessionId,
    customer_phone: customerPhone,
    customer_name: customer?.name || customerPhone,
    status: "waiting",
    category: "Tech",
    created_at: nowIso
  });

  logMessage(sessionId, "system", "system", `Support link generated: ${supportLink}`, { type: "link_generated" });
  enqueueSession("Tech", sessionId);

  // Notify customer
  await safeSend(customerPhone,
    `Support request received.\n\n` +
    `Click to chat with an agent:\n${supportLink}\n\n` +
    `Please do not reply directly to this WhatsApp number.`
  );

  // Nudge available agent
  const availableAgent = findAvailableAgentByCategory("Tech");
  if (availableAgent) {
    await safeSend(availableAgent.phone,
      `New Tech support session waiting. Open dashboard to accept: ${BASE_URL}/test-dashboard.html`
    );
  }

  console.log(`[TEST_MODE] Created session ${sessionId} for ${customerPhone}`);
}
