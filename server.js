const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');   // node-fetch версии 2 (CommonJS)
require('dotenv').config();

const app = express();
app.use(express.json());

// ---------- CORS – чтобы Netlify мог отправлять запросы ----------
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ---------- База данных SQLite ----------
const db = new Database('users.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        balance    INTEGER DEFAULT 50,
        level      INTEGER DEFAULT 1,
        xp         INTEGER DEFAULT 0,
        xp_next    INTEGER DEFAULT 100
    )
`);

const BOT_TOKEN = process.env.BOT_TOKEN;   // Railway Variables

// ---------- Проверка жизни сервера ----------
app.get('/', (req, res) => {
    res.send('Zora Backend is running');
});

// ---------- Создание инвойса для оплаты Telegram Stars ----------
app.post('/api/create-invoice', async (req, res) => {
    try {
        const { telegram_id, amount } = req.body;

        if (!telegram_id || !amount) {
            return res.status(400).json({ error: 'telegram_id и amount обязательны' });
        }

        const response = await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Пополнение звёзд',
                    description: `Покупка ${amount} Telegram Stars`,
                    payload: `stars_${telegram_id}_${amount}`,
                    provider_token: '',         // для внутренней валюты Telegram Stars
                    currency: 'XTR',           // код Telegram Stars
                    prices: [{ label: 'Звёзды', amount: amount }]
                })
            }
        );

        const data = await response.json();

        if (data.ok) {
            res.json({ invoiceLink: data.result });
        } else {
            console.error('Ошибка создания инвойса:', data);
            res.status(500).json({ error: 'Ошибка создания инвойса' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ---------- Webhook для приёма успешных платежей ----------
app.post('/webhook', (req, res) => {
    try {
        const update = req.body;

        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            const match = payload.match(/^stars_(\d+)_(\d+)$/);

            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);

                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?')
                  .run(amount, userId);

                console.log(`Пользователь ${userId} пополнил баланс на ${amount} звёзд`);
            }
        }
    } catch (err) {
        console.error('Ошибка обработки webhook:', err);
    }

    res.sendStatus(200);
});

// ---------- Дополнительно: получение баланса (для тестов) ----------
app.get('/api/balance/:telegram_id', (req, res) => {
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?')
                   .get(req.params.telegram_id);
    res.json(user || { balance: 0 });
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
