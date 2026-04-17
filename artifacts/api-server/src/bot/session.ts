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

// SESSION_ID encoding strategy — creds + pre-keys only:
//
//   WHY pre-key-*.json files are REQUIRED:
//     When a contact sends a message, WhatsApp's server gives them one of the
//     bot's pre-keys to establish a Signal session.  Without the matching
//     private key file on disk, decryption fails with "Key used already or
//     never filled" — and Baileys treats that as a SILENT failure (just ACKs,
//     NO retry sent).  Having the pre-key files on disk is the only fix.
//
//   WHY not session-*.json / sender-key-*.json?
//     Those files are large and re-established automatically:
//       session-*     → P2P Signal sessions (automatic retry via getMessage)
//       sender-key-*  → Group keys (re-exchanged on bot reconnect)
//       app-state-sync-* → Not needed for message decryption at all
//
//   SIZE: fresh pair generates ~30 pre-keys × ~300 bytes = ~9 KB raw
//         → ~2.5 KB gzip → ~3.5 KB base64 → well under Heroku's 64 KB limit.
//
//   Safety cap MAX_PREKEYS: keep only the highest-ID (most recent) keys.
//   WA server holds at most 30 pre-keys per device at a time.
const MAX_PREKEYS = 50;

export async function encodeSessionToBase64(fileMap: SessionFileMap): Promise<string> {
  const toEncode: SessionFileMap = {};

  // Always include creds.json (reconnection identity)
  if (fileMap["creds.json"]) {
    toEncode["creds.json"] = fileMap["creds.json"];
  } else {
    logger.warn("creds.json not found in fileMap — SESSION_ID may be invalid");
  }

  // Collect pre-key files, sort ascending by numeric ID, take last MAX_PREKEYS
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

  logger.info(
    { totalFiles: Object.keys(toEncode).length, preKeys: preKeyFiles.length },
    "Encoding session (creds + pre-keys)"
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
