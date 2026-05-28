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
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-netlify-app.netlify.app';

if (!BOT_TOKEN) {
    console.error('BOT_TOKEN is not set!');
    process.exit(1);
}

const userStates = {};

app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// Получить баланс
app.get('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    console.log(`[GET /api/balance/${tid}]`);
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
    const balance = user ? user.balance : 50;
    console.log(`[GET /api/balance/${tid}] → ${balance}`);
    res.json({ balance });
});

// Обновить баланс (и опционально уровень/опыт)
app.post('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const { balance, level, xp, xp_next } = req.body;
    console.log(`[POST /api/balance/${tid}] body=`, req.body);
    if (typeof balance !== 'number' || balance < 0) {
        return res.status(400).json({ error: 'Invalid balance' });
    }
    const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tid);
    if (user) {
        db.prepare('UPDATE users SET balance = ?, level = COALESCE(?, level), xp = COALESCE(?, xp), xp_next = COALESCE(?, xp_next) WHERE telegram_id = ?')
          .run(balance, level, xp, xp_next, tid);
    } else {
        db.prepare('INSERT INTO users (telegram_id, balance, level, xp, xp_next) VALUES (?, ?, ?, ?, ?)')
          .run(tid, balance, level || 1, xp || 0, xp_next || 100);
    }
    console.log(`[POST /api/balance/${tid}] updated to balance=${balance}`);
    res.json({ success: true });
});

// Webhook – остальная часть без изменений (вставьте свой рабочий код)
// ...
