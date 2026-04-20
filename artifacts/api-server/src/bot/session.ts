import { logger } from "../lib/logger";
import fs from "fs";
import path from "path";
import os from "os";
import zlib from "zlib";
import { promisify } from "util";

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const SESSION_PREFIX = "NUTTERX-MD::;";

export type SessionFileMap = Record<string, unknown>;

// Use a fixed directory name — NOT process.pid (which is always 4 on Heroku).
// The old pid-based name caused the directory to be deleted and recreated on
// every restart, wiping all Signal keys Baileys accumulated at runtime and
// causing verifyMAC / Bad MAC decryption failures on every redeploy.
const SESSION_DIR = path.join(os.tmpdir(), "nutter-xmd-session");

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
    logger.error("❌ SESSION_ID env var is not set — set it in Heroku Config Vars.");
    return null;
  }

  logger.info(
    { length: sessionId.length, prefix: sessionId.slice(0, 20) },
    "🔑 SESSION_ID found — checking prefix"
  );

  if (!sessionId.startsWith(SESSION_PREFIX)) {
    logger.error(
      { expected: SESSION_PREFIX, got: sessionId.slice(0, 20) },
      "❌ Invalid SESSION_ID prefix — re-pair on the pairing page to get a new SESSION_ID."
    );
    return null;
  }

  const encoded = sessionId.slice(SESSION_PREFIX.length);
  logger.info({ encodedLength: encoded.length }, "🔑 Encoded payload extracted");

  let fileMap: SessionFileMap;

  try {
    const raw = Buffer.from(encoded, "base64");
    logger.info({ rawBytes: raw.length, isGzip: raw[0] === 0x1f && raw[1] === 0x8b }, "🗜 Base64 decoded");

    let jsonStr: string;
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
      const decompressed = await gunzip(raw);
      jsonStr = decompressed.toString("utf-8");
      logger.info({ decompressedBytes: decompressed.length }, "🗜 Gzip decompressed");
    } else {
      jsonStr = raw.toString("utf-8");
      logger.info({ rawBytes: raw.length }, "📄 No compression — using raw");
    }

    fileMap = JSON.parse(jsonStr) as SessionFileMap;
  } catch (err) {
    logger.error({ err }, "❌ SESSION_ID is corrupted — re-pair on the pairing page to get a new one.");
    return null;
  }

  const fileKeys       = Object.keys(fileMap);
  const hasCreds       = fileKeys.includes("creds.json");
  const preKeyCount    = fileKeys.filter((f) => f.startsWith("pre-key-")).length;
  const sessionCount   = fileKeys.filter((f) => f.startsWith("session-")).length;
  const senderKeyCount = fileKeys.filter((f) => f.startsWith("sender-key-")).length;

  logger.info(
    { totalFiles: fileKeys.length, hasCreds, preKeyCount, sessionCount, senderKeyCount },
    "📋 SESSION_ID file inventory"
  );

  if (!hasCreds) {
    logger.error("❌ SESSION_ID is missing creds.json — re-pair to get a valid SESSION_ID.");
    return null;
  }

  // Create session directory if it doesn't exist yet (fresh dyno).
  // If it already exists, its files are more current than the SESSION_ID
  // snapshot so we preserve them and only fill in any missing files.
  const sessionDir  = SESSION_DIR;
  const isFirstBoot = !fs.existsSync(sessionDir);

  if (isFirstBoot) {
    fs.mkdirSync(sessionDir, { recursive: true });
    logger.info({ sessionDir }, "📁 Fresh session directory created");
  } else {
    const existing = fs.readdirSync(sessionDir).length;
    logger.info({ sessionDir, existingFiles: existing }, "📁 Reusing existing session directory");
  }

  // Write files from SESSION_ID only if they don't already exist on disk.
  // On-disk files were written by Baileys at runtime and are always newer.
  let written = 0;
  let skipped = 0;
  for (const [filename, content] of Object.entries(fileMap)) {
    const filePath = path.join(sessionDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(content), "utf-8");
      written++;
    } else {
      skipped++;
    }
  }

  logger.info({ written, skipped }, "📝 Session files written (skipped = newer runtime copy already on disk)");

  let authState: Awaited<ReturnType<import("@whiskeysockets/baileys")["useMultiFileAuthState"]>>;
  try {
    const { useMultiFileAuthState } = await import("@whiskeysockets/baileys");
    authState = await useMultiFileAuthState(sessionDir);
  } catch (authErr) {
    logger.error({ authErr }, "❌ useMultiFileAuthState failed — session files may be corrupted. Re-pair to fix.");
    return null;
  }

  activeBotSessionDir = sessionDir;

  const allFiles       = fs.readdirSync(sessionDir);
  const diskSessions   = allFiles.filter((f) => f.startsWith("session-")).length;
  const diskSenderKeys = allFiles.filter((f) => f.startsWith("sender-key-") && f !== "sender-key-memory.json").length;
  const diskPreKeys    = allFiles.filter((f) => f.startsWith("pre-key-")).length;
  const hasDiskCreds   = allFiles.includes("creds.json");

  logger.info(
    {
      sessionDir,
      totalOnDisk: allFiles.length,
      hasCreds: hasDiskCreds,
      preKeys: diskPreKeys,
      sessions: diskSessions,
      senderKeys: diskSenderKeys,
    },
    "✅ Session loaded — Baileys auth state ready"
  );

  return authState;
}

const MAX_PREKEYS           = 50;
const SESSION_RAW_BUDGET    = 150_000;
const SENDER_KEY_RAW_BUDGET = 120_000;

export async function encodeSessionToBase64(fileMap: SessionFileMap): Promise<string> {
  const toEncode: SessionFileMap = {};

  if (fileMap["creds.json"]) {
    toEncode["creds.json"] = fileMap["creds.json"];
  } else {
    logger.warn("creds.json not found in fileMap — SESSION_ID may be invalid");
  }

  // Pre-key files — take the newest MAX_PREKEYS
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

  // Session files — include up to budget
  let sessionRawBytes = 0;
  const sessionFiles = Object.keys(fileMap)
    .filter((f) => f.startsWith("session-") && f.endsWith(".json"))
    .sort();

  for (const f of sessionFiles) {
    const size = JSON.stringify(fileMap[f]).length;
    if (sessionRawBytes + size > SESSION_RAW_BUDGET) break;
    toEncode[f] = fileMap[f];
    sessionRawBytes += size;
  }

  const sessionCount = Object.keys(toEncode).filter((f) => f.startsWith("session-")).length;

  // Sender-key files — sort newest modified first so active group keys survive
  // when the budget is hit (old alphabetical sort dropped the newest keys)
  if (fileMap["sender-key-memory.json"]) {
    toEncode["sender-key-memory.json"] = fileMap["sender-key-memory.json"];
  }

  const sessionDirForStat = activeBotSessionDir ?? os.tmpdir();
  let senderKeyRawBytes   = 0;

  const senderKeyFiles = Object.keys(fileMap)
    .filter((f) => f.startsWith("sender-key-") && f.endsWith(".json") && f !== "sender-key-memory.json")
    .sort((a, b) => {
      try {
        const mtimeA = fs.statSync(path.join(sessionDirForStat, a)).mtimeMs;
        const mtimeB = fs.statSync(path.join(sessionDirForStat, b)).mtimeMs;
        return mtimeB - mtimeA;
      } catch {
        return a.localeCompare(b);
      }
    });

  for (const f of senderKeyFiles) {
    const size = JSON.stringify(fileMap[f]).length;
    if (senderKeyRawBytes + size > SENDER_KEY_RAW_BUDGET) break;
    toEncode[f] = fileMap[f];
    senderKeyRawBytes += size;
  }

  const senderKeyCount = Object.keys(toEncode).filter((f) => f.startsWith("sender-key-")).length;

  logger.info(
    {
      totalFiles:   Object.keys(toEncode).length,
      preKeys:      preKeyFiles.length,
      sessions:     sessionCount,
      senderKeys:   senderKeyCount,
      sessionBytes: sessionRawBytes,
      senderBytes:  senderKeyRawBytes,
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
      "⚠️ SESSION_ID approaching Heroku 64 KB limit — consider re-pairing."
    );
  } else {
    logger.info({ charLen, herokuLimit: 65536 }, "✅ SESSION_ID size OK");
  }

  return encoded;
}
