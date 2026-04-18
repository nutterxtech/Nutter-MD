import pino from "pino";
import { Boom } from "@hapi/boom";
import { logger } from "../lib/logger";
import { loadSessionFromEnv } from "./session";
import { handleMessage, handleStatusMessage, handleGroupParticipantsUpdate, populateGroupMetaCache, upsertGroupMetaCache } from "./handler";
import { cacheMessage, popCachedMessage, getGroupSettings, getBotSettings, registerLidMapping } from "./store";
import { safeSend } from "./utils";
import type { WASocket } from "@whiskeysockets/baileys";

const MAX_RECONNECTS = 2;
const RECONNECT_DELAY_MS = 5000;

const silentLogger = pino({ level: "silent" });

let failureCount = 0;
let hasSentWelcome = false;
/** Epoch-ms when the current WA connection opened. Used to skip stale replayed messages. */
let connectedAt = 0;

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
      await safeSend(sock, ownerJid, { text: welcome });
      logger.info("✅ Sent welcome message to owner");
    } catch (err) {
      logger.warn({ err }, "Could not send welcome message to owner");
    }
  } else {
    logger.warn("OWNER_NUMBER not set — skipping welcome message");
  }

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
    // Never cache group metadata in memory — prevents RAM ballooning on busy groups.
    cachedGroupMetadata: async () => undefined,
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

  // ── LID → JID mapping ────────────────────────────────────────────────────────
  // WhatsApp privacy mode delivers DMs with @lid remoteJids.  Baileys fires
  // contacts.upsert with {id: realJid, lid: lidJid} both on first connect (bulk)
  // and whenever a new contact is seen.  We persist the mapping so handleMessage
  // can resolve the @lid to the real @s.whatsapp.net JID before calling
  // sock.sendMessage — sending to a @lid JID hangs after the first attempt.
  sock.ev.on("contacts.upsert", (contacts) => {
    let mapped = 0;
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        registerLidMapping(contact.lid, contact.id);
        mapped++;
      }
    }
    if (mapped > 0) {
      logger.info({ mapped }, "📇 LID→JID mappings registered from contacts.upsert");
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      failureCount = 0;
      connectedAt = Date.now();
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

      // Announce presence so WhatsApp knows the bot is online.
      // This triggers the server to flush any pending sender-key exchanges,
      // which reduces the first-message delay for contacts who already tried
      // to reach the bot while it was restarting.
      try {
        await sock.sendPresenceUpdate("available");
        logger.info("✅ Presence set to available");
      } catch (err) {
        logger.warn({ err }, "Presence update skipped (non-fatal)");
      }

      // Pre-populate group metadata cache in the background so it never
      // blocks the connection.open handler (heavy on large accounts).
      setImmediate(async () => {
        try {
          const allGroups = await sock.groupFetchAllParticipating();
          const count = populateGroupMetaCache(
            allGroups as Record<string, { subject: string; participants: Array<{ id: string; admin?: "admin" | "superadmin" | null }> }>
          );
          logger.info({ groups: count }, "✅ Group metadata cache pre-populated");
        } catch (err) {
          logger.warn({ err }, "Could not pre-fetch group list — cache will warm on first message");
        }
      });

      // Delay onFirstConnect by 8 s so the WA session fully settles before
      // we send the welcome message and attempt auto-join/follow.
      // This is non-blocking — connection.open returns immediately.
      setTimeout(() => {
        onFirstConnect(sock).catch((err) => logger.warn({ err }, "onFirstConnect error"));
      }, 8_000);
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

  // ── Per-JID serial message queue ─────────────────────────────────────────────
  //
  // Architecture:
  //   Each JID (sender) gets its own promise chain. Messages from the SAME
  //   sender are processed one-at-a-time — the next command only starts after
  //   the previous one fully completes (response sent). Messages from DIFFERENT
  //   senders run in parallel, so one slow command never delays another sender.
  //
  // Why this is better than setImmediate:
  //   • Back-pressure built-in: if one user spams 50 commands, they queue up
  //     behind each other instead of spawning 50 concurrent async handlers.
  //   • No event loop saturation: promise chains yield naturally at every
  //     await point (sock.sendMessage, groupMetadata, etc.).
  //   • Automatic cleanup: the queue entry is deleted once the tail completes,
  //     so the Map never grows unbounded.
  //   • Errors are isolated per-message: one failure skips that job and the
  //     next queued message for that JID still runs.
  //
  const jidQueues = new Map<string, Promise<void>>();

  function enqueueForJid(jid: string, label: string, fn: () => Promise<void>) {
    const prev = jidQueues.get(jid) ?? Promise.resolve();
    const next = prev
      .then(() =>
        // Per-job 15 s safety net: if fn() hangs for 15 s the queue still
        // moves on. Individual handlers add their own tighter timeouts.
        Promise.race([
          fn(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`Queue timeout (15s) for ${label}`)), 15_000)
          ),
        ])
      )
      .catch((err) => logger.error({ err, label, jid }, "Queue handler error"))
      .finally(() => {
        if (jidQueues.get(jid) === next) jidQueues.delete(jid);
      });
    jidQueues.set(jid, next);
  }

  // Fire-and-forget for events that don't need per-sender ordering
  // (status reactions, antidelete forwards). Uses Promise micro-queue,
  // not setImmediate, so it starts in the same event-loop turn.
  function fireAsync(label: string, fn: () => Promise<void>) {
    Promise.resolve()
      .then(() => fn())
      .catch((err) => logger.error({ err, label }, "Async handler error"));
  }

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    logger.info({ type, count: messages.length }, "📨 messages.upsert fired");

    if (type !== "notify" && type !== "append") {
      logger.info({ type }, "↩ Skipped — type is neither notify nor append");
      return;
    }

    const ownerNumber = (process.env["OWNER_NUMBER"] || "").replace(/\D/g, "");
    const botNumber   = (sock.user?.id || "").split(":")[0].split("@")[0];

    for (const msg of messages) {
      // ── Synchronous filtering — zero awaits, keeps the loop tight ────────
      const remoteJid    = msg.key?.remoteJid || "";
      const remoteNumber = remoteJid.split(":")[0].split("@")[0];

      if (msg.key?.fromMe) {
        const isGroupJid = remoteJid.endsWith("@g.us");
        const isSelfChat = !!botNumber && remoteNumber === botNumber;

        if (!isSelfChat && !isGroupJid) {
          logger.info({ jid: remoteJid }, "↩ fromMe DM echo — skipped");
          continue;
        }
        if (isSelfChat) {
          logger.info({ jid: remoteJid }, "👤 Self-chat — processing as owner command");
        }
      }

      const hasMessage = !!msg.message;
      const hasJid     = !!msg.key?.remoteJid;
      if (!hasMessage || !hasJid) {
        const stubType = msg.messageStubType ?? 0;
        if (stubType === 0) {
          logger.warn(
            { jid: remoteJid, hasMessage, hasJid, fromMe: msg.key?.fromMe },
            "⚠️ Decryption failure — content is null. Re-pair to get fresh session files."
          );
        } else {
          logger.info({ stubType, jid: remoteJid }, "↩ Protocol notification — skipped");
        }
        continue;
      }

      // ── Stale-message guard ───────────────────────────────────────────────
      // WhatsApp replays pending messages when the bot reconnects. Skip any
      // message that was sent more than 15 s before this connection opened so
      // stale commands don't get processed as if they just arrived.
      const sentAt = Number(msg.messageTimestamp) * 1000 || 0;
      const cutoff = connectedAt - 15_000;
      if (cutoff > 0 && sentAt > 0 && sentAt < cutoff) {
        logger.info({ jid: remoteJid, sentAt, cutoff }, "⏩ Stale message — skipped (pre-connection)");
        continue;
      }

      const jid = msg.key.remoteJid!;
      logger.info({ jid, jidType: jid.split("@")[1] ?? "unknown", fromMe: msg.key.fromMe }, "➡️ Dispatching message");

      // ── Status broadcasts — fire-and-forget (no per-sender ordering needed)
      if (jid === "status@broadcast") {
        fireAsync("handleStatusMessage", () => handleStatusMessage(sock, msg));
        continue;
      }

      // ── Antidelete: detect REVOKE protocol messages (type 0 = delete for everyone)
      const proto = msg.message!.protocolMessage;
      if (proto && proto.type === 0 && proto.key?.id) {
        // popCachedMessage is sync — must run in the loop to avoid racing with
        // a revoke that arrives in the same batch a few ms later.
        const deletedMsg = popCachedMessage(proto.key.id);

        if (deletedMsg && ownerNumber) {
          const capturedDeleted = deletedMsg;
          fireAsync("antidelete", async () => {
            const srcJid  = capturedDeleted.key.remoteJid || "";
            const isGroup = srcJid.endsWith("@g.us");
            const gs      = isGroup ? getGroupSettings(srcJid) : null;
            const antiDeleteOn = isGroup ? gs?.antiDelete : true;

            if (!antiDeleteOn) return;

            const ownerJid  = `${ownerNumber}@s.whatsapp.net`;
            const senderNum = (capturedDeleted.key.participant || capturedDeleted.key.remoteJid || "")
              .split(":")[0].split("@")[0];
            const where  = isGroup ? `group ${srcJid.split("@")[0]}` : `DM`;
            const header = `🗑 *Deleted message detected*\n👤 From: ${capturedDeleted.pushName || senderNum} (${senderNum})\n📍 In: ${where}`;

            const innerMsg = capturedDeleted.message;
            if (innerMsg?.conversation || innerMsg?.extendedTextMessage?.text) {
              const text = innerMsg.conversation || innerMsg.extendedTextMessage?.text || "";
              await safeSend(sock, ownerJid, { text: `${header}\n\n💬 "${text}"` });
            } else if (innerMsg?.imageMessage) {
              await safeSend(sock, ownerJid, { text: header });
              await safeSend(sock, ownerJid, { forward: capturedDeleted, force: true } as Parameters<typeof sock.sendMessage>[1]);
            } else {
              await safeSend(sock, ownerJid, { text: `${header}\n\n📎 (media/unsupported message type)` });
            }
            logger.info({ from: senderNum, jid: srcJid }, "🗑 Antidelete: forwarded deleted message to owner");
          });
        }
        continue;
      }

      // ── Cache for antidelete (sync — must happen before dispatching) ──────
      cacheMessage(msg);

      // ── Command handler — enqueued per-JID for back-pressure ─────────────
      // 10 s inner timeout: if handleMessage hangs (slow API, stuck sendMessage)
      // it times out and the queue for this JID moves on immediately.
      // Duration is logged so slow paths are visible in Heroku logs.
      const _capturedMsg = msg;
      enqueueForJid(jid, "handleMessage", async () => {
        const _start = Date.now();
        try {
          await Promise.race([
            handleMessage(sock, _capturedMsg),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("handleMessage timeout (10s)")), 10_000)
            ),
          ]);
        } finally {
          logger.info({ duration: Date.now() - _start, jid }, "⏱ handleMessage duration");
        }
      });
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    try {
      await handleGroupParticipantsUpdate(sock, update);
    } catch (err) {
      logger.error({ err }, "Error handling group update");
    }
  });

  // ── Keep group metadata cache in sync (mirrors what RAVEN-BOT's store.bind does) ──
  // groups.upsert fires when the bot joins a new group or on initial sync
  sock.ev.on("groups.upsert", (groups) => {
    for (const group of groups) {
      upsertGroupMetaCache(group.id, {
        subject: group.subject,
        participants: group.participants as Array<{ id: string; admin?: "admin" | "superadmin" | null }>,
      });
    }
    logger.info({ count: groups.length }, "📦 groups.upsert — cache updated");
  });

  // groups.update fires when subject, description, settings change
  sock.ev.on("groups.update", (updates) => {
    for (const update of updates) {
      if (update.id) {
        upsertGroupMetaCache(update.id, {
          subject: update.subject,
          participants: update.participants as Array<{ id: string; admin?: "admin" | "superadmin" | null }> | undefined,
        });
      }
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
        await safeSend(sock, call.from, { text: "🚫Calls are not allowed" });
        logger.info({ from: call.from, callId: call.id }, "📵 Auto-rejected incoming call");
      } catch (err) {
        logger.warn({ err, from: call.from }, "Failed to reject call");
      }
    }
  });

  return sock;
}
