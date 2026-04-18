import type { proto } from "@whiskeysockets/baileys";

export interface GroupSettings {
  groupId: string;
  antilink: boolean;
  antibadword: "off" | "delete" | "kick";
  customBadWords: string | null;
  antimention: boolean;
  antiDelete: boolean;
  mute: boolean;
  customPrefix: string | null;
  welcomeEnabled: boolean;
  welcomeMessage: string | null;
  autoReply: string | null;
}

export interface UserSettings {
  userId: string;
  isBanned: boolean;
}

export interface BotSettings {
  autoViewStatus: boolean;
  autoLikeStatus: boolean;
  statusLikeEmoji: string;
  autoRejectCall: boolean;
}

// ── Group store ────────────────────────────────────────────────────────────────
const groupStore = new Map<string, GroupSettings>();

export function getGroupSettings(groupId: string): GroupSettings | null {
  return groupStore.get(groupId) ?? null;
}

export function ensureGroupSettings(groupId: string): GroupSettings {
  if (!groupStore.has(groupId)) {
    groupStore.set(groupId, {
      groupId,
      // FIX: Default ALL protections to OFF so the bot doesn't start deleting
      // messages or kicking members in groups immediately after joining.
      // Admins must explicitly enable features with commands (.antilink on, etc).
      // Env vars can still force a default ON via ANTI_LINK=true etc.
      antilink:    process.env["ANTI_LINK"]      === "true",
      antibadword: (process.env["ANTI_BAD_WORD"] === "true" ? "delete" : "off") as "off" | "delete" | "kick",
      customBadWords: null,
      antimention: process.env["ANTI_MENTION"]   === "true",
      antiDelete:  process.env["ANTI_DELETE"]    === "true",
      mute: false,
      customPrefix: null,
      welcomeEnabled: false,
      welcomeMessage: null,
      autoReply: null,
    });
  }
  return groupStore.get(groupId)!;
}

export function updateGroupSettings(groupId: string, update: Partial<Omit<GroupSettings, "groupId">>): void {
  const existing = ensureGroupSettings(groupId);
  groupStore.set(groupId, { ...existing, ...update });
}

// ── User store ─────────────────────────────────────────────────────────────────
const userStore = new Map<string, UserSettings>();

export function getUserSettings(userId: string): UserSettings | null {
  return userStore.get(userId) ?? null;
}

export function setUserBanned(userId: string, isBanned: boolean): void {
  userStore.set(userId, { userId, isBanned });
}

// ── Bot-level settings ─────────────────────────────────────────────────────────
const botSettings: BotSettings = {
  autoViewStatus: process.env["AUTO_VIEW_STATUS"] !== "false",
  autoLikeStatus: process.env["AUTO_LIKE_STATUS"] !== "false",
  statusLikeEmoji: process.env["STATUS_LIKE_EMOJI"] || "❤️",
  autoRejectCall:  process.env["AUTO_REJECT_CALL"]  !== "false",
};

export function getBotSettings(): BotSettings {
  return { ...botSettings };
}

export function updateBotSettings(update: Partial<BotSettings>): void {
  Object.assign(botSettings, update);
}

// ── Volatile in-memory message cache (for antidelete) ─────────────────────────
const MSG_TTL = 5 * 60 * 1000; // 5 minutes
const MSG_MAX = 2000;

interface CacheEntry { msg: proto.IWebMessageInfo; expireAt: number }
const msgCache = new Map<string, CacheEntry>();

export function cacheMessage(msg: proto.IWebMessageInfo): void {
  const id = msg.key.id;
  if (!id) return;
  // FIX: Original code skipped fromMe messages, but we should cache them too
  // so antidelete can forward messages the bot itself sent (e.g. in groups).
  // The fromMe guard was overly restrictive — only skip protocol/stub messages.
  if (msgCache.size >= MSG_MAX) {
    const now = Date.now();
    for (const [k, v] of msgCache) {
      if (v.expireAt < now) msgCache.delete(k);
    }
  }
  msgCache.set(id, { msg, expireAt: Date.now() + MSG_TTL });
}

export function popCachedMessage(id: string): proto.IWebMessageInfo | null {
  const entry = msgCache.get(id);
  if (!entry) return null;
  msgCache.delete(id);
  return entry.expireAt >= Date.now() ? entry.msg : null;
}

// ── LID ↔ JID mapping ─────────────────────────────────────────────────────────
const lidToJidMap = new Map<string, string>();

export function registerLidMapping(lidJid: string, realJid: string) {
  lidToJidMap.set(lidJid, realJid);
}

/**
 * Resolve a @lid JID to the actual @s.whatsapp.net JID.
 * Returns the original JID unchanged if no mapping is known yet.
 */
export function resolveLid(jid: string): string {
  if (!jid.endsWith("@lid")) return jid;
  return lidToJidMap.get(jid) ?? jid;
  }
