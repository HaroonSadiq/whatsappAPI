/**
 * classifier.js
 * Gemini-powered message classifier and responder.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { PRODUCT_KB } from "./knowledge-base.js";

if (!process.env.GEMINI_API_KEY) {
  console.warn("[Classifier] GEMINI_API_KEY is not set — AI classification will be unavailable.");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

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

    // Robust JSON extraction: find first { and last }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error('No JSON object found in response');
    }
    const jsonStr = text.slice(firstBrace, lastBrace + 1);
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
