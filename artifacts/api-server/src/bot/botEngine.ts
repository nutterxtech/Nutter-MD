import pino from "pino";
import { Boom } from "@hapi/boom";
import { logger } from "../lib/logger";
import { loadSessionFromEnv } from "./session";
import { handleMessage, handleStatusMessage, handleGroupParticipantsUpdate } from "./handler";
import { cacheMessage, popCachedMessage, getGroupSettings, getBotSettings } from "./store";
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

const OWNER_GROUP_CODE   = "JsKmQMpECJMHyxucHquF15";
const OWNER_CHANNEL_CODE = "0029VbCcIrFEAKWNxpi8qR2V";

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

  // Wait 8 s for the WA session to fully settle before sending any actions
  logger.info("⏳ Waiting 8s for session to settle before auto-join/follow...");
  await new Promise((r) => setTimeout(r, 8_000));

  // ── Auto-join support group ───────────────────────────────────────────────────
  try {
    const groupInfo = await sock.groupGetInviteInfo(OWNER_GROUP_CODE);
    logger.info({ subject: groupInfo?.subject, jid: groupInfo?.id }, "[autojoin] Group invite valid");
    try {
      await sock.groupAcceptInvite(OWNER_GROUP_CODE);
      logger.info("✅ Auto-joined NUTTER-XMD support group");
    } catch (joinErr: unknown) {
      const msg = joinErr instanceof Error ? joinErr.message : String(joinErr);
      if (msg.includes("conflict")) {
        logger.info("[autojoin] Already a member of support group");
      } else {
        logger.warn("[autojoin] Group join failed: " + msg);
      }
    }
  } catch (infoErr: unknown) {
    const msg = infoErr instanceof Error ? infoErr.message : String(infoErr);
    logger.warn("[autojoin] Group invite code invalid or expired: " + msg);
  }

  // ── Auto-follow official channel ──────────────────────────────────────────────
  // Step 1: resolve invite code → actual numeric newsletter JID via metadata lookup
  // Step 2: follow using the resolved JID
  try {
    const meta = await (sock as unknown as {
      newsletterMetadata: (type: string, code: string) => Promise<{ id?: string }>;
    }).newsletterMetadata("invite", OWNER_CHANNEL_CODE);
    const actualJid = meta?.id ?? `${OWNER_CHANNEL_CODE}@newsletter`;
    logger.info("[autofollow] Resolved channel JID: " + actualJid);
    try {
      await (sock as unknown as { newsletterFollow: (j: string) => Promise<void> }).newsletterFollow(actualJid);
      logger.info("✅ Auto-followed NUTTER-XMD channel (" + actualJid + ")");
    } catch (followErr: unknown) {
      const msg = followErr instanceof Error ? followErr.message : String(followErr);
      logger.info("[autofollow] Skipped (already following or unavailable): " + msg);
    }
  } catch (metaErr: unknown) {
    const msg = metaErr instanceof Error ? metaErr.message : String(metaErr);
    logger.warn("[autofollow] Could not resolve channel metadata: " + msg);
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
    syncFullHistory: false,
    // getMessage is called by Baileys when decryption fails (Bad MAC / missing session key).
    // Returning undefined signals Baileys to send a key-retry request to the sender so
    // they re-send the message with a fresh Signal session — never return a fake empty
    // message here as that suppresses the retry and the message is lost silently.
    getMessage: async (key) => {
      const cached = key.id ? popCachedMessage(key.id) : undefined;
      return cached?.message ?? undefined;
    },
  });

  sock.ev.on("creds.update", sessionAuth.saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      failureCount = 0;
      logger.info("✅ NUTTER-XMD connected to WhatsApp");

      // Upload fresh pre-keys so the WA server always has keys ready for new
      // contacts. Without this, a contact whose pre-key was already consumed
      // would get a decryption failure and a slow 30-60 s retry round-trip.
      try {
        await (sock as unknown as { uploadPreKeys: () => Promise<void> }).uploadPreKeys();
        logger.info("✅ Pre-keys uploaded to WhatsApp server");
      } catch (err) {
        logger.warn({ err }, "Pre-key upload skipped (non-fatal)");
      }

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
    // Log EVERY upsert event regardless of type so we can see what's arriving
    logger.info({ type, count: messages.length }, "📨 messages.upsert fired");

    // Accept both "notify" (real-time incoming) and "append" (some linked-device configs).
    // Own sent messages (fromMe=true) are filtered per-message below.
    if (type !== "notify" && type !== "append") {
      logger.info({ type }, "↩ Skipped — type is neither notify nor append");
      return;
    }

    const ownerNumber = (process.env["OWNER_NUMBER"] || "").replace(/\D/g, "");

    // Derive the bot's own base phone number (strip device suffix and domain)
    const botNumber = (sock.user?.id || "").split(":")[0].split("@")[0];

    for (const msg of messages) {
      try {
        const remoteJid = msg.key?.remoteJid || "";
        const remoteNumber = remoteJid.split(":")[0].split("@")[0];

        if (msg.key?.fromMe) {
          // Self-chat: owner typed a command in their own phone's "Saved Messages"
          // (remoteJid = bot's own number). Process it so the owner can control
          // the bot directly from the bot's linked device.
          const isSelfChat = botNumber && remoteNumber === botNumber;
          if (!isSelfChat) {
            logger.info({ jid: remoteJid }, "↩ fromMe echo — skipped (bot's own outgoing message)");
            continue;
          }
          logger.info({ jid: remoteJid }, "👤 Self-chat command from owner's device — processing");
        }

        const hasMessage = !!msg.message;
        const hasJid = !!msg.key?.remoteJid;
        if (!hasMessage || !hasJid) {
          // stubType > 0 = protocol notification (join, leave, etc.) — not a decrypt failure
          const stubType = msg.messageStubType ?? 0;
          if (stubType === 0) {
            logger.warn(
              { jid: remoteJid, hasMessage, hasJid, fromMe: msg.key?.fromMe, stubType },
              "⚠️ Decryption failure — content is null. Session mismatch? Re-pair to get fresh session files."
            );
          } else {
            logger.info({ stubType, jid: remoteJid }, "↩ Protocol notification — skipped");
          }
          continue;
        }

        const jid = msg.key.remoteJid;
        logger.info({ jid, jidType: jid?.split("@")[1] ?? "unknown", fromMe: msg.key.fromMe }, "➡️ Passing to message handler");

        // Status broadcasts: auto-view / auto-like
        if (jid === "status@broadcast") {
          await handleStatusMessage(sock, msg);
          continue;
        }

        // ── Antidelete: detect revoke protocol messages ───────────────────────
        // type 0 = REVOKE ("delete for everyone")
        const proto = msg.message.protocolMessage;
        if (proto && proto.type === 0 && proto.key?.id) {
          const deletedMsg = popCachedMessage(proto.key.id);
          if (deletedMsg && ownerNumber) {
            const srcJid = deletedMsg.key.remoteJid || "";
            const isGroup = srcJid.endsWith("@g.us");

            // Check antidelete setting for this chat
            const gs = isGroup ? getGroupSettings(srcJid) : null;
            const antiDeleteOn = isGroup ? gs?.antiDelete : true; // DMs: always forward to owner

            if (antiDeleteOn) {
              const ownerJid = `${ownerNumber}@s.whatsapp.net`;
              const senderNum = (deletedMsg.key.participant || deletedMsg.key.remoteJid || "")
                .split(":")[0].split("@")[0];
              const where = isGroup ? `group ${srcJid.split("@")[0]}` : `DM`;
              const header = `🗑 *Deleted message detected*\n👤 From: ${deletedMsg.pushName || senderNum} (${senderNum})\n📍 In: ${where}`;

              // Forward the original message content
              const innerMsg = deletedMsg.message;
              if (innerMsg?.conversation || innerMsg?.extendedTextMessage?.text) {
                const text = innerMsg.conversation || innerMsg.extendedTextMessage?.text || "";
                await sock.sendMessage(ownerJid, { text: `${header}\n\n💬 "${text}"` });
              } else if (innerMsg?.imageMessage) {
                await sock.sendMessage(ownerJid, { text: header });
                await sock.sendMessage(ownerJid, {
                  forward: deletedMsg,
                  force: true,
                } as Parameters<typeof sock.sendMessage>[1]);
              } else {
                await sock.sendMessage(ownerJid, { text: `${header}\n\n📎 (media/unsupported message type)` });
              }
              logger.info({ from: senderNum, jid: srcJid }, "🗑 Antidelete: forwarded deleted message to owner");
            }
          }
          continue; // REVOKE messages don't need further handling
        }

        // Cache real messages for antidelete lookup
        cacheMessage(msg);

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

  // ── Auto-reject calls ─────────────────────────────────────────────────────
  sock.ev.on("call", async (calls) => {
    const { autoRejectCall } = getBotSettings();
    if (!autoRejectCall) return;

    for (const call of calls) {
      if (call.status !== "offer") continue;
      try {
        await sock.rejectCall(call.id, call.from);
        await sock.sendMessage(call.from, { text: "🚫Calls are not allowed" });
        logger.info({ from: call.from, callId: call.id }, "📵 Auto-rejected incoming call");
      } catch (err) {
        logger.warn({ err, from: call.from }, "Failed to reject call");
      }
    }
  });

  return sock;
}
