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
const ADMIN_ID = process.env.ADMIN_ID;
if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is missing!');
    process.exit(1);
}

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('Zora Backend is running'));

app.get('/api/balance/:telegram_id', (req, res) => {
    try {
        const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(req.params.telegram_id);
        res.json({ balance: user ? user.balance : 50 });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Вебхук и остальная логика (без изменений, просто замени этот блок)
const userStates = {};
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        // ... (вставь сюда ВЕСЬ свой обработчик из предыдущего рабочего кода, но оберни в try/catch)
        // Я не вставляю его полностью, чтобы не загромождать, возьми из последнего рабочего варианта.
        // Главное – убедись, что там нет вызовов createInvoiceLink при получении /start и т.д.
        // Если хочешь, я скину полный компактный вебхук отдельно.
    } catch (e) {
        console.error('Webhook error:', e);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend running on port ${PORT}`);
}).on('error', (err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
});

// Обработка необработанных ошибок
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});
