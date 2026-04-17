/**
 * patch-baileys.mjs
 *
 * Patches @whiskeysockets/baileys messages-recv.js so that a "Key used already
 * or never filled" (MISSING_KEYS_ERROR_TEXT) decryption failure sends a proper
 * retry receipt (with a pre-key upload) instead of silently ACKing.
 *
 * Without this patch:
 *   - Contact sends message encrypted with a pre-key the bot no longer has
 *   - Baileys detects MISSING_KEYS_ERROR_TEXT, emits ACK only, returns
 *   - No retry is sent; the contact's WA thinks delivery succeeded
 *   - msg.message is null forever; bot never responds
 *
 * With this patch:
 *   - MISSING_KEYS_ERROR_TEXT falls through to the isPreKeyError branch
 *   - Baileys uploads 5 fresh pre-keys, waits 1 s, sends retry receipt
 *   - Contact's WA fetches a newly uploaded pre-key, re-encrypts, resends
 *   - Bot decrypts with the fresh pre-key; message goes through
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Locate messages-recv.js inside pnpm's content-addressable store
function findBaileysFile() {
  const candidates = [
    // pnpm hoisted layout
    path.join(__dirname, 'node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js'),
    // pnpm nested store layout
    path.join(__dirname, 'node_modules/.pnpm/@whiskeysockets+baileys@7.0.0-rc.9/node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js'),
    path.join(__dirname, 'node_modules/.pnpm/@whiskeysockets+baileys@7.0.0-rc.9_sharp@0.34.5/node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const target = findBaileysFile();
if (!target) {
  console.log('[patch-baileys] messages-recv.js not found — skipping patch');
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf-8');

// Idempotency guard — don't double-patch
if (src.includes('NUTTER_XMD_PATCHED')) {
  console.log('[patch-baileys] Already patched — skipping');
  process.exit(0);
}

// ── The patch ──────────────────────────────────────────────────────────────
//
// Original (ACK-only for both error types):
//
//   if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT ||
//       msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
//       return sendMessageAck(node);
//   }
//   const errorMessage = msg?.messageStubParameters?.[0] || '';
//   const isPreKeyError = errorMessage.includes('PreKey');
//
// Patched (ACK-only for NO_MESSAGE_FOUND; retry for MISSING_KEYS):
//
//   if (msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
//       return sendMessageAck(node);
//   }
//   const errorMessage = msg?.messageStubParameters?.[0] || '';
//   const isPreKeyError = errorMessage.includes('PreKey') || errorMessage === MISSING_KEYS_ERROR_TEXT; // NUTTER_XMD_PATCHED

const SEARCH = `if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT ||
                        msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
                        return sendMessageAck(node);
                    }
                    const errorMessage = msg?.messageStubParameters?.[0] || '';
                    const isPreKeyError = errorMessage.includes('PreKey');`;

const REPLACE = `if (msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
                        return sendMessageAck(node);
                    }
                    const errorMessage = msg?.messageStubParameters?.[0] || '';
                    const isPreKeyError = errorMessage.includes('PreKey') || errorMessage === MISSING_KEYS_ERROR_TEXT; // NUTTER_XMD_PATCHED`;

if (!src.includes(SEARCH.split('\n')[0].trim())) {
  // Whitespace might differ — try a looser match on the key lines
  const looseSearch = /if\s*\(msg\?\.messageStubParameters\?\.\[0\]\s*===\s*MISSING_KEYS_ERROR_TEXT\s*\|\|[\s\S]{0,200}?return\s+sendMessageAck\(node\);\s*\}\s*const\s+errorMessage\s*=[\s\S]{0,100}?const\s+isPreKeyError\s*=\s*errorMessage\.includes\('PreKey'\);/;
  const match = src.match(looseSearch);
  if (match) {
    const patched = src.replace(looseSearch, (original) => {
      // Keep the original indentation but fix the logic
      return original
        .replace(
          /if\s*\(msg\?\.messageStubParameters\?\.\[0\]\s*===\s*MISSING_KEYS_ERROR_TEXT\s*\|\|/,
          'if ('
        )
        .replace(
          /MISSING_KEYS_ERROR_TEXT\s*\|\|\s*/,
          ''
        )
        .replace(
          /isPreKeyError\s*=\s*errorMessage\.includes\('PreKey'\);/,
          `isPreKeyError = errorMessage.includes('PreKey') || errorMessage === MISSING_KEYS_ERROR_TEXT; // NUTTER_XMD_PATCHED`
        );
    });
    fs.writeFileSync(target, patched, 'utf-8');
    console.log('[patch-baileys] Patch applied (loose match)');
  } else {
    console.warn('[patch-baileys] Could not find target code — Baileys version may have changed. Skipping.');
  }
} else {
  const patched = src.replace(SEARCH, REPLACE);
  fs.writeFileSync(target, patched, 'utf-8');
  console.log('[patch-baileys] Patch applied successfully');
}
