"use strict";

const { GoogleGenerativeAI } = require("@google/generative-ai");

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

// ─── Product Knowledge Base ───────────────────────────────────────────────────
const PRODUCT_KB = `
=== ELECTRONICS ===
iPhone 15 Pro:
  - Price: PKR 299,000
  - Delivery: 2–3 working days
  - Warranty: 1 year Apple official
  - Legitimacy: 100% original, authorized Apple reseller
  - Durability: Titanium frame, Ceramic Shield glass, IP68 water-resistant

Samsung QLED 55" TV:
  - Price: PKR 185,000
  - Delivery: 3–5 working days
  - Warranty: 2 years Samsung

HP ProBook Laptop 450 G10:
  - Price: PKR 120,000
  - Delivery: 1–2 working days
  - Warranty: 1 year HP
  - Legitimacy: Authorized HP partner reseller

=== CLOTHING ===
Linen Suit (Men):
  - Price: PKR 8,500
  - Delivery: 1–2 working days
  - Material: 100% pure linen, machine washable 30°C
  - Sizes: S / M / L / XL / XXL

Kurta Collection (Men/Women):
  - Price: PKR 2,500–4,500
  - Delivery: 1 working day (in-stock)
  - Material: Cotton lawn / khaddar (seasonal)
  - Sizes: S / M / L / XL / XXL

=== APPLIANCES ===
Haier Refrigerator 14 Cu Ft:
  - Price: PKR 65,000
  - Delivery: 3–5 working days (free + installation)
  - Warranty: 5 years compressor, 1 year parts

Dawlance AC 1.5 Ton Inverter:
  - Price: PKR 89,000
  - Delivery: 2–3 working days (free + installation)
  - Warranty: 3 years compressor, 1 year parts/labour

=== POLICIES ===
Returns: 7-day window, unused & original packaging. Defective: replacement in 3 working days.
Payment: COD nationwide | Bank transfer | JazzCash / Easypaisa / SadaPay
Tracking: WhatsApp link sent after dispatch.
`;

const SYSTEM_PROMPT = `You are a warm, helpful sales guide for a Pakistani e-commerce business.
- Never be pushy. Ask one question at a time.
- Keep replies short and conversational — two sentences max.
- Only use verified information from the knowledge base. Never invent facts, prices, or policies.
- If information is missing, escalate instead of guessing.

PRODUCT KNOWLEDGE BASE:
${PRODUCT_KB}

INSTRUCTIONS:
Analyse the customer message. Return ONLY valid JSON (no markdown, no explanation):

{
  "type": "faq_answer" or "escalate",
  "reply": "your response text",
  "reason": "one-line reason"
}

Answer directly (type = faq_answer) for:
- Price, delivery time, product specs, warranty, return policy, payment methods, tracking

Escalate (type = escalate) when:
- Customer asks to speak with a human
- Complaint about a specific order
- Refund or billing dispute
- Information not in the knowledge base
- Customer is frustrated
- Bulk order or custom pricing request`;

// ─── WhatsApp sender ──────────────────────────────────────────────────────────
async function sendWhatsApp(to, body) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
}

// ─── AI classifier ────────────────────────────────────────────────────────────
async function classify(message) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: SYSTEM_PROMPT,
    });
    const result = await model.generateContent(message);
    const text   = result.response.text().trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(text);
  } catch (err) {
    console.error("[Classifier] Error:", err.message);
    return {
      type:  "escalate",
      reply: "Let me connect you with our support team right away.",
      reason: `Classifier error: ${err.message}`,
    };
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // ── GET — webhook verification ──
  if (req.method === "GET") {
    const mode      = req.query["hub.mode"];
    const token     = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }

  // ── POST — incoming message ──
  if (req.method === "POST") {
    res.sendStatus(200); // Acknowledge Meta immediately

    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg     = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!msg) return;

    const phone = msg.from;
    const name  = contact?.profile?.name?.split(" ")[0] || "there";

    // Button reply
    if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
      const btnId = msg.interactive.button_reply.id;
      if (btnId === "talk_to_human") {
        await sendWhatsApp(phone,
          `Got it! A team member will reach out to you shortly. Thank you for your patience. 🙏`
        ).catch(console.error);
      }
      return;
    }

    if (msg.type !== "text") return;

    const text = msg.text.body.trim();
    console.log(`📩 ${name} (+${phone}): ${text}`);

    try {
      const result = await classify(text);
      console.log(`🤖 ${result.type} | ${result.reason}`);

      if (result.type === "faq_answer") {
        await sendWhatsApp(phone, result.reply);
      } else {
        // Escalation — notify customer, no agent routing (stateless)
        const escalateMsg =
          `${result.reply}\n\n` +
          `Our team will reach out to you on WhatsApp shortly. ` +
          `You can also call/WhatsApp us directly at +92 323 475 8743.`;
        await sendWhatsApp(phone, escalateMsg);
      }
    } catch (err) {
      console.error("[Webhook] Error:", err);
      await sendWhatsApp(phone,
        "Sorry, something went wrong on our end. Please try again or contact us directly."
      ).catch(() => {});
    }

    return;
  }

  res.sendStatus(405);
};
