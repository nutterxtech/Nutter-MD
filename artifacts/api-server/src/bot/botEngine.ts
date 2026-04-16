import { Boom } from "@hapi/boom";
import { logger } from "../lib/logger";
import { loadSessionFromEnv } from "./session";
import { handleMessage } from "./handler";

const RECONNECT_DELAY_MS = 5000;
let reconnectAttempts = 0;
const MAX_RECONNECTS = 10;

export async function startBot() {
  const session = loadSessionFromEnv();
  if (!session) {
    logger.info("No SESSION_ID provided — bot engine not started. Set SESSION_ID env var to start the bot.");
    return;
  }

  logger.info("Starting NUTTER-XMD bot engine...");
  await connectBot(session);
}

async function connectBot(session: unknown) {
  const { default: makeWASocket, DisconnectReason } = await import("@whiskeysockets/baileys");
  const { default: NodeCache } = await import("node-cache");

  const msgRetryCounterCache = new NodeCache();

  const sock = makeWASocket({
    auth: session as Parameters<typeof makeWASocket>[0]["auth"],
    printQRInTerminal: false,
    browser: ["NUTTER-XMD", "Chrome", "1.0.0"],
    msgRetryCounterCache,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      reconnectAttempts = 0;
      logger.info("Bot connected to WhatsApp");
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const { DisconnectReason: DR } = await import("@whiskeysockets/baileys");

      if (reason === DR.loggedOut) {
        logger.error("Bot was logged out. Please generate a new SESSION_ID via the pairing page.");
        return;
      }

      if (reconnectAttempts >= MAX_RECONNECTS) {
        logger.error({ reconnectAttempts }, "Max reconnect attempts reached. Exiting.");
        process.exit(1);
      }

      reconnectAttempts++;
      logger.warn({ reason, attempt: reconnectAttempts }, `Connection closed, reconnecting in ${RECONNECT_DELAY_MS}ms...`);
      setTimeout(() => connectBot(session), RECONNECT_DELAY_MS);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err, msgKey: msg.key }, "Error handling message");
      }
    }
  });

  return sock;
}
