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
    logger.error("❌ SESSION_ID not set.");
    return null;
  }

  logger.info({ length: sessionId.length, prefix: sessionId.slice(0, 20) }, "🔑 SESSION_ID found");

  if (!sessionId.startsWith(SESSION_PREFIX)) {
    logger.error({ expected: SESSION_PREFIX, got: sessionId.slice(0, 20) }, "❌ Invalid SESSION_ID prefix — re-pair on the pairing page.");
    return null;
  }

  const encoded = sessionId.slice(SESSION_PREFIX.length);

  let fileMap: SessionFileMap;
  try {
    const raw = Buffer.from(encoded, "base64");
    let jsonStr: string;
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
      jsonStr = (await gunzip(raw)).toString("utf-8");
    } else {
      jsonStr = raw.toString("utf-8");
    }
    fileMap = JSON.parse(jsonStr) as SessionFileMap;
  } catch (err) {
    logger.error({ err }, "❌ SESSION_ID corrupted — re-pair to get a new one.");
    return null;
  }

  const fileKeys = Object.keys(fileMap);
  const hasCreds = fileKeys.includes("creds.json");
  logger.info(
    {
      totalFiles: fileKeys.length,
      hasCreds,
      preKeys: fileKeys.filter(f => f.startsWith("pre-key-")).length,
      sessions: fileKeys.filter(f => f.startsWith("session-")).length,
      senderKeys: fileKeys.filter(f => f.startsWith("sender-key-")).length,
    },
    "📋 SESSION_ID inventory"
  );

  if (!hasCreds) {
    logger.error("❌ creds.json missing — re-pair to get a valid SESSION_ID.");
    return null;
  }

  const sessionDir  = SESSION_DIR;
  const isFirstBoot = !fs.existsSync(sessionDir);

  if (isFirstBoot) {
    fs.mkdirSync(sessionDir, { recursive: true });
    logger.info({ sessionDir }, "📁 Fresh session directory created");
  } else {
    logger.info({ sessionDir, existingFiles: fs.readdirSync(sessionDir).length }, "📁 Reusing existing session directory");
  }

  // ── Write session files, skipping session-*.json ────────────────────────
  // session-*.json files contain per-contact Signal ratchet state tied to a
  // specific pairing. After any restart on Heroku (ephemeral /tmp), these
  // files are gone anyway. Writing them from SESSION_ID causes "Decrypted
  // message with closed session" errors when the saved ratchet state no longer
  // matches what WhatsApp expects.
  //
  // Strategy: NEVER write session-*.json from SESSION_ID. Always let Baileys
  // negotiate a fresh Signal session on first contact (takes 1-2 seconds per
  // contact, then cached in memory for the lifetime of the dyno). Only creds,
  // pre-keys, and sender-keys are written — those survive restarts fine.
  //
  // Purge any stale session files on disk in case they were left by a
  // previous run on the same dyno.
  let purged = 0;
  if (fs.existsSync(sessionDir)) {
    for (const f of fs.readdirSync(sessionDir)) {
      if (f.startsWith("session-") && f.endsWith(".json")) {
        try { fs.rmSync(path.join(sessionDir, f)); purged++; } catch { /* ignore */ }
      }
    }
    if (purged > 0) {
      logger.info({ purged }, "🧹 Purged stale on-disk session files");
    }
  }

  let written = 0, skipped = 0;
  for (const [filename, fileContent] of Object.entries(fileMap)) {
    // NEVER restore session-*.json from SESSION_ID — always negotiate fresh
    if (filename.startsWith("session-") && filename.endsWith(".json")) {
      skipped++;
      continue;
    }
    const filePath = path.join(sessionDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fileContent), "utf-8");
      written++;
    } else {
      skipped++;
    }
  }
  logger.info({ written, skipped, purged, note: "session-*.json intentionally skipped — fresh Signal sessions negotiated on first contact" }, "📝 Session files written");

  let authState: Awaited<ReturnType<import("@whiskeysockets/baileys")["useMultiFileAuthState"]>>;
  try {
    const { useMultiFileAuthState } = await import("@whiskeysockets/baileys");
    authState = await useMultiFileAuthState(sessionDir);
  } catch (authErr) {
    logger.error({ authErr }, "❌ useMultiFileAuthState failed — re-pair to fix.");
    return null;
  }

  activeBotSessionDir = sessionDir;
  const allFiles = fs.readdirSync(sessionDir);
  logger.info(
    {
      sessionDir,
      totalOnDisk: allFiles.length,
      hasCreds: allFiles.includes("creds.json"),
      preKeys: allFiles.filter(f => f.startsWith("pre-key-")).length,
      sessions: allFiles.filter(f => f.startsWith("session-")).length,
      senderKeys: allFiles.filter(f => f.startsWith("sender-key-") && f !== "sender-key-memory.json").length,
    },
    "✅ Session loaded — Baileys auth state ready"
  );

  // ── Auto-export enriched SESSION_ID once Baileys fully settles ───────────
  //
  // Strategy: wait for Baileys to finish its initial sync burst before
  // exporting. We track three signals that indicate the session is warm:
  //   1. contacts.upsert has fired at least once (LID mappings registered)
  //   2. At least one session-*.json file exists on disk (Signal sessions ready)
  //   3. A 90-second quiet period after the last contacts.upsert event
  //      (ensures the bulk sync is fully complete before we snapshot)
  //
  // This means:
  //   - On a brand-new pairing: export fires ~90s after contacts finish loading
  //   - On restarts with a rich SESSION_ID: export is skipped (no improvement needed)
  //   - The exported SESSION_ID is sent to Heroku logs — copy it once, never regenerate
  //
  // NOTE: This export only needs to happen ONCE after the first pairing.
  // After you update SESSION_ID in Heroku, this logic will see sessions already
  // on disk from the SESSION_ID and skip the export entirely.

  let contactsUpsertFired = false;
  let lastContactsUpsertAt = 0;
  let exportScheduled = false;

  async function doExport() {
    try {
      const currentFiles = fs.readdirSync(sessionDir);
      const sessionCount   = currentFiles.filter(f => f.startsWith("session-")).length;
      const senderKeyCount = currentFiles.filter(f => f.startsWith("sender-key-") && f !== "sender-key-memory.json").length;

      const startingSessions = fileKeys.filter(f => f.startsWith("session-")).length;

      if (sessionCount <= startingSessions && senderKeyCount === 0) {
        logger.info({ sessionCount, senderKeyCount }, "⏭ Session export skipped — no new sessions accumulated");
        return;
      }

      const updatedFileMap: SessionFileMap = {};
      for (const file of currentFiles) {
        try {
          updatedFileMap[file] = JSON.parse(fs.readFileSync(path.join(sessionDir, file), "utf-8"));
        } catch { /* skip unreadable */ }
      }

      const newSessionId = await encodeSessionToBase64(updatedFileMap);
      logger.info(
        { sessionCount, senderKeyCount, sessionIdLength: newSessionId.length },
        "✅ SESSION_ID fully enriched — Baileys sync complete. Copy the value below to Heroku SESSION_ID config var:"
      );
      logger.info({ SESSION_ID: newSessionId }, "📋 ENRICHED SESSION_ID");
    } catch (err) {
      logger.warn({ err }, "Session export failed — use .refreshsession instead");
    }
  }

  function scheduleExportAfterQuiet() {
    if (exportScheduled) return;
    exportScheduled = true;
    // Wait 90 seconds of quiet after last contacts.upsert before snapshotting.
    // This ensures Baileys has finished the full contact/session sync burst.
    const CHECK_INTERVAL = 5_000;   // check every 5s
    const QUIET_WINDOW   = 90_000;  // 90s of no new contacts.upsert = sync done
    const MAX_WAIT       = 300_000; // hard cap: export no later than 5 minutes

    const started = Date.now();

    const interval = setInterval(async () => {
      const quietFor = Date.now() - lastContactsUpsertAt;
      const elapsed  = Date.now() - started;

      const sessionCount = fs.readdirSync(sessionDir).filter(f => f.startsWith("session-")).length;
      const isReady = (contactsUpsertFired && quietFor >= QUIET_WINDOW && sessionCount > 0)
                   || elapsed >= MAX_WAIT;

      if (isReady) {
        clearInterval(interval);
        logger.info({ quietFor, elapsed, sessionCount }, "🔄 Baileys sync settled — exporting enriched SESSION_ID");
        await doExport();
      } else {
        logger.info({ quietFor, elapsed, sessionCount, waitingFor: Math.max(0, QUIET_WINDOW - quietFor) }, "⏳ Waiting for Baileys sync to settle...");
      }
    }, CHECK_INTERVAL);
  }

  // Hook into contacts.upsert to track when Baileys is syncing
  // We export the authState first so Baileys can start, then we attach
  // the export trigger via a one-time listener on the returned authState.
  // The actual listener attachment happens in connection.ts which calls
  // sock.ev.on("contacts.upsert") — we expose a callback here instead.
  (globalThis as any).__nutterOnContactsUpsert = () => {
    contactsUpsertFired = true;
    lastContactsUpsertAt = Date.now();
    scheduleExportAfterQuiet();
  };

  return authState;
}

const MAX_PREKEYS           = 50;
const SESSION_RAW_BUDGET    = 150_000;
const SENDER_KEY_RAW_BUDGET = 120_000;

export async function encodeSessionToBase64(fileMap: SessionFileMap): Promise<string> {
  const toEncode: SessionFileMap = {};

  if (fileMap["creds.json"]) toEncode["creds.json"] = fileMap["creds.json"];
  else logger.warn("creds.json not found");

  // Pre-key files — newest MAX_PREKEYS
  const preKeyFiles = Object.keys(fileMap)
    .filter(f => f.startsWith("pre-key-") && f.endsWith(".json"))
    .sort((a, b) => {
      const idA = parseInt(a.replace("pre-key-", "").replace(".json", ""), 10) || 0;
      const idB = parseInt(b.replace("pre-key-", "").replace(".json", ""), 10) || 0;
      return idA - idB;
    })
    .slice(-MAX_PREKEYS);
  for (const f of preKeyFiles) toEncode[f] = fileMap[f];

  // Session files — up to budget
  let sessionRawBytes = 0;
  for (const f of Object.keys(fileMap).filter(f => f.startsWith("session-") && f.endsWith(".json")).sort()) {
    const size = JSON.stringify(fileMap[f]).length;
    if (sessionRawBytes + size > SESSION_RAW_BUDGET) break;
    toEncode[f] = fileMap[f];
    sessionRawBytes += size;
  }

  // Sender-key files — newest first
  if (fileMap["sender-key-memory.json"]) toEncode["sender-key-memory.json"] = fileMap["sender-key-memory.json"];

  const sessionDirForStat = activeBotSessionDir ?? os.tmpdir();
  let senderKeyRawBytes = 0;
  const senderKeyFiles = Object.keys(fileMap)
    .filter(f => f.startsWith("sender-key-") && f.endsWith(".json") && f !== "sender-key-memory.json")
    .sort((a, b) => {
      try {
        return fs.statSync(path.join(sessionDirForStat, b)).mtimeMs - fs.statSync(path.join(sessionDirForStat, a)).mtimeMs;
      } catch { return a.localeCompare(b); }
    });
  for (const f of senderKeyFiles) {
    const size = JSON.stringify(fileMap[f]).length;
    if (senderKeyRawBytes + size > SENDER_KEY_RAW_BUDGET) break;
    toEncode[f] = fileMap[f];
    senderKeyRawBytes += size;
  }

  const sessionCount   = Object.keys(toEncode).filter(f => f.startsWith("session-")).length;
  const senderKeyCount = Object.keys(toEncode).filter(f => f.startsWith("sender-key-")).length;

  logger.info(
    {
      totalFiles: Object.keys(toEncode).length,
      preKeys: preKeyFiles.length,
      sessions: sessionCount,
      senderKeys: senderKeyCount,
      sessionBytes: sessionRawBytes,
      senderBytes: senderKeyRawBytes,
    },
    "Encoding session"
  );

  const compressed = await gzip(Buffer.from(JSON.stringify(toEncode), "utf-8"));
  const encoded = SESSION_PREFIX + compressed.toString("base64");

  const charLen = encoded.length;
  if (charLen > 60_000) logger.warn({ charLen }, "⚠️ SESSION_ID approaching Heroku 64 KB limit");
  else logger.info({ charLen }, "✅ SESSION_ID size OK");

  return encoded;
}
