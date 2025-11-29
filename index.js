require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2');
const crypto = require('crypto');

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
// MIDDLEWARE: Authentication Check
// =====================================================
function requireAuth(chatId, callback) {
  // Cari session berdasarkan chat_id dari tabel sessions
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
    
    // Return user data kalau authenticated
    callback(true, null, results[0]);
  });
}

// =====================================================
// Helper Functions
// =====================================================
function generateActivationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generatePairingCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function checkPendingOrder(telegramId, callback) {
  const query = `
    SELECT * FROM subscriptions 
    WHERE telegram_id = ? 
    AND status = 'pending' 
    AND order_expires_at > NOW()
    ORDER BY created_at DESC 
    LIMIT 1
  `;
  
  db.query(query, [telegramId], (err, results) => {
    if (err) return callback(err, null);
    callback(null, results.length > 0 ? results[0] : null);
  });
}

const subscriptionPlans = {
  monthly: {
    1: 20000,
    2: 30000,
    3: 35000,
    5: 40000,
    extra_month: 10000
  },
  lifetime: {
    1: 300000,
    2: 500000,
    3: 700000,
    5: 1000000,
    unlimited: 5000000
  }
};

// =====================================================
// AUTO CLEANUP
// =====================================================

// Auto reject expired orders
setInterval(() => {
  const query = `
    UPDATE subscriptions 
    SET status = 'rejected' 
    WHERE status = 'pending' 
    AND order_expires_at < NOW()
  `;
  
  db.query(query, (err, result) => {
    if (err) console.error('Error auto-rejecting expired orders:', err);
    if (result.affectedRows > 0) {
      console.log(`Auto-rejected ${result.affectedRows} expired orders`);
    }
  });
}, 60000); // Every 1 minute

// Auto cleanup expired sessions
setInterval(() => {
  const query = `DELETE FROM sessions WHERE session_expiry < NOW()`;
  
  db.query(query, (err, result) => {
    if (err) console.error('Error cleaning expired sessions:', err);
    if (result.affectedRows > 0) {
      console.log(`🔒 Cleaned ${result.affectedRows} expired sessions`);
    }
  });
}, 60000); // Every 1 minute

// =====================================================
// PUBLIC COMMANDS (No Auth Required)
// =====================================================

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMsg = `
🤖 *Selamat datang di Anrat Bot!*

Gunakan command berikut:

🔓 *Public:*
/info - Informasi bot
/adduser - Tambah user baru (admin)

🔐 *Requires Login:*
/login - Login ke akun
/sub - Lihat paket subscription
/buy - Beli subscription
/mysub - Lihat subscription aktif
/activate - Aktivasi kode
/pair - Generate pairing code
/mydevices - Lihat device terpair
/mystatus - Cek status order
/mysessions - Lihat active sessions (multi-device)
/logout - Keluar dari device ini

📱 *Cara penggunaan:*
1. Login dengan /login (bisa dari banyak device!)
2. Pilih paket dengan /sub
3. Beli dengan /buy
4. Kirim bukti bayar dengan /confirm
5. Setelah approve, aktivasi dengan /activate
6. Pair device dengan /pair

🔄 *Multi-Device Support*
Kamu bisa login dari banyak device dengan akun yang sama!
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

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "lang_id") {
    bot.sendMessage(chatId, `
Selamat datang di Bot Telegram!
Gunakan command berikut:
/adduser - Menambahkan user baru
/login - Login dengan username dan password
/sub - Lihat paket subscription
/buy - Beli subscription
    `);
  } else if (data === "lang_en") {
    bot.sendMessage(chatId, `
Welcome to Telegram Bot!
Use the following commands:
/adduser - Add a new user
/login - Login with username and password
/sub - View subscription packages
/buy - Buy subscription
    `);
  }
  bot.answerCallbackQuery(query.id);
});

// =====================================================
// ADMIN: Add User (Public - tapi bisa dibatasi)
// =====================================================
bot.onText(/\/adduser/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Kirim data user baru dengan format:\nusername,password,phone");

  bot.once('message', (response) => {
    const text = response.text;
    const parts = text.split(',');

    if(parts.length !== 3){
      return bot.sendMessage(chatId, "Format salah! Gunakan username,password,phone");
    }

    const [username, password, phone] = parts;
    const query = "INSERT INTO users (username, password, phone) VALUES (?, ?, ?)";
    
    db.query(query, [username, password, phone], (err, result) => {
      if(err){
        console.error(err);
        return bot.sendMessage(chatId, "Gagal menambahkan user! Mungkin username sudah ada.");
      }
      bot.sendMessage(chatId, `✅ User ${username} berhasil ditambahkan!\n\nGunakan /login untuk masuk.`);
    });
  });
});

// =====================================================
// LOGIN & LOGOUT
// =====================================================
bot.onText(/\/login/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🔐 Kirim login dengan format:\nusername,password");

  bot.once('message', (response) => {
    const text = response.text;
    const parts = text.split(',');
    if(parts.length !== 2) return bot.sendMessage(chatId, "Format salah! Gunakan username,password");

    const [username, password] = parts;

    db.query("SELECT * FROM users WHERE username=? AND password=?", [username, password], (err, results) => {
      if(err) return bot.sendMessage(chatId, "Error database!");
      if(results.length === 0) return bot.sendMessage(chatId, "❌ User atau password salah!");

      const userId = results[0].id;
      const token = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 jam

      // Cek apakah chat_id ini sudah punya session
      db.query("SELECT * FROM sessions WHERE chat_id = ?", [chatId], (err2, sessions) => {
        if (err2) return bot.sendMessage(chatId, "Error database!");

        if (sessions.length > 0) {
          // Update session yang ada
          db.query(
            "UPDATE sessions SET user_id=?, session_token=?, session_expiry=?, updated_at=NOW() WHERE chat_id=?",
            [userId, token, expiry, chatId],
            (err3) => {
              if(err3) return bot.sendMessage(chatId, "Gagal update session!");
              sendLoginSuccess(chatId, results[0].username);
            }
          );
        } else {
          // Insert session baru
          db.query(
            "INSERT INTO sessions (user_id, chat_id, session_token, session_expiry) VALUES (?, ?, ?, ?)",
            [userId, chatId, token, expiry],
            (err3) => {
              if(err3) return bot.sendMessage(chatId, "Gagal membuat session!");
              sendLoginSuccess(chatId, results[0].username);
            }
          );
        }
      });
    });
  });
});

function sendLoginSuccess(chatId, username) {
  bot.sendMessage(chatId, `
✅ *Login berhasil!*

Username: ${username}
Session berlaku: 24 jam

Gunakan /sub untuk melihat paket subscription.
  `, { parse_mode: 'Markdown' });
}

bot.onText(/\/logout/, (msg) => {
  const chatId = msg.chat.id;
  
  const query = `DELETE FROM sessions WHERE chat_id = ?`;
  
  db.query(query, [chatId], (err) => {
    if (err) {
      return bot.sendMessage(chatId, "❌ Gagal logout!");
    }
    
    bot.sendMessage(chatId, "✅ Anda telah logout dari device ini. Gunakan /login untuk masuk kembali.");
  });
});

bot.onText(/\/cek/, (msg) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }
    
    bot.sendMessage(chatId, `✅ Kamu login sebagai *${user.username}*!`, { parse_mode: 'Markdown' });
  });
});

bot.onText(/\/mysessions/, (msg) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    const query = `
      SELECT 
        chat_id,
        session_expiry,
        created_at,
        updated_at
      FROM sessions
      WHERE user_id = ?
      AND session_expiry > NOW()
      ORDER BY updated_at DESC
    `;

    db.query(query, [user.id], (err, results) => {
      if (err) return bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return bot.sendMessage(chatId, "Tidak ada session aktif.");
      }

      let message = `📱 *Active Sessions (${results.length} device)*\n\n`;
      results.forEach((session, index) => {
        const isCurrent = session.chat_id == chatId;
        const expiry = new Date(session.chat_id);
        const lastActive = new Date(session.updated_at);
        
        message += `${index + 1}. Chat ID: \`${session.chat_id}\`${isCurrent ? ' *(Device ini)*' : ''}\n`;
        message += `   Last Active: ${lastActive.toLocaleString('id-ID')}\n`;
        message += `   Expires: ${new Date(session.session_expiry).toLocaleString('id-ID')}\n\n`;
      });

      message += '\n💡 Gunakan /logout untuk keluar dari device ini.';

      bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    });
  });
});

// =====================================================
// PROTECTED COMMANDS (Require Login)
// =====================================================

bot.onText(/\/sub/, (msg) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    let message = `
💳 *Paket Subscription*

📅 *Bulanan:*
1 user  : Rp20.000
2 user  : Rp30.000
3 user  : Rp35.000
5 user  : Rp40.000
+1 bulan tambahan: Rp10.000

♾️ *Permanent:*
1 user  : Rp300.000
2 user  : Rp500.000
3 user  : Rp700.000
5 user  : Rp1.000.000
Unlimited : Rp5.000.000

Ketik: 
/buy [type] [users] [months]

Contoh:
/buy monthly 2 1
/buy lifetime 5

⏰ *Order berlaku 15 menit* setelah dibuat.
Setelah 15 menit otomatis rejected jika tidak konfirmasi.
`;

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  });
});

bot.onText(/\/buy (.+)/, (msg, match) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    const args = match[1].split(" ");

    checkPendingOrder(chatId, (err, pendingOrder) => {
      if (err) {
        return bot.sendMessage(chatId, "Error checking pending orders!");
      }

      if (pendingOrder) {
        const expiresAt = new Date(pendingOrder.order_expires_at);
        const remainingMinutes = Math.ceil((expiresAt - new Date()) / 60000);
        
        return bot.sendMessage(chatId, `
⚠️ *Kamu masih punya order pending!*

Order ID: ${pendingOrder.id}
Tipe: ${pendingOrder.type}
Users: ${pendingOrder.users}
Harga: Rp${pendingOrder.price.toLocaleString("id-ID")}

Order akan expired dalam *${remainingMinutes} menit*.

Silakan konfirmasi dengan /confirm atau tunggu hingga expired.
        `, { parse_mode: "Markdown" });
      }

      const type = args[0];
      const users = args[1];
      const months = args[2] ? parseInt(args[2]) : 1;

      let price = 0;

      if (type === "monthly") {
        if (!subscriptionPlans.monthly[users]) {
          return bot.sendMessage(chatId, "Jumlah user tidak valid!");
        }
        price = subscriptionPlans.monthly[users];
        if (months > 1) {
          price += (months - 1) * subscriptionPlans.monthly.extra_month;
        }
      } 
      else if (type === "lifetime") {
        if (!subscriptionPlans.lifetime[users]) {
          return bot.sendMessage(chatId, "Jumlah user tidak valid! Gunakan 'monthly' atau 'lifetime'");
        }
        price = subscriptionPlans.lifetime[users];
      }
      else {
        return bot.sendMessage(chatId, "Tipe subscription tidak valid! Gunakan 'monthly' atau 'lifetime'");
      }

      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      const query = `
        INSERT INTO subscriptions (telegram_id, type, users, price, status, order_expires_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `;
      
      db.query(query, [chatId, type, users, price, expiresAt], (err, result) => {
        if(err) {
          console.error(err);
          return bot.sendMessage(chatId, "Gagal menyimpan order ke database!");
        }

        bot.sendMessage(chatId, `
✅ *Order berhasil dibuat!*

Order ID: ${result.insertId}
Tipe: ${type}
Users: ${users}
Durasi: ${type === "monthly" ? months + " bulan" : "Permanent"}
Total harga: Rp${price.toLocaleString("id-ID")}

⏰ Order akan expired dalam *15 menit*
Segera konfirmasi dengan /confirm

📱 Transfer ke:
Dana/GoPay: [nomor rekening]
        `, { parse_mode: "Markdown" });
      });
    });
  });
});

bot.onText(/\/confirm/, (msg) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    checkPendingOrder(chatId, (err, pendingOrder) => {
      if (err) {
        return bot.sendMessage(chatId, "Error checking orders!");
      }

      if (!pendingOrder) {
        return bot.sendMessage(chatId, "Tidak ada order pending! Buat order dulu dengan /buy");
      }

      bot.sendMessage(chatId, "Kirim bukti pembayaran (screenshot):");

      bot.once('message', (response) => {
        let proof = "";

        if (response.photo && response.photo.length > 0) {
          const file_id = response.photo[response.photo.length - 1].file_id;
          proof = `photo:${file_id}`;
        }
        else if (response.document) {
          proof = `document:${response.document.file_id}`;
        }
        else if (response.text) {
          proof = response.text;
        }
        else {
          proof = "Bukti tidak valid";
        }

        db.query(
          "UPDATE subscriptions SET payment_info=? WHERE id=?",
          [proof, pendingOrder.id],
          (err2) => {
            if(err2) return bot.sendMessage(chatId, "Gagal menyimpan bukti!");
            
            bot.sendMessage(chatId, `
✅ *Bukti pembayaran diterima!*

Order ID: ${pendingOrder.id}

Admin akan memeriksa pembayaran Anda.
Kamu akan mendapat kode aktivasi setelah diapprove.

Cek status dengan /mystatus
            `, { parse_mode: "Markdown" });
          }
        );
      });
    });
  });
});

bot.onText(/\/activate (.+)/, (msg, match) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    const code = match[1].toUpperCase().trim();

    const query = `
      SELECT * FROM subscriptions 
      WHERE activation_code = ? 
      AND telegram_id = ?
      AND status = 'approved'
      AND is_active = 0
    `;

    db.query(query, [code, chatId], (err, results) => {
      if (err) return bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return bot.sendMessage(chatId, `
❌ Kode aktivasi tidak valid!

Pastikan:
- Kode sudah benar
- Order sudah diapprove admin
- Kode belum pernah diaktivasi

Cek kode dengan /mystatus
        `);
      }

      const subscription = results[0];

      db.query(
        "UPDATE subscriptions SET is_active = 1, activated_at = NOW() WHERE id = ?",
        [subscription.id],
        (err2) => {
          if (err2) return bot.sendMessage(chatId, "Gagal aktivasi!");

          bot.sendMessage(chatId, `
🎉 *Subscription berhasil diaktivasi!*

Tipe: ${subscription.type}
Users: ${subscription.users}
Aktivasi: ${new Date().toLocaleString('id-ID')}

Langkah selanjutnya:
1. Generate pairing code dengan /pair
2. Download APK
3. Masukkan pairing code di APK
          `, { parse_mode: "Markdown" });
        }
      );
    });
  });
});

bot.onText(/\/pair/, (msg) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    const subQuery = `
      SELECT * FROM subscriptions
      WHERE telegram_id = ?
      AND status = 'approved'
      AND is_active = 1
      AND (
        type = 'lifetime'
        OR (type = 'manual' AND activated_at IS NOT NULL)
      )
      ORDER BY activated_at DESC
      LIMIT 1
    `;

    db.query(subQuery, [chatId], (err, subs) => {
      if (err) {
        console.error(err);
        return bot.sendMessage(chatId, "❌ Database error.");
      }

      if (subs.length === 0) {
        return bot.sendMessage(chatId, `
❌ Kamu belum punya subscription aktif!

Gunakan:
/sub → lihat paket
/buy → beli subscription
        `);
      }

      const subscription = subs[0];

      let maxDevices;
      if (subscription.type === 'lifetime' && subscription.users === 0) {
        maxDevices = Infinity;
      } else {
        maxDevices = parseInt(subscription.users);
      }

      const countQuery = `
        SELECT COUNT(*) AS total
        FROM devices
        WHERE subscription_id = ?
        AND status = 'active'
      `;

      db.query(countQuery, [subscription.id], (err2, countRes) => {
        if (err2) {
          console.error(err2);
          return bot.sendMessage(chatId, "❌ Error cek jumlah device.");
        }

        const pairedCount = countRes[0].total;

        if (pairedCount >= maxDevices) {
          return bot.sendMessage(chatId, `
❌ Batas device tercapai!

Aktif: ${pairedCount}/${maxDevices === Infinity ? 'unlimited' : maxDevices}

Gunakan:
/removedevice [device_id]
          `);
        }

        const checkPairQuery = `
          SELECT * FROM pairing_codes
          WHERE telegram_id = ?
          AND expires_at > NOW()
          AND used = 0
          ORDER BY created_at DESC
          LIMIT 1
        `;

        db.query(checkPairQuery, [chatId], (err3, codes) => {
          if (err3) {
            console.error(err3);
            return bot.sendMessage(chatId, "❌ Error cek pairing code.");
          }

          if (codes.length > 0) {
            const code = codes[0].pairing_code;
            const exp = codes[0].expires_at;

            return bot.sendMessage(chatId, `
🔁 *Pairing Code Masih Aktif*

Kode: \`${code}\`
Berlaku sampai: ${exp}

📱 Masukkan ke aplikasi kamu.
Slot: ${pairedCount}/${maxDevices === Infinity ? 'unlimited' : maxDevices}
            `, { parse_mode: "Markdown" });
          }

          const newCode = generatePairingCode();
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

          const insertQuery = `
            INSERT INTO pairing_codes
            (subscription_id, telegram_id, pairing_code, expires_at)
            VALUES (?, ?, ?, ?)
          `;

          db.query(insertQuery, [
            subscription.id,
            chatId,
            newCode,
            expiresAt
          ], (err4) => {
            if (err4) {
              console.error(err4);
              return bot.sendMessage(chatId, "❌ Gagal membuat pairing code.");
            }

            bot.sendMessage(chatId, `
✅ *Pairing Code Baru Dibuat!*

Kode: \`${newCode}\`
Berlaku: 10 menit

📱 Masukkan ke aplikasi kamu.
Slot: ${pairedCount}/${maxDevices === Infinity ? 'unlimited' : maxDevices}
            `, { parse_mode: "Markdown" });
          });
        });
      });
    });
  });
});

bot.onText(/\/mydevices/, (msg) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    const query = `
      SELECT d.*, s.type, s.users 
      FROM devices d
      JOIN subscriptions s ON d.subscription_id = s.id
      WHERE d.telegram_id = ? AND d.status = 'active'
      ORDER BY d.paired_at DESC
    `;

    db.query(query, [chatId], (err, results) => {
      if (err) return bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return bot.sendMessage(chatId, "Belum ada device yang terpair!");
      }

      let message = "📱 *Device yang terpair:*\n\n";
      results.forEach((device, index) => {
        message += `${index + 1}. ${device.device_name || device.device_id}\n`;
        message += `   ID: \`${device.device_id}\`\n`;
        message += `   Paired: ${new Date(device.paired_at).toLocaleString('id-ID')}\n`;
        message += `   Last active: ${device.last_active ? new Date(device.last_active).toLocaleString('id-ID') : 'Never'}\n\n`;
      });

      bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    });
  });
});

bot.onText(/\/mystatus/, (msg) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    const query = `
      SELECT * FROM subscriptions 
      WHERE telegram_id = ?
      ORDER BY created_at DESC
      LIMIT 5
    `;

    db.query(query, [chatId], (err, results) => {
      if (err) return bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return bot.sendMessage(chatId, "Belum ada order!");
      }

      let message = "📊 *Status Order Kamu:*\n\n";
      results.forEach((sub, index) => {
        message += `${index + 1}. Order #${sub.id}\n`;
        message += `   Tipe: ${sub.type} (${sub.users} users)\n`;
        message += `   Status: ${sub.status}\n`;
        message += `   Harga: Rp${sub.price.toLocaleString('id-ID')}\n`;
        
        if (sub.status === 'pending' && sub.order_expires_at) {
          const remaining = Math.ceil((new Date(sub.order_expires_at) - new Date()) / 60000);
          if (remaining > 0) {
            message += `   ⏰ Expired dalam: ${remaining} menit\n`;
          } else {
            message += `   ❌ Sudah expired\n`;
          }
        }
        
        if (sub.status === 'approved' && sub.activation_code && !sub.is_active) {
          message += `   🔑 Kode Aktivasi: \`${sub.activation_code}\`\n`;
          message += `   Aktivasi dengan: /activate ${sub.activation_code}\n`;
        }
        
        if (sub.is_active) {
          message += `   ✅ Aktif sejak: ${new Date(sub.activated_at).toLocaleString('id-ID')}\n`;
        }
        
        message += '\n';
      });

      bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    });
  });
});

bot.onText(/\/mysub/, (msg) => {
  const chatId = msg.chat.id;

  requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return bot.sendMessage(chatId, errorMsg);
    }

    db.query(
      "SELECT * FROM subscriptions WHERE telegram_id=? AND is_active=1 ORDER BY activated_at DESC", 
      [chatId], 
      (err, results) => {
        if(err) return bot.sendMessage(chatId, "Error DB!");
        if(results.length === 0) return bot.sendMessage(chatId, "Kamu belum memiliki subscription aktif!");

        let message = "💳 *Subscription aktif kamu:*\n\n";
        results.forEach((sub, index) => {
          message += `${index + 1}. ID: ${sub.id}\n`;
          message += `   Type: ${sub.type}\n`;
          message += `   Users: ${sub.users}\n`;
          message += `   Price: Rp${sub.price.toLocaleString("id-ID")}\n`;
          message += `   Activated: ${new Date(sub.activated_at).toLocaleString('id-ID')}\n\n`;
        });
        
        bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
      }
    );
  });
});

console.log("🤖 Bot berjalan...");
console.log("🔒 Authentication middleware aktif!");
console.log("⏰ Auto-reject expired orders setiap 1 menit");
console.log("🧹 Auto-cleanup expired sessions setiap 1 menit");