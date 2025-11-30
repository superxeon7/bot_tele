const crypto = require('crypto');
const main = require('../index');

// Add User
exports.addUser = (msg) => {
  const chatId = msg.chat.id;
  main.bot.sendMessage(chatId, "Kirim data user baru dengan format:\nusername,password,phone,telegram_id");

  main.bot.once('message', (response) => {
    const text = response.text;
    const parts = text.split(',');

    if(parts.length !== 4){
      return main.bot.sendMessage(chatId, "Format salah! Gunakan username,password,phone,telegram_id");
    }

    const [username, password, phone, telegram_id] = parts;
    const query = "INSERT INTO users (username, password, phone, telegram_id) VALUES (?, ?, ?, ?)";
    
    main.db.query(query, [username, password, phone, telegram_id], (err, result) => {
      if(err){
        console.error(err);
        return main.bot.sendMessage(chatId, "Gagal menambahkan user! Mungkin username sudah ada.");
      }
      main.bot.sendMessage(chatId, `✅ User ${username} berhasil ditambahkan!\n\nGunakan /login untuk masuk.`);
    });
  });
};

// Login
exports.login = (msg) => {
  const chatId = msg.chat.id;
  main.bot.sendMessage(chatId, "🔐 Kirim login dengan format:\nusername,password");

  main.bot.once('message', (response) => {
    const text = response.text;
    const parts = text.split(',');
    if(parts.length !== 2) return main.bot.sendMessage(chatId, "Format salah! Gunakan username,password");

    const [username, password] = parts;

    main.db.query("SELECT * FROM users WHERE username=? AND password=?", [username, password], (err, results) => {
      if(err) return main.bot.sendMessage(chatId, "Error database!");
      if(results.length === 0) return main.bot.sendMessage(chatId, "❌ User atau password salah!");

      const userId = results[0].id;
      const token = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      main.db.query("SELECT * FROM sessions WHERE chat_id = ?", [chatId], (err2, sessions) => {
        if (err2) return main.bot.sendMessage(chatId, "Error database!");

        if (sessions.length > 0) {
          main.db.query(
            "UPDATE sessions SET user_id=?, session_token=?, session_expiry=?, updated_at=NOW() WHERE chat_id=?",
            [userId, token, expiry, chatId],
            (err3) => {
              if(err3) return main.bot.sendMessage(chatId, "Gagal update session!");
              sendLoginSuccess(chatId, results[0].username);
            }
          );
        } else {
          main.db.query(
            "INSERT INTO sessions (user_id, chat_id, session_token, session_expiry) VALUES (?, ?, ?, ?)",
            [userId, chatId, token, expiry],
            (err3) => {
              if(err3) return main.bot.sendMessage(chatId, "Gagal membuat session!");
              sendLoginSuccess(chatId, results[0].username);
            }
          );
        }
      });
    });
  });
};

function sendLoginSuccess(chatId, username) {
  main.bot.sendMessage(chatId, `
✅ *Login berhasil!*

Username: ${username}
Session berlaku: 24 jam

Gunakan /start untuk melihat semua command.
  `, { parse_mode: 'Markdown' });
}

// Logout
exports.logout = (msg) => {
  const chatId = msg.chat.id;
  
  const query = `DELETE FROM sessions WHERE chat_id = ?`;
  
  main.db.query(query, [chatId], (err) => {
    if (err) {
      return main.bot.sendMessage(chatId, "❌ Gagal logout!");
    }
    
    main.bot.sendMessage(chatId, "✅ Anda telah logout dari device ini. Gunakan /login untuk masuk kembali.");
  });
};

// Check Auth
exports.checkAuth = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
    }
    
    main.bot.sendMessage(chatId, `✅ Kamu login sebagai *${user.username}*!`, { parse_mode: 'Markdown' });
  });
};

// My Sessions
exports.mySessions = (msg) => {
  const chatId = msg.chat.id;

  main.requireAuth(chatId, (isAuth, errorMsg, user) => {
    if (!isAuth) {
      return main.bot.sendMessage(chatId, errorMsg);
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

    main.db.query(query, [user.id], (err, results) => {
      if (err) return main.bot.sendMessage(chatId, "Error database!");
      
      if (results.length === 0) {
        return main.bot.sendMessage(chatId, "Tidak ada session aktif.");
      }

      let message = `📱 *Active Sessions (${results.length} device)*\n\n`;
      results.forEach((session, index) => {
        const isCurrent = session.chat_id == chatId;
        const lastActive = new Date(session.updated_at);
        
        message += `${index + 1}. Chat ID: \`${session.chat_id}\`${isCurrent ? ' *(Device ini)*' : ''}\n`;
        message += `   Last Active: ${lastActive.toLocaleString('id-ID')}\n`;
        message += `   Expires: ${new Date(session.session_expiry).toLocaleString('id-ID')}\n\n`;
      });

      message += '\n💡 Gunakan /logout untuk keluar dari device ini.';

      main.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    });
  });
};