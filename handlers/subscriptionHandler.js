const main = require('../index');

function generateActivationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
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
  
  main.db.query(query, [telegramId], (err, results) => {
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

// Show Plans
exports.showPlans = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
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

    main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  });
};

// Buy Subscription
exports.buySubscription = (msg, match) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    const args = match[1].split(" ");

    checkPendingOrder(chatId, (err, pendingOrder) => {
      if (err) {
        return main.bot.sendMessage(chatId, "Error checking pending orders!");
      }

      if (pendingOrder) {
        const expiresAt = new Date(pendingOrder.order_expires_at);
        const remainingMinutes = Math.ceil((expiresAt - new Date()) / 60000);
        
        return main.bot.sendMessage(chatId, `
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
          return main.bot.sendMessage(chatId, "Jumlah user tidak valid!");
        }
        price = subscriptionPlans.monthly[users];
        if (months > 1) {
          price += (months - 1) * subscriptionPlans.monthly.extra_month;
        }
      } 
      else if (type === "lifetime") {
        if (!subscriptionPlans.lifetime[users]) {
          return main.bot.sendMessage(chatId, "Jumlah user tidak valid! Gunakan 'monthly' atau 'lifetime'");
        }
        price = subscriptionPlans.lifetime[users];
      }
      else {
        return main.bot.sendMessage(chatId, "Tipe subscription tidak valid! Gunakan 'monthly' atau 'lifetime'");
      }

      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      const query = `
        INSERT INTO subscriptions (telegram_id, type, users, price, status, order_expires_at)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `;
      
      main.db.query(query, [chatId, type, users, price, expiresAt], (err, result) => {
        if(err) {
          console.error(err);
          return main.bot.sendMessage(chatId, "Gagal menyimpan order ke database!");
        }

        main.bot.sendMessage(chatId, `
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
};

// Confirm Payment
exports.confirmPayment = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    checkPendingOrder(chatId, (err, pendingOrder) => {
      if (err) {
        return main.bot.sendMessage(chatId, "Error checking orders!");
      }

      if (!pendingOrder) {
        return main.bot.sendMessage(chatId, "Tidak ada order pending! Buat order dulu dengan /buy");
      }

      main.bot.sendMessage(chatId, "Kirim bukti pembayaran (screenshot):");

      main.bot.once('message', (response) => {
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

        main.db.query(
          "UPDATE subscriptions SET payment_info=? WHERE id=?",
          [proof, pendingOrder.id],
          (err2) => {
            if(err2) return main.bot.sendMessage(chatId, "Gagal menyimpan bukti!");
            
            main.bot.sendMessage(chatId, `
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
};

// Activate Code
exports.activateCode = (msg, match) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    const code = match[1].toUpperCase().trim();

    const query = `
      SELECT * FROM subscriptions 
      WHERE activation_code = ? 
      AND telegram_id = ?
      AND status = 'approved'
      AND is_active = 0
    `;

    main.db.query(query, [code, chatId], (err, results) => {
      if (err) return main.bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return main.bot.sendMessage(chatId, `
❌ Kode aktivasi tidak valid!

Pastikan:
- Kode sudah benar
- Order sudah diapprove admin
- Kode belum pernah diaktivasi

Cek kode dengan /mystatus
        `);
      }

      const subscription = results[0];

      main.db.query(
        "UPDATE subscriptions SET is_active = 1, activated_at = NOW() WHERE id = ?",
        [subscription.id],
        (err2) => {
          if (err2) return main.bot.sendMessage(chatId, "Gagal aktivasi!");

          main.bot.sendMessage(chatId, `
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
};

// My Status
exports.myStatus = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    const query = `
      SELECT * FROM subscriptions 
      WHERE telegram_id = ?
      ORDER BY created_at DESC
      LIMIT 5
    `;

    main.db.query(query, [chatId], (err, results) => {
      if (err) return main.bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return main.bot.sendMessage(chatId, "Belum ada order!");
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

      main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    });
  });
};

// My Subscription
exports.mySubscription = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    main.db.query(
      "SELECT * FROM subscriptions WHERE telegram_id=? AND is_active=1 ORDER BY activated_at DESC", 
      [chatId], 
      (err, results) => {
        if(err) return main.bot.sendMessage(chatId, "Error DB!");
        if(results.length === 0) return main.bot.sendMessage(chatId, "Kamu belum memiliki subscription aktif!");

        let message = "💳 *Subscription aktif kamu:*\n\n";
        results.forEach((sub, index) => {
          message += `${index + 1}. ID: ${sub.id}\n`;
          message += `   Type: ${sub.type}\n`;
          message += `   Users: ${sub.users}\n`;
          message += `   Price: Rp${sub.price.toLocaleString("id-ID")}\n`;
          message += `   Activated: ${new Date(sub.activated_at).toLocaleString('id-ID')}\n\n`;
        });
        
        main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
      }
    );
  });
};