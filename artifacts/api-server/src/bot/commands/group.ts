import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { CommandContext } from "../handler";
import { db } from "@workspace/db";
import { groupSettingsTable, userSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";

async function ensureGroupSettings(groupId: string) {
  const existing = await db.select().from(groupSettingsTable).where(eq(groupSettingsTable.groupId, groupId)).limit(1);
  if (existing.length > 0) return existing[0];
  const [created] = await db.insert(groupSettingsTable).values({ groupId }).returning();
  return created;
}

async function updateGroupSetting(groupId: string, update: Partial<typeof groupSettingsTable.$inferInsert>) {
  await db.update(groupSettingsTable)
    .set({ ...update, updatedAt: new Date() })
    .where(eq(groupSettingsTable.groupId, groupId));
}

export async function handleKick(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isBotGroupAdmin) {
    await sock.sendMessage(ctx.jid, { text: "This command requires bot admin privileges." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await sock.sendMessage(ctx.jid, { text: "Only group admins can kick members." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(ctx.jid, { text: "Tag the user to kick: .kick @user" });
    return;
  }
  try {
    await sock.groupParticipantsUpdate(ctx.jid, mentioned, "remove");
    await sock.sendMessage(ctx.jid, { text: `Removed ${mentioned.length} member(s).` });
  } catch (err) {
    logger.error({ err }, "Failed to kick");
    await sock.sendMessage(ctx.jid, { text: "Failed to kick. Make sure I am an admin." });
  }
}

export async function handleAdd(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isBotGroupAdmin) {
    await sock.sendMessage(ctx.jid, { text: "This command requires bot admin privileges." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await sock.sendMessage(ctx.jid, { text: "Only group admins can add members." });
    return;
  }
  const number = args[0]?.replace(/[^0-9]/g, "");
  if (!number) {
    await sock.sendMessage(ctx.jid, { text: "Provide number: .add +254712345678" });
    return;
  }
  const memberJid = number + "@s.whatsapp.net";
  try {
    await sock.groupParticipantsUpdate(ctx.jid, [memberJid], "add");
    await sock.sendMessage(ctx.jid, { text: `Added ${number} to the group.` });
  } catch (err) {
    logger.error({ err }, "Failed to add");
    await sock.sendMessage(ctx.jid, { text: "Failed to add. The number may not be on WhatsApp." });
  }
}

export async function handlePromote(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isBotGroupAdmin) {
    await sock.sendMessage(ctx.jid, { text: "Bot must be admin to use this command." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await sock.sendMessage(ctx.jid, { text: "Only group admins can promote members." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(ctx.jid, { text: "Tag a user: .promote @user" });
    return;
  }
  await sock.groupParticipantsUpdate(ctx.jid, mentioned, "promote");
  await sock.sendMessage(ctx.jid, { text: "Promoted successfully." });
}

export async function handleDemote(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isBotGroupAdmin) {
    await sock.sendMessage(ctx.jid, { text: "Bot must be admin to use this command." });
    return;
  }
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await sock.sendMessage(ctx.jid, { text: "Only group admins can demote members." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(ctx.jid, { text: "Tag a user: .demote @user" });
    return;
  }
  await sock.groupParticipantsUpdate(ctx.jid, mentioned, "demote");
  await sock.sendMessage(ctx.jid, { text: "Demoted successfully." });
}

export async function handleAntilink(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await sock.sendMessage(ctx.jid, { text: "Only group admins can use this." });
    return;
  }
  const state = args[0]?.toLowerCase() === "on";
  await ensureGroupSettings(ctx.jid);
  await updateGroupSetting(ctx.jid, { antilink: state });
  await sock.sendMessage(ctx.jid, { text: `Antilink is now ${state ? "ON" : "OFF"}.` });
}

export async function handleAntibadword(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await sock.sendMessage(ctx.jid, { text: "Only group admins can use this." });
    return;
  }
  const state = args[0]?.toLowerCase() === "on";
  await ensureGroupSettings(ctx.jid);
  await updateGroupSetting(ctx.jid, { antibadword: state });
  await sock.sendMessage(ctx.jid, { text: `Antibadword is now ${state ? "ON" : "OFF"}.` });
}

export async function handleAntimention(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isSenderGroupAdmin && !ctx.isOwner) {
    await sock.sendMessage(ctx.jid, { text: "Only group admins can use this." });
    return;
  }
  const state = args[0]?.toLowerCase() === "on";
  await ensureGroupSettings(ctx.jid);
  await updateGroupSetting(ctx.jid, { antimention: state });
  await sock.sendMessage(ctx.jid, { text: `Antimention is now ${state ? "ON" : "OFF"}.` });
}

export async function handleBan(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner && !ctx.isSenderGroupAdmin) {
    await sock.sendMessage(ctx.jid, { text: "Only admins can ban users." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(ctx.jid, { text: "Tag a user: .ban @user" });
    return;
  }

  for (const userId of mentioned) {
    await db.insert(userSettingsTable).values({ userId, isBanned: true })
      .onConflictDoUpdate({ target: userSettingsTable.userId, set: { isBanned: true, updatedAt: new Date() } });
  }
  await sock.sendMessage(ctx.jid, { text: `Banned ${mentioned.length} user(s).` });
}

export async function handleUnban(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner && !ctx.isSenderGroupAdmin) {
    await sock.sendMessage(ctx.jid, { text: "Only admins can unban users." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(ctx.jid, { text: "Tag a user: .unban @user" });
    return;
  }

  for (const userId of mentioned) {
    await db.update(userSettingsTable).set({ isBanned: false, updatedAt: new Date() }).where(eq(userSettingsTable.userId, userId));
  }
  await sock.sendMessage(ctx.jid, { text: `Unbanned ${mentioned.length} user(s).` });
}

export { ensureGroupSettings };
