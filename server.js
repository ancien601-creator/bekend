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
    balance INTEGER DEFAULT 50,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    xp_next INTEGER DEFAULT 100
)`);
db.exec(`CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    amount INTEGER,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-netlify-app.netlify.app';

if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is not set!');
    process.exit(1);
}

const userStates = {};

// ---------- Здоровье ----------
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------- API для Mini App ----------
app.get('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    console.log(`[GET /api/balance/${tid}] requested`);
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
    const balance = user ? user.balance : 50;
    console.log(`[GET /api/balance/${tid}] returning balance=${balance}`);
    res.json({ balance });
});

app.post('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const { balance } = req.body;
    console.log(`[POST /api/balance/${tid}] body=`, req.body);
    if (typeof balance !== 'number' || balance < 0) {
        console.log(`[POST /api/balance/${tid}] invalid balance`);
        return res.status(400).json({ error: 'Invalid balance' });
    }
    db.prepare('INSERT OR REPLACE INTO users (telegram_id, balance) VALUES (?, ?)').run(tid, balance);
    console.log(`[POST /api/balance/${tid}] updated to ${balance}`);
    res.json({ success: true });
});

// ---------- Вебхук Telegram ----------
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        console.log('Webhook update:', JSON.stringify(update));

        // Платёж
        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            const match = payload.match(/^stars_(\d+)_(\d+)$/);
            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
                console.log(`Платёж: ${userId} +${amount}`);
            }
            return res.sendStatus(200);
        }

        // Текстовые сообщения
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (userStates[chatId] === 'awaiting_withdraw_amount') {
                const amount = parseInt(text);
                if (isNaN(amount) || amount < 1) {
                    await sendMessage(chatId, 'Введите целое число звёзд (минимум 1).');
                } else {
                    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                    if (!user || user.balance < amount) {
                        await sendMessage(chatId, 'Недостаточно звёзд.');
                    } else {
                        db.prepare('INSERT INTO withdrawals (telegram_id, amount) VALUES (?, ?)').run(chatId, amount);
                        db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amount, chatId);
                        await sendMessage(chatId, `✅ Заявка на вывод ${amount} ⭐ создана.`);
                        if (ADMIN_ID) {
                            const username = update.message.from.username ? '@'+update.message.from.username : update.message.from.first_name;
                            await sendMessage(ADMIN_ID, `📤 Вывод: ${username} (ID:${chatId}) сумма ${amount} ⭐`);
                        }
                    }
                }
                delete userStates[chatId];
                return res.sendStatus(200);
            }

            if (text === '/start') {
                await sendMessage(chatId, 'Добро пожаловать!', {
                    reply_markup: {
                        keyboard: [[{ text: '🎰 Начать играть', web_app: { url: WEBAPP_URL } }], [{ text: '👤 Профиль' }]],
                        resize_keyboard: true
                    }
                });
                return res.sendStatus(200);
            }

            if (text === '👤 Профиль') {
                await showProfile(chatId);
                return res.sendStatus(200);
            }

            const amount = parseInt(text);
            if (!isNaN(amount) && amount >= 1) {
                await createInvoice(chatId, amount);
            } else {
                await sendMessage(chatId, 'Используйте кнопки меню.');
            }
        }

        // Callback кнопки
        if (update.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const data = query.data;

            if (data === 'profile') {
                await showProfile(chatId);
            } else if (data === 'topup') {
                await sendMessage(chatId, 'Введите сумму звёзд (минимум 1):', {
                    reply_markup: {
                        keyboard: [[{ text: '10' }, { text: '25' }], [{ text: '50' }, { text: '100' }], [{ text: '200' }]],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                });
            } else if (data === 'withdraw') {
                userStates[chatId] = 'awaiting_withdraw_amount';
                await sendMessage(chatId, 'Введите сумму для вывода:');
            } else if (data === 'history') {
                const wds = db.prepare('SELECT amount, status, created_at FROM withdrawals WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 5').all(chatId);
                if (wds.length === 0) {
                    await sendMessage(chatId, 'Нет заявок на вывод.');
                } else {
                    let text = '📋 История выводов:\n\n';
                    wds.forEach(w => {
                        text += `• ${w.amount} ⭐ (${w.status}) — ${new Date(w.created_at).toLocaleString()}\n`;
                    });
                    await sendMessage(chatId, text);
                }
            }
            await answerCallbackQuery(query.id);
            return res.sendStatus(200);
        }

        res.sendStatus(200);
    } catch (e) {
        console.error('Webhook error:', e);
        res.sendStatus(500);
    }
});

async function sendMessage(chatId, text, extra = {}) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra })
    });
}
async function answerCallbackQuery(id) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: id })
    });
}
async function showProfile(chatId) {
    const user = db.prepare('SELECT balance, level, xp, xp_next FROM users WHERE telegram_id = ?').get(chatId);
    const balance = user ? user.balance : 50;
    const level = user ? user.level : 1;
    const xp = user ? user.xp : 0;
    const xpNext = user ? user.xp_next : 100;
    const text = `👤 Ваш профиль:\n\n⭐ Баланс: ${balance}\n🎚 Уровень: ${level}\n🔹 Опыт: ${xp}/${xpNext}`;
    await sendMessage(chatId, text, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '💳 Пополнить', callback_data: 'topup' }],
                [{ text: '💸 Вывести', callback_data: 'withdraw' }],
                [{ text: '📋 История выводов', callback_data: 'history' }]
            ]
        }
    });
}
async function createInvoice(chatId, amount) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Пополнение звёзд',
            description: `${amount} Stars`,
            payload: `stars_${chatId}_${amount}`,
            provider_token: '', currency: 'XTR',
            prices: [{ label: 'Звёзды', amount }]
        })
    });
    const d = await r.json();
    if (d.ok) {
        await sendMessage(chatId, `Счёт на ${amount} ⭐: [Оплатить](${d.result})`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: 'Оплатить', url: d.result }]] }
        });
    } else {
        console.error('Invoice error:', d);
        await sendMessage(chatId, 'Ошибка создания счёта.');
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));
