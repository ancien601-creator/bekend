const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

// ---------- CORS ----------
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ---------- База данных ----------
const db = new Database('users.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    balance INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    xp_next INTEGER DEFAULT 100,
    username TEXT DEFAULT '',
    photo_url TEXT DEFAULT '',
    referrer_id INTEGER DEFAULT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    amount INTEGER,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS promocodes (
    code TEXT PRIMARY KEY,
    amount INTEGER NOT NULL,
    created_by INTEGER,
    used INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_id INTEGER NOT NULL UNIQUE,
    bonus_given INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS bonus_cases (
    user_id INTEGER PRIMARY KEY,
    opened INTEGER DEFAULT 0
)`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;      // уведомления о выводе
const ADMIN_ID2 = process.env.ADMIN_ID2;    // команды /addstars и /createpromo
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-netlify-app.netlify.app';

if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is not set!');
    process.exit(1);
}

// ---------- Здоровье ----------
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------- API для Mini App ----------
app.get('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
    const balance = user ? user.balance : 0;
    res.json({ balance });
});

app.post('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const { balance, username, photo_url } = req.body;
    if (typeof balance !== 'number' || balance < 0) {
        return res.status(400).json({ error: 'Invalid balance' });
    }
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
    if (user) {
        db.prepare('UPDATE users SET balance = ?, username = COALESCE(?, username), photo_url = COALESCE(?, photo_url) WHERE telegram_id = ?')
          .run(balance, username, photo_url, tid);
    } else {
        db.prepare('INSERT INTO users (telegram_id, balance, username, photo_url) VALUES (?, ?, ?, ?)')
          .run(tid, balance, username || '', photo_url || '');
    }
    console.log(`[POST /api/balance/${tid}] updated to ${balance}`);
    res.json({ success: true });
});

// Топ-10
app.get('/api/top', (req, res) => {
    try {
        const top = db.prepare('SELECT telegram_id, balance, username, photo_url FROM users ORDER BY balance DESC LIMIT 10').all();
        const result = top.map(u => ({
            id: u.telegram_id,
            username: u.username || ('ID' + String(u.telegram_id).slice(-4)),
            balance: u.balance,
            photo_url: u.photo_url || ''
        }));
        res.json(result);
    } catch (err) {
        console.error('/api/top error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Рефералы
app.get('/api/referral/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const count = db.prepare('SELECT COUNT(*) as cnt FROM referrals WHERE referrer_id = ?').get(tid);
    const earnings = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM referrals r JOIN users u ON r.referred_id = u.telegram_id WHERE r.referrer_id = ?').get(tid);
    const bonusCase = db.prepare('SELECT opened FROM bonus_cases WHERE user_id = ?').get(tid);
    res.json({
        refCount: count ? count.cnt : 0,
        refEarnings: earnings ? earnings.total : 0,
        bonusCaseOpened: bonusCase ? bonusCase.opened === 1 : false
    });
});

// Бонусный кейс за рефералов
app.post('/api/bonus-case/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const refCount = db.prepare('SELECT COUNT(*) as cnt FROM referrals WHERE referrer_id = ?').get(tid);
    if (!refCount || refCount.cnt < 2) {
        return res.json({ success: false, error: 'Недостаточно рефералов' });
    }
    const already = db.prepare('SELECT opened FROM bonus_cases WHERE user_id = ?').get(tid);
    if (already && already.opened === 1) {
        return res.json({ success: false, error: 'Бонусный кейс уже открыт' });
    }
    // случайная награда 10-50 звёзд
    const reward = Math.floor(Math.random() * 41) + 10;
    db.prepare('INSERT OR REPLACE INTO bonus_cases (user_id, opened) VALUES (?, 1)').run(tid);
    db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(tid);
    db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(reward, tid);
    res.json({ success: true, reward });
});

// Активация промокода
app.post('/api/activate-promo', (req, res) => {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ success: false, error: 'Нет данных' });
    const promo = db.prepare('SELECT * FROM promocodes WHERE code = ? AND used = 0').get(code.toUpperCase());
    if (!promo) {
        return res.json({ success: false, error: 'Неверный или использованный промокод' });
    }
    db.prepare('UPDATE promocodes SET used = 1 WHERE code = ?').run(code.toUpperCase());
    db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(userId);
    db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(promo.amount, userId);
    res.json({ success: true, amount: promo.amount });
});

// ---------- Вебхук Telegram ----------
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        console.log('Update:', JSON.stringify(update).slice(0, 200));

        // pre_checkout_query
        if (update.pre_checkout_query) {
            const query = update.pre_checkout_query;
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pre_checkout_query_id: query.id, ok: true })
            });
            return res.sendStatus(200);
        }

        // Успешный платёж
        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            const match = payload.match(/^stars_(\d+)_(\d+)$/);
            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(userId);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
                const user = db.prepare('SELECT balance, referrer_id FROM users WHERE telegram_id = ?').get(userId);
                console.log(`Пользователь ${userId} пополнил баланс на ${amount} звёзд, текущий баланс: ${user.balance}`);

                // Реферальное вознаграждение (30%)
                if (user && user.referrer_id) {
                    const bonus = Math.floor(amount * 0.3);
                    if (bonus > 0) {
                        db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(user.referrer_id);
                        db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(bonus, user.referrer_id);
                        console.log(`Рефереру ${user.referrer_id} начислен бонус ${bonus} звёзд`);
                        // Обновляем сумму заработка в referrals (условно)
                        db.prepare('UPDATE referrals SET amount = COALESCE(amount,0) + ? WHERE referred_id = ? AND referrer_id = ?')
                            .run(bonus, userId, user.referrer_id);
                    }
                }
                await sendMessage(userId, `✅ Ваш баланс пополнен на ${amount} ⭐. Текущий баланс: ${user.balance} ⭐`);
            }
            return res.sendStatus(200);
        }

        // Текстовые сообщения
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            console.log(`Получено сообщение от ${chatId}: "${text}"`);

            // Обработка реферальной ссылки /start ref123456
            if (text.startsWith('/start ref')) {
                const refId = parseInt(text.replace('/start ref', '').trim());
                if (!isNaN(refId) && refId !== chatId) {
                    // Записываем реферала, если он ещё не существует
                    const exists = db.prepare('SELECT telegram_id FROM users WHERE telegram_id = ?').get(chatId);
                    if (!exists) {
                        db.prepare('INSERT INTO users (telegram_id, balance, referrer_id) VALUES (?, 0, ?)').run(chatId, refId);
                    } else {
                        // Если пользователь уже есть, обновляем реферера (если ещё не назначен)
                        const currentRef = db.prepare('SELECT referrer_id FROM users WHERE telegram_id = ?').get(chatId);
                        if (!currentRef || !currentRef.referrer_id) {
                            db.prepare('UPDATE users SET referrer_id = ? WHERE telegram_id = ?').run(refId, chatId);
                        }
                    }
                    // Добавляем запись в таблицу referrals
                    db.prepare('INSERT OR IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)').run(refId, chatId);
                    console.log(`Пользователь ${chatId} зарегистрирован по реферальной ссылке от ${refId}`);
                }
                // Показываем приветственное сообщение
                await sendMessage(chatId, 'Добро пожаловать в ZORA IMPERIAL!', {
                    reply_markup: {
                        keyboard: [
                            [{ text: '🎰 Начать играть', web_app: { url: WEBAPP_URL } }],
                            [{ text: '👤 Профиль' }]
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: false
                    }
                });
                return res.sendStatus(200);
            }

            if (text === '/start') {
                await sendMessage(chatId, 'Добро пожаловать в ZORA IMPERIAL!', {
                    reply_markup: {
                        keyboard: [
                            [{ text: '🎰 Начать играть', web_app: { url: WEBAPP_URL } }],
                            [{ text: '👤 Профиль' }]
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: false
                    }
                });
                return res.sendStatus(200);
            }

            if (text === '/balance') {
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                await sendMessage(chatId, `Ваш баланс: ${user ? user.balance : 0} ⭐`);
                return res.sendStatus(200);
            }

            if (text === '👤 Профиль') {
                await showProfile(chatId);
                return res.sendStatus(200);
            }

            // Команда /addstars – только для ADMIN_ID2
            if (text.startsWith('/addstars')) {
                const parts = text.split(' ');
                if (parts.length !== 3) {
                    await sendMessage(chatId, 'Используйте: /addstars [ID пользователя] [количество]');
                    return res.sendStatus(200);
                }
                const targetUserId = parseInt(parts[1]);
                const amount = parseInt(parts[2]);
                if (isNaN(targetUserId) || isNaN(amount) || amount < 1) {
                    await sendMessage(chatId, 'Неверный формат. Пример: /addstars 5350902324 100');
                    return res.sendStatus(200);
                }

                if (String(chatId) !== String(ADMIN_ID2)) {
                    await sendMessage(chatId, 'У вас нет прав для выполнения этой команды.');
                    return res.sendStatus(200);
                }

                db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(targetUserId);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, targetUserId);
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(targetUserId);
                await sendMessage(chatId, `✅ Пользователю ${targetUserId} начислено ${amount} ⭐. Текущий баланс: ${user.balance} ⭐`);
                return res.sendStatus(200);
            }

            // Команда /createpromo – только для ADMIN_ID2
            if (text.startsWith('/createpromo')) {
                const parts = text.split(' ');
                if (parts.length !== 3) {
                    await sendMessage(chatId, 'Используйте: /createpromo [код] [сумма]');
                    return res.sendStatus(200);
                }
                const code = parts[1].toUpperCase();
                const amount = parseInt(parts[2]);
                if (isNaN(amount) || amount < 1) {
                    await sendMessage(chatId, 'Неверная сумма. Пример: /createpromo SUPER 50');
                    return res.sendStatus(200);
                }
                if (String(chatId) !== String(ADMIN_ID2)) {
                    await sendMessage(chatId, 'У вас нет прав для создания промокодов.');
                    return res.sendStatus(200);
                }
                try {
                    db.prepare('INSERT INTO promocodes (code, amount, created_by) VALUES (?, ?, ?)').run(code, amount, chatId);
                    await sendMessage(chatId, `✅ Промокод ${code} на ${amount} ⭐ создан!`);
                } catch (err) {
                    await sendMessage(chatId, '❌ Ошибка: возможно, такой код уже существует.');
                }
                return res.sendStatus(200);
            }

            // Команда /activate – активация промокода (запасной вариант)
            if (text.startsWith('/activate')) {
                const parts = text.split(' ');
                if (parts.length !== 2) {
                    await sendMessage(chatId, 'Используйте: /activate [код]');
                    return res.sendStatus(200);
                }
                const code = parts[1].toUpperCase();
                const promo = db.prepare('SELECT * FROM promocodes WHERE code = ? AND used = 0').get(code);
                if (!promo) {
                    await sendMessage(chatId, '❌ Промокод не найден или уже использован.');
                    return res.sendStatus(200);
                }
                db.prepare('UPDATE promocodes SET used = 1 WHERE code = ?').run(code);
                db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(chatId);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(promo.amount, chatId);
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                await sendMessage(chatId, `🎉 Вы активировали промокод ${code} и получили ${promo.amount} ⭐! Ваш баланс: ${user.balance} ⭐`);
                return res.sendStatus(200);
            }

            const amount = parseInt(text);
            if (!isNaN(amount) && amount >= 1) {
                await createInvoice(chatId, amount);
            } else {
                await sendMessage(chatId, 'Используйте кнопки меню.');
            }
        }

        // Callback-запросы
        if (update.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const data = query.data;

            if (data === 'profile') {
                await showProfile(chatId);
                await answerCallbackQuery(query.id);
            } else if (data === 'topup') {
                await sendMessage(chatId, 'Введите сумму звёзд для пополнения (минимум 1):', {
                    reply_markup: {
                        keyboard: [
                            [{ text: '10' }, { text: '25' }],
                            [{ text: '50' }, { text: '100' }],
                            [{ text: '200' }]
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                });
                await answerCallbackQuery(query.id);
            } else if (data === 'withdraw') {
                await sendMessage(chatId, 'Выберите сумму для вывода:', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '25 ⭐', callback_data: 'withdraw_25' }],
                            [{ text: '50 ⭐', callback_data: 'withdraw_50' }],
                            [{ text: '75 ⭐', callback_data: 'withdraw_75' }],
                            [{ text: '100 ⭐', callback_data: 'withdraw_100' }]
                        ]
                    }
                });
                await answerCallbackQuery(query.id);
            } else if (data.startsWith('withdraw_')) {
                const amount = parseInt(data.split('_')[1]);
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                if (!user || user.balance < amount) {
                    await sendMessage(chatId, 'Недостаточно звёзд для вывода.');
                } else {
                    db.prepare('INSERT INTO withdrawals (telegram_id, amount) VALUES (?, ?)').run(chatId, amount);
                    db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amount, chatId);
                    await sendMessage(chatId, `✅ Заявка на вывод ${amount} ⭐ создана. Ожидайте подтверждения.`);
                    if (ADMIN_ID) {
                        const username = query.from.username ? `@${query.from.username}` : query.from.first_name;
                        await sendMessage(
                            ADMIN_ID,
                            `📤 Новая заявка на вывод:\n` +
                            `Пользователь: ${username} (ID: ${chatId})\n` +
                            `Сумма: ${amount} ⭐\n` +
                            `Дата: ${new Date().toLocaleString()}`
                        );
                    }
                }
                await answerCallbackQuery(query.id);
            } else if (data === 'history') {
                const withdrawals = db.prepare(
                    'SELECT amount, status, created_at FROM withdrawals WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 5'
                ).all(chatId);
                if (withdrawals.length === 0) {
                    await sendMessage(chatId, 'У вас пока нет заявок на вывод.');
                } else {
                    let text = '📋 История выводов:\n\n';
                    withdrawals.forEach(w => {
                        const date = new Date(w.created_at).toLocaleString();
                        text += `• ${w.amount} ⭐ (${w.status}) — ${date}\n`;
                
