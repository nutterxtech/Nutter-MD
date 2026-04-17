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

// Tracks the active bot session directory (set when the bot successfully loads
// its session). Used by the /bot/refresh-session endpoint to export a fresh
// SESSION_ID that includes all sender-key + session files accumulated at runtime.
let activeBotSessionDir: string | null = null;

export function getActiveBotSessionDir(): string | null {
  return activeBotSessionDir;
}

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
    activeBotSessionDir = sessionDir;
    logger.info({ sessionDir, fileCount }, "Session loaded from SESSION_ID env var");
    return authState;
  } catch (err) {
    logger.error({ err }, "Failed to parse SESSION_ID — re-pair on the pairing page to get a new one");
    return null;
  }
}

// SESSION_ID encoding strategy — creds + pre-keys + P2P sessions + sender keys:
//
//   creds.json             — always required (identity / reconnection keys)
//
//   pre-key-*.json         — REQUIRED for new contacts.
//     WA server gives a contact one of our pre-keys when they first message us.
//     Without the private key on disk, Baileys fails silently (ACKs the message,
//     never retries). Keeping up to MAX_PREKEYS newest keys covers all active ones.
//
//   session-*.json         — REQUIRED for fast DM decryption.
//     These are the P2P Signal ratchet states (~1-2 KB each). Without them,
//     every contact's FIRST message after each redeploy fails to decrypt and
//     triggers a 30-120 s retry round-trip before the bot can reply.
//
//   sender-key-*.json      — CRITICAL: without these ALL group messages are delayed
//   sender-key-memory.json   2 minutes every redeploy. WhatsApp uses sender keys
//                            (not P2P sessions) for group encryption. If the key
//                            is missing, WA holds the message and retries after
//                            ~60-120 s once a fresh key is exchanged. Including
//                            these files makes group commands instant.
//
//   NOT included: app-state-sync-* (chat history sync, not needed for decryption)
//
//   SIZE budget (raw JSON → gzip → base64, must stay under Heroku 64 KB limit):
//     creds (~1 KB) + 50 pre-keys (~15 KB) + 150 KB sessions + 120 KB sender-keys
//     → combined raw ~290 KB → gzip ~50-55 KB → base64 ~72 KB.
//     The 60 000 char warning fires if approaching that limit; trim budgets if hit.
const MAX_PREKEYS = 50;

// Budget for session-*.json files (raw JSON bytes).
const SESSION_RAW_BUDGET = 150_000;

// Budget for sender-key-*.json files (raw JSON bytes).
// sender-key files are ~0.5-2 KB each; 120 KB raw covers 60-240 active senders.
// Combined with sessions this gzips to ~50 KB — safely under the 64 KB limit.
const SENDER_KEY_RAW_BUDGET = 120_000;

export async function encodeSessionToBase64(fileMap: SessionFileMap): Promise<string> {
  const toEncode: SessionFileMap = {};

  // Always include creds.json (reconnection identity)
  if (fileMap["creds.json"]) {
    toEncode["creds.json"] = fileMap["creds.json"];
  } else {
    logger.warn("creds.json not found in fileMap — SESSION_ID may be invalid");
  }

  // ── Pre-key files: needed so new contacts can establish Signal sessions ───────
  // Sort ascending by numeric ID, take last MAX_PREKEYS (highest = most recent)
  const preKeyFiles = Object.keys(fileMap)
    .filter((f) => f.startsWith("pre-key-") && f.endsWith(".json"))
    .sort((a, b) => {
      const idA = parseInt(a.replace("pre-key-", "").replace(".json", ""), 10) || 0;
      const idB = parseInt(b.replace("pre-key-", "").replace(".json", ""), 10) || 0;
      return idA - idB;
    })
    .slice(-MAX_PREKEYS);

  for (const f of preKeyFiles) {
    toEncode[f] = fileMap[f];
  }

  // ── Session files: preserve Signal sessions with existing contacts ────────────
  // Without these, every contact needs a retry round-trip (30-60 s delay) after
  // redeployment because the bot cannot decrypt their first message.
  // With them, the bot decrypts immediately using the saved Signal chain state.
  let sessionRawBytes = 0;
  const sessionFiles = Object.keys(fileMap)
    .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
    .sort(); // consistent order; all are equally "recent" from WA's perspective

  for (const f of sessionFiles) {
    const size = JSON.stringify(fileMap[f]).length;
    if (sessionRawBytes + size > SESSION_RAW_BUDGET) break;
    toEncode[f] = fileMap[f];
    sessionRawBytes += size;
  }

  const sessionCount = Object.keys(toEncode).filter((f) => f.startsWith("session-")).length;

  // ── Sender-key files: prevent 2-minute group message delays ─────────────────
  // sender-key-memory.json is the index file Baileys reads first — include it
  // unconditionally (it is small, usually <5 KB).
  if (fileMap["sender-key-memory.json"]) {
    toEncode["sender-key-memory.json"] = fileMap["sender-key-memory.json"];
  }

  let senderKeyRawBytes = 0;
  const senderKeyFiles = Object.keys(fileMap)
    .filter((f) => f.startsWith("sender-key-") && f.endsWith(".json") && f !== "sender-key-memory.json")
    .sort();

  for (const f of senderKeyFiles) {
    const size = JSON.stringify(fileMap[f]).length;
    if (senderKeyRawBytes + size > SENDER_KEY_RAW_BUDGET) break;
    toEncode[f] = fileMap[f];
    senderKeyRawBytes += size;
  }

  const senderKeyCount = Object.keys(toEncode).filter((f) => f.startsWith("sender-key-")).length;

  logger.info(
    {
      totalFiles: Object.keys(toEncode).length,
      preKeys: preKeyFiles.length,
      sessions: sessionCount,
      senderKeys: senderKeyCount,
    },
    "Encoding session (creds + pre-keys + sessions + sender-keys)"
  );

  const json       = Buffer.from(JSON.stringify(toEncode), "utf-8");
  const compressed = await gzip(json);
  const encoded    = SESSION_PREFIX + compressed.toString("base64");

  const charLen = encoded.length;
  if (charLen > 60_000) {
    logger.warn(
      { charLen, herokuLimit: 65536 },
      "SESSION_ID is large — approaching Heroku 64 KB limit. Consider re-pairing."
    );
  } else {
    logger.info(
      { charLen, herokuLimit: 65536 },
      "SESSION_ID size OK"
    );
  }
  return encoded;
}
