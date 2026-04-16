import { Boom } from "@hapi/boom";
import { logger } from "../lib/logger";
import type { AuthState } from "./session";
import { encodeSessionToBase64 } from "./session";

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
  authState: AuthState | null;
}

export const pairingState: PairingSessionState = {
  status: "idle",
  phoneNumber: null,
  pairCode: null,
  qrDataUrl: null,
  qrExpiresAt: null,
  sessionId: null,
  authState: null,
};

export function resetPairingState() {
  pairingState.status = "idle";
  pairingState.phoneNumber = null;
  pairingState.pairCode = null;
  pairingState.qrDataUrl = null;
  pairingState.qrExpiresAt = null;
  pairingState.sessionId = null;
  pairingState.authState = null;
}

let activePairingSocket: unknown = null;

export function setActivePairingSocket(sock: unknown) {
  activePairingSocket = sock;
}

export function getActivePairingSocket() {
  return activePairingSocket;
}

export async function startPairingSession(phoneNumber: string): Promise<string> {
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import("@whiskeysockets/baileys");
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

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["NUTTER-XMD", "Chrome", "1.0.0"],
    });

    setActivePairingSocket(sock);

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      try {
        const files = fs.readdirSync(sessionDir);
        const creds: Record<string, unknown> = {};
        for (const file of files) {
          const content = fs.readFileSync(path.join(sessionDir, file), "utf-8");
          creds[file] = JSON.parse(content);
        }
        pairingState.authState = creds as unknown as AuthState;
        pairingState.sessionId = encodeSessionToBase64(creds as unknown as AuthState);
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
        logger.info({ phoneNumber }, "WhatsApp pairing session connected");
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

    const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
    setTimeout(async () => {
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
    }, 3000);
  });
}
