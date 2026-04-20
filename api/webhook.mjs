const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

const PRODUCT_KB = `
=== ELECTRONICS ===
iPhone 15 Pro: PKR 299,000 | Delivery 2-3 days | Warranty 1yr Apple | 100% original
Samsung QLED 55" TV: PKR 185,000 | Delivery 3-5 days | Warranty 2yr Samsung
HP ProBook Laptop 450 G10: PKR 120,000 | Delivery 1-2 days | Warranty 1yr HP

=== CLOTHING ===
Linen Suit (Men): PKR 8,500 | Delivery 1-2 days | Sizes S/M/L/XL/XXL
Kurta Collection: PKR 2,500-4,500 | Delivery 1 day | Sizes S/M/L/XL/XXL

=== APPLIANCES ===
Haier Refrigerator 14 Cu Ft: PKR 65,000 | Delivery 3-5 days free+install | Warranty 5yr compressor
Dawlance AC 1.5 Ton Inverter: PKR 89,000 | Delivery 2-3 days free+install | Warranty 3yr compressor

=== POLICIES ===
Returns: 7-day window, unused & original packaging. Defective: replacement in 3 days.
Payment: COD | Bank transfer | JazzCash / Easypaisa / SadaPay
Tracking: WhatsApp link sent after dispatch.
`;

const SYSTEM_PROMPT = `You are a helpful sales assistant for a Pakistani e-commerce store.
Keep replies short (2 sentences max). Never invent prices or facts not in the knowledge base.

KNOWLEDGE BASE:
${PRODUCT_KB}

Reply with ONLY this JSON (no markdown):
{"type":"faq_answer","reply":"your reply"}
OR
{"type":"escalate","reply":"your reply"}

Use faq_answer for: prices, delivery, warranty, specs, returns, payment, tracking.
Use escalate for: complaints, refunds, human agent requests, bulk orders, unknown products.`;

async function classify(message) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: message }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });
    const data = await res.json();
    const text = data.candidates[0].content.parts[0].text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    return JSON.parse(text);
  } catch (err) {
    console.error("[Classifier]", err.message);
    return { type: "escalate", reply: "Let me connect you with our team right away." };
  }
}

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

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode      = req.query["hub.mode"];
    const token     = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method === "POST") {
    res.status(200).end();

    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg     = value?.messages?.[0];
    const contact = value?.contacts?.[0];
    if (!msg || msg.type !== "text") return;

    const phone = msg.from;
    const name  = contact?.profile?.name?.split(" ")[0] || "there";
    const text  = msg.text.body.trim();

    console.log(`📩 ${name} (+${phone}): ${text}`);
    const result = await classify(text);
    console.log(`🤖 ${result.type}: ${result.reply}`);

    const reply = result.type === "escalate"
      ? `${result.reply}\n\nOur team will WhatsApp you shortly. You can also reach us at +92 323 475 8743.`
      : result.reply;

    await sendWhatsApp(phone, reply).catch(console.error);
  }
}
