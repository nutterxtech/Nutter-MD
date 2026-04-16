import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { CommandContext } from "../handler";
import { db } from "@workspace/db";
import { groupSettingsTable } from "@workspace/db/schema";
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
  if (!ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "This command requires bot admin privileges." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Tag the user to kick: .kick @user" });
    return;
  }
  try {
    await sock.groupParticipantsUpdate(msg.key.remoteJid!, mentioned, "remove");
    await sock.sendMessage(msg.key.remoteJid!, { text: `Removed ${mentioned.length} member(s).` });
  } catch (err) {
    logger.error({ err }, "Failed to kick");
    await sock.sendMessage(msg.key.remoteJid!, { text: "Failed to kick. Make sure I am an admin." });
  }
}

export async function handleAdd(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "This command requires bot admin privileges." });
    return;
  }
  const number = args[0]?.replace(/[^0-9]/g, "");
  if (!number) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Provide number: .add +254712345678" });
    return;
  }
  const jid = number + "@s.whatsapp.net";
  try {
    await sock.groupParticipantsUpdate(msg.key.remoteJid!, [jid], "add");
    await sock.sendMessage(msg.key.remoteJid!, { text: `Added ${number} to the group.` });
  } catch (err) {
    logger.error({ err }, "Failed to add");
    await sock.sendMessage(msg.key.remoteJid!, { text: "Failed to add. The number may not be on WhatsApp." });
  }
}

export async function handlePromote(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Bot must be admin to use this command." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Tag a user: .promote @user" });
    return;
  }
  await sock.groupParticipantsUpdate(msg.key.remoteJid!, mentioned, "promote");
  await sock.sendMessage(msg.key.remoteJid!, { text: "Promoted successfully." });
}

export async function handleDemote(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Bot must be admin to use this command." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Tag a user: .demote @user" });
    return;
  }
  await sock.groupParticipantsUpdate(msg.key.remoteJid!, mentioned, "demote");
  await sock.sendMessage(msg.key.remoteJid!, { text: "Demoted successfully." });
}

export async function handleAntilink(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Only group admins can use this." });
    return;
  }
  const state = args[0]?.toLowerCase() === "on";
  await ensureGroupSettings(msg.key.remoteJid!);
  await updateGroupSetting(msg.key.remoteJid!, { antilink: state });
  await sock.sendMessage(msg.key.remoteJid!, { text: `Antilink is now ${state ? "ON" : "OFF"}.` });
}

export async function handleAntibadword(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Only group admins can use this." });
    return;
  }
  const state = args[0]?.toLowerCase() === "on";
  await ensureGroupSettings(msg.key.remoteJid!);
  await updateGroupSetting(msg.key.remoteJid!, { antibadword: state });
  await sock.sendMessage(msg.key.remoteJid!, { text: `Antibadword is now ${state ? "ON" : "OFF"}.` });
}

export async function handleAntimention(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext, args: string[]) {
  if (!ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Only group admins can use this." });
    return;
  }
  const state = args[0]?.toLowerCase() === "on";
  await ensureGroupSettings(msg.key.remoteJid!);
  await updateGroupSetting(msg.key.remoteJid!, { antimention: state });
  await sock.sendMessage(msg.key.remoteJid!, { text: `Antimention is now ${state ? "ON" : "OFF"}.` });
}

export async function handleBan(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner && !ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Only admins can ban users." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Tag a user: .ban @user" });
    return;
  }

  const { userSettingsTable } = await import("@workspace/db/schema");
  for (const jid of mentioned) {
    await db.insert(userSettingsTable).values({ userId: jid, isBanned: true })
      .onConflictDoUpdate({ target: userSettingsTable.userId, set: { isBanned: true, updatedAt: new Date() } });
  }
  await sock.sendMessage(msg.key.remoteJid!, { text: `Banned ${mentioned.length} user(s).` });
}

export async function handleUnban(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner && !ctx.isGroupAdmin) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Only admins can unban users." });
    return;
  }
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!mentioned || mentioned.length === 0) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Tag a user: .unban @user" });
    return;
  }

  const { userSettingsTable } = await import("@workspace/db/schema");
  for (const jid of mentioned) {
    await db.update(userSettingsTable).set({ isBanned: false, updatedAt: new Date() }).where(eq(userSettingsTable.userId, jid));
  }
  await sock.sendMessage(msg.key.remoteJid!, { text: `Unbanned ${mentioned.length} user(s).` });
}

export { ensureGroupSettings };
