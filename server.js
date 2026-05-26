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
let db;
try {
    db = new Database('users.db');
    db.exec(`CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        balance INTEGER DEFAULT 50,
        level INTEGER DEFAULT 1,
        xp INTEGER DEFAULT 0,
        xp_next INTEGER DEFAULT 100
    )`);
    console.log('Database ready');
} catch (err) {
    console.error('Database error:', err);
    process.exit(1);
}

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is not set!');
    process.exit(1);
}

// ---------- Логирование запросов ----------
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// ---------- Маршруты ----------
app.get('/', (req, res) => res.send('Zora Backend is running'));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.post('/api/create-invoice', async (req, res) => {
    try {
        const { telegram_id, amount } = req.body;
        if (!telegram_id || !amount) return res.status(400).json({ error: 'telegram_id и amount обязательны' });

        console.log(`Creating invoice for user ${telegram_id}, amount ${amount}`);
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Пополнение звёзд',
                description: `Покупка ${amount} Telegram Stars`,
                payload: `stars_${telegram_id}_${amount}`,
                provider_token: '',
                currency: 'XTR',
                prices: [{ label: 'Звёзды', amount: amount }]
            })
        });

        const data = await response.json();
        console.log('Telegram API response:', data);
        if (data.ok) {
            res.json({ invoiceLink: data.result });
        } else {
            res.status(500).json({ error: 'Ошибка создания инвойса' });
        }
    } catch (err) {
        console.error('Error in /api/create-invoice:', err);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

app.post('/webhook', (req, res) => {
    try {
        const update = req.body;
        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            const match = payload.match(/^stars_(\d+)_(\d+)$/);
            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
                console.log(`User ${userId} topped up ${amount} stars`);
            }
        }
    } catch (err) {
        console.error('Webhook error:', err);
    }
    res.sendStatus(200);
});

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on port ${PORT}`);
}).on('error', (err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
