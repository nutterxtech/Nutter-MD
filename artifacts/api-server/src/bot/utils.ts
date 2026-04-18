import type { WASocket } from "@whiskeysockets/baileys";

// ── safeSend — wraps sock.sendMessage with an 8 s timeout ─────────────────────
// Baileys can silently hang on sendMessage when the WA connection is degraded.
// This wrapper ensures every outgoing message either resolves or rejects within
// 8 s so the calling handler never blocks the per-JID queue indefinitely.
export async function safeSend(
  sock: WASocket,
  jid: string,
  content: Parameters<WASocket["sendMessage"]>[1],
  options?: Parameters<WASocket["sendMessage"]>[2]
): Promise<ReturnType<WASocket["sendMessage"]>> {
  return Promise.race([
    sock.sendMessage(jid, content, options),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`safeSend timeout → ${jid}`)), 8_000)
    ),
  ]);
}
