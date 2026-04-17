export interface GroupSettings {
  groupId: string;
  antilink: boolean;
  antibadword: boolean;
  antimention: boolean;
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
      antilink: false,
      antibadword: false,
      antimention: false,
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
  autoViewStatus: false,
  autoLikeStatus: false,
  statusLikeEmoji: "❤️",
};

export function getBotSettings(): BotSettings {
  return { ...botSettings };
}

export function updateBotSettings(update: Partial<BotSettings>): void {
  Object.assign(botSettings, update);
}
