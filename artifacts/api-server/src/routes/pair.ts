import { Router } from "express";
import { pairingState, startPairingSession, startQrSession, resetPairingState, getActivePairingSocket, generatePairingToken } from "../bot/pairingSession";
import { logger } from "../lib/logger";
import { z } from "zod";

const router = Router();

router.post("/pair/request", async (req, res) => {
  const body = z.object({ phoneNumber: z.string().min(7) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "INVALID_PHONE", message: "Provide a valid phone number in international format" });
    return;
  }

  const { phoneNumber } = body.data;

  if (pairingState.status === "connected") {
    res.status(400).json({ error: "ALREADY_CONNECTED", message: "A session is already connected. Reset first." });
    return;
  }

  resetPairingState();
  pairingState.status = "connecting";
  pairingState.phoneNumber = phoneNumber;
  pairingState.pairingToken = generatePairingToken();

  // Start the Baileys session in the background — return the token immediately
  // so Heroku's 30-second request timeout is never hit.
  // The pair code will appear in GET /pair/status once WhatsApp responds.
  startPairingSession(phoneNumber).catch((err) => {
    logger.error({ err }, "Pairing session error");
    if (pairingState.status === "connecting") {
      pairingState.status = "disconnected";
    }
  });

  res.json({
    pairCode: null,
    phoneNumber,
    pairingToken: pairingState.pairingToken,
    status: "connecting",
  });
});

router.get("/pair/qr", (_req, res) => {
  if (pairingState.status === "disconnected") {
    res.status(503).json({ error: "DISCONNECTED", message: "WhatsApp connection failed. Please reset and try again." });
    return;
  }
  if (!pairingState.qrDataUrl) {
    // Still connecting — tell the client to keep polling
    res.status(202).json({ qr: null, status: pairingState.status, message: "QR not ready yet, still connecting" });
    return;
  }
  res.json({ qr: pairingState.qrDataUrl, expiresAt: pairingState.qrExpiresAt });
});

router.get("/pair/status", (_req, res) => {
  res.json({
    status: pairingState.status,
    phoneNumber: pairingState.phoneNumber,
    pairCode: pairingState.pairCode,
  });
});

router.get("/pair/session", (req, res) => {
  const providedToken = req.headers["x-pairing-token"] as string | undefined;
  if (!pairingState.pairingToken || providedToken !== pairingState.pairingToken) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid or missing pairing token. Use the token returned when you started the session." });
    return;
  }
  if (pairingState.status !== "connected" || !pairingState.sessionId) {
    res.status(202).json({ error: "NOT_READY", message: "Pairing not complete yet. Keep waiting." });
    return;
  }
  res.json({
    sessionId: pairingState.sessionId,
    phoneNumber: pairingState.phoneNumber,
  });
});

router.post("/pair/start-qr", (_req, res) => {
  if (pairingState.status === "connected") {
    res.status(400).json({ error: "ALREADY_CONNECTED", message: "A session is already connected. Reset first." });
    return;
  }

  resetPairingState();
  pairingState.status = "connecting";
  const token = generatePairingToken();
  pairingState.pairingToken = token;

  startQrSession().catch((err) => {
    logger.error({ err }, "QR session error");
    if (pairingState.status === "connecting") {
      pairingState.status = "disconnected";
    }
  });

  res.json({ status: "connecting", message: "QR session starting. Poll /pair/qr for the code.", pairingToken: token });
});

router.post("/pair/reset", async (_req, res) => {
  const sock = getActivePairingSocket() as { end?: () => void } | null;
  if (sock?.end) {
    try { sock.end(); } catch (_) {}
  }
  resetPairingState();
  res.json({ status: "ok" });
});

export default router;
