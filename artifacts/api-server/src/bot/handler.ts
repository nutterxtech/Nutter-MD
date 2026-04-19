import type { WASocket, WAMessageKey, proto } from "@whiskeysockets/baileys";
import type { GroupSettings } from "./store";
import { getGroupSettings, getUserSettings, getBotSettings, updateBotSettings, resolveLid } from "./store";
import { logger } from "../lib/logger";
import { safeSend } from "./utils";

export { safeSend };
import {
  handlePing,
  handleAlive,
  handleMenu,
  handleOwner,
  handleSettings,
  handleSticker,
  handleRestart,
  handleRefreshSession,
} from "./commands/general";
import {
  handleKick,
  handleAdd,
  handlePromote,
  handleDemote,
  handleAntilink,
  handleAntibadword,
  handleAntimention,
  handleBan,
  handleUnban,
  handleSetPrefix,
  handleTagAll,
  handleGroupInfo,
  handleMute,
  handleUnmute,
  handleWelcome,
  handleSetWelcome,
  handleAutoReply,
  handleSetBadWords,
  handleAntiDelete,
} from "./commands/group";

const DEFAULT_BAD_WORDS = ["fuck", "shit", "bitch", "asshole", "nigga", "faggot", "cunt"];
const URL_REGEX = /https?:\/\/[^\s]+|wa\.me\/[^\s]+|t\.me\/[^\s]+/i;

// ── Group metadata cache ───────────────────────────────────────────────────────
interface GroupMetaEntry {
  subject: string;
  participants: Array<{ id: string; admin?: "admin" | "superadmin" | null }>;
  expireAt: number;
}
const groupMetaCache = new Map<string, GroupMetaEntry>();
const GROUP_META_TTL     = 2 * 60 * 1000;
const GROUP_META_TIMEOUT = 5_000;

async function getCachedGroupMeta(sock: WASocket, jid: string): Promise<GroupMetaEntry> {
  const cached = groupMetaCache.get(jid);
  if (cached && cached.expireAt > Date.now()) return cached;

  const meta = await Promise.race([
    sock.groupMetadata(jid),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`groupMetadata timeout for ${jid}`)), GROUP_META_TIMEOUT)
    ),
  ]);

  const entry: GroupMetaEntry = {
    subject: meta.subject,
    participants: meta.participants as GroupMetaEntry["participants"],
    expireAt: Date.now() + GROUP_META_TTL,
  };
  groupMetaCache.set(jid, entry);
  return entry;
}

export function invalidateGroupMetaCache(jid: string) {
  groupMetaCache.delete(jid);
}

export function populateGroupMetaCache(
  groups: Record<string, { subject: string; participants: Array<{ id: string; admin?: "admin" | "superadmin" | null }> }>
) {
  const expireAt = Date.now() + GROUP_META_TTL;
  for (const [jid, meta] of Object.entries(groups)) {
    groupMetaCache.set(jid, { subject: meta.subject, participants: meta.participants, expireAt });
  }
  return Object.keys(groups).length;
}

export function upsertGroupMetaCache(
  jid: string,
  meta: { subject?: string; participants?: Array<{ id: string; admin?: "admin" | "superadmin" | null }> }
) {
  const existing = groupMetaCache.get(jid);
  const updated: GroupMetaEntry = {
    subject: meta.subject ?? existing?.subject ?? "",
    participants: meta.participants ?? existing?.participants ?? [],
    expireAt: Date.now() + GROUP_META_TTL,
  };
  groupMetaCache.set(jid, updated);
}

function printMessageActivity(opts: {
  msgType: string;
  pushName: string;
  senderNumber: string;
  isGroup: boolean;
  groupName?: string;
  groupNumber?: string;
  isDM?: boolean;
}) {
  const botName = (process.env["BOT_NAME"] || "NUTTER-XMD").toUpperCase().split("").join(" ");
  const border = "╔════════════════════════════╗";
  const title  = "║ ✉   N E W   M E S S A G E   ✉ ║";
  const bottom = "╚════════════════════════════╝";

  console.log(`\t ✦ ✦ ✦ { ${botName} } ✦ ✦ ✦`);
  console.log(border);
  console.log(title);
  console.log(bottom);

  if (opts.isGroup && opts.groupName) {
    console.log(`👥 Group: ${opts.groupName}`);
    console.log(`   ↳ Group ID: (${opts.groupNumber || ""})`);
  } else {
    console.log(`💬 Direct Message`);
  }

  console.log(`👤 Sender: [${opts.pushName || opts.senderNumber}]`);
  console.log(`🆔 JID: ${opts.senderNumber}`);
  console.log(`📋 Message Type: ${opts.msgType}`);
  console.log("");
}

export interface CommandContext {
  jid: string;
  isGroup: boolean;
  isOwner: boolean;
  isSenderGroupAdmin: boolean;
  isBotGroupAdmin: boolean;
  groupSettings: GroupSettings | null;
  prefix: string;
}

// ── Status broadcast handler ───────────────────────────────────────────────────
export async function handleStatusMessage(sock: WASocket, msg: proto.IWebMessageInfo) {
  const settings = getBotSettings();

  if (settings.autoViewStatus) {
    try { await sock.readMessages([msg.key]); } catch {}
  }

  if (settings.autoLikeStatus && msg.key.participant) {
    try {
      if (!settings.autoViewStatus) {
        try { await sock.readMessages([msg.key]); } catch {}
      }
      const emojiList = (settings.statusLikeEmoji || "❤️")
        .split(",").map((e) => e.trim()).filter(Boolean);
      const emoji = emojiList[Math.floor(Math.random() * emojiList.length)] || "❤️";
      await safeSend(sock, msg.key.participant, {
        react: { text: emoji, key: { ...msg.key, remoteJid: "status@broadcast" } },
      });
    } catch {}
  }
}

// ── Main message handler ───────────────────────────────────────────────────────
export async function handleMessage(sock: WASocket, msg: proto.IWebMessageInfo) {
  if (!msg.key) {
    logger.warn("handleMessage called with no msg.key — dropped");
    return;
  }

  const ownerNumber  = (process.env["OWNER_NUMBER"] || "").replace(/[^0-9]/g, "");
  const defaultPrefix = process.env["PREFIX"] || ".";

  const jid = msg.key.remoteJid;
  if (!jid) {
    logger.warn("handleMessage: no remoteJid — dropped");
    return;
  }

  // ── Safety net: drop protocol/Signal housekeeping messages ────────────────
  // connection.ts already filters these but this guard catches anything that
  // slips through (e.g. antidelete REVOKE that wasn't caught upstream).
  const msgContent = msg.message;
  if (
    msgContent?.protocolMessage ||
    msgContent?.reactionMessage ||
    msgContent?.pollUpdateMessage ||
    msgContent?.keepInChatMessage ||
    msgContent?.senderKeyDistributionMessage
  ) {
    logger.info({ jid, type: msgContent ? Object.keys(msgContent)[0] : "unknown" }, "↩ Protocol/reaction message — dropped in handler");
    return;
  }

  logger.info({ jid, fromMe: msg.key.fromMe, msgKeys: Object.keys(msg.message || {}) }, "📩 handleMessage reached");

  const isGroup = jid.endsWith("@g.us");
  const botJidFull = sock.user?.id || "";

  const senderJid = isGroup
    ? msg.key.participant || botJidFull
    : msg.key.fromMe
      ? `${ownerNumber}@s.whatsapp.net`
      : jid;

  // Resolve LID → real JID BEFORE extracting number
  const realSenderJid = resolveLid(senderJid);
  const senderNumber  = realSenderJid.split(":")[0].split("@")[0];
  const isOwner       = ownerNumber !== "" && senderNumber === ownerNumber;

  logger.info({ ownerNumber, senderNumber, isOwner, fromMe: msg.key.fromMe }, "🔑 Owner resolution");

  const msgType = Object.keys(msg.message || {})[0] || "unknown";

  const botMode = (process.env["BOT_MODE"] || "public").toLowerCase();
  if (botMode === "private" && !isOwner) {
    logger.info({ jid, sender: senderNumber, msgType }, "Skipped — private mode, sender is not owner");
    return;
  }

  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    msg.message?.buttonsResponseMessage?.selectedButtonId ||
    msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.message?.templateButtonReplyMessage?.selectedId ||
    "";

  if (!body) {
    printMessageActivity({ msgType, pushName: msg.pushName || "", senderNumber, isGroup });
    logger.info({ jid, msgType }, "No text body — skipped command processing");
    return;
  }

  let groupSettings: GroupSettings | null = null;
  let isSenderGroupAdmin = false;
  let isBotGroupAdmin    = false;
  let prefix   = defaultPrefix;
  let groupName: string | undefined;
  let groupNumber: string | undefined;

  if (isGroup) {
    try {
      groupSettings = getGroupSettings(jid);
      if (groupSettings?.customPrefix) prefix = groupSettings.customPrefix;

      const groupMeta = await getCachedGroupMeta(sock, jid);
      groupName   = groupMeta.subject;
      groupNumber = jid.split("@")[0];
      const botNumber = botJidFull.split(":")[0].split("@")[0];

      for (const participant of groupMeta.participants) {
        const pNum    = participant.id.split(":")[0].split("@")[0];
        const isAdmin = participant.admin === "admin" || participant.admin === "superadmin";
        if (pNum === senderNumber) isSenderGroupAdmin = isAdmin;
        if (pNum === botNumber)    isBotGroupAdmin    = isAdmin;
      }

      const msgKey = msg.key as WAMessageKey;
      if (groupSettings) {
        if (groupSettings.antilink && !isOwner && !isSenderGroupAdmin && URL_REGEX.test(body)) {
          await safeSend(sock, jid, { delete: msgKey });
          await safeSend(sock, jid, { text: "Links are not allowed in this group." });
          return;
        }

        const badWordList = groupSettings.customBadWords
          ? groupSettings.customBadWords.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)
          : DEFAULT_BAD_WORDS;
        if (groupSettings.antibadword !== "off" && !isOwner && badWordList.some((w) => body.toLowerCase().includes(w))) {
          await safeSend(sock, jid, { delete: msgKey });
          if (groupSettings.antibadword === "kick") {
            // FIX: use realSenderJid (resolved from @lid) for group operations
            await sock.groupParticipantsUpdate(jid, [realSenderJid], "remove");
            await safeSend(sock, jid, { text: `@${realSenderJid.split("@")[0]} was kicked for using bad language.`, mentions: [realSenderJid] });
          } else {
            await safeSend(sock, jid, { text: "Bad language is not allowed." });
          }
          return;
        }

        if (groupSettings.antimention && !isOwner && !isSenderGroupAdmin) {
          const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          if (mentions.length >= 5) {
            await safeSend(sock, jid, { delete: msgKey });
            await safeSend(sock, jid, { text: "Mass mentions are not allowed." });
            return;
          }
        }
      }
    } catch (err) {
      logger.warn({ err, jid }, "Failed to fetch group metadata — continuing without admin info");
    }
  }

  printMessageActivity({
    msgType,
    pushName: msg.pushName || "",
    senderNumber,
    isGroup,
    groupName,
    groupNumber,
  });

  logger.info({ jid, prefix, hasPrefix: body.startsWith(prefix), bodyPreview: body.slice(0, 40) }, "📝 Body extracted");

  if (!body.startsWith(prefix)) {
    if (isGroup && groupSettings?.autoReply) {
      try {
        const autoReplyMap: Record<string, string> = JSON.parse(groupSettings.autoReply);
        const bodyLower = body.toLowerCase().trim();
        const matched = Object.entries(autoReplyMap).find(([trigger]) =>
          bodyLower.includes(trigger.toLowerCase())
        );
        if (matched) {
          await safeSend(sock, jid, { text: matched[1] });
        }
      } catch {
        // skip auto-reply if parsing fails
      }
    }
    return;
  }

  // Resolve reply JID — always use real @s.whatsapp.net, never @lid
  const replyJid = isGroup
    ? jid
    : msg.key.fromMe
      ? `${ownerNumber}@s.whatsapp.net`
      : resolveLid(jid);

  if (replyJid !== jid) {
    logger.info({ lid: jid, resolved: replyJid }, "🔀 @lid resolved to real JID for reply");
  }

  // FIX: use realSenderJid (resolved) for ban lookup so @lid users are found correctly
  const userSettings = getUserSettings(realSenderJid);
  if (userSettings?.isBanned && !isOwner) {
    await safeSend(sock, replyJid, { text: "You are banned from using this bot." });
    return;
  }

  const ctx: CommandContext = { jid: replyJid, isGroup, isOwner, isSenderGroupAdmin, isBotGroupAdmin, groupSettings, prefix };
  const commandText = body.slice(prefix.length).trim();
  const parts = commandText.split(/\s+/).filter(Boolean);
  const [command = "", ...args] = parts;
  const cmd = command.toLowerCase();

  logger.info({ cmd, jid, replyJid, sender: senderNumber, isOwner }, "Command received");

  switch (cmd) {
    // ── General ──────────────────────────────────────────────────────────────
    case "ping":          return handlePing(sock, msg, ctx);
    case "alive":         return handleAlive(sock, msg, ctx);
    case "menu":          return handleMenu(sock, msg, ctx, prefix);
    case "owner":         return handleOwner(sock, msg, ctx);
    case "settings":      return handleSettings(sock, msg, ctx, prefix);
    case "sticker":       return handleSticker(sock, msg, ctx);
    case "restart":       return handleRestart(sock, msg, ctx);
    case "refreshsession":
    case "getsession":    return handleRefreshSession(sock, msg, ctx);

    // ── Bot status settings (owner only) ─────────────────────────────────────
    // FIX: all use replyJid instead of raw jid
    case "autoviewstatus":
    case "autoview": {
      if (!isOwner) { await safeSend(sock, replyJid, { text: "🚫 Only owner command" }); return; }
      const val = args[0]?.toLowerCase();
      if (val !== "true" && val !== "false" && val !== "on" && val !== "off") {
        await safeSend(sock, replyJid, { text: `Current: ${getBotSettings().autoViewStatus ? "ON" : "OFF"}\nUsage: ${prefix}autoviewstatus on/off` });
        return;
      }
      const enabled = val === "true" || val === "on";
      updateBotSettings({ autoViewStatus: enabled });
      await safeSend(sock, replyJid, { text: `Auto-view status: *${enabled ? "ON" : "OFF"}*` });
      return;
    }

    case "autolikestatus":
    case "autolike": {
      if (!isOwner) { await safeSend(sock, replyJid, { text: "🚫 Only owner command" }); return; }
      const val = args[0]?.toLowerCase();
      if (val !== "true" && val !== "false" && val !== "on" && val !== "off") {
        await safeSend(sock, replyJid, { text: `Current: ${getBotSettings().autoLikeStatus ? "ON" : "OFF"}\nUsage: ${prefix}autolikestatus on/off` });
        return;
      }
      const enabled = val === "true" || val === "on";
      updateBotSettings({ autoLikeStatus: enabled });
      await safeSend(sock, replyJid, { text: `Auto-like status: *${enabled ? "ON" : "OFF"}*` });
      return;
    }

    case "statusemoji": {
      if (!isOwner) { await safeSend(sock, replyJid, { text: "🚫 Only owner command" }); return; }
      const emoji = args.join(" ").trim();
      if (!emoji) {
        await safeSend(sock, replyJid, { text: `Current emoji: ${getBotSettings().statusLikeEmoji}\nUsage: ${prefix}statusemoji ❤️,🔥,😍` });
        return;
      }
      updateBotSettings({ statusLikeEmoji: emoji });
      await safeSend(sock, replyJid, { text: `Status like emoji set to: *${emoji}*` });
      return;
    }

    // ── Group management ──────────────────────────────────────────────────────
    case "kick":          return handleKick(sock, msg, ctx);
    case "add":           return handleAdd(sock, msg, ctx, args);
    case "promote":       return handlePromote(sock, msg, ctx);
    case "demote":        return handleDemote(sock, msg, ctx);
    case "antilink":      return handleAntilink(sock, msg, ctx, args);
    case "antibadword":   return handleAntibadword(sock, msg, ctx, args);
    case "setbadwords":   return handleSetBadWords(sock, msg, ctx, args);
    case "antimention":   return handleAntimention(sock, msg, ctx, args);
    case "antidelete":    return handleAntiDelete(sock, msg, ctx, args);
    case "ban":           return handleBan(sock, msg, ctx);
    case "unban":         return handleUnban(sock, msg, ctx);
    case "setprefix":     return handleSetPrefix(sock, msg, ctx, args);
    case "tagall":        return handleTagAll(sock, msg, ctx, args);
    case "groupinfo":     return handleGroupInfo(sock, msg, ctx);
    case "mute":          return handleMute(sock, msg, ctx);
    case "unmute":        return handleUnmute(sock, msg, ctx);
    case "welcome":       return handleWelcome(sock, msg, ctx, args);
    case "setwelcome":    return handleSetWelcome(sock, msg, ctx, args);
    case "autoreply":     return handleAutoReply(sock, msg, ctx, args);

    default:
      return;
  }
}

export async function handleGroupParticipantsUpdate(
  sock: WASocket,
  update: { id: string; participants: Array<{ id: string } | string>; action: string }
) {
  if (update.action !== "add") return;

  const groupId = update.id;
  try {
    const settings = getGroupSettings(groupId);
    if (!settings?.welcomeEnabled) return;

    const groupMeta = await sock.groupMetadata(groupId);
    const welcomeTemplate = settings.welcomeMessage || "Welcome to *{group}*, {name}! 🎉";

    for (const participant of update.participants) {
      const participantJid = typeof participant === "string" ? participant : participant.id;
      const number = participantJid.split("@")[0];
      const name   = `@${number}`;
      const welcomeText = welcomeTemplate
        .replace(/\{name\}/gi, name)
        .replace(/\{group\}/gi, groupMeta.subject);

      await safeSend(sock, groupId, {
        text: welcomeText,
        mentions: [participantJid],
      });
    }
  } catch (err) {
    logger.warn({ err, groupId }, "Failed to send welcome message");
  }
}
