import { randomBytes } from "crypto";
import { Boom } from "@hapi/boom";
import { logger } from "../lib/logger";
import { encodeSessionToBase64, type SessionFileMap } from "./session";

export type PairingStatus =
  | "idle"
  | "connecting"
  | "qr_ready"
  | "pair_code_ready"
  | "connected"
  | "disconnected";

export interface PairingSessionState {
  status: PairingStatus;
  phoneNumber: string | null;
  pairCode: string | null;
  qrDataUrl: string | null;
  qrExpiresAt: Date | null;
  sessionId: string | null;
  pairingToken: string | null;
}

export const pairingState: PairingSessionState = {
  status: "idle",
  phoneNumber: null,
  pairCode: null,
  qrDataUrl: null,
  qrExpiresAt: null,
  sessionId: null,
  pairingToken: null,
};

export function generatePairingToken(): string {
  return `pt_${randomBytes(16).toString("hex")}`;
}

export function resetPairingState() {
  pairingState.status = "idle";
  pairingState.phoneNumber = null;
  pairingState.pairCode = null;
  pairingState.qrDataUrl = null;
  pairingState.qrExpiresAt = null;
  pairingState.sessionId = null;
  pairingState.pairingToken = null;
}

let activePairingSocket: unknown = null;

export function setActivePairingSocket(sock: unknown) {
  activePairingSocket = sock;
}

export function getActivePairingSocket() {
  return activePairingSocket;
}

export async function startPairingSession(phoneNumber: string): Promise<string> {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = await import("@whiskeysockets/baileys");
  const { default: QRCode } = await import("qrcode");
  const fs = await import("fs");
  const path = await import("path");

  const sessionDir = path.join(process.cwd(), ".pairing-session");
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sessionDir, { recursive: true });

  resetPairingState();
  pairingState.status = "connecting";
  pairingState.phoneNumber = phoneNumber;
  pairingState.pairingToken = generatePairingToken();

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
    });

    setActivePairingSocket(sock);

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      try {
        const files = fs.readdirSync(sessionDir);
        const fileMap: SessionFileMap = {};
        for (const file of files) {
          const content = fs.readFileSync(path.join(sessionDir, file), "utf-8");
          fileMap[file] = JSON.parse(content);
        }
        pairingState.sessionId = encodeSessionToBase64(fileMap);
      } catch (err) {
        logger.error({ err }, "Failed to serialize credentials");
      }
    });

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
    let pairCodeRequested = false;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Use the QR event as a signal that the socket is connected and ready.
      // In pair-code mode we don't display the QR — we use it to trigger requestPairingCode.
      if (qr && !pairCodeRequested) {
        pairCodeRequested = true;
        try {
          const code = await sock.requestPairingCode(cleanNumber);
          const formattedCode = code?.match(/.{1,4}/g)?.join("-") ?? code;
          pairingState.pairCode = formattedCode ?? null;
          pairingState.status = "pair_code_ready";
          logger.info({ code: formattedCode }, "Pair code generated");
          resolve(formattedCode ?? "");
        } catch (err) {
          pairingState.status = "idle";
          reject(err);
        }
      }

      if (connection === "open") {
        pairingState.status = "connected";
        logger.info({ phoneNumber }, "WhatsApp pairing session connected");

        // Send SESSION_ID directly to the user's WhatsApp DM
        if (pairingState.sessionId) {
          const jid = `${cleanNumber}@s.whatsapp.net`;
          const msg =
            `*NUTTER-XMD — Your Session ID*\n\n` +
            `Your WhatsApp account is now linked. Copy the SESSION_ID below and paste it as the ` +
            `SESSION_ID environment variable when deploying to Heroku:\n\n` +
            `${pairingState.sessionId}\n\n` +
            `_Keep this private — anyone with it can control your bot._`;
          try {
            await sock.sendMessage(jid, { text: msg });
            logger.info({ jid }, "SESSION_ID sent to user WhatsApp DM");
          } catch (err) {
            logger.error({ err }, "Failed to send SESSION_ID to user DM");
          }
        }
      }

      if (connection === "close") {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          pairingState.status = "disconnected";
          resetPairingState();
        } else if (pairingState.status !== "connected") {
          pairingState.status = "disconnected";
        }
      }
    });
  });
}

export async function startQrSession(): Promise<void> {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = await import("@whiskeysockets/baileys");
  const { default: QRCode } = await import("qrcode");
  const fs = await import("fs");
  const path = await import("path");

  const sessionDir = path.join(process.cwd(), ".pairing-session");
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
  });

  setActivePairingSocket(sock);

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    try {
      const files = fs.readdirSync(sessionDir);
      const fileMap: SessionFileMap = {};
      for (const file of files) {
        const content = fs.readFileSync(path.join(sessionDir, file), "utf-8");
        fileMap[file] = JSON.parse(content);
      }
      pairingState.sessionId = encodeSessionToBase64(fileMap);
      // Extract phone number from JID once credentials are set (QR mode)
      if (!pairingState.phoneNumber && state.creds.me?.id) {
        pairingState.phoneNumber = state.creds.me.id.split("@")[0] ?? null;
      }
    } catch (err) {
      logger.error({ err }, "Failed to serialize credentials");
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        pairingState.qrDataUrl = dataUrl;
        pairingState.qrExpiresAt = new Date(Date.now() + 60000);
        pairingState.status = "qr_ready";
        logger.info("QR code generated for pairing");
      } catch (err) {
        logger.error({ err }, "Failed to generate QR code");
      }
    }

    if (connection === "open") {
      pairingState.status = "connected";
      logger.info("WhatsApp QR session connected");

      // Send SESSION_ID directly to the user's WhatsApp DM
      const phoneNum = pairingState.phoneNumber ?? state.creds.me?.id?.split("@")[0];
      if (pairingState.sessionId && phoneNum) {
        const jid = `${phoneNum.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
        const msg =
          `*NUTTER-XMD — Your Session ID*\n\n` +
          `Your WhatsApp account is now linked. Copy the SESSION_ID below and paste it as the ` +
          `SESSION_ID environment variable when deploying to Heroku:\n\n` +
          `${pairingState.sessionId}\n\n` +
          `_Keep this private — anyone with it can control your bot._`;
        try {
          await sock.sendMessage(jid, { text: msg });
          logger.info({ jid }, "SESSION_ID sent to user WhatsApp DM");
        } catch (err) {
          logger.error({ err }, "Failed to send SESSION_ID to user DM");
        }
      }
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as import("@hapi/boom").Boom)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        pairingState.status = "disconnected";
        resetPairingState();
      } else if (pairingState.status !== "connected") {
        pairingState.status = "disconnected";
      }
    }
  });
}
