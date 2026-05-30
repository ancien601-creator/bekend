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
const db = new Database('usersе.db');
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
const ADMIN_ID = process.env.ADMIN_ID;      // уведомления о выводе
const ADMIN_ID2 = process.env.ADMIN_ID2;    // команда /addstars
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-netlify-app.netlify.app';

console.log('=== Запуск сервера ===');
console.log('BOT_TOKEN задан:', BOT_TOKEN ? 'Да' : 'Нет');
console.log('ADMIN_ID:', ADMIN_ID);
console.log('ADMIN_ID2:', ADMIN_ID2);
console.log('WEBAPP_URL:', WEBAPP_URL);

// ---------- Здоровье ----------
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------- API для Mini App ----------
app.get('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    console.log(`[API] Запрос баланса для ${tid}`);
    try {
        const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
        const balance = user ? user.balance : 0;
        console.log(`[API] Баланс ${tid}: ${balance}`);
        res.json({ balance });
    } catch (err) {
        console.error('[API] Ошибка получения баланса:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const { balance } = req.body;
    console.log(`[API] Обновление баланса ${tid}: ${balance}`);
    if (typeof balance !== 'number' || balance < 0) {
        console.log('[API] Неверный баланс');
        return res.status(400).json({ error: 'Invalid balance' });
    }
    try {
        db.prepare('INSERT OR REPLACE INTO users (telegram_id, balance) VALUES (?, ?)').run(tid, balance);
        console.log(`[API] Баланс ${tid} обновлён до ${balance}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[API] Ошибка обновления баланса:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------- Вебхук Telegram ----------
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        console.log('=== Новое обновление ===');
        console.log('Тип:', update.message ? 'сообщение' : update.callback_query ? 'callback' : update.pre_checkout_query ? 'pre_checkout' : 'другое');
        if (update.message) console.log(`От: ${update.message.from?.id} (${update.message.from?.username || 'без username'}) Текст: "${update.message.text}"`);
        if (update.callback_query) console.log(`Callback от: ${update.callback_query.from.id} Данные: "${update.callback_query.data}"`);

        // pre_checkout_query
        if (update.pre_checkout_query) {
            const query = update.pre_checkout_query;
            console.log(`[PreCheckout] Запрос ID: ${query.id} от ${query.from.id}`);
            try {
                const answerRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pre_checkout_query_id: query.id, ok: true })
                });
                const answerData = await answerRes.json();
                console.log('[PreCheckout] Ответ:', answerData);
            } catch (err) {
                console.error('[PreCheckout] Ошибка отправки ответа:', err);
            }
            return res.sendStatus(200);
        }

        // Успешный платёж
        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            console.log(`[Платёж] payload: ${payload}`);
            const match = payload.match(/^stars_(\d+)_(\d+)$/);
            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                console.log(`[Платёж] Начисление ${amount} звёзд пользователю ${userId}`);
                try {
                    db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(userId);
                    db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
                    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(userId);
                    console.log(`[Платёж] Баланс пользователя ${userId} теперь: ${user.balance}`);
                    await sendMessage(userId, `✅ Ваш баланс пополнен на ${amount} ⭐. Текущий баланс: ${user.balance} ⭐`);
                } catch (err) {
                    console.error('[Платёж] Ошибка обновления баланса:', err);
                }
            } else {
                console.log('[Платёж] Неверный формат payload');
            }
            return res.sendStatus(200);
        }

        // Текстовые сообщения
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            console.log(`[Сообщение] chatId=${chatId} текст="${text}"`);

            if (text === '/start') {
                console.log('[Команда] /start');
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
                console.log('[Команда] /balance');
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                await sendMessage(chatId, `Ваш баланс: ${user ? user.balance : 0} ⭐`);
                return res.sendStatus(200);
            }

            if (text === '👤 Профиль') {
                console.log('[Кнопка] Профиль');
                await showProfile(chatId);
                return res.sendStatus(200);
            }

            // Команда /addstars
            if (text.startsWith('/addstars')) {
                console.log('[Команда] /addstars');
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

                console.log(`[Команда] addstars от ${chatId}, target=${targetUserId}, amount=${amount}`);
                console.log(`[Команда] ADMIN_ID2=${ADMIN_ID2}, chatId=${chatId}, совпадение: ${String(chatId) === String(ADMIN_ID2)}`);
                if (String(chatId) !== String(ADMIN_ID2)) {
                    console.log('[Команда] Отказано в доступе');
                    await sendMessage(chatId, 'У вас нет прав для выполнения этой команды.');
                    return res.sendStatus(200);
                }

                try {
                    db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(targetUserId);
                    db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, targetUserId);
                    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(targetUserId);
                    console.log(`[Команда] Звёзды начислены, баланс: ${user.balance}`);
                    await sendMessage(chatId, `✅ Пользователю ${targetUserId} начислено ${amount} ⭐. Текущий баланс: ${user.balance} ⭐`);
                } catch (err) {
                    console.error('[Команда] Ошибка начисления звёзд:', err);
                    await sendMessage(chatId, 'Произошла ошибка при начислении звёзд.');
                }
                return res.sendStatus(200);
            }

            const amount = parseInt(text);
            if (!isNaN(amount) && amount >= 1) {
                console.log(`[Пополнение] Запрос на ${amount} звёзд`);
                await createInvoice(chatId, amount);
            } else {
                console.log('[Сообщение] Неизвестная команда');
                await sendMessage(chatId, 'Используйте кнопки меню.');
            }
        }

        // Callback-запросы
        if (update.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const data = query.data;
            console.log(`[Callback] chatId=${chatId} data="${data}"`);

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
                console.log(`[Вывод] Запрос на ${amount} звёзд от ${chatId}`);
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                if (!user || user.balance < amount) {
                    await sendMessage(chatId, 'Недостаточно звёзд для вывода.');
                } else {
                    try {
                        db.prepare('INSERT INTO withdrawals (telegram_id, amount) VALUES (?, ?)').run(chatId, amount);
                        db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amount, chatId);
                        await sendMessage(chatId, `✅ Заявка на вывод ${amount} ⭐ создана. Ожидайте подтверждения.`);
                        if (ADMIN_ID) {
                            const username = query.from.username ? `@${query.from.username}` : query.from.first_name;
                            console.log(`[Вывод] Уведомление админу ${ADMIN_ID}`);
                            await sendMessage(
                                ADMIN_ID,
                                `📤 Новая заявка на вывод:\n` +
                                `Пользователь: ${username} (ID: ${chatId})\n` +
                                `Сумма: ${amount} ⭐\n` +
                                `Дата: ${new Date().toLocaleString()}`
                            );
                        }
                    } catch (err) {
                        console.error('[Вывод] Ошибка:', err);
                        await sendMessage(chatId, 'Произошла ошибка при создании заявки.');
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
                    });
                    await sendMessage(chatId, text);
                }
                await answerCallbackQuery(query.id);
            }
            return res.sendStatus(200);
        }

        res.sendStatus(200);
    } catch (e) {
        console.error('=== КРИТИЧЕСКАЯ ОШИБКА В WEBHOOK ===');
        console.error(e);
        res.sendStatus(500);
    }
});

// ---------- Вспомогательные функции с подробным логированием ----------
async function sendMessage(chatId, text, extra = {}) {
    console.log(`[sendMessage] Кому: ${chatId}`);
    console.log(`[sendMessage] Текст: ${text.substring(0, 100)}`);
    if (extra.reply_markup) console.log(`[sendMessage] Клавиатура: Да`);
    try {
        const body = { chat_id: chatId, text, ...extra };
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await response.json();
        console.log(`[sendMessage] Результат:`, data);
        if (!data.ok) {
            console.error(`[sendMessage] ОШИБКА Telegram API:`, data);
        }
    } catch (err) {
        console.error(`[sendMessage] Ошибка сети:`, err);
    }
}

async function answerCallbackQuery(callbackQueryId) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId })
        });
        const data = await res.json();
        console.log(`[answerCallbackQuery] Результат:`, data);
    } catch (err) {
        console.error('[answerCallbackQuery] Ошибка:', err);
    }
}

async function showProfile(chatId) {
    console.log(`[showProfile] Для ${chatId}`);
    const user = db.prepare('SELECT balance, level, xp, xp_next FROM users WHERE telegram_id = ?').get(chatId);
    const balance = user ? user.balance : 0;
    const level = user ? user.level : 1;
    const xp = user ? user.xp : 0;
    const xpNext = user ? user.xp_next : 100;

    const text = `👤 Ваш профиль:\n\n` +
                 `⭐ Баланс: ${balance}\n` +
                 `🎚 Уровень: ${level}\n` +
                 `🔹 Опыт: ${xp}/${xpNext}`;

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
    console.log(`[createInvoice] Для ${chatId} на сумму ${amount}`);
    try {
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
        console.log(`[createInvoice] Результат:`, data);
        if (data.ok) {
            await sendMessage(chatId, `Счёт на ${amount} ⭐ готов:\n[Оплатить](${data.result})`, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } else {
            await sendMessage(chatId, 'Ошибка создания счёта. Попробуйте позже.');
        }
    } catch (err) {
        console.error('[createInvoice] Ошибка:', err);
    }
}

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`=== Сервер запущен на порту ${PORT} ===`);
});
