import pino from "pino";
import { Boom } from "@hapi/boom";
import { logger } from "../lib/logger";
import { loadSessionFromEnv } from "./session";
import { handleMessage, handleGroupParticipantsUpdate } from "./handler";

const RECONNECT_DELAY_MS = 5000;
let reconnectAttempts = 0;
const MAX_RECONNECTS = 10;

const silentLogger = pino({ level: "silent" });

export async function startBot() {
  const sessionAuth = await loadSessionFromEnv();
  if (!sessionAuth) {
    logger.info("No SESSION_ID provided — bot engine not started.");
    return;
  }

  logger.info("Starting NUTTER-XMD bot engine...");
  await connectBot(sessionAuth);
}

async function connectBot(sessionAuth: {
  state: { creds: unknown; keys: unknown };
  saveCreds: () => Promise<void>;
}) {
  const { default: makeWASocket, DisconnectReason, Browsers } = await import("@whiskeysockets/baileys");
  const { default: NodeCache } = await import("node-cache");

  const msgRetryCounterCache = new NodeCache();

  const sock = makeWASocket({
    auth: sessionAuth.state as Parameters<typeof makeWASocket>[0]["auth"],
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    msgRetryCounterCache,
    logger: silentLogger,
  });

  sock.ev.on("creds.update", sessionAuth.saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      reconnectAttempts = 0;
      logger.info("✅ NUTTER-XMD connected to WhatsApp");
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const { DisconnectReason: DR } = await import("@whiskeysockets/baileys");

      if (reason === DR.loggedOut) {
        logger.error("❌ Bot logged out. Generate a new SESSION_ID from the pairing page.");
        return;
      }

      if (reconnectAttempts >= MAX_RECONNECTS) {
        logger.error("❌ Max reconnect attempts reached. Exiting.");
        process.exit(1);
      }

      reconnectAttempts++;
      logger.warn(`🔄 Reconnecting... (attempt ${reconnectAttempts}/${MAX_RECONNECTS})`);
      setTimeout(() => connectBot(sessionAuth), RECONNECT_DELAY_MS);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      try {
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
