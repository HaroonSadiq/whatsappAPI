# Workflow: WhatsApp E-Commerce Router

## Objective
Route incoming WhatsApp messages to the right destination:
- Auto-answer FAQs instantly using Gemini AI
- Escalate complex queries to the right human agent
- Queue customers fairly when all agents are busy

## Setup (One-time)

### 1. Install dependencies
```bash
npm install
```

### 2. Get WhatsApp Business API credentials
1. Go to https://developers.facebook.com
2. Create an App → Business → WhatsApp
3. Add a test phone number under WhatsApp > API Setup
4. Copy your `Phone Number ID` and `Access Token`
5. Paste them into `.env`

### 3. Expose localhost with ngrok
```bash
# Install ngrok: https://ngrok.com/download
ngrok http 3001
```
Copy the `https://xxxx.ngrok-free.app` URL.

### 4. Register webhook with Meta
1. In Meta Developer Portal → WhatsApp → Configuration
2. Webhook URL: `https://xxxx.ngrok-free.app/webhook`
3. Verify Token: `my_secret_verify_token_123` (matches VERIFY_TOKEN in .env)
4. Subscribe to: `messages`

### 5. Start the bot
```bash
npm start
```

## How Messages Flow

```
Customer sends WhatsApp message
        ↓
Meta sends webhook → src/server.js
        ↓
Gemini classifies message (src/classifier.js)
        ↓
      FAQ? ──→ Auto-reply instantly
        ↓
   Escalate? ──→ Find available agent (src/agents.js)
                    ↓
              Agent available? ──→ Notify agent + customer
                    ↓
              All busy? ──→ Queue customer + send ETA
```

## Agent Commands

Agents interact by calling the API or (in production) via a management interface:

**Mark chat as done:**
```
POST /agent-done
{ "agentId": "A1", "customerPhone": "923001234567" }
```
This frees the agent and auto-notifies the next customer in queue.

**Check system status:**
```
GET /status
```
Returns agent availability, active chats, and queue length.

## Updating the Knowledge Base

Edit `PRODUCT_KB` in `src/classifier.js` to add:
- Product names and prices
- Delivery times per region
- Warranty details
- Any policies specific to your store

The more detail you add, the more FAQs Gemini can answer without escalating.

## Adding New Agents

Edit `src/agents.js` → `agentRegistry`:
```js
general: [
  { id: "A1", name: "Hafiz",  number: "923234774372", status: "available" },
  { id: "A2", name: "Haroon", number: "923234758743", status: "available" },
  { id: "A3", name: "NewPerson", number: "923001234567", status: "available" }, // add here
],
```

## Edge Cases & Known Behaviors

| Situation | What happens |
|---|---|
| All agents busy | Customer queued, given ETA |
| Agent finishes chat | Next queued customer auto-assigned |
| Gemini API fails | Defaults to escalation (safe fallback) |
| Non-text message (image, voice) | Ignored (only text handled) |
| Customer messages again while in queue | Session tracked, added to context |

## Production Checklist
- [ ] Replace in-memory sessions with Redis
- [ ] Store queue in a database (PostgreSQL / MongoDB)
- [ ] Add agent management UI or Slack integration
- [ ] Use a permanent server instead of ngrok
- [ ] Set up Meta App in Live mode (not test mode)
- [ ] Rotate Gemini API key (currently in .env)
