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

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is not set!');
    process.exit(1);
}

// ---------- Здоровье ----------
app.get('/', (req, res) => res.send('Zora Backend is running'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------- API для Mini App: получить баланс ----------
app.get('/api/balance/:telegram_id', (req, res) => {
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(req.params.telegram_id);
    res.json({ balance: user ? user.balance : 50 });
});

// ---------- API для Mini App: создать инвойс (уже не используется, но оставим для совместимости) ----------
app.post('/api/create-invoice', async (req, res) => {
    // Теперь это не требуется, но оставим заглушку
    res.status(410).json({ error: 'Используйте пополнение через бота' });
});

// ---------- Вебхук Telegram ----------
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;

        // Обработка успешного платежа
        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            const match = payload.match(/^stars_(\d+)_(\d+)$/);
            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
                console.log(`Пользователь ${userId} пополнил баланс на ${amount} звёзд`);
            }
            return res.sendStatus(200);
        }

        // Обработка текстовых сообщений и команд
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text === '/start' || text === 'Пополнить') {
                // Отправляем счёт на пополнение
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendInvoice`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        title: 'Пополнение звёзд',
                        description: 'Покупка Telegram Stars для Zora Imperial',
                        payload: `stars_${chatId}_10`,   // фиксированная сумма 10 звёзд
                        provider_token: '',
                        currency: 'XTR',
                        prices: [{ label: 'Звёзды', amount: 10 }],
                        start_parameter: 'start',
                        need_name: false,
                        need_phone_number: false,
                        need_email: false,
                        need_shipping_address: false,
                        send_phone_number_to_provider: false,
                        send_email_to_provider: false,
                        is_flexible: false,
                        disable_notification: false,
                        protect_content: false,
                        reply_to_message_id: null,
                        allow_sending_without_reply: true,
                        reply_markup: JSON.stringify({
                            inline_keyboard: [[
                                { text: 'Оплатить 10 ⭐', pay: true }
                            ]]
                        })
                    })
                });
            } else {
                // Ответ на любое другое сообщение – показываем кнопку
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: 'Для пополнения баланса нажми кнопку ниже 👇',
                        reply_markup: JSON.stringify({
                            keyboard: [[{ text: 'Пополнить' }]],
                            resize_keyboard: true,
                            one_time_keyboard: false
                        })
                    })
                });
            }
        }

        res.sendStatus(200);
    } catch (e) {
        console.error('Webhook error:', e);
        res.sendStatus(500);
    }
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Backend running on port ${PORT}`));
