import "dotenv/config";

export const SANDBOX_PORT = process.env.SANDBOX_PORT || 3002;
export const BASE_URL = process.env.SANDBOX_BASE_URL || `http://localhost:${SANDBOX_PORT}`;
export const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
