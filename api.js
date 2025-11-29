// server.js - Backend API untuk Admin Order Management (Anrat Database)
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'anrat',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test database connection
pool.getConnection()
    .then(connection => {
        console.log('✅ Database connected successfully');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Database connection failed:', err);
    });

// ==================== SUBSCRIPTIONS ENDPOINTS ====================
app.get('/api/telegram/photo/:file_id', async (req, res) => {
    try {
        const fileId = req.params.file_id;
        const BOT_TOKEN = process.env.BOT_TOKEN;

        if (!BOT_TOKEN) {
            return res.status(500).json({ error: 'BOT_TOKEN not configured' });
        }

        // Get file path from Telegram
        const getFileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        
        const fileResponse = await fetch(getFileUrl);
        const fileData = await fileResponse.json();

        if (!fileData.ok) {
            return res.status(400).json({ error: 'Failed to get file from Telegram' });
        }

        // Get actual file URL
        const filePath = fileData.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        res.json({ 
            success: true,
            file_url: fileUrl,
            file_path: filePath
        });

    } catch (error) {
        console.error('Error fetching Telegram photo:', error);
        res.status(500).json({ error: 'Failed to fetch photo from Telegram' });
    }
});

// Endpoint untuk proxy download foto (agar bisa tampil di frontend tanpa CORS issue)
app.get('/api/telegram/download/:file_id', async (req, res) => {
    try {
        const fileId = req.params.file_id;
        const BOT_TOKEN = process.env.BOT_TOKEN;

        if (!BOT_TOKEN) {
            return res.status(500).json({ error: 'BOT_TOKEN not configured' });
        }

        // Get file path from Telegram
        const getFileUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        
        const fileResponse = await fetch(getFileUrl);
        const fileData = await fileResponse.json();

        if (!fileData.ok) {
            return res.status(400).json({ error: 'Failed to get file from Telegram' });
        }

        // Download file from Telegram
        const filePath = fileData.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

        const imageResponse = await fetch(fileUrl);
        const imageBuffer = await imageResponse.arrayBuffer();

        // Set proper headers
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 1 day
        res.send(Buffer.from(imageBuffer));

    } catch (error) {
        console.error('Error downloading Telegram photo:', error);
        res.status(500).json({ error: 'Failed to download photo' });
    }
});
// GET: Ambil semua subscriptions
app.get('/api/subscriptions', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                s.id,
                s.telegram_id,
                s.type,
                s.users,
                s.price,
                s.status,
                s.payment_info,
                s.created_at,
                s.updated_at,
                u.username,
                u.phone
            FROM subscriptions s
            LEFT JOIN users u ON s.telegram_id = u.telegram_id
            ORDER BY s.created_at DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching subscriptions:', error);
        res.status(500).json({ error: 'Failed to fetch subscriptions' });
    }
});

// GET: Ambil subscription by ID
app.get('/api/subscriptions/:id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                s.id,
                s.telegram_id,
                s.type,
                s.users,
                s.price,
                s.status,
                s.payment_info,
                s.created_at,
                s.updated_at,
                u.username,
                u.phone
            FROM subscriptions s
            LEFT JOIN users u ON s.telegram_id = u.telegram_id
            WHERE s.id = ?
        `, [req.params.id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Error fetching subscription:', error);
        res.status(500).json({ error: 'Failed to fetch subscription' });
    }
});

// GET: Ambil subscriptions by telegram_id
app.get('/api/subscriptions/user/:telegram_id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                s.id,
                s.telegram_id,
                s.type,
                s.users,
                s.price,
                s.status,
                s.payment_info,
                s.created_at,
                s.updated_at
            FROM subscriptions s
            WHERE s.telegram_id = ?
            ORDER BY s.created_at DESC
        `, [req.params.telegram_id]);
        
        res.json(rows);
    } catch (error) {
        console.error('Error fetching user subscriptions:', error);
        res.status(500).json({ error: 'Failed to fetch user subscriptions' });
    }
});

// PUT: Approve subscription
// PUT: Approve subscription - AUTO GENERATE ACTIVATION CODE
app.put('/api/subscriptions/:id/approve', async (req, res) => {
    try {
        function generateActivationCode() {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let code = '';
            for (let i = 0; i < 8; i++) {
                if (i === 4) code += '-';
                code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return code;
        }

        const activationCode = generateActivationCode();

        const [result] = await pool.query(`
            UPDATE subscriptions 
            SET status = 'approved', 
                activation_code = ?,
                is_active = 1,
                updated_at = NOW() 
            WHERE id = ? AND status = 'pending'
        `, [activationCode, req.params.id]);
        
        if (result.affectedRows === 0) {
            return res.status(400).json({ error: 'Subscription not found or already processed' });
        }

        // Get subscription details
        const [subDetails] = await pool.query(
            'SELECT * FROM subscriptions WHERE id = ?',
            [req.params.id]
        );

        const subscription = subDetails[0];

        // Kirim notifikasi ke user via Telegram
        try {
            const message = `
🎉 *Pembayaran Approved!*

Order ID: ${subscription.id}
Tipe: ${subscription.type}
Users: ${subscription.users}
Harga: Rp${subscription.price.toLocaleString('id-ID')}

🔑 *Kode Aktivasi:* \`${activationCode}\`

Aktivasi sekarang dengan:
/activate ${activationCode}
            `;

            await telegramBot.sendMessage(subscription.telegram_id, message, { parse_mode: 'Markdown' });
        } catch (telegramError) {
            console.error('Failed to send Telegram notification:', telegramError);
            // Tetap lanjut meski notif gagal
        }

        res.json({ 
            message: 'Subscription approved successfully',
            id: req.params.id,
            activation_code: activationCode,
            subscription: subscription
        });

    } catch (error) {
        console.error('Error approving subscription:', error);
        res.status(500).json({ error: 'Failed to approve subscription' });
    }
});

// PUT: Reject subscription
app.put('/api/subscriptions/:id/reject', async (req, res) => {
    try {
        const { reason } = req.body;
        
        const [result] = await pool.query(`
            UPDATE subscriptions 
            SET status = 'rejected', updated_at = NOW()
            WHERE id = ? AND status = 'pending'
        `, [req.params.id]);
        
        if (result.affectedRows === 0) {
            return res.status(400).json({ error: 'Subscription not found or already processed' });
        }
        
        res.json({ 
            message: 'Subscription rejected successfully',
            id: req.params.id,
            reason: reason || 'No reason provided'
        });
    } catch (error) {
        console.error('Error rejecting subscription:', error);
        res.status(500).json({ error: 'Failed to reject subscription' });
    }
});

// DELETE: Hapus subscription
app.delete('/api/subscriptions/:id', async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM subscriptions WHERE id = ?', [req.params.id]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }
        
        res.json({ message: 'Subscription deleted successfully' });
    } catch (error) {
        console.error('Error deleting subscription:', error);
        res.status(500).json({ error: 'Failed to delete subscription' });
    }
});

// ==================== USERS ENDPOINTS ====================

// GET: Ambil semua users
app.get('/api/users', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                id,
                telegram_id,
                username,
                phone,
                session_token,
                session_expiry
            FROM users 
            ORDER BY id DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// GET: Ambil user by telegram_id
app.get('/api/users/:telegram_id', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                id,
                telegram_id,
                username,
                phone,
                session_token,
                session_expiry
            FROM users 
            WHERE telegram_id = ?
        `, [req.params.telegram_id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// ==================== STATISTICS ENDPOINTS ====================

// GET: Statistics
app.get('/api/stats', async (req, res) => {
    try {
        const [stats] = await pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                SUM(CASE WHEN status = 'approved' THEN price ELSE 0 END) as total_revenue
            FROM subscriptions
        `);
        
        const [userCount] = await pool.query('SELECT COUNT(*) as total_users FROM users');
        
        res.json({
            subscriptions: stats[0],
            users: userCount[0]
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// GET: Revenue by type
app.get('/api/stats/revenue', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                type,
                COUNT(*) as count,
                SUM(price) as total_revenue,
                AVG(price) as avg_price
            FROM subscriptions
            WHERE status = 'approved'
            GROUP BY type
        `);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching revenue stats:', error);
        res.status(500).json({ error: 'Failed to fetch revenue statistics' });
    }
});

// GET: Daily statistics
app.get('/api/stats/daily', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total_orders,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                SUM(CASE WHEN status = 'approved' THEN price ELSE 0 END) as revenue
            FROM subscriptions
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);
        res.json(rows);
    } catch (error) {
        console.error('Error fetching daily stats:', error);
        res.status(500).json({ error: 'Failed to fetch daily statistics' });
    }
});

// ==================== UTILITY ENDPOINTS ====================

// Health check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'OK', 
            timestamp: new Date(),
            database: 'connected'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'ERROR', 
            timestamp: new Date(),
            database: 'disconnected',
            error: error.message
        });
    }
});

// Error handler middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        error: 'Something went wrong!',
        message: err.message 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 API endpoints available at http://localhost:${PORT}/api`);
    console.log(`💾 Database: ${process.env.DB_NAME || 'anrat'}`);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: closing HTTP server');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received: closing HTTP server');
    await pool.end();
    process.exit(0);
});

// Tambahkan di bagian atas file, setelah require
const TelegramBot = require('node-telegram-bot-api');
const telegramBot = new TelegramBot(process.env.BOT_TOKEN);

// PUT: Approve subscription - DENGAN NOTIFIKASI TELEGRAM
