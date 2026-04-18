import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { CommandContext } from "../handler";
import { getBotSettings } from "../store";
import { getActiveBotSessionDir, encodeSessionToBase64 } from "../session";
import { logger } from "../../lib/logger";
import { safeSend } from "../utils";
import fs from "fs";
import path from "path";

// ── Menu image ────────────────────────────────────────────────────────────────
function getMenuImageBuffer(): Buffer | null {
  try {
    const assetPath = path.join(__dirname, "assets", "menu.jpg");
    return fs.readFileSync(assetPath);
  } catch {
    return null;
  }
}

// ── Menu category definitions ─────────────────────────────────────────────────
const MENU_CATEGORIES = [
  {
    icon: "🤖",
    name: "AI",
    commands: ["gpt", "gemini", "deepseek", "blackbox", "code", "analyze", "summarize", "translate", "recipe", "story", "teach", "generate"],
  },
  {
    icon: "💾",
    name: "DOWNLOADS",
    commands: ["youtube", "song", "tiktok", "instagram", "twitter", "facebook", "gdrive", "mediafire", "image"],
  },
  {
    icon: "🎵",
    name: "AUDIO",
    commands: ["tomp3", "toptt", "bass", "earrape", "reverse", "robot", "deep"],
  },
  {
    icon: "😊",
    name: "FUN",
    commands: ["meme", "joke", "quote", "trivia", "8ball", "ship", "love", "hug"],
  },
  {
    icon: "🛡️",
    name: "GROUP",
    commands: ["kick", "add", "promote", "demote", "mute", "unmute", "antilink", "tagall", "groupinfo"],
  },
  {
    icon: "⚙️",
    name: "TOOLS",
    commands: ["sticker", "ping", "alive", "menu", "owner", "settings", "restart", "setprefix", "refreshsession"],
  },
  {
    icon: "🔒",
    name: "SECURITY",
    commands: ["antibadword", "antimention", "antidelete", "ban", "unban"],
  },
  {
    icon: "📊",
    name: "STATUS",
    commands: ["autoviewstatus", "autolikestatus", "statusemoji"],
  },
  {
    icon: "🎉",
    name: "EVENTS",
    commands: ["welcome", "setwelcome", "autoreply"],
  },
];

const TOTAL_COMMANDS = MENU_CATEGORIES.reduce((sum, c) => sum + c.commands.length, 0);

function buildMenuText(prefix: string, pushName: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString("en-US", {
    weekday: "short", year: "numeric", month: "short",
    day: "numeric", hour: "2-digit", minute: "2-digit",
  });

  const header =
    `──────── [ NUTTER-XMD ] ─────────\n\n` +
    `✳ | TOTAL COMMANDS: ${TOTAL_COMMANDS}\n` +
    `✳ | PREFIX: ${prefix}\n` +
    `✳ | USER: ${pushName}\n` +
    `✳ | DATE: ${dateStr}`;

  const categories = MENU_CATEGORIES.map(({ icon, name, commands }) => {
    const rows = commands.map((cmd) => `│↪→. ${prefix}${cmd}`).join("\n");
    return `\n\n──── 「 ${icon} ${name} 」 ────→\n${rows}\n└──────────────→`;
  }).join("");

  return header + categories;
}

// ── Command handlers ──────────────────────────────────────────────────────────

export async function handlePing(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const start = Date.now();
  await safeSend(sock, ctx.jid, { text: "🏓 Measuring..." }, { quoted: msg });
  const latency = Date.now() - start;
  await safeSend(sock, ctx.jid, { text: `🏓 *Pong!*\n*Latency:* ${latency}ms` }, { quoted: msg });
}

export async function handleAlive(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const uptime = process.uptime();
  const hours   = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  const text = `*NUTTER-XMD* ⚡\n\n*Status:* Online\n*Uptime:* ${hours}h ${minutes}m ${seconds}s\n*Version:* 9.1.3`;
  await safeSend(sock, ctx.jid, { text });
}

export async function handleMenu(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext, prefix: string) {
  // FIX: Original code used `msg.key.fromMe` (a boolean) as a fallback for
  // senderJid, producing "true" or "false" as the JID string in DMs. We now
  // derive the real sender JID properly for all cases.
  let senderJid: string;
  if (ctx.isGroup) {
    senderJid = msg.key.participant || (sock.user?.id || "");
  } else if (msg.key.fromMe) {
    // Owner sent the command from their own phone (paired account)
    const ownerNumber = (process.env["OWNER_NUMBER"] || "").replace(/[^0-9]/g, "");
    senderJid = ownerNumber ? `${ownerNumber}@s.whatsapp.net` : (sock.user?.id || "");
  } else {
    senderJid = msg.key.remoteJid || "";
  }

  const pushName = msg.pushName || senderJid.split("@")[0].split(":")[0];
  const menuText = `Hey @${senderJid.split("@")[0]} 🤖\n\n` + buildMenuText(prefix, pushName);
  const imgBuf   = getMenuImageBuffer();

  if (imgBuf) {
    await safeSend(
      sock,
      ctx.jid,
      {
        image: imgBuf,
        caption: menuText,
        mimetype: "image/jpeg",
        mentions: [senderJid],
      },
      { quoted: msg }
    );
  } else {
    logger.warn("Menu image not found — sending text only");
    await safeSend(sock, ctx.jid, { text: menuText, mentions: [senderJid] }, { quoted: msg });
  }
}

export async function handleOwner(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const ownerNumber = process.env["OWNER_NUMBER"] || "";
  if (!ownerNumber) {
    await safeSend(sock, ctx.jid, { text: "Owner number not configured." });
    return;
  }
  const digits = ownerNumber.replace(/[^0-9]/g, "");
  await safeSend(sock, ctx.jid, {
    contacts: {
      displayName: "NUTTER-XMD Owner",
      contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:NUTTER-XMD Owner\nTEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`, displayName: "NUTTER-XMD Owner" }]
    }
  });
}

export async function handleSettings(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext, prefix: string) {
  const botName    = process.env["BOT_NAME"] || "NUTTER-XMD";
  const ownerNumber = process.env["OWNER_NUMBER"] || "Not set";
  const mode        = (process.env["BOT_MODE"] || "public").toLowerCase();
  const bs          = getBotSettings();

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
      `Antibadword: ${s.antibadword !== "off" ? "ON (" + s.antibadword + ")" : "OFF"}\n` +
      `Antimention: ${s.antimention ? "ON" : "OFF"}\n` +
      `Antidelete: ${s.antiDelete ? "ON" : "OFF"}\n` +
      `Mute: ${s.mute ? "ON" : "OFF"}\n` +
      `Custom Prefix: ${s.customPrefix || prefix}\n\n` +
      `*Welcome*\n` +
      `Welcome Messages: ${s.welcomeEnabled ? "ON" : "OFF"}\n` +
      `Welcome Text: ${s.welcomeMessage || "Default"}`;
  }

  await safeSend(sock, ctx.jid, { text: botInfo + groupInfo });
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
  const os      = await import("os");
  const pathMod = await import("path");
  const fsMod   = await import("fs");
  const { spawn } = await import("child_process");

  const tmpDir    = os.default.tmpdir();
  const inputPath  = pathMod.default.join(tmpDir, `nutter_vid_${Date.now()}.mp4`);
  const outputPath = pathMod.default.join(tmpDir, `nutter_frame_${Date.now()}.png`);

  fsMod.default.writeFileSync(inputPath, videoBuffer);

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

  const frameBuffer = fsMod.default.readFileSync(outputPath);
  fsMod.default.rmSync(inputPath, { force: true });
  fsMod.default.rmSync(outputPath, { force: true });
  return frameBuffer;
}

export async function handleSticker(sock: WASocket, msg: proto.IWebMessageInfo, ctx: CommandContext) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) {
    await safeSend(sock, ctx.jid, { text: "Reply to an image or video with .sticker to convert it to a sticker." });
    return;
  }

  const imageMsg = quoted.imageMessage;
  const videoMsg = quoted.videoMessage;

  if (!imageMsg && !videoMsg) {
    await safeSend(sock, ctx.jid, { text: "Only images and short videos can be converted to stickers. Reply to an image or video." });
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
      await safeSend(sock, ctx.jid, { text: "Could not download the media. Please try again." });
      return;
    }

    const webpBuffer = await sharp(sourceBuffer)
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80 })
      .toBuffer();

    await safeSend(sock, ctx.jid, { sticker: webpBuffer });
  } catch (err) {
    logger.error({ err }, "Sticker conversion failed");
    const isNoFfmpeg = err instanceof Error && err.message === "FFMPEG_NOT_FOUND";
    await safeSend(sock, ctx.jid, {
      text: isNoFfmpeg
        ? "Video stickers are not supported on this server (ffmpeg not installed). Try sending an image instead."
        : "Sticker conversion failed. Please try again.",
    });
  }
}

export async function handleRestart(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Only owner command" });
    return;
  }
  await safeSend(sock, ctx.jid, { text: "Restarting..." });
  setTimeout(() => process.exit(0), 1000);
}

export async function handleRefreshSession(sock: WASocket, _msg: proto.IWebMessageInfo, ctx: CommandContext) {
  if (!ctx.isOwner) {
    await safeSend(sock, ctx.jid, { text: "🚫 Only owner command" });
    return;
  }

  const sessionDir = getActiveBotSessionDir();
  if (!sessionDir) {
    await safeSend(sock, ctx.jid, { text: "⚠️ Session directory not found. Bot may not be fully initialized." });
    return;
  }

  await safeSend(sock, ctx.jid, { text: "⏳ Reading live session files and building new SESSION_ID — please wait..." });

  try {
    const files = fs.readdirSync(sessionDir);
    const fileMap: Record<string, unknown> = {};
    for (const file of files) {
      try {
        fileMap[file] = JSON.parse(fs.readFileSync(path.join(sessionDir, file), "utf-8"));
      } catch {
        // skip unreadable files
      }
    }

    const sessionCount   = files.filter((f) => f.startsWith("session-")).length;
    const senderKeyCount = files.filter((f) => f.startsWith("sender-key-") && f !== "sender-key-memory.json").length;
    const totalKb        = Buffer.byteLength(JSON.stringify(fileMap)) / 1024;

    const newSessionId = await encodeSessionToBase64(fileMap);

    await safeSend(sock, ctx.jid, { text: newSessionId });
    await safeSend(sock, ctx.jid, {
      text:
        `✅ *New SESSION_ID generated!*\n\n` +
        `📊 *Stats:*\n` +
        `• Session files:    ${sessionCount}\n` +
        `• Sender-key files: ${senderKeyCount}\n` +
        `• Raw size:         ${totalKb.toFixed(1)} KB\n\n` +
        `Copy the SESSION_ID above and set it as the *SESSION_ID* config var on Heroku, then redeploy.\n` +
        `After that, all commands (DM + groups) will respond instantly.`,
    });
  } catch (err) {
    logger.error({ err }, "handleRefreshSession failed");
    await safeSend(sock, ctx.jid, { text: "❌ Failed to generate SESSION_ID. Check server logs." });
  }
}
