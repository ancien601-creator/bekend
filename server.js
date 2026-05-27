const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

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
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.netlify.app';

if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is missing!');
    process.exit(1);
}

const userStates = {};

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('Zora Backend is running'));

app.get('/api/balance/:telegram_id', (req, res) => {
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(req.params.telegram_id);
    res.json({ balance: user ? user.balance : 50 });
});

app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        console.log('Update:', JSON.stringify(update));

        // Платёж
        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            const match = payload.match(/^stars_(\d+)_(\d+)$/);
            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
                console.log(`User ${userId} topped up ${amount} stars`);
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
                    await sendMessage(chatId, 'Введите число больше 0.');
                } else {
                    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                    if (!user || user.balance < amount) {
                        await sendMessage(chatId, 'Недостаточно звёзд.');
                    } else {
                        db.prepare('INSERT INTO withdrawals (telegram_id, amount) VALUES (?, ?)').run(chatId, amount);
                        db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amount, chatId);
                        await sendMessage(chatId, `✅ Заявка на вывод ${amount} ⭐ создана.`);
                        if (ADMIN_ID) {
                            const userInfo = update.message.from;
                            const username = userInfo.username ? `@${userInfo.username}` : userInfo.first_name;
                            await sendMessage(ADMIN_ID, `📤 Новая заявка на вывод:\nПользователь: ${username} (ID: ${chatId})\nСумма: ${amount} ⭐\nДата: ${new Date().toLocaleString()}`);
                        }
                    }
                }
                delete userStates[chatId];
                return res.sendStatus(200);
            }

            if (text === '/start') {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text: 'Тестовый ответ'
        })
    });
    return res.sendStatus(200);
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
                await sendMessage(chatId, 'Введите сумму звёзд для пополнения:', {
                    reply_markup: {
                        keyboard: [[{ text: '10' }, { text: '25' }], [{ text: '50' }, { text: '100' }]],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                });
            } else if (data === 'withdraw') {
                userStates[chatId] = 'awaiting_withdraw_amount';
                await sendMessage(chatId, 'Введите сумму для вывода:');
            } else if (data === 'history') {
                const withdrawals = db.prepare('SELECT amount, status, created_at FROM withdrawals WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 5').all(chatId);
                if (withdrawals.length === 0) {
                    await sendMessage(chatId, 'У вас пока нет заявок на вывод.');
                } else {
                    let text = '📋 История выводов:\n\n';
                    withdrawals.forEach(w => {
                        const date = new Date(w.created_at).toLocaleString();
                        text += `• ${w.amount} ⭐ (${w.status}) — ${date}\n`;
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra })
    });
}

async function answerCallbackQuery(callbackQueryId) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId })
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
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Пополнение звёзд',
            description: `Покупка ${amount} Telegram Stars`,
            payload: `stars_${chatId}_${amount}`,
            provider_token: '',
            currency: 'XTR',
            prices: [{ label: 'Звёзды', amount: amount }]
        })
    });
    const data = await response.json();
    if (data.ok) {
        await sendMessage(chatId, `Счёт на ${amount} ⭐: [Оплатить](${data.result})`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: `Оплатить ${amount} ⭐`, url: data.result }]]
            }
        });
    } else {
        console.error('Invoice error:', data);
        await sendMessage(chatId, 'Ошибка создания счёта. Попробуйте позже.');
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on port ${PORT}`));
