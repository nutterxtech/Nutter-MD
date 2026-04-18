import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { CommandContext } from "../handler";
import { ensureGroupSettings, updateGroupSettings, setUserBanned } from "../store";
import { logger } from "../../lib/logger";
import { safeSend } from "../utils";

export async function handleKick(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isBotGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "This command requires bot admin privileges." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await safeSend(sock, ctx.jid, { text: "Tag the user to kick: .kick @user" });
    return;
  }
  try {
    await sock.groupParticipantsUpdate(ctx.jid, mentioned, "remove");
    await safeSend(sock, ctx.jid, { text: `Removed ${mentioned.length} member(s).` });
  } catch (err) {
    logger.error({ err }, "Failed to kick");
    await safeSend(sock, ctx.jid, { text: "Failed to kick. Make sure I am an admin." });
  }
}

export async function handleAdd(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isBotGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "This command requires bot admin privileges." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const number = args[0]?.replace(/[^0-9]/g, "");
  if (!number) {
    await safeSend(sock, ctx.jid, { text: "Provide number: .add +254712345678" });
    return;
  }
  const memberJid = number + "@s.whatsapp.net";
  try {
    await sock.groupParticipantsUpdate(ctx.jid, [memberJid], "add");
    await safeSend(sock, ctx.jid, { text: `Added ${number} to the group.` });
  } catch (err) {
    logger.error({ err }, "Failed to add");
    await safeSend(sock, ctx.jid, { text: "Failed to add. The number may not be on WhatsApp." });
  }
}

export async function handlePromote(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isBotGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "🚫 I need admin privileges for this." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await safeSend(sock, ctx.jid, { text: "Tag a user: .promote @user" });
    return;
  }
  await sock.groupParticipantsUpdate(ctx.jid, mentioned, "promote");
  await safeSend(sock, ctx.jid, { text: "Promoted successfully." });
}

export async function handleDemote(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isBotGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "🚫 I need admin privileges for this." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await safeSend(sock, ctx.jid, { text: "Tag a user: .demote @user" });
    return;
  }
  await sock.groupParticipantsUpdate(ctx.jid, mentioned, "demote");
  await safeSend(sock, ctx.jid, { text: "Demoted successfully." });
}

export async function handleAntilink(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const raw = args[0]?.toLowerCase();
  if (raw !== "on" && raw !== "off") {
    await safeSend(sock, ctx.jid, { text: "Usage: .antilink on | .antilink off" });
    return;
  }
  const state = raw === "on";
  updateGroupSettings(ctx.jid, { antilink: state });
  await safeSend(sock, ctx.jid, { text: `Antilink is now ${state ? "ON" : "OFF"}.` });
}

export async function handleAntibadword(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const raw = args[0]?.toLowerCase();
  const VALID = ["on", "true", "delete", "kick", "off", "false"];
  if (!raw || !VALID.includes(raw)) {
    await safeSend(sock, ctx.jid, {
      text:
        `Usage:\n` +
        `.antibadword delete — Delete bad messages\n` +
        `.antibadword kick   — Delete + kick the sender\n` +
        `.antibadword off    — Disable\n` +
        `\nCurrent: ${ensureGroupSettings(ctx.jid).antibadword}`,
    });
    return;
  }
  let mode: "off" | "delete" | "kick";
  if (raw === "off" || raw === "false") mode = "off";
  else if (raw === "kick") mode = "kick";
  else mode = "delete";
  updateGroupSettings(ctx.jid, { antibadword: mode });
  const label = mode === "off" ? "OFF" : mode === "kick" ? "ON — Delete + Kick" : "ON — Delete only";
  await safeSend(sock, ctx.jid, { text: `Antibadword is now *${label}*.` });
}

export async function handleSetBadWords(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  if (!ctx.isGroup) {
    await safeSend(sock, ctx.jid, { text: "This command can only be used in a group." });
    return;
  }
  if (args[0]?.toLowerCase() === "reset") {
    updateGroupSettings(ctx.jid, { customBadWords: null });
    await safeSend(sock, ctx.jid, { text: "✅ Bad words list reset to default." });
    return;
  }
  if (args[0]?.toLowerCase() === "list") {
    const gs = ensureGroupSettings(ctx.jid);
    const list = gs.customBadWords
      ? gs.customBadWords.split(",").map((w) => w.trim()).join(", ")
      : "Using default list";
    await safeSend(sock, ctx.jid, { text: `*Bad Words List:*\n${list}` });
    return;
  }
  if (!args.length) {
    await safeSend(sock, ctx.jid, {
      text:
        `Usage:\n` +
        `.setbadwords <word1, word2, word3> — Set custom bad words\n` +
        `.setbadwords list — Show current list\n` +
        `.setbadwords reset — Restore default list`,
    });
    return;
  }
  const words = args.join(" ").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  updateGroupSettings(ctx.jid, { customBadWords: words.join(",") });
  await safeSend(sock, ctx.jid, { text: `✅ Bad words list updated:\n${words.join(", ")}` });
}

export async function handleAntiDelete(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  if (!ctx.isGroup) {
    await safeSend(sock, ctx.jid, { text: "This command can only be used in a group." });
    return;
  }
  const raw = args[0]?.toLowerCase();
  if (raw !== "on" && raw !== "off") {
    const current = ensureGroupSettings(ctx.jid).antiDelete;
    await safeSend(sock, ctx.jid, { text: `Usage: .antidelete on | .antidelete off\nCurrent: ${current ? "ON" : "OFF"}` });
    return;
  }
  const state = raw === "on";
  updateGroupSettings(ctx.jid, { antiDelete: state });
  await safeSend(sock, ctx.jid, { text: `Antidelete is now *${state ? "ON" : "OFF"}*.${state ? "\nDeleted messages will be forwarded to owner's DM." : ""}` });
}

export async function handleAntimention(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const raw = args[0]?.toLowerCase();
  if (raw !== "on" && raw !== "off") {
    await safeSend(sock, ctx.jid, { text: "Usage: .antimention on | .antimention off" });
    return;
  }
  const state = raw === "on";
  updateGroupSettings(ctx.jid, { antimention: state });
  await safeSend(sock, ctx.jid, { text: `Antimention is now ${state ? "ON" : "OFF"}.` });
}

export async function handleBan(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner && !ctx.isSenderGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await safeSend(sock, ctx.jid, { text: "Tag a user: .ban @user" });
    return;
  }
  for (const userId of mentioned) {
    setUserBanned(userId, true);
  }
  await safeSend(sock, ctx.jid, { text: `Banned ${mentioned.length} user(s).` });
}

export async function handleUnban(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner && !ctx.isSenderGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await safeSend(sock, ctx.jid, { text: "Tag a user: .unban @user" });
    return;
  }
  for (const userId of mentioned) {
    setUserBanned(userId, false);
  }
  await safeSend(sock, ctx.jid, { text: `Unbanned ${mentioned.length} user(s).` });
}

export async function handleSetPrefix(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.jid.endsWith("@g.us")) {
    await safeSend(sock, ctx.jid, { text: "This command can only be used in groups." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const newPrefix = args[0]?.trim();
  if (!newPrefix || newPrefix.length > 5) {
    await safeSend(sock, ctx.jid, { text: "Provide a prefix (1–5 chars): .setprefix !" });
    return;
  }
  updateGroupSettings(ctx.jid, { customPrefix: newPrefix });
  await safeSend(sock, ctx.jid, { text: `Prefix changed to: ${newPrefix}` });
}

export async function handleTagAll(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isBotGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "🚫 I need admin privileges for tagall." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  try {
    const groupMeta = await sock.groupMetadata(ctx.jid);
    const participants = groupMeta.participants.map((p) => p.id);
    const announcement = args.length > 0 ? args.join(" ") : "📢 Attention everyone!";
    const mentions = participants.map((jid) => `@${jid.split("@")[0]}`).join(" ");
    await safeSend(sock, ctx.jid, {
      text: `${announcement}\n\n${mentions}`,
      mentions: participants,
    });
  } catch (err) {
    logger.error({ err }, "Failed to tagall");
    await safeSend(sock, ctx.jid, { text: "Failed to tag all members." });
  }
}

export async function handleGroupInfo(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  try {
    const groupMeta = await sock.groupMetadata(ctx.jid);
    const adminCount = groupMeta.participants.filter(
      (p) => p.admin === "admin" || p.admin === "superadmin"
    ).length;
    const createdAt = groupMeta.creation
      ? new Date(groupMeta.creation * 1000).toLocaleDateString()
      : "Unknown";

    const settings = ctx.groupSettings;
    const protections = [
      settings?.antilink ? "Antilink" : null,
      settings?.antibadword ? "Antibadword" : null,
      settings?.antimention ? "Antimention" : null,
      settings?.mute ? "Muted" : null,
    ].filter(Boolean).join(", ") || "None";

    const text =
      `*Group Info*\n\n` +
      `*Name:* ${groupMeta.subject}\n` +
      `*Members:* ${groupMeta.participants.length}\n` +
      `*Admins:* ${adminCount}\n` +
      `*Created:* ${createdAt}\n` +
      `*Description:* ${groupMeta.desc || "None"}\n` +
      `*Active Protections:* ${protections}`;

    await safeSend(sock, ctx.jid, { text });
  } catch (err) {
    logger.error({ err }, "Failed to get group info");
    await safeSend(sock, ctx.jid, { text: "Failed to retrieve group info." });
  }
}

export async function handleMute(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isBotGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "🚫 I need admin privileges to mute." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  try {
    await sock.groupSettingUpdate(ctx.jid, "announcement");
    updateGroupSettings(ctx.jid, { mute: true });
    await safeSend(sock, ctx.jid, { text: "🔇 Group muted. Only admins can send messages." });
  } catch (err) {
    logger.error({ err }, "Failed to mute group");
    await safeSend(sock, ctx.jid, { text: "Failed to mute group." });
  }
}

export async function handleUnmute(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isBotGroupAdmin) {
    await safeSend(sock, ctx.jid, { text: "🚫 I need admin privileges to unmute." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  try {
    await sock.groupSettingUpdate(ctx.jid, "not_announcement");
    updateGroupSettings(ctx.jid, { mute: false });
    await safeSend(sock, ctx.jid, { text: "🔊 Group unmuted. All members can send messages." });
  } catch (err) {
    logger.error({ err }, "Failed to unmute group");
    await safeSend(sock, ctx.jid, { text: "Failed to unmute group." });
  }
}

export async function handleWelcome(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.jid.endsWith("@g.us")) {
    await safeSend(sock, ctx.jid, { text: "This command can only be used in groups." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const raw = args[0]?.toLowerCase();
  if (raw !== "on" && raw !== "off") {
    await safeSend(sock, ctx.jid, { text: `Usage: ${ctx.prefix}welcome on | ${ctx.prefix}welcome off` });
    return;
  }
  const state = raw === "on";
  updateGroupSettings(ctx.jid, { welcomeEnabled: state });
  await safeSend(sock, ctx.jid, {
    text: `Welcome messages are now ${state ? "ON" : "OFF"}.${state ? `\n\nUse ${ctx.prefix}setwelcome <message> to set a custom message. Use {name} as placeholder for the new member's name.` : ""}`,
  });
}

export async function handleSetWelcome(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.jid.endsWith("@g.us")) {
    await safeSend(sock, ctx.jid, { text: "This command can only be used in groups." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }
  const message = args.join(" ").trim();
  if (!message) {
    await safeSend(sock, ctx.jid, { text: `Usage: ${ctx.prefix}setwelcome Welcome to the group, {name}! 🎉` });
    return;
  }
  updateGroupSettings(ctx.jid, { welcomeMessage: message });
  await safeSend(sock, ctx.jid, { text: `Welcome message set:\n\n${message}` });
}

export async function handleAutoReply(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.jid.endsWith("@g.us")) {
    await safeSend(sock, ctx.jid, { text: "This command can only be used in groups." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Group admins only" });
    return;
  }

  const subCmd = args[0]?.toLowerCase();
  const settings = ensureGroupSettings(ctx.jid);
  let autoReplyMap: Record<string, string> = {};
  try {
    if (settings?.autoReply) autoReplyMap = JSON.parse(settings.autoReply);
  } catch {
    autoReplyMap = {};
  }

  if (subCmd === "list") {
    const entries = Object.entries(autoReplyMap);
    if (entries.length === 0) {
      await safeSend(sock, ctx.jid, { text: "No auto-replies configured for this group." });
      return;
    }
    const list = entries.map(([k, v]) => `*${k}* → ${v}`).join("\n");
    await safeSend(sock, ctx.jid, { text: `*Auto-replies:*\n\n${list}` });
    return;
  }

  if (subCmd === "add") {
    const rest = args.slice(1).join(" ");
    const separatorIdx = rest.indexOf("|");
    if (separatorIdx === -1) {
      await safeSend(sock, ctx.jid, { text: `Usage: ${ctx.prefix}autoreply add <trigger> | <response>` });
      return;
    }
    const trigger = rest.slice(0, separatorIdx).trim().toLowerCase();
    const response = rest.slice(separatorIdx + 1).trim();
    if (!trigger || !response) {
      await safeSend(sock, ctx.jid, { text: "Trigger and response cannot be empty." });
      return;
    }
    autoReplyMap[trigger] = response;
    updateGroupSettings(ctx.jid, { autoReply: JSON.stringify(autoReplyMap) });
    await safeSend(sock, ctx.jid, { text: `Auto-reply added:\n*${trigger}* → ${response}` });
    return;
  }

  if (subCmd === "remove") {
    const trigger = args.slice(1).join(" ").trim().toLowerCase();
    if (!trigger) {
      await safeSend(sock, ctx.jid, { text: `Usage: ${ctx.prefix}autoreply remove <trigger>` });
      return;
    }
    if (!autoReplyMap[trigger]) {
      await safeSend(sock, ctx.jid, { text: `No auto-reply found for: ${trigger}` });
      return;
    }
    delete autoReplyMap[trigger];
    updateGroupSettings(ctx.jid, { autoReply: JSON.stringify(autoReplyMap) });
    await safeSend(sock, ctx.jid, { text: `Auto-reply removed: ${trigger}` });
    return;
  }

  await safeSend(sock, ctx.jid, {
    text: `Usage:\n${ctx.prefix}autoreply add <trigger> | <response>\n${ctx.prefix}autoreply remove <trigger>\n${ctx.prefix}autoreply list`,
  });
}

export { ensureGroupSettings };
