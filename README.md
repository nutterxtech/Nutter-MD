# NUTTER-XMD

> A powerful WhatsApp multi-device bot by [@nutterxtech](https://github.com/nutterxtech)

---

## What is NUTTER-XMD?

NUTTER-XMD is a WhatsApp bot that runs on your own Heroku instance. It supports group management, anti-spam protection, fun commands, and more — all configurable via WhatsApp commands.

---

## How to Deploy

### Step 1: Get Your Session ID

Visit the pairing page and link your WhatsApp number:

**Pairing Page:** [ 𝗣𝗔𝗜𝗥𝗜𝗡𝗚  𝗣𝗔𝗚𝗘 ]([[https://nutter-xmd-d5ce894ba4519.herokuapp.com]])

1. Enter your phone number in international format (e.g. `+254712345678`)
2. You will receive a pair code — enter it in WhatsApp under **Linked Devices → Link a Device**
3. After linking, copy the **Session ID** shown on the page

### Step 2: Fork this Repo

Click the button below to fork this repository to your GitHub account:

[Fork Nutter-MD on GitHub](https://github.com/nutterxtech/Nutter-MD/fork)

### Step 3: Deploy to Heroku

Go to the deploy verification page, enter your GitHub username to confirm your fork, then deploy:

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://nutter-md-31047d4ad9a9.herokuapp.com/deploy)

You will be asked to fill in:

| Config Var | Description | Required |
|---|---|---|
| `SESSION_ID` | Session ID from the pairing page | Yes |
| `OWNER_NUMBER` | Your WhatsApp number (e.g. `254712345678`) | Yes |
| `BOT_NAME` | Your bot's display name | No (default: NUTTER-XMD) |
| `PREFIX` | Command prefix character | No (default: `.`) |

---

## Commands

### General Commands

| Command | Description |
|---|---|
| `.menu` | Show all available commands |
| `.ping` | Check bot response latency |
| `.alive` | Show bot uptime and status |
| `.owner` | Get the bot owner's contact |
| `.settings` | Show current bot configuration |
| `.sticker` | Convert a quoted image/video to a sticker |
| `.restart` | Restart the bot (owner only) |

### Group Management (Bot must be admin)

| Command | Description |
|---|---|
| `.kick @user` | Remove a member from the group |
| `.add +number` | Add a member by phone number |
| `.promote @user` | Make a member a group admin |
| `.demote @user` | Remove a member's admin status |
| `.antilink on/off` | Block non-admin messages with links |
| `.antibadword on/off` | Block messages with profanity |
| `.antimention on/off` | Block mass-mention messages |
| `.ban @user` | Ban a user from using the bot |
| `.unban @user` | Unban a user |

---

## Requirements

- Node.js 18+
- A Heroku account (free eco dynos work)
- A WhatsApp account to link

---

## Tech Stack

- **WhatsApp:** [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)
- **Runtime:** Node.js
- **Database:** PostgreSQL (Heroku Postgres) — stores group/user settings only
- **Sessions:** Stored as Heroku config var (SESSION_ID) — not in the database

---

## Credits

- Developer: [@nutterxtech](https://github.com/nutterxtech)
- Built with [Baileys](https://github.com/WhiskeySockets/Baileys)
- Inspired by the WhatsApp MD bot community

---

## Support

For help, open an issue on GitHub or contact the bot owner on WhatsApp.

> **Note:** WhatsApp credentials are never stored in the database. Your SESSION_ID stays only in your Heroku config vars.
