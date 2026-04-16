import type { WASocket, WAMessageKey, proto } from "@whiskeysockets/baileys";
import { db } from "@workspace/db";
import { groupSettingsTable, userSettingsTable } from "@workspace/db/schema";
import type { GroupSettings } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
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
} from "./commands/group";

const BAD_WORDS = ["fuck", "shit", "bitch", "asshole", "nigga", "faggot", "cunt"];
const URL_REGEX = /https?:\/\/[^\s]+|wa\.me\/[^\s]+|t\.me\/[^\s]+/i;

export interface CommandContext {
  jid: string;
  isOwner: boolean;
  isSenderGroupAdmin: boolean;
  isBotGroupAdmin: boolean;
  groupSettings: GroupSettings | null;
}

export async function handleMessage(sock: WASocket, msg: proto.IWebMessageInfo) {
  if (!msg.key) return;

  const ownerNumber = (process.env["OWNER_NUMBER"] || "").replace(/[^0-9]/g, "");
  const defaultPrefix = process.env["PREFIX"] || ".";

  const jid = msg.key.remoteJid;
  if (!jid) return;

  const isGroup = jid.endsWith("@g.us");
  const senderJid = isGroup ? msg.key.participant || "" : jid;
  const senderNumber = senderJid.split("@")[0];
  const isOwner = senderNumber === ownerNumber;

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
      const rows = await db.select().from(groupSettingsTable).where(eq(groupSettingsTable.groupId, jid)).limit(1);
      groupSettings = rows[0] ?? null;

      if (groupSettings?.customPrefix) {
        prefix = groupSettings.customPrefix;
      }

      const groupMeta = await sock.groupMetadata(jid);
      const botJid = sock.user?.id || "";
      const botNumber = botJid.split(":")[0].split("@")[0];
      const senderNum = senderJid.split("@")[0];

      for (const participant of groupMeta.participants) {
        const participantNumber = participant.id.split("@")[0];
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

  if (!body.startsWith(prefix)) return;

  try {
    const [banned] = await db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, senderJid)).limit(1);
    if (banned?.isBanned && !isOwner) {
      await sock.sendMessage(jid, { text: "You are banned from using this bot." });
      return;
    }
  } catch (_err) {
    // Non-fatal: continue if DB check fails
  }

  const ctx: CommandContext = { jid, isOwner, isSenderGroupAdmin, isBotGroupAdmin, groupSettings };
  const commandText = body.slice(prefix.length).trim();
  const [command, ...args] = commandText.split(" ");
  const cmd = command.toLowerCase();

  logger.info({ cmd, jid, sender: senderNumber }, "Command received");

  switch (cmd) {
    case "ping": return handlePing(sock, msg, ctx);
    case "alive": return handleAlive(sock, msg, ctx);
    case "menu": return handleMenu(sock, msg, ctx, prefix);
    case "owner": return handleOwner(sock, msg, ctx);
    case "settings": return handleSettings(sock, msg, ctx, prefix);
    case "sticker": return handleSticker(sock, msg, ctx);
    case "restart": return handleRestart(sock, msg, ctx);
    case "kick": return handleKick(sock, msg, ctx);
    case "add": return handleAdd(sock, msg, ctx, args);
    case "promote": return handlePromote(sock, msg, ctx);
    case "demote": return handleDemote(sock, msg, ctx);
    case "antilink": return handleAntilink(sock, msg, ctx, args);
    case "antibadword": return handleAntibadword(sock, msg, ctx, args);
    case "antimention": return handleAntimention(sock, msg, ctx, args);
    case "ban": return handleBan(sock, msg, ctx);
    case "unban": return handleUnban(sock, msg, ctx);
    default:
      await sock.sendMessage(jid, { text: `Unknown command: ${prefix}${cmd}. Use ${prefix}menu to see all commands.` });
  }
}
