import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { GroupSettings } from "@workspace/db";
import { db } from "@workspace/db";
import { groupSettingsTable, userSettingsTable } from "@workspace/db/schema";
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
  ensureGroupSettings,
} from "./commands/group";

const BAD_WORDS = ["fuck", "shit", "bitch", "asshole", "nigga", "faggot", "cunt"];
const URL_REGEX = /https?:\/\/[^\s]+|wa\.me\/[^\s]+|t\.me\/[^\s]+/gi;

export interface CommandContext {
  isOwner: boolean;
  isGroupAdmin: boolean;
  groupSettings: GroupSettings | null;
}

export async function handleMessage(sock: WASocket, msg: proto.IWebMessageInfo) {
  const ownerNumber = (process.env["OWNER_NUMBER"] || "").replace(/[^0-9]/g, "");
  const prefix = process.env["PREFIX"] || ".";

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
  let isGroupAdmin = false;

  if (isGroup) {
    try {
      const settings = await db.select().from(groupSettingsTable).where(eq(groupSettingsTable.groupId, jid)).limit(1);
      groupSettings = settings[0] ?? null;

      const groupMeta = await sock.groupMetadata(jid);
      const botJid = sock.user?.id || "";
      const botNumber = botJid.split(":")[0].split("@")[0];
      const senderNum = senderJid.split("@")[0];
      isGroupAdmin = groupMeta.participants.some(
        (p) => (p.id.split("@")[0] === senderNum || p.id.split("@")[0] === botNumber) && (p.admin === "admin" || p.admin === "superadmin")
      );

      if (groupSettings) {
        if (groupSettings.antilink && !isOwner && !isGroupAdmin && URL_REGEX.test(body)) {
          await sock.sendMessage(jid, { delete: msg.key });
          await sock.sendMessage(jid, { text: "Links are not allowed in this group." });
          return;
        }
        if (groupSettings.antibadword && !isOwner && BAD_WORDS.some((w) => body.toLowerCase().includes(w))) {
          await sock.sendMessage(jid, { delete: msg.key });
          await sock.sendMessage(jid, { text: "Bad language is not allowed." });
          return;
        }
        if (groupSettings.antimention && !isOwner && !isGroupAdmin) {
          const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          if (mentions.length >= 5) {
            await sock.sendMessage(jid, { delete: msg.key });
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
  } catch (_) {}

  const ctx: CommandContext = { isOwner, isGroupAdmin, groupSettings };
  const commandText = body.slice(prefix.length).trim();
  const [command, ...args] = commandText.split(" ");
  const cmd = command.toLowerCase();

  logger.info({ cmd, jid, sender: senderNumber }, "Command received");

  switch (cmd) {
    case "ping": return handlePing(sock, msg, ctx);
    case "alive": return handleAlive(sock, msg, ctx);
    case "menu": return handleMenu(sock, msg, ctx);
    case "owner": return handleOwner(sock, msg, ctx);
    case "settings": return handleSettings(sock, msg, ctx);
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
