/**
 * classifier-kimi.js
 * Kimi k2-powered message classifier and responder.
 * Uses Moonshot AI's OpenAI-compatible API.
 *
 * To switch from Gemini: set AI_CLASSIFIER=kimi in your environment.
 * Add to .env: KIMI_API_KEY=your_moonshot_api_key
 */

import OpenAI from "openai";
import { PRODUCT_KB } from "./knowledge-base.js";

const client = new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: "https://api.moonshot.cn/v1",
});

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
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    const completion = await client.chat.completions.create({
      model: "kimi-k2-0711-preview",
      messages,
      temperature: 0.3,
    });

    const text    = completion.choices[0].message.content.trim();

    // Robust JSON extraction: find first { and last }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error('No JSON object found in response');
    }
    const jsonStr = text.slice(firstBrace, lastBrace + 1);
    return JSON.parse(jsonStr);

  } catch (err) {
    console.error("[Classifier-Kimi] Error:", err.message);
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
