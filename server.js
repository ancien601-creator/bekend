const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

const db = new Database('users.db');
db.exec(`CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  balance INTEGER DEFAULT 50,
  level INTEGER DEFAULT 1,
  xp INTEGER DEFAULT 0,
  xp_next INTEGER DEFAULT 100
)`);

// Telegram Bot Token (получи у @BotFather)
const BOT_TOKEN = process.env.BOT_TOKEN;

// Проверка подписи данных Telegram (упрощённо, для продакшена нужна полная проверка)
function verifyTelegramData(initData) {
  // ... здесь реализуй проверку hash согласно документации Telegram
  return true; // для демо
}

// Получить профиль пользователя
app.post('/api/profile', (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegramData(initData)) return res.status(401).json({ error: 'Invalid data' });
  const user = JSON.parse(initData).user;
  let dbUser = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(user.id);
  if (!dbUser) {
    db.prepare('INSERT INTO users (telegram_id) VALUES (?)').run(user.id);
    dbUser = { telegram_id: user.id, balance: 50, level: 1, xp: 0, xp_next: 100 };
  }
  res.json(dbUser);
});

// Обновить прогресс (баланс, уровень, опыт)
app.post('/api/sync', (req, res) => {
  const { initData, balance, level, xp, xp_next } = req.body;
  if (!verifyTelegramData(initData)) return res.status(401).json({ error: 'Invalid data' });
  const user = JSON.parse(initData).user;
  db.prepare('UPDATE users SET balance=?, level=?, xp=?, xp_next=? WHERE telegram_id=?')
    .run(balance, level, xp, xp_next, user.id);
  res.json({ success: true });
});

// Создание инвойса для пополнения звёзд (Telegram Stars)
app.post('/api/create-invoice', async (req, res) => {
  const { initData, amount } = req.body;
  if (!verifyTelegramData(initData)) return res.status(401).json({ error: 'Invalid data' });
  const user = JSON.parse(initData).user;
  // Отправляем запрос к Telegram Bot API для создания счёта
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Пополнение звёзд',
      description: `Покупка ${amount} Telegram Stars`,
      payload: `stars_${user.id}_${amount}`,
      provider_token: '', // для звёзд оплата через внутренний кошелёк Telegram
      currency: 'XTR',
      prices: [{ label: 'Звёзды', amount: amount }]
    })
  });
  const data = await response.json();
  if (data.ok) {
    res.json({ invoiceLink: data.result });
  } else {
    res.status(500).json({ error: 'Ошибка создания инвойса' });
  }
});

// Webhook для обработки успешных платежей (настрой через setWebhook)
app.post('/webhook', (req, res) => {
  const update = req.body;
  if (update.message?.successful_payment) {
    const payload = update.message.successful_payment.invoice_payload;
    const match = payload.match(/^stars_(\d+)_(\d+)$/);
    if (match) {
      const userId = parseInt(match[1]);
      const amount = parseInt(match[2]);
      db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
      console.log(`Пользователь ${userId} пополнил баланс на ${amount} звёзд`);
    }
  }
  res.sendStatus(200);
});

app.listen(3000, () => console.log('Backend running on port 3000'));
