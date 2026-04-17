import type { WASocket, WAMessageKey, proto } from "@whiskeysockets/baileys";
import type { GroupSettings } from "./store";
import { getGroupSettings, getUserSettings, getBotSettings, updateBotSettings } from "./store";
import { logger } from "../lib/logger";
import {
  handlePing,
  handleAlive,
  handleMenu,
  handleOwner,
  handleSettings,
  handleSticker,
  handleRestart,
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
} from "./commands/group";

const BAD_WORDS = ["fuck", "shit", "bitch", "asshole", "nigga", "faggot", "cunt"];
const URL_REGEX = /https?:\/\/[^\s]+|wa\.me\/[^\s]+|t\.me\/[^\s]+/i;

export interface CommandContext {
  jid: string;
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
    try {
      await sock.readMessages([msg.key]);
    } catch {}
  }

  if (settings.autoLikeStatus && msg.key.participant) {
    try {
      const emojiList = (settings.statusLikeEmoji || "❤️")
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      const emoji = emojiList[Math.floor(Math.random() * emojiList.length)] || "❤️";
      await sock.sendMessage(msg.key.participant, {
        react: {
          text: emoji,
          key: { ...msg.key, remoteJid: "status@broadcast" },
        },
      });
    } catch {}
  }
}

// ── Main message handler ───────────────────────────────────────────────────────
export async function handleMessage(sock: WASocket, msg: proto.IWebMessageInfo) {
  if (!msg.key) return;

  const ownerNumber = (process.env["OWNER_NUMBER"] || "").replace(/[^0-9]/g, "");
  const defaultPrefix = process.env["PREFIX"] || ".";

  const jid = msg.key.remoteJid;
  if (!jid) return;

  const isGroup = jid.endsWith("@g.us");

  // Identify sender. In a DM with fromMe=true, the sender IS the bot owner
  // (they typed from their primary phone); remoteJid is the recipient, not sender.
  const botJidFull = sock.user?.id || "";
  const senderJid = isGroup
    ? msg.key.participant || botJidFull
    : msg.key.fromMe
      ? botJidFull
      : jid;

  const senderNumber = senderJid.split(":")[0].split("@")[0];
  const isOwner = ownerNumber !== "" && senderNumber === ownerNumber;

  const botMode = (process.env["BOT_MODE"] || "public").toLowerCase();
  if (botMode === "private" && !isOwner) return;

  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    "";

  if (!body) return;

  let groupSettings: GroupSettings | null = null;
  let isSenderGroupAdmin = false;
  let isBotGroupAdmin = false;
  let prefix = defaultPrefix;

  if (isGroup) {
    try {
      groupSettings = getGroupSettings(jid);

      if (groupSettings?.customPrefix) {
        prefix = groupSettings.customPrefix;
      }

      const groupMeta = await sock.groupMetadata(jid);
      const botNumber = botJidFull.split(":")[0].split("@")[0];
      const senderNum = senderNumber;

      for (const participant of groupMeta.participants) {
        const participantNumber = participant.id.split(":")[0].split("@")[0];
        const isAdmin = participant.admin === "admin" || participant.admin === "superadmin";
        if (participantNumber === senderNum && isAdmin) isSenderGroupAdmin = true;
        if (participantNumber === botNumber && isAdmin) isBotGroupAdmin = true;
      }

      const msgKey = msg.key as WAMessageKey;
      if (groupSettings) {
        if (groupSettings.antilink && !isOwner && !isSenderGroupAdmin && URL_REGEX.test(body)) {
          await sock.sendMessage(jid, { delete: msgKey });
          await sock.sendMessage(jid, { text: "Links are not allowed in this group." });
          return;
        }
        if (groupSettings.antibadword && !isOwner && BAD_WORDS.some((w) => body.toLowerCase().includes(w))) {
          await sock.sendMessage(jid, { delete: msgKey });
          await sock.sendMessage(jid, { text: "Bad language is not allowed." });
          return;
        }
        if (groupSettings.antimention && !isOwner && !isSenderGroupAdmin) {
          const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          if (mentions.length >= 5) {
            await sock.sendMessage(jid, { delete: msgKey });
            await sock.sendMessage(jid, { text: "Mass mentions are not allowed." });
            return;
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "Failed to fetch group metadata");
    }
  }

  if (!body.startsWith(prefix)) {
    if (isGroup && groupSettings?.autoReply) {
      try {
        const autoReplyMap: Record<string, string> = JSON.parse(groupSettings.autoReply);
        const bodyLower = body.toLowerCase().trim();
        const matched = Object.entries(autoReplyMap).find(([trigger]) =>
          bodyLower.includes(trigger.toLowerCase())
        );
        if (matched) {
          await sock.sendMessage(jid, { text: matched[1] });
        }
      } catch {
        // skip auto-reply if parsing fails
      }
    }
    return;
  }

  const userSettings = getUserSettings(senderJid);
  if (userSettings?.isBanned && !isOwner) {
    await sock.sendMessage(jid, { text: "You are banned from using this bot." });
    return;
  }

  const ctx: CommandContext = { jid, isOwner, isSenderGroupAdmin, isBotGroupAdmin, groupSettings, prefix };
  const commandText = body.slice(prefix.length).trim();
  const [command, ...args] = commandText.split(" ");
  const cmd = command.toLowerCase();

  logger.info({ cmd, jid, sender: senderNumber, isOwner }, "Command received");

  switch (cmd) {
    // ── General ──────────────────────────────────────────────────────────────
    case "ping":          return handlePing(sock, msg, ctx);
    case "alive":         return handleAlive(sock, msg, ctx);
    case "menu":          return handleMenu(sock, msg, ctx, prefix);
    case "owner":         return handleOwner(sock, msg, ctx);
    case "settings":      return handleSettings(sock, msg, ctx, prefix);
    case "sticker":       return handleSticker(sock, msg, ctx);
    case "restart":       return handleRestart(sock, msg, ctx);

    // ── Bot status settings (owner only) ─────────────────────────────────────
    case "autoviewstatus":
    case "autoview": {
      if (!isOwner) { await sock.sendMessage(jid, { text: "Only the owner can change this." }); return; }
      const val = args[0]?.toLowerCase();
      if (val !== "true" && val !== "false" && val !== "on" && val !== "off") {
        await sock.sendMessage(jid, { text: `Current: ${getBotSettings().autoViewStatus ? "ON" : "OFF"}\nUsage: ${prefix}autoviewstatus on/off` });
        return;
      }
      const enabled = val === "true" || val === "on";
      updateBotSettings({ autoViewStatus: enabled });
      await sock.sendMessage(jid, { text: `Auto-view status: *${enabled ? "ON" : "OFF"}*` });
      return;
    }

    case "autolikestatus":
    case "autolike": {
      if (!isOwner) { await sock.sendMessage(jid, { text: "Only the owner can change this." }); return; }
      const val = args[0]?.toLowerCase();
      if (val !== "true" && val !== "false" && val !== "on" && val !== "off") {
        await sock.sendMessage(jid, { text: `Current: ${getBotSettings().autoLikeStatus ? "ON" : "OFF"}\nUsage: ${prefix}autolikestatus on/off` });
        return;
      }
      const enabled = val === "true" || val === "on";
      updateBotSettings({ autoLikeStatus: enabled });
      await sock.sendMessage(jid, { text: `Auto-like status: *${enabled ? "ON" : "OFF"}*` });
      return;
    }

    case "statusemoji": {
      if (!isOwner) { await sock.sendMessage(jid, { text: "Only the owner can change this." }); return; }
      const emoji = args.join(" ").trim();
      if (!emoji) {
        await sock.sendMessage(jid, { text: `Current emoji: ${getBotSettings().statusLikeEmoji}\nUsage: ${prefix}statusemoji ❤️,🔥,😍` });
        return;
      }
      updateBotSettings({ statusLikeEmoji: emoji });
      await sock.sendMessage(jid, { text: `Status like emoji set to: *${emoji}*` });
      return;
    }

    // ── Group management ──────────────────────────────────────────────────────
    case "kick":          return handleKick(sock, msg, ctx);
    case "add":           return handleAdd(sock, msg, ctx, args);
    case "promote":       return handlePromote(sock, msg, ctx);
    case "demote":        return handleDemote(sock, msg, ctx);
    case "antilink":      return handleAntilink(sock, msg, ctx, args);
    case "antibadword":   return handleAntibadword(sock, msg, ctx, args);
    case "antimention":   return handleAntimention(sock, msg, ctx, args);
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
      await sock.sendMessage(jid, { text: `Unknown command: ${prefix}${cmd}\nUse ${prefix}menu for all commands.` });
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
      const name = `@${number}`;
      const welcomeText = welcomeTemplate
        .replace(/\{name\}/gi, name)
        .replace(/\{group\}/gi, groupMeta.subject);

      await sock.sendMessage(groupId, {
        text: welcomeText,
        mentions: [participantJid],
      });
    }
  } catch (err) {
    logger.warn({ err, groupId }, "Failed to send welcome message");
  }
}
