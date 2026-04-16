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

  try {
    const pairCode = await startPairingSession(phoneNumber);
    res.json({ pairCode, phoneNumber, pairingToken: pairingState.pairingToken });
  } catch (err) {
    logger.error({ err }, "Pairing request failed");
    res.status(500).json({ error: "PAIRING_FAILED", message: "Failed to start pairing. Try again." });
  }
});

router.get("/pair/qr", (_req, res) => {
  if (!pairingState.qrDataUrl) {
    res.status(404).json({ error: "NO_QR", message: "No QR code available. Request pairing first." });
    return;
  }
  res.json({ qr: pairingState.qrDataUrl, expiresAt: pairingState.qrExpiresAt });
});

router.get("/pair/status", (_req, res) => {
  res.json({
    status: pairingState.status,
    phoneNumber: pairingState.phoneNumber,
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
