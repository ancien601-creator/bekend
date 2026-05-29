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

// ---------- База даних ----------
const db = new Database('users.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    balance INTEGER DEFAULT 0,
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

// ---------- Здоров'я ----------
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------- API для Mini App ----------
app.get('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
    const balance = user ? user.balance : 0;
    console.log(`[GET /api/balance/${tid}] → ${balance}`);
    res.json({ balance });
});

app.post('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const { balance } = req.body;
    if (typeof balance !== 'number' || balance < 0) {
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
        console.log('Update:', JSON.stringify(update).slice(0, 200));

        // Обробка pre_checkout_query (обов'язково для платежів)
        if (update.pre_checkout_query) {
            const query = update.pre_checkout_query;
            console.log('Pre-checkout query:', query.id);
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pre_checkout_query_id: query.id,
                    ok: true
                })
            });
            return res.sendStatus(200);
        }

        // Успішний платіж
        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            const match = payload.match(/^stars_(\d+)_(\d+)$/);
            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
                console.log(`Користувач ${userId} поповнив баланс на ${amount} зірок`);
                // Відправляємо підтвердження
                await sendMessage(userId, `✅ Ваш баланс поповнено на ${amount} ⭐. Можете грати!`);
            }
            return res.sendStatus(200);
        }

        // Текстові повідомлення
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text === '/start') {
                await sendMessage(chatId, 'Ласкаво просимо до ZORA IMPERIAL!', {
                    reply_markup: {
                        keyboard: [
                            [{ text: '🎰 Грати', web_app: { url: WEBAPP_URL } }],
                            [{ text: '👤 Профіль' }]
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

            if (text === '👤 Профіль') {
                await showProfile(chatId);
                return res.sendStatus(200);
            }

            // Поповнення: якщо користувач надіслав число (>=1)
            const amount = parseInt(text);
            if (!isNaN(amount) && amount >= 1) {
                await createInvoice(chatId, amount);
            } else {
                await sendMessage(chatId, 'Використовуйте кнопки меню.');
            }
        }

        // Callback-запити (inline-кнопки)
        if (update.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const data = query.data;

            if (data === 'profile') {
                await showProfile(chatId);
                await answerCallbackQuery(query.id);
            } else if (data === 'topup') {
                await sendMessage(chatId, 'Введіть суму зірок для поповнення (мінімум 1):', {
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
                await sendMessage(chatId, 'Оберіть суму для виведення:', {
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
                    await sendMessage(chatId, 'Недостатньо зірок для виведення.');
                } else {
                    db.prepare('INSERT INTO withdrawals (telegram_id, amount) VALUES (?, ?)').run(chatId, amount);
                    db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amount, chatId);
                    await sendMessage(chatId, `✅ Заявку на виведення ${amount} ⭐ створено. Очікуйте підтвердження.`);
                    if (ADMIN_ID) {
                        const username = query.from.username ? `@${query.from.username}` : query.from.first_name;
                        await sendMessage(
                            ADMIN_ID,
                            `📤 Нова заявка на виведення:\n` +
                            `Користувач: ${username} (ID: ${chatId})\n` +
                            `Сума: ${amount} ⭐\n` +
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
                    await sendMessage(chatId, 'У вас поки немає заявок на виведення.');
                } else {
                    let text = '📋 Історія виведень:\n\n';
                    withdrawals.forEach(w => {
                        const date = new Date(w.created_at).toLocaleString();
                        text += `• ${w.amount} ⭐ (${w.status}) — ${date}\n`;
                    });
                    await sendMessage(chatId, text);
                }
                await answerCallbackQuery(query.id);
            }
            return res.sendStatus(200);
        }

        res.sendStatus(200);
    } catch (e) {
        console.error('Webhook error:', e);
        res.sendStatus(500);
    }
});

// ---------- Допоміжні функції ----------
async function sendMessage(chatId, text, extra = {}) {
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, ...extra })
        });
    } catch (err) {
        console.error('sendMessage error:', err);
    }
}

async function answerCallbackQuery(callbackQueryId) {
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId })
        });
    } catch (err) {
        console.error('answerCallbackQuery error:', err);
    }
}

async function showProfile(chatId) {
    const user = db.prepare('SELECT balance, level, xp, xp_next FROM users WHERE telegram_id = ?').get(chatId);
    const balance = user ? user.balance : 0;
    const level = user ? user.level : 1;
    const xp = user ? user.xp : 0;
    const xpNext = user ? user.xp_next : 100;

    const text = `👤 Ваш профіль:\n\n` +
                 `⭐ Баланс: ${balance}\n` +
                 `🎚 Рівень: ${level}\n` +
                 `🔹 Досвід: ${xp}/${xpNext}`;

    await sendMessage(chatId, text, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '💳 Поповнити', callback_data: 'topup' }],
                [{ text: '💸 Вивести', callback_data: 'withdraw' }],
                [{ text: '📋 Історія виведень', callback_data: 'history' }]
            ]
        }
    });
}

async function createInvoice(chatId, amount) {
    try {
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Поповнення зірок',
                description: `Купівля ${amount} Telegram Stars`,
                payload: `stars_${chatId}_${amount}`,
                provider_token: '',
                currency: 'XTR',
                prices: [{ label: 'Зірки', amount: amount }]
            })
        });
        const data = await response.json();
        if (data.ok) {
            await sendMessage(chatId, `Рахунок на ${amount} ⭐ готовий:\n[Оплатити](${data.result})`, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } else {
            console.error('Invoice error:', data);
            await sendMessage(chatId, 'Помилка створення рахунку. Спробуйте пізніше.');
        }
    } catch (err) {
        console.error('createInvoice error:', err);
    }
}

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on port ${PORT}`));
