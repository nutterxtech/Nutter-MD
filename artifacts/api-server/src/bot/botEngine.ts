import pino from "pino";
import { Boom } from "@hapi/boom";
import { logger } from "../lib/logger";
import { loadSessionFromEnv } from "./session";
import { handleMessage, handleStatusMessage, handleGroupParticipantsUpdate } from "./handler";
import type { WASocket } from "@whiskeysockets/baileys";

const MAX_RECONNECTS = 2;
const RECONNECT_DELAY_MS = 5000;

const silentLogger = pino({ level: "silent" });

let failureCount = 0;
let hasSentWelcome = false;

export async function startBot() {
  const sessionAuth = await loadSessionFromEnv();
  if (!sessionAuth) {
    logger.info("No SESSION_ID provided — bot engine not started.");
    return;
  }

  logger.info("Starting NUTTER-XMD bot engine...");
  await connectBot(sessionAuth);
}

async function onFirstConnect(sock: WASocket) {
  if (hasSentWelcome) return;
  hasSentWelcome = true;

  const ownerNumber = (process.env["OWNER_NUMBER"] || "").replace(/\D/g, "");
  const mode = (process.env["BOT_MODE"] || "public").toLowerCase();
  const prefix = process.env["PREFIX"] || ".";
  const botNumber = (sock.user?.id || "").split(":")[0].split("@")[0];

  // ── Welcome message ──────────────────────────────────────────────────────────
  if (ownerNumber) {
    const ownerJid = `${ownerNumber}@s.whatsapp.net`;
    const welcome = [
      `✅ 𝗖𝗼𝗻𝗻𝗲𝗰𝘁𝗲𝗱  ╍>〚𝗡𝗨𝗧𝗧𝗘𝗥𝗫-𝗠𝗗〛`,
      `👥 𝗠𝗼𝗱𝗲  ╍>〚${mode}〛`,
      `👤 𝗣𝗿𝗲𝗳𝗶𝘅  ╍>〚 ${prefix} 〛`,
      botNumber ? `📱 𝗕𝗼𝘁  ╍>〚+${botNumber}〛` : "",
    ].filter(Boolean).join("\n");

    try {
      await sock.sendMessage(ownerJid, { text: welcome });
      logger.info("✅ Sent welcome message to owner");
    } catch (err) {
      logger.warn({ err }, "Could not send welcome message to owner");
    }
  } else {
    logger.warn("OWNER_NUMBER not set — skipping welcome message");
  }

  // ── Auto-join support group ───────────────────────────────────────────────────
  try {
    await sock.groupAcceptInvite("JsKmQMpECJMHyxucHquF15");
    logger.info("✅ Auto-joined NUTTER-XMD support group");
  } catch (err) {
    logger.info({ err }, "Auto-join group: already a member or invite expired");
  }

  // ── Auto-follow official channel ──────────────────────────────────────────────
  try {
    await sock.newsletterFollow("0029VbCcIrFEAKWNxpi8qR2V@newsletter");
    logger.info("✅ Auto-followed NUTTER-XMD channel");
  } catch (err) {
    logger.info({ err }, "Auto-follow channel: already following or unavailable");
  }
}

async function connectBot(sessionAuth: {
  state: { creds: unknown; keys: unknown };
  saveCreds: () => Promise<void>;
}) {
  const {
    default: makeWASocket,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
  } = await import("@whiskeysockets/baileys");

  const { default: NodeCache } = await import("node-cache");
  const msgRetryCounterCache = new NodeCache();

  let waVersion: [number, number, number] | undefined;
  try {
    const { version } = await fetchLatestBaileysVersion();
    waVersion = version;
    logger.info({ version }, "Using WhatsApp Web version");
  } catch {
    logger.warn("Could not fetch latest WA version — using Baileys default");
  }

  const sock = makeWASocket({
    version: waVersion,
    auth: sessionAuth.state as Parameters<typeof makeWASocket>[0]["auth"],
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    msgRetryCounterCache,
    logger: silentLogger,
  });

  sock.ev.on("creds.update", sessionAuth.saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      failureCount = 0;
      logger.info("✅ NUTTER-XMD connected to WhatsApp");
      void onFirstConnect(sock);
      return;
    }

    if (connection === "close") {
      const boom = lastDisconnect?.error as Boom | undefined;
      const reason = boom?.output?.statusCode;
      const message = boom?.message ?? "unknown";

      logger.warn({ reason, message }, `Connection closed — reason ${reason} (${message})`);

      if (reason === DisconnectReason.restartRequired) {
        logger.info("Restart required by server — reconnecting immediately");
        void connectBot(sessionAuth);
        return;
      }

      if (reason === DisconnectReason.loggedOut) {
        logger.error("❌ Bot logged out. Generate a new SESSION_ID from the pairing page.");
        return;
      }

      if (reason === 403) {
        logger.error("❌ Session rejected (403). Generate a new SESSION_ID from the pairing page.");
        return;
      }

      failureCount++;
      if (failureCount > MAX_RECONNECTS) {
        logger.error({ reason, failureCount }, `❌ Failed ${MAX_RECONNECTS} times. Bot stopped.`);
        process.exit(1);
      }

      logger.warn(`🔄 Reconnecting after failure... (${failureCount}/${MAX_RECONNECTS})`);
      setTimeout(() => void connectBot(sessionAuth), RECONNECT_DELAY_MS);
    }
  });

  // ── Messages ─────────────────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message || !msg.key.remoteJid) continue;

        const jid = msg.key.remoteJid;

        // Status broadcasts: auto-view / auto-like
        if (jid === "status@broadcast") {
          await handleStatusMessage(sock, msg);
          continue;
        }

        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err }, "Error handling message");
      }
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    try {
      await handleGroupParticipantsUpdate(sock, update);
    } catch (err) {
      logger.error({ err }, "Error handling group update");
    }
  });

  return sock;
}
