/**
 * classifier.js
 * Gemini-powered message classifier and responder.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
  - Durability: QLED panel, rated 100,000+ hours

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
  - Durability: High-quality stitching, colour-fast

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
  - Durability: Frost-free, inverter compressor

Dawlance AC 1.5 Ton Inverter:
  - Price: PKR 89,000
  - Delivery: 2–3 working days (free + installation)
  - Warranty: 3 years compressor, 1 year parts/labour
  - Energy: 5-star inverter

=== POLICIES ===
Returns: 7-day window, unused & original packaging. Defective: replacement in 3 working days.
Legitimacy: Registered Pakistani business (NTN verified). All products official/authorized.
Payment: COD nationwide | Bank transfer | JazzCash / Easypaisa / SadaPay
Tracking: WhatsApp link sent after dispatch. Also via order number on website.
`;

const SYSTEM_PROMPT = `You are a warm, helpful, and relaxed sales guide for a Pakistani e-commerce business.
- Never be pushy. Ask one question at a time.
- Keep replies short and conversational — two sentences max.
- Only use verified information from the knowledge base. Never invent facts, prices, or policies.
- If information is missing, escalate instead of guessing.

PRODUCT KNOWLEDGE BASE:
${PRODUCT_KB}

INSTRUCTIONS:
Analyse the latest customer message and conversation history. Return ONLY valid JSON (no markdown, no explanation):

{
  "type": "faq_answer" or "escalate",
  "productCategory": "clothing" or "tech" or "general",
  "reply": "your response text",
  "reason": "one-line reason for decision",
  "customerSentiment": "happy" or "neutral" or "frustrated",
  "showDemoOffer": true or false
}

Set "showDemoOffer": true only when the customer is clearly interested in buying a specific product.

Answer directly (type = faq_answer) for:
- Price, delivery time, product specs, durability, legitimacy, return policy, payment methods, tracking

Escalate (type = escalate) when:
- Customer asks to speak with a human / "connect me" / "support"
- Complaint about a specific order
- Refund or billing dispute
- Information not in the knowledge base
- Customer is frustrated and AI hasn't resolved it
- Bulk order or custom pricing request
- Demo booking request`;

// ─── Main export ──────────────────────────────────────────────────────────────
export async function classifyAndRespond(message, history = []) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: SYSTEM_PROMPT,
    });

    const chatHistory = history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const chat   = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(message);
    const text   = result.response.text().trim();

    const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(jsonStr);

  } catch (err) {
    console.error("[Classifier] Error:", err.message);
    return {
      type: "escalate",
      productCategory: "general",
      reply: "Let me connect you with our support team right away.",
      reason: `Classifier error: ${err.message}`,
      customerSentiment: "neutral",
      showDemoOffer: false,
    };
  }
}
