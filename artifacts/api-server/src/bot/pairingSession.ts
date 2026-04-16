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

// Generation counter — incremented each time a new top-level pairing session
// starts (from the route handler). Retry attempts within the same session share
// the same generation. When the user resets and triggers a brand-new session,
// the generation increments so all old socket handlers become no-ops.
let currentGeneration = 0;

const MAX_PAIRING_RETRIES = 6;

function jitteredDelay(attempt: number): number {
  const base = Math.min(5000 * (attempt + 1), 30000);
  const jitter = Math.floor(Math.random() * 3000);
  return base + jitter;
}

async function getWaVersion(): Promise<[number, number, number]> {
  try {
    const { fetchLatestBaileysVersion } = await import("@whiskeysockets/baileys");
    const result = await fetchLatestBaileysVersion();
    return result.version;
  } catch {
    return [2, 3000, 1035194821];
  }
}

export async function startPairingSession(
  phoneNumber: string,
  attempt = 0,
  skipPairCodeRequest = false,
): Promise<void> {
  // Each top-level call (attempt === 0) advances the generation so any
  // lingering sockets from a previous session become inert.
  if (attempt === 0) {
    currentGeneration++;
  }
  const myGeneration = currentGeneration;

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = await import("@whiskeysockets/baileys");
  const fs = await import("fs");
  const path = await import("path");

  // Bail out early if a newer session has already started
  if (myGeneration !== currentGeneration && attempt === 0) return;

  const version = await getWaVersion();
  logger.info({ version, attempt }, "Starting pairing session");

  const sessionDir = path.join(process.cwd(), ".pairing-session");
  // Only wipe the session directory on fresh starts.
  // When reconnecting after a pair code was delivered (skipPairCodeRequest=true),
  // we must keep the existing auth state — it contains the pending pairing info
  // that WhatsApp will confirm when the user enters the code.
  if (!skipPairCodeRequest) {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    defaultQueryTimeoutMs: undefined,
    syncFullHistory: false,
  });

  setActivePairingSocket(sock);

  sock.ev.on("creds.update", async () => {
    if (myGeneration !== currentGeneration) return;
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
  // On reconnects where a pair code was already delivered, skip requesting a new one.
  // The existing code is still valid — we just need the socket alive so WhatsApp
  // can send back the confirmation once the user enters it.
  let pairCodeRequested = skipPairCodeRequest;

  sock.ev.on("connection.update", async (update) => {
    // Ignore events from superseded sessions
    if (myGeneration !== currentGeneration) return;

    const { connection, lastDisconnect, qr } = update;

    // QR event fires when WhatsApp is ready — use it to request the pair code
    if (qr && !pairCodeRequested) {
      pairCodeRequested = true;
      try {
        const code = await sock.requestPairingCode(cleanNumber);
        if (myGeneration !== currentGeneration) return; // superseded while awaiting
        const formattedCode = code?.match(/.{1,4}/g)?.join("-") ?? code;
        pairingState.pairCode = formattedCode ?? null;
        pairingState.status = "pair_code_ready";
        logger.info({ code: formattedCode }, "Pair code generated");
      } catch (err) {
        if (myGeneration !== currentGeneration) return;
        logger.error({ err }, "Failed to generate pair code");
        pairingState.status = "disconnected";
      }
    }

    if (connection === "open") {
      if (myGeneration !== currentGeneration) return;
      pairingState.status = "connected";
      logger.info({ phoneNumber }, "WhatsApp pairing session connected");

      // creds.update (which serialises sessionId) may fire slightly after
      // connection "open" — wait up to 5 s for the sessionId to appear.
      let sessionId = pairingState.sessionId;
      if (!sessionId) {
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (myGeneration !== currentGeneration) return;
          sessionId = pairingState.sessionId;
          if (sessionId) break;
        }
      }

      if (sessionId) {
        const jid = `${cleanNumber}@s.whatsapp.net`;
        const msg =
          `*NUTTER-XMD — Your Session ID*\n\n` +
          `Your WhatsApp account is now linked. Copy the SESSION_ID below and paste it as the ` +
          `SESSION_ID environment variable when deploying to Heroku:\n\n` +
          `${sessionId}\n\n` +
          `_Keep this private — anyone with it can control your bot._`;
        try {
          await sock.sendMessage(jid, { text: msg });
          logger.info({ jid }, "SESSION_ID sent to user WhatsApp DM");
        } catch (err) {
          logger.error({ err }, "Failed to send SESSION_ID to user DM");
        }
      } else {
        logger.error({ phoneNumber }, "SESSION_ID not available 5 s after connection — credentials may not have saved");
      }
    }

    if (connection === "close") {
      if (myGeneration !== currentGeneration) return;

      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      logger.warn({ reason, attempt, pairingStatus: pairingState.status }, "WhatsApp connection closed");

      if (reason === DisconnectReason.loggedOut) {
        pairingState.status = "disconnected";
        resetPairingState();
        return;
      }

      if (pairingState.status === "connected") {
        pairingState.status = "disconnected";
        return;
      }

      if (attempt < MAX_PAIRING_RETRIES) {
        const hasPairCode = !!(pairingState.pairCode && pairingState.status === "pair_code_ready");

        if (hasPairCode) {
          // The pair code was displayed and the socket just expired.
          // The user may have entered the code RIGHT before expiry — WhatsApp
          // could still be trying to deliver the pairing confirmation.
          // Reconnect with the SAME auth state so WhatsApp can complete the
          // handshake on the new connection. We don't request a new code.
          // If that reconnect also closes without pairing, the next iteration
          // will see hasPairCode=false and start a completely fresh session.
          logger.info({ attempt: attempt + 1 }, "Pair code session expired — reconnecting with same auth to catch late confirmation");
          pairingState.pairCode = null;
          pairingState.status = "connecting";
          setTimeout(() => {
            if (myGeneration !== currentGeneration) return;
            startPairingSession(phoneNumber, attempt + 1, true).catch((err) => {
              logger.error({ err }, "Same-auth reconnect failed");
              if (myGeneration === currentGeneration) pairingState.status = "disconnected";
            });
          }, 1500);
        } else {
          // No pair code outstanding (either pre-code close or failed same-auth
          // reconnect). Start a completely fresh session for a new pair code.
          logger.warn({ attempt: attempt + 1 }, "WhatsApp connection closed — starting fresh session");
          pairingState.status = "connecting";
          const delayMs = skipPairCodeRequest ? 2000 : 2000;
          setTimeout(() => {
            if (myGeneration !== currentGeneration) return;
            startPairingSession(phoneNumber, attempt + 1, false).catch((err) => {
              logger.error({ err }, "Retry attempt failed");
              if (myGeneration === currentGeneration) pairingState.status = "disconnected";
            });
          }, delayMs);
        }
      } else {
        logger.error({ attempt }, "All retry attempts exhausted — marking disconnected");
        pairingState.status = "disconnected";
      }
    }
  });
}

export async function startQrSession(attempt = 0): Promise<void> {
  if (attempt === 0) {
    currentGeneration++;
  }
  const myGeneration = currentGeneration;

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = await import("@whiskeysockets/baileys");
  const { default: QRCode } = await import("qrcode");
  const fs = await import("fs");
  const path = await import("path");

  const version = await getWaVersion();

  const sessionDir = path.join(process.cwd(), ".pairing-session");
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    defaultQueryTimeoutMs: undefined,
    syncFullHistory: false,
  });

  setActivePairingSocket(sock);

  sock.ev.on("creds.update", async () => {
    if (myGeneration !== currentGeneration) return;
    await saveCreds();
    try {
      const files = fs.readdirSync(sessionDir);
      const fileMap: SessionFileMap = {};
      for (const file of files) {
        const content = fs.readFileSync(path.join(sessionDir, file), "utf-8");
        fileMap[file] = JSON.parse(content);
      }
      pairingState.sessionId = encodeSessionToBase64(fileMap);
      if (!pairingState.phoneNumber && state.creds.me?.id) {
        pairingState.phoneNumber = state.creds.me.id.split("@")[0]?.split(":")[0] ?? null;
      }
    } catch (err) {
      logger.error({ err }, "Failed to serialize credentials");
    }
  });

  sock.ev.on("connection.update", async (update) => {
    if (myGeneration !== currentGeneration) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        if (myGeneration !== currentGeneration) return;
        pairingState.qrDataUrl = dataUrl;
        pairingState.qrExpiresAt = new Date(Date.now() + 60000);
        pairingState.status = "qr_ready";
        logger.info("QR code generated for pairing");
      } catch (err) {
        logger.error({ err }, "Failed to generate QR code");
      }
    }

    if (connection === "open") {
      if (myGeneration !== currentGeneration) return;
      pairingState.status = "connected";
      logger.info("WhatsApp QR session connected");

      // creds.update may fire slightly after "open" — wait up to 5 s
      let sessionId = pairingState.sessionId;
      if (!sessionId) {
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (myGeneration !== currentGeneration) return;
          sessionId = pairingState.sessionId;
          if (sessionId) break;
        }
      }

      const phoneNum = pairingState.phoneNumber ?? state.creds.me?.id?.split("@")[0]?.split(":")[0];
      if (sessionId && phoneNum) {
        const jid = `${phoneNum.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
        const msg =
          `*NUTTER-XMD — Your Session ID*\n\n` +
          `Your WhatsApp account is now linked. Copy the SESSION_ID below and paste it as the ` +
          `SESSION_ID environment variable when deploying to Heroku:\n\n` +
          `${sessionId}\n\n` +
          `_Keep this private — anyone with it can control your bot._`;
        try {
          await sock.sendMessage(jid, { text: msg });
          logger.info({ jid }, "SESSION_ID sent to user WhatsApp DM");
        } catch (err) {
          logger.error({ err }, "Failed to send SESSION_ID to user DM");
        }
      } else {
        logger.error({ phoneNum }, "SESSION_ID or phone not available after QR connection");
      }
    }

    if (connection === "close") {
      if (myGeneration !== currentGeneration) return;

      const reason = (lastDisconnect?.error as import("@hapi/boom").Boom)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        pairingState.status = "disconnected";
        resetPairingState();
      } else if (pairingState.status === "connected") {
        pairingState.status = "disconnected";
      } else if (attempt < MAX_PAIRING_RETRIES) {
        const delayMs = jitteredDelay(attempt);
        logger.warn({ attempt: attempt + 1, delayMs }, "WhatsApp QR connection closed before scanning — retrying");
        pairingState.qrDataUrl = null;
        pairingState.status = "connecting";
        setTimeout(() => {
          if (myGeneration !== currentGeneration) return;
          startQrSession(attempt + 1).catch((err) => {
            logger.error({ err }, "QR retry attempt failed");
            if (myGeneration === currentGeneration) pairingState.status = "disconnected";
          });
        }, delayMs);
      } else {
        logger.error({ attempt }, "All QR retry attempts exhausted — marking disconnected");
        pairingState.status = "disconnected";
      }
    }
  });
}
