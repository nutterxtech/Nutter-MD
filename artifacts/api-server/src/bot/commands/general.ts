import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { CommandContext } from "../handler";

export async function handlePing(sock: WASocket, msg: proto.IWebMessageInfo, _ctx: CommandContext) {
  const start = Date.now();
  await sock.sendMessage(msg.key.remoteJid!, { text: "🏓 Pong!" });
  const latency = Date.now() - start;
  await sock.sendMessage(msg.key.remoteJid!, { text: `*Latency:* ${latency}ms` });
}

export async function handleAlive(sock: WASocket, msg: proto.IWebMessageInfo, _ctx: CommandContext) {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const text = `*NUTTER-XMD* ⚡\n\n*Status:* Online\n*Uptime:* ${hours}h ${minutes}m ${seconds}s\n*Version:* 1.0.0`;
  await sock.sendMessage(msg.key.remoteJid!, { text });
}

export async function handleMenu(sock: WASocket, msg: proto.IWebMessageInfo, _ctx: CommandContext) {
  const prefix = process.env["PREFIX"] || ".";
  const botName = process.env["BOT_NAME"] || "NUTTER-XMD";
  const menu = `*${botName}* — Command Menu\n\n` +
    `*General*\n` +
    `${prefix}ping — Check bot latency\n` +
    `${prefix}alive — Bot uptime & status\n` +
    `${prefix}menu — Show this menu\n` +
    `${prefix}owner — Get owner contact\n` +
    `${prefix}settings — Current bot settings\n` +
    `${prefix}sticker — Convert image/video to sticker\n\n` +
    `*Group Management* (Admin only)\n` +
    `${prefix}kick @user — Remove member\n` +
    `${prefix}add +number — Add member\n` +
    `${prefix}promote @user — Make admin\n` +
    `${prefix}demote @user — Remove admin\n` +
    `${prefix}antilink on/off — Block links\n` +
    `${prefix}antibadword on/off — Block bad words\n` +
    `${prefix}antimention on/off — Block mass mentions\n` +
    `${prefix}ban @user — Ban user\n` +
    `${prefix}unban @user — Unban user`;
  await sock.sendMessage(msg.key.remoteJid!, { text: menu });
}

export async function handleOwner(sock: WASocket, msg: proto.IWebMessageInfo, _ctx: CommandContext) {
  const ownerNumber = process.env["OWNER_NUMBER"] || "";
  if (!ownerNumber) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Owner number not configured." });
    return;
  }
  const jid = ownerNumber.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
  await sock.sendMessage(msg.key.remoteJid!, {
    contacts: {
      displayName: "NUTTER-XMD Owner",
      contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:NUTTER-XMD Owner\nTEL;type=CELL;type=VOICE;waid=${ownerNumber}:${ownerNumber}\nEND:VCARD`, displayName: "NUTTER-XMD Owner" }]
    }
  });
}

export async function handleSettings(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const prefix = process.env["PREFIX"] || ".";
  const botName = process.env["BOT_NAME"] || "NUTTER-XMD";
  const ownerNumber = process.env["OWNER_NUMBER"] || "Not set";

  let groupInfo = "";
  if (ctx.groupSettings) {
    groupInfo = `\n\n*Group Protection*\nAntilink: ${ctx.groupSettings.antilink ? "ON" : "OFF"}\nAntibadword: ${ctx.groupSettings.antibadword ? "ON" : "OFF"}\nAntimention: ${ctx.groupSettings.antimention ? "ON" : "OFF"}`;
  }

  const text = `*${botName} Settings*\n\nPrefix: ${prefix}\nOwner: ${ownerNumber}${groupInfo}`;
  await sock.sendMessage(msg.key.remoteJid!, { text });
}

export async function handleSticker(sock: WASocket, msg: proto.IWebMessageInfo, _ctx: CommandContext) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Reply to an image or video with .sticker to convert it." });
    return;
  }

  const imageMsg = quoted.imageMessage || quoted.videoMessage;
  if (!imageMsg) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Only images and short videos can be converted to stickers." });
    return;
  }

  await sock.sendMessage(msg.key.remoteJid!, { text: "Sticker conversion requires ffmpeg. Feature coming soon!" });
}

export async function handleRestart(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner) {
    await sock.sendMessage(msg.key.remoteJid!, { text: "Only the bot owner can restart." });
    return;
  }
  await sock.sendMessage(msg.key.remoteJid!, { text: "Restarting..." });
  setTimeout(() => process.exit(0), 1000);
}
