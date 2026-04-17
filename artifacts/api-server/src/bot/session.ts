import { logger } from "../lib/logger";
import fs from "fs";
import path from "path";
import os from "os";
import zlib from "zlib";
import { promisify } from "util";

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Prefix that identifies a valid NUTTER-XMD session string.
// Bumped to NUTTERX-MD::; so users know to regenerate after the full-state fix.
export const SESSION_PREFIX = "NUTTERX-MD::;";

export type SessionFileMap = Record<string, unknown>;

export async function loadSessionFromEnv(): Promise<{
  state: { creds: unknown; keys: unknown };
  saveCreds: () => Promise<void>;
} | null> {
  const sessionId = process.env["SESSION_ID"];
  if (!sessionId) {
    logger.info("No SESSION_ID env var found — bot will not start");
    return null;
  }

  if (!sessionId.startsWith(SESSION_PREFIX)) {
    logger.error(
      { prefix: sessionId.slice(0, 16) },
      `Invalid SESSION_ID: must start with "${SESSION_PREFIX}". Re-pair your device on the pairing page to get a new SESSION_ID.`
    );
    return null;
  }

  const encoded = sessionId.slice(SESSION_PREFIX.length);

  try {
    const raw = Buffer.from(encoded, "base64");

    let jsonStr: string;
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
      const decompressed = await gunzip(raw);
      jsonStr = decompressed.toString("utf-8");
    } else {
      jsonStr = raw.toString("utf-8");
    }

    const fileMap = JSON.parse(jsonStr) as SessionFileMap;

    const { useMultiFileAuthState } = await import("@whiskeysockets/baileys");

    const sessionDir = path.join(os.tmpdir(), `nutter-xmd-session-${process.pid}`);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionDir, { recursive: true });

    const fileCount = Object.keys(fileMap).length;
    for (const [filename, content] of Object.entries(fileMap)) {
      fs.writeFileSync(path.join(sessionDir, filename), JSON.stringify(content), "utf-8");
    }

    const authState = await useMultiFileAuthState(sessionDir);
    logger.info({ sessionDir, fileCount }, "Session loaded from SESSION_ID env var");
    return authState;
  } catch (err) {
    logger.error({ err }, "Failed to parse SESSION_ID — re-pair on the pairing page to get a new one");
    return null;
  }
}

// SESSION_ID encoding strategy — keep it tiny (< 2 KB encoded):
//
//   ONLY creds.json is included. This matches how bots like KEITH work
//   (their SESSION_ID decodes to exactly the creds.json object, ~1.9 KB).
//
//   Why creds.json is enough:
//     • noiseKey / signedIdentityKey / signedPreKey → reconnects to WA servers
//     • nextPreKeyId / firstUnuploadedPreKeyId      → Baileys generates a FRESH
//       batch of one-time pre-keys on every startup and uploads them to WA
//     • All other fields (registrationId, account, etc.) → re-used as-is
//
//   What happens to existing Signal sessions / group sender-keys:
//     • Baileys has no session-*.json / sender-key-*.json on startup
//     • First message from a contact: getMessage returns undefined →
//       Baileys sends key-retry → contact retransmits with fresh pre-key
//       → session re-established (~15-30 s delay, one time only)
//     • Group sender keys: re-exchanged automatically on group reconnect
//
//   Estimated SESSION_ID size: ~1.5-2 KB — well within Heroku's 64 KB limit.
export async function encodeSessionToBase64(fileMap: SessionFileMap): Promise<string> {
  const creds = fileMap["creds.json"];
  if (!creds) {
    // Fallback: if for some reason creds.json is absent, encode everything
    logger.warn("creds.json not found in fileMap — encoding all files as fallback");
    const json       = Buffer.from(JSON.stringify(fileMap), "utf-8");
    const compressed = await gzip(json);
    const encoded    = SESSION_PREFIX + compressed.toString("base64");
    logger.info({ byteLength: encoded.length }, "SESSION_ID size (fallback, all files)");
    return encoded;
  }

  // Wrap in file-map so the decoder (loadSessionFromEnv) can write it to disk
  const toEncode = { "creds.json": creds };

  const json       = Buffer.from(JSON.stringify(toEncode), "utf-8");
  const compressed = await gzip(json);
  const encoded    = SESSION_PREFIX + compressed.toString("base64");
  logger.info({ byteLength: encoded.length }, "SESSION_ID size (creds.json only)");
  return encoded;
}
