const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const fs = require("node:fs/promises");

const BACKEND_URL =
  process.env.BACKEND_URL || "http://backend-fastapi:8000/chat-context";
const PERSONA_NAME = process.env.PERSONA_NAME;
const PAIRING_CODE_PHONE_NUMBER =
  process.env.PAIRING_CODE_PHONE_NUMBER?.replace(/\D/g, "");
const AUTH_DIR = "auth_info_baileys";
let reconnectTimer = null;
let pairingCodeRequested = false;

if (!PERSONA_NAME) {
  throw new Error("PERSONA_NAME is required");
}
if (
  process.env.PAIRING_CODE_PHONE_NUMBER &&
  (!PAIRING_CODE_PHONE_NUMBER || PAIRING_CODE_PHONE_NUMBER.length < 8)
) {
  throw new Error(
    "PAIRING_CODE_PHONE_NUMBER must be the full phone number in digits only, for example 60123456789",
  );
}
const PERSONA_COMMAND = `!${PERSONA_NAME.toLowerCase()}`;
const STORE_PATH = "./baileys_store_multi.json";

async function clearAuthState(dirPath) {
  const entries = await fs
    .readdir(dirPath, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = `${dirPath}/${entry.name}`;
      if (entry.isDirectory()) {
        await fs.rm(entryPath, { recursive: true, force: true });
        return;
      }

      await fs.unlink(entryPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }),
  );
}

const store = {
  messages: Object.create(null),
  bind(ev) {
    ev.on("messages.upsert", (m) => {
      if (m.type !== "notify") return;
      for (const msg of m.messages) {
        const jid = msg.key.remoteJid;
        if (!jid) continue;

        const bucket = store.messages[jid] || (store.messages[jid] = []);
        bucket.push(msg);
        if (bucket.length > 100) {
          bucket.splice(0, bucket.length - 100);
        }
      }
    });
  },
  async readFromFile(filePath) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      store.messages = parsed.messages || Object.create(null);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Error reading message store:", error.message);
      }
    }
  },
  async writeToFile(filePath) {
    await fs.writeFile(
      filePath,
      JSON.stringify({ messages: store.messages }, null, 2),
    );
  },
};

store.readFromFile(STORE_PATH);
setInterval(() => {
  store.writeToFile(STORE_PATH).catch((error) => {
    console.error("Error writing message store:", error.message);
  });
}, 10_000);

async function startBot() {
  let { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (PAIRING_CODE_PHONE_NUMBER && !state.creds.registered) {
    await clearAuthState(AUTH_DIR);
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
  }

  const sock = makeWASocket({
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.0"],
    qrTimeout: 120_000,
  });

  store.bind(sock.ev);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr && !PAIRING_CODE_PHONE_NUMBER) {
      qrcode.generate(qr, { small: true });
    }

    if (qr && PAIRING_CODE_PHONE_NUMBER && !pairingCodeRequested) {
      pairingCodeRequested = true;
      sock
        .requestPairingCode(PAIRING_CODE_PHONE_NUMBER)
        .then((code) => {
          console.log(`Pairing code: ${code}`);
        })
        .catch((error) => {
          pairingCodeRequested = false;
          console.error("Error requesting pairing code:", error.message);
        });
    }

    if (connection === "open") {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      pairingCodeRequested = false;
      return;
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.error("WhatsApp connection closed:", reason ?? "unknown");

      if (
        PAIRING_CODE_PHONE_NUMBER &&
        (reason === 401 || reason === DisconnectReason.loggedOut)
      ) {
        clearAuthState(AUTH_DIR)
          .then(() => {
            pairingCodeRequested = false;
            startBot().catch((error) => {
              console.error("Error restarting bot:", error.message);
            });
          })
          .catch((error) => {
            console.error("Error clearing auth state:", error.message);
          });
        return;
      }

      if (reconnectTimer || reason === DisconnectReason.loggedOut) {
        return;
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        pairingCodeRequested = false;
        startBot().catch((error) => {
          console.error("Error restarting bot:", error.message);
        });
      }, 5000);
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;
    for (const msg of m.messages) {
      if (!msg.message) continue;
      const from = msg.key.remoteJid;
      const text =
        msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      const normalizedText = text.trim();

      if (normalizedText.toLowerCase().startsWith(PERSONA_COMMAND)) {
        const promptText = normalizedText.slice(PERSONA_COMMAND.length).trim();

        if (!promptText) {
          continue;
        }

        await sock.sendPresenceUpdate("composing", from);

        try {
          const res = await axios.post(BACKEND_URL, {
            history: [
              {
                sender: msg.pushName || "Friend",
                text: promptText,
              },
            ],
          });
          await sock.sendMessage(
            from,
            { text: res.data.reply },
            { quoted: msg },
          );
        } catch (err) {
          console.error("Error communicating with backend:", err.message);
        }
      }
    }
  });
}
startBot();
