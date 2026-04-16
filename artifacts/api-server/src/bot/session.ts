import { logger } from "../lib/logger";

export interface AuthState {
  creds: unknown;
  keys: unknown;
}

export function loadSessionFromEnv(): AuthState | null {
  const sessionId = process.env["SESSION_ID"];
  if (!sessionId) {
    logger.info("No SESSION_ID env var found — bot will not start");
    return null;
  }

  try {
    const decoded = Buffer.from(sessionId, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as AuthState;
    logger.info("Session loaded from SESSION_ID env var");
    return parsed;
  } catch (err) {
    logger.error({ err }, "Failed to parse SESSION_ID — ensure it is a valid base64-encoded JSON string");
    return null;
  }
}

export function encodeSessionToBase64(state: AuthState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64");
}
