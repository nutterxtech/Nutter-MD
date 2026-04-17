import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { CommandContext } from "../handler";
import { logger } from "../../lib/logger";

export async function handlePing(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const start = Date.now();
  await sock.sendMessage(ctx.jid, { text: "🏓 Pong!" });
  const latency = Date.now() - start;
  await sock.sendMessage(ctx.jid, { text: `*Latency:* ${latency}ms` });
}

export async function handleAlive(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const text = `*NUTTER-XMD* ⚡\n\n*Status:* Online\n*Uptime:* ${hours}h ${minutes}m ${seconds}s\n*Version:* 1.0.0`;
  await sock.sendMessage(ctx.jid, { text });
}

export async function handleMenu(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, prefix: string) {
  const botName = process.env["BOT_NAME"] || "NUTTER-XMD";
  const menu = `*${botName}* — Command Menu\n\n` +
    `*General*\n` +
    `${prefix}ping — Check bot latency\n` +
    `${prefix}alive — Bot uptime & status\n` +
    `${prefix}menu — Show this menu\n` +
    `${prefix}owner — Get owner contact\n` +
    `${prefix}settings — Current bot settings\n` +
    `${prefix}sticker — Convert image to sticker (reply to image)\n` +
    `${prefix}restart — Restart bot (owner only)\n\n` +
    `*Status (Owner only)*\n` +
    `${prefix}autoviewstatus on/off — Auto-view contacts' statuses\n` +
    `${prefix}autolikestatus on/off — Auto-react to statuses\n` +
    `${prefix}statusemoji <emoji> — Set reaction emoji (e.g. ❤️,🔥,😍)\n\n` +
    `*Group Info*\n` +
    `${prefix}groupinfo — Show group details & stats\n` +
    `${prefix}tagall [msg] — Tag all members (admin only)\n\n` +
    `*Group Management* (Admin only)\n` +
    `${prefix}kick @user — Remove member\n` +
    `${prefix}add +number — Add member\n` +
    `${prefix}promote @user — Make admin\n` +
    `${prefix}demote @user — Remove admin\n` +
    `${prefix}mute — Mute group (admins only can chat)\n` +
    `${prefix}unmute — Unmute group\n` +
    `${prefix}antilink on/off — Block links\n` +
    `${prefix}antibadword delete/kick/off — Block bad words\n` +
    `${prefix}setbadwords <w1,w2> — Set custom bad words list\n` +
    `${prefix}setbadwords list — Show current bad words\n` +
    `${prefix}setbadwords reset — Restore default list\n` +
    `${prefix}antimention on/off — Block mass mentions\n` +
    `${prefix}ban @user — Ban user from bot\n` +
    `${prefix}unban @user — Unban user\n` +
    `${prefix}setprefix <char> — Change command prefix\n\n` +
    `*Welcome Messages* (Admin only)\n` +
    `${prefix}welcome on/off — Enable/disable welcome messages\n` +
    `${prefix}setwelcome <msg> — Set welcome text (use {name} & {group})\n\n` +
    `*Auto-Reply* (Admin only)\n` +
    `${prefix}autoreply add <trigger> | <response>\n` +
    `${prefix}autoreply remove <trigger>\n` +
    `${prefix}autoreply list`;
  await sock.sendMessage(ctx.jid, { text: menu });
}

export async function handleOwner(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const ownerNumber = process.env["OWNER_NUMBER"] || "";
  if (!ownerNumber) {
    await sock.sendMessage(ctx.jid, { text: "Owner number not configured." });
    return;
  }
  const digits = ownerNumber.replace(/[^0-9]/g, "");
  await sock.sendMessage(ctx.jid, {
    contacts: {
      displayName: "NUTTER-XMD Owner",
      contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:NUTTER-XMD Owner\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`, displayName: "NUTTER-XMD Owner" }]
    }
  });
}

export async function handleSettings(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, prefix: string) {
  const { getBotSettings } = await import("../store");
  const botName = process.env["BOT_NAME"] || "NUTTER-XMD";
  const ownerNumber = process.env["OWNER_NUMBER"] || "Not set";
  const mode = (process.env["BOT_MODE"] || "public").toLowerCase();
  const bs = getBotSettings();

  const botInfo =
    `*${botName} Settings*\n\n` +
    `*General*\n` +
    `Prefix: ${prefix}\n` +
    `Mode: ${mode}\n` +
    `Owner: ${ownerNumber}\n\n` +
    `*Status*\n` +
    `Auto-view status: ${bs.autoViewStatus ? "ON" : "OFF"}\n` +
    `Auto-like status: ${bs.autoLikeStatus ? "ON" : "OFF"}\n` +
    `Status emoji: ${bs.statusLikeEmoji}`;

  let groupInfo = "";
  if (ctx.groupSettings) {
    const s = ctx.groupSettings;
    groupInfo =
      `\n\n*Group Protection*\n` +
      `Antilink: ${s.antilink ? "ON" : "OFF"}\n` +
      `Antibadword: ${s.antibadword ? "ON" : "OFF"}\n` +
      `Antimention: ${s.antimention ? "ON" : "OFF"}\n` +
      `Mute: ${s.mute ? "ON" : "OFF"}\n` +
      `Custom Prefix: ${s.customPrefix || prefix}\n\n` +
      `*Welcome*\n` +
      `Welcome Messages: ${s.welcomeEnabled ? "ON" : "OFF"}\n` +
      `Welcome Text: ${s.welcomeMessage || "Default"}`;
  }

  await sock.sendMessage(ctx.jid, { text: botInfo + groupInfo });
}

async function downloadToBuffer(mediaMsg: object, type: "image" | "video"): Promise<Buffer> {
  const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
  const stream = await downloadContentFromMessage(
    mediaMsg as Parameters<typeof downloadContentFromMessage>[0],
    type
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function extractVideoFirstFrame(videoBuffer: Buffer): Promise<Buffer> {
  const os = await import("os");
  const path = await import("path");
  const fs = await import("fs");
  const { spawn } = await import("child_process");

  const tmpDir = os.default.tmpdir();
  const inputPath = path.default.join(tmpDir, `nutter_vid_${Date.now()}.mp4`);
  const outputPath = path.default.join(tmpDir, `nutter_frame_${Date.now()}.png`);

  fs.default.writeFileSync(inputPath, videoBuffer);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y", "-i", inputPath,
      "-ss", "0", "-vframes", "1",
      "-f", "image2", outputPath,
    ]);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") reject(new Error("FFMPEG_NOT_FOUND"));
      else reject(err);
    });
  });

  const frameBuffer = fs.default.readFileSync(outputPath);
  fs.default.rmSync(inputPath, { force: true });
  fs.default.rmSync(outputPath, { force: true });
  return frameBuffer;
}

export async function handleSticker(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) {
    await sock.sendMessage(ctx.jid, { text: "Reply to an image or video with .sticker to convert it to a sticker." });
    return;
  }

  const imageMsg = quoted.imageMessage;
  const videoMsg = quoted.videoMessage;

  if (!imageMsg && !videoMsg) {
    await sock.sendMessage(ctx.jid, { text: "Only images and short videos can be converted to stickers. Reply to an image or video." });
    return;
  }

  try {
    const { default: sharp } = await import("sharp");

    let sourceBuffer: Buffer;

    if (imageMsg) {
      sourceBuffer = await downloadToBuffer(imageMsg, "image");
    } else {
      sourceBuffer = await downloadToBuffer(videoMsg!, "video");
      sourceBuffer = await extractVideoFirstFrame(sourceBuffer);
    }

    if (!sourceBuffer || sourceBuffer.length === 0) {
      await sock.sendMessage(ctx.jid, { text: "Could not download the media. Please try again." });
      return;
    }

    const webpBuffer = await sharp(sourceBuffer)
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80 })
      .toBuffer();

    await sock.sendMessage(ctx.jid, { sticker: webpBuffer });
  } catch (err) {
    logger.error({ err }, "Sticker conversion failed");
    const isNoFfmpeg = err instanceof Error && err.message === "FFMPEG_NOT_FOUND";
    await sock.sendMessage(ctx.jid, {
      text: isNoFfmpeg
        ? "Video stickers are not supported on this server (ffmpeg not installed). Try sending an image instead."
        : "Sticker conversion failed. Please try again.",
    });
  }
}

export async function handleRestart(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner) {
    await sock.sendMessage(ctx.jid, { text: "🚫 Only owner command" });
    return;
  }
  await sock.sendMessage(ctx.jid, { text: "Restarting..." });
  setTimeout(() => process.exit(0), 1000);
}
