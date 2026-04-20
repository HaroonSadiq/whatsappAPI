/**
 * api/index.js
 * Vercel serverless entry point for the full WhatsApp Support Platform.
 *
 * Forwards every incoming request through the httpServer's request listener,
 * which chains Socket.IO (polling transport) → Express (all app routes + static files).
 */

import { httpServer } from "../src/server.js";

export default function handler(req, res) {
  httpServer.emit("request", req, res);
}
