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

// ── Stable session directory ──────────────────────────────────────────────────
// Using a fixed name (not process.pid) so the directory survives restarts
// within the same dyno lifetime. Baileys writes new Signal keys here at runtime;
// wiping it on restart causes verifyMAC / Bad MAC decryption failures.
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

  // ── Diagnostic: log SESSION_ID presence and prefix ────────────────────────
  if (!sessionId) {
    logger.error("❌ SESSION_ID env var is not set — bot cannot start. Set it in Heroku Config Vars.");
    return null;
  }

  logger.info(
    { length: sessionId.length, prefix: sessionId.slice(0, 20), endsWithSemicolon: sessionId.startsWith(SESSION_PREFIX) },
    "🔑 SESSION_ID found — checking prefix"
  );

  if (!sessionId.startsWith(SESSION_PREFIX)) {
    logger.error(
      { expected: SESSION_PREFIX, got: sessionId.slice(0, 20) },
      `❌ Invalid SESSION_ID prefix. Re-pair on the pairing page to get a new SESSION_ID.`
    );
    return null;
  }

  const encoded = sessionId.slice(SESSION_PREFIX.length);
  logger.info({ encodedLength: encoded.length }, "🔑 Encoded payload extracted");

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
      logger.info({ rawBytes: raw.length }, "📄 No compression detected — using raw");
    }

    // ── Validate JSON ─────────────────────────────────────────────────────────
    let fileMap: SessionFileMap;
    try {
      fileMap = JSON.parse(jsonStr) as SessionFileMap;
    } catch (parseErr) {
      logger.error({ parseErr, preview: jsonStr.slice(0, 100) }, "❌ SESSION_ID JSON is corrupted — re-pair to get a new one");
      return null;
    }

    const fileKeys = Object.keys(fileMap);
    const hasCreds       = fileKeys.includes("creds.json");
    const preKeyCount    = fileKeys.filter((f) => f.startsWith("pre-key-")).length;
    const sessionCount   = fileKeys.filter((f) => f.startsWith("session-")).length;
    const senderKeyCount = fileKeys.filter((f) => f.startsWith("sender-key-")).length;

    logger.info(
      { totalFiles: fileKeys.length, hasCreds, preKeyCount, sessionCount, senderKeyCount },
      "📋 SESSION_ID file inventory"
    );

    if (!hasCreds) {
      logger.error("❌ SESSION_ID is missing creds.json — this session cannot connect. Re-pair to get a new SESSION_ID.");
      return null;
    }

    // ── Write session files to stable directory ───────────────────────────────
    const sessionDir   = SESSION_DIR;
    const dirExists    = fs.existsSync(sessionDir);
    const isFirstBoot  = !dirExists;

    if (isFirstBoot) {
      fs.mkdirSync(sessionDir, { recursive: true });
      logger.info({ sessionDir }, "📁 Fresh session directory created");
    } else {
      const existingFiles = fs.readdirSync(sessionDir);
      logger.info({ sessionDir, existingFiles: existingFiles.length }, "📁 Reusing existing session directory");
    }

    // Write files from SESSION_ID — skip any that already exist on disk
    // (the on-disk version was written by Baileys at runtime and is newer)
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

    logger.info({ written, skipped }, "📝 Session files written (skipped = already on disk from runtime)");

    // ── Load Baileys auth state ───────────────────────────────────────────────
    const { useMultiFileAuthState } = await import("@whiskeysockets/baileys");

    let authState: Awaited<ReturnType<typeof useMultiFileAuthState>>;
    try {
      authState = await useMultiFileAuthState(sessionDir);
    } catch (authErr) {
      logger.error({ authErr }, "❌ useMultiFileAuthState failed — session files may be corrupted. Re-pair to fix.");
      return null;
    }

    activeBotSessionDir = sessionDir;

    // ── Final inventory of what's actually on disk ────────────────────────────
    const allFiles         = fs.readdirSync(sessionDir);
    const diskSessions     = allFiles.filter((f) => f.startsWith("session-")).length;
    const diskSenderKeys   = allFiles.filter((f) => f.startsWith("sender-key-") && f !== "sender-key-memory.json").length;
    const diskPreKeys      = allFiles.filter((f) => f.startsWith("pre-key-")).length;
    const hasDiskCreds     = allFiles.includes("creds.json");

    logger.info(
      {
        sessionDir,
        totalOnDisk: allFiles.length,
        hasCreds: hasDiskCreds,
        preKeys: diskPreKeys,
        sessions: diskSessions,
        senderKeys: diskSenderKeys,
      },
      "✅ Session loaded successfully — Baileys auth state ready"
    );

    if (!hasDiskCreds) {
      logger.error("❌ creds.json missing from session directory after write — this will cause immediate logout");
    }

    return authState;

  } catch (err) {
    logger.error({ err }, "❌ Failed to load SESSION_ID — re-pair on the pairing page to get a new one");
    return null;
  }
}

// ── Encoding constants ────────────────────────────────────────────────────────
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

  // ── Pre-key files ─────────────────────────────────────────────────────────
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

  // ── Session files ─────────────────────────────────────────────────────────
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

  // ── Sender-key files — sort newest first so active groups survive budget ──
  if (fileMap["sender-key-memory.json"]) {
    toEncode["sender-key-memory.json"] = fileMap["sender-key-memory.json"];
  }

  let senderKeyRawBytes = 0;
  const sessionDirForStat = activeBotSessionDir ?? os.tmpdir();

  const senderKeyFiles = Object.keys(fileMap)
    .filter((f) => f.startsWith("sender-key-") && f.endsWith(".json") && f !== "sender-key-memory.json")
    .sort((a, b) => {
      try {
        const mtimeA = fs.statSync(path.join(sessionDirForStat, a)).mtimeMs;
        const mtimeB = fs.statSync(path.join(sessionDirForStat, b)).mtimeMs;
        return mtimeB - mtimeA; // newest first
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
      "⚠️ SESSION_ID is large — approaching Heroku 64 KB limit. Consider re-pairing."
    );
  } else {
    logger.info({ charLen, herokuLimit: 65536 }, "✅ SESSION_ID size OK");
  }
  return encoded;
}    // Write SESSION_ID files — skip any file that already exists on disk
    // (the on-disk version is newer and should not be overwritten).
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

    const authState = await useMultiFileAuthState(sessionDir);
    activeBotSessionDir = sessionDir;

    const allFiles       = fs.readdirSync(sessionDir);
    const sessionFiles   = allFiles.filter((f) => f.startsWith("session-")).length;
    const senderKeyFiles = allFiles.filter((f) => f.startsWith("sender-key-") && f !== "sender-key-memory.json").length;
    const preKeyFiles    = allFiles.filter((f) => f.startsWith("pre-key-")).length;

    logger.info(
      { sessionDir, totalOnDisk: allFiles.length, written, skipped, sessionFiles, senderKeyFiles, preKeyFiles },
      "📦 Session loaded — runtime keys preserved, SESSION_ID files filled gaps"
    );
    return authState;
  } catch (err) {
    logger.error({ err }, "Failed to parse SESSION_ID — re-pair on the pairing page to get a new one");
    return null;
  }
}

// ── Encoding constants ────────────────────────────────────────────────────────
const MAX_PREKEYS = 50;
const SESSION_RAW_BUDGET    = 150_000;
const SENDER_KEY_RAW_BUDGET = 120_000;

export async function encodeSessionToBase64(fileMap: SessionFileMap): Promise<string> {
  const toEncode: SessionFileMap = {};

  if (fileMap["creds.json"]) {
    toEncode["creds.json"] = fileMap["creds.json"];
  } else {
    logger.warn("creds.json not found in fileMap — SESSION_ID may be invalid");
  }

  // ── Pre-key files ─────────────────────────────────────────────────────────
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

  // ── Session files ─────────────────────────────────────────────────────────
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

  // ── Sender-key files ──────────────────────────────────────────────────────
  if (fileMap["sender-key-memory.json"]) {
    toEncode["sender-key-memory.json"] = fileMap["sender-key-memory.json"];
  }

  // FIX: sort by most recently modified first so the newest (most active) sender
  // keys are included when the budget is hit, not the alphabetically first ones.
  // The old alphabetical sort meant the newest group sender keys were silently
  // dropped, causing 2-minute group message delays after redeploy.
  let senderKeyRawBytes = 0;
  const sessionDirForStat = activeBotSessionDir ?? os.tmpdir();
  const senderKeyFiles = Object.keys(fileMap)
    .filter((f) => f.startsWith("sender-key-") && f.endsWith(".json") && f !== "sender-key-memory.json")
    .sort((a, b) => {
      try {
        const mtimeA = fs.statSync(path.join(sessionDirForStat, a)).mtimeMs;
        const mtimeB = fs.statSync(path.join(sessionDirForStat, b)).mtimeMs;
        return mtimeB - mtimeA; // newest first
      } catch {
        return a.localeCompare(b); // fallback to alphabetical if stat fails
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
      "SESSION_ID is large — approaching Heroku 64 KB limit. Consider re-pairing."
    );
  } else {
    logger.info({ charLen, herokuLimit: 65536 }, "SESSION_ID size OK");
  }
  return encoded;
}
