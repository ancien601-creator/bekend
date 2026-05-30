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
    balance INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    xp_next INTEGER DEFAULT 100,
    username TEXT DEFAULT '',
    photo_url TEXT DEFAULT '',
    referrer_id INTEGER DEFAULT NULL,
    referrals_count INTEGER DEFAULT 0,
    referral_case_used INTEGER DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    amount INTEGER,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS promocodes (
    code TEXT PRIMARY KEY,
    amount INTEGER NOT NULL,
    created_by INTEGER,
    used INTEGER DEFAULT 0
)`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;      // уведомления о выводе
const ADMIN_ID2 = process.env.ADMIN_ID2;    // команды /addstars и /createpromo
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-netlify-app.netlify.app';

if (!BOT_TOKEN) {
    console.error('BOT_TOKEN не установлен!');
    process.exit(1);
}

// ---------- Здоровье ----------
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.status(200).send('OK'));

// ---------- API для Mini App ----------
app.get('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
    res.json({ balance: user ? user.balance : 0 });
});

app.post('/api/balance/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const { balance, username, photo_url } = req.body;
    if (typeof balance !== 'number' || balance < 0) {
        return res.status(400).json({ error: 'Неверный баланс' });
    }
    const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
    if (user) {
        db.prepare('UPDATE users SET balance = ?, username = COALESCE(?, username), photo_url = COALESCE(?, photo_url) WHERE telegram_id = ?')
          .run(balance, username, photo_url, tid);
    } else {
        db.prepare('INSERT INTO users (telegram_id, balance, username, photo_url) VALUES (?, ?, ?, ?)')
          .run(tid, balance, username || '', photo_url || '');
    }
    console.log(`[POST /api/balance/${tid}] обновлён до ${balance}, username=${username}, photo_url=${photo_url}`);
    res.json({ success: true });
});

// Топ-10 игроков по балансу
app.get('/api/top', (req, res) => {
    try {
        const top = db.prepare('SELECT telegram_id, balance, username, photo_url FROM users ORDER BY balance DESC LIMIT 10').all();
        const result = top.map(u => ({
            id: u.telegram_id,
            username: u.username || ('ID' + String(u.telegram_id).slice(-4)),
            balance: u.balance,
            photo_url: u.photo_url || ''
        }));
        res.json(result);
    } catch (err) {
        console.error('/api/top ошибка:', err);
        res.status(500).json({ error: 'Внутренняя ошибка' });
    }
});

// Данные реферальной системы для Mini App
app.get('/api/referral/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const user = db.prepare('SELECT referrals_count, referral_case_used, referrer_id FROM users WHERE telegram_id = ?').get(tid);
    if (!user) return res.json({ referrals: 0, caseUsed: false, referrer: null });
    res.json({ referrals: user.referrals_count || 0, caseUsed: !!user.referral_case_used, referrer: user.referrer_id });
});

// Открытие реферального кейса (проверка на MiniApp)
app.post('/api/referral-case/:telegram_id', (req, res) => {
    const tid = req.params.telegram_id;
    const user = db.prepare('SELECT referrals_count, referral_case_used FROM users WHERE telegram_id = ?').get(tid);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.referrals_count < 2) return res.status(400).json({ error: 'Нужно минимум 2 реферала' });
    if (user.referral_case_used) return res.status(400).json({ error: 'Кейс уже открыт' });

    // Возможные награды (звёзды или предметы)
    const rewards = [
        { type: 'stars', amount: 50, emoji: '⭐', text: '50 звёзд' },
        { type: 'stars', amount: 100, emoji: '⭐', text: '100 звёзд' },
        { type: 'gift', name: 'Алмаз', emoji: '💎', price: 100 },
        { type: 'gift', name: 'Кольцо', emoji: '💍', price: 100 },
        { type: 'gift', name: 'Осколок звезды', emoji: '🌟', price: 200 },
        { type: 'nothing', emoji: '😞', text: 'Ничего' }
    ];
    const reward = rewards[Math.floor(Math.random() * rewards.length)];

    // Помечаем кейс использованным
    db.prepare('UPDATE users SET referral_case_used = 1 WHERE telegram_id = ?').run(tid);

    // Выдаём награду
    if (reward.type === 'stars') {
        db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(reward.amount, tid);
        const updated = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
        return res.json({ success: true, reward: { type: 'stars', amount: reward.amount, emoji: reward.emoji, text: reward.text }, balance: updated.balance });
    } else if (reward.type === 'gift') {
        // Здесь можно добавить предмет в инвентарь через отдельную таблицу, но пока просто даём звёзды равные цене
        db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(reward.price, tid);
        const updated = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(tid);
        return res.json({ success: true, reward: { type: 'gift', name: reward.name, emoji: reward.emoji, price: reward.price, text: reward.name + ' (⭐' + reward.price + ')' }, balance: updated.balance });
    } else {
        return res.json({ success: true, reward: { type: 'nothing', emoji: reward.emoji, text: reward.text }, balance: user.balance });
    }
});

// ---------- Вебхук Telegram ----------
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        console.log('Update:', JSON.stringify(update).slice(0, 200));

        // pre_checkout_query
        if (update.pre_checkout_query) {
            const query = update.pre_checkout_query;
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pre_checkout_query_id: query.id, ok: true })
            });
            return res.sendStatus(200);
        }

        // Успешный платёж
        if (update.message?.successful_payment) {
            const payload = update.message.successful_payment.invoice_payload;
            const match = payload.match(/^stars_(\d+)_(\d+)$/);
            if (match) {
                const userId = parseInt(match[1]);
                const amount = parseInt(match[2]);
                db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(userId);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, userId);
                const user = db.prepare('SELECT balance, referrer_id FROM users WHERE telegram_id = ?').get(userId);
                console.log(`Пользователь ${userId} пополнил баланс на ${amount} звёзд, текущий баланс: ${user.balance}`);

                // Начисляем 30% рефереру, если он есть
                if (user.referrer_id) {
                    const referralBonus = Math.floor(amount * 0.3);
                    if (referralBonus > 0) {
                        db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(referralBonus, user.referrer_id);
                        console.log(`Реферер ${user.referrer_id} получил ${referralBonus} звёзд за пополнение реферала ${userId}`);
                        await sendMessage(user.referrer_id, `🎉 Ваш реферал пополнил баланс на ${amount} ⭐! Вы получили ${referralBonus} ⭐ (30%).`);
                    }
                }
                await sendMessage(userId, `✅ Ваш баланс пополнен на ${amount} ⭐. Текущий баланс: ${user.balance} ⭐`);
            }
            return res.sendStatus(200);
        }

        // Текстовые сообщения
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();
            console.log(`Получено сообщение от ${chatId}: "${text}"`);

            // Обработка /start с параметром (реферальная ссылка)
            if (text.startsWith('/start')) {
                const parts = text.split(' ');
                let referrerId = null;
                if (parts.length > 1) {
                    referrerId = parseInt(parts[1]);
                }

                // Если это новый пользователь и он перешёл по реферальной ссылке
                if (referrerId && referrerId !== chatId) {
                    const existing = db.prepare('SELECT referrer_id FROM users WHERE telegram_id = ?').get(chatId);
                    if (!existing || !existing.referrer_id) {
                        // Устанавливаем реферера
                        db.prepare('UPDATE users SET referrer_id = ? WHERE telegram_id = ?').run(referrerId, chatId);
                        // Увеличиваем счётчик рефералов у реферера
                        db.prepare('UPDATE users SET referrals_count = referrals_count + 1 WHERE telegram_id = ?').run(referrerId);
                        console.log(`Пользователь ${chatId} присоединился по реферальной ссылке от ${referrerId}`);
                        await sendMessage(referrerId, `🎉 По вашей ссылке присоединился новый пользователь! У вас теперь +1 реферал.`);
                    }
                }

                await sendMessage(chatId, '👑 Добро пожаловать в ZORA IMPERIAL!\n\n🎰 Здесь ты можешь открывать кейсы, играть в мини-игры и зарабатывать звёзды Telegram.\n👥 Приглашай друзей и получай 30% от их пополнений!', {
                    reply_markup: {
                        keyboard: [
                            [{ text: '🎰 Играть', web_app: { url: WEBAPP_URL } }],
                            [{ text: '👤 Профиль' }, { text: '🔗 Реферальная ссылка' }],
                            [{ text: '🏆 Топ' }, { text: '❓ Помощь' }]
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: false
                    }
                });
                return res.sendStatus(200);
            }

            if (text === '❓ Помощь') {
                const helpText = `🆘 <b>Помощь по командам:</b>\n\n` +
                    `/balance – ваш баланс\n` +
                    `/level – ваш уровень и опыт\n` +
                    `/activate [код] – активировать промокод\n` +
                    `👤 Профиль – управление балансом\n` +
                    `🔗 Реферальная ссылка – пригласить друга и получать 30% от его пополнений\n` +
                    `🎰 Играть – запустить MiniApp\n` +
                    `🏆 Топ – список лидеров\n\n` +
                    `По всем вопросам: @Vados4433`;
                await sendMessage(chatId, helpText, { parse_mode: 'HTML' });
                return res.sendStatus(200);
            }

            if (text === '/balance') {
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                await sendMessage(chatId, `Ваш баланс: ${user ? user.balance : 0} ⭐`);
                return res.sendStatus(200);
            }

            if (text === '/level') {
                const user = db.prepare('SELECT level, xp, xp_next FROM users WHERE telegram_id = ?').get(chatId);
                if (user) {
                    await sendMessage(chatId, `🎚 Ваш уровень: ${user.level}\n🔹 Опыт: ${user.xp}/${user.xp_next}`);
                } else {
                    await sendMessage(chatId, 'Ваш уровень: 1\n🔹 Опыт: 0/100');
                }
                return res.sendStatus(200);
            }

            if (text === '👤 Профиль') {
                await showProfile(chatId);
                return res.sendStatus(200);
            }

            if (text === '🔗 Реферальная ссылка') {
                const link = `https://t.me/${(await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)).json()).result.username}?start=${chatId}`;
                const user = db.prepare('SELECT referrals_count FROM users WHERE telegram_id = ?').get(chatId);
                const count = user ? user.referrals_count : 0;
                await sendMessage(chatId, `🔗 Ваша реферальная ссылка:\n${link}\n\n👥 Приглашено: ${count}\n💰 Вы получаете 30% от пополнений приглашённых пользователей!\n🎁 За двух приглашённых – специальный кейс!`, { disable_web_page_preview: true });
                return res.sendStatus(200);
            }

            if (text === '🏆 Топ') {
                const top = db.prepare('SELECT telegram_id, balance, username FROM users ORDER BY balance DESC LIMIT 10').all();
                let topText = '🏆 <b>Топ игроков:</b>\n\n';
                top.forEach((u, i) => {
                    const name = u.username || ('ID' + String(u.telegram_id).slice(-4));
                    topText += `${i+1}. ${name} – ${u.balance} ⭐\n`;
                });
                if (top.length === 0) topText += 'Пока никто не играл.';
                await sendMessage(chatId, topText, { parse_mode: 'HTML' });
                return res.sendStatus(200);
            }

            // Команда /addstars – только для ADMIN_ID2
            if (text.startsWith('/addstars')) {
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

                if (String(chatId) !== String(ADMIN_ID2)) {
                    await sendMessage(chatId, 'У вас нет прав для выполнения этой команды.');
                    return res.sendStatus(200);
                }

                db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(targetUserId);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(amount, targetUserId);
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(targetUserId);
                await sendMessage(chatId, `✅ Пользователю ${targetUserId} начислено ${amount} ⭐. Текущий баланс: ${user.balance} ⭐`);
                return res.sendStatus(200);
            }

            // Команда /createpromo – только для ADMIN_ID2
            if (text.startsWith('/createpromo')) {
                const parts = text.split(' ');
                if (parts.length !== 3) {
                    await sendMessage(chatId, 'Используйте: /createpromo [код] [сумма]');
                    return res.sendStatus(200);
                }
                const code = parts[1].toUpperCase();
                const amount = parseInt(parts[2]);
                if (isNaN(amount) || amount < 1) {
                    await sendMessage(chatId, 'Неверная сумма. Пример: /createpromo SUPER 50');
                    return res.sendStatus(200);
                }
                if (String(chatId) !== String(ADMIN_ID2)) {
                    await sendMessage(chatId, 'У вас нет прав для создания промокодов.');
                    return res.sendStatus(200);
                }
                try {
                    db.prepare('INSERT INTO promocodes (code, amount, created_by) VALUES (?, ?, ?)').run(code, amount, chatId);
                    await sendMessage(chatId, `✅ Промокод ${code} на ${amount} ⭐ создан!`);
                } catch (err) {
                    await sendMessage(chatId, '❌ Ошибка: возможно, такой код уже существует.');
                }
                return res.sendStatus(200);
            }

            // Команда /activate – активация промокода
            if (text.startsWith('/activate')) {
                const parts = text.split(' ');
                if (parts.length !== 2) {
                    await sendMessage(chatId, 'Используйте: /activate [код]');
                    return res.sendStatus(200);
                }
                const code = parts[1].toUpperCase();
                const promo = db.prepare('SELECT * FROM promocodes WHERE code = ? AND used = 0').get(code);
                if (!promo) {
                    await sendMessage(chatId, '❌ Промокод не найден или уже использован.');
                    return res.sendStatus(200);
                }
                db.prepare('UPDATE promocodes SET used = 1 WHERE code = ?').run(code);
                db.prepare('INSERT OR IGNORE INTO users (telegram_id, balance) VALUES (?, 0)').run(chatId);
                db.prepare('UPDATE users SET balance = balance + ? WHERE telegram_id = ?').run(promo.amount, chatId);
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                await sendMessage(chatId, `🎉 Вы активировали промокод ${code} и получили ${promo.amount} ⭐! Ваш баланс: ${user.balance} ⭐`);
                return res.sendStatus(200);
            }

            const amount = parseInt(text);
            if (!isNaN(amount) && amount >= 1) {
                await createInvoice(chatId, amount);
            } else {
                await sendMessage(chatId, 'Используйте кнопки меню.');
            }
        }

        // Callback-запросы
        if (update.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const data = query.data;

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
                const user = db.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(chatId);
                if (!user || user.balance < amount) {
                    await sendMessage(chatId, 'Недостаточно звёзд для вывода.');
                } else {
                    db.prepare('INSERT INTO withdrawals (telegram_id, amount) VALUES (?, ?)').run(chatId, amount);
                    db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amount, chatId);
                    await sendMessage(chatId, `✅ Заявка на вывод ${amount} ⭐ создана. Ожидайте подтверждения.`);
                    if (ADMIN_ID) {
                        const username = query.from.username ? `@${query.from.username}` : query.from.first_name;
                        await sendMessage(
                            ADMIN_ID,
                            `📤 Новая заявка на вывод:\n` +
                            `Пользователь: ${username} (ID: ${chatId})\n` +
                            `Сумма: ${amount} ⭐\n` +
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
        console.error('Webhook ошибка:', e);
        res.sendStatus(500);
    }
});

// ---------- Вспомогательные функции ----------
async function sendMessage(chatId, text, extra = {}) {
    try {
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, ...extra })
        });
        const data = await response.json();
        if (!data.ok) {
            console.error('Ошибка отправки:', data);
        }
    } catch (err) {
        console.error('sendMessage ошибка:', err);
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
        console.error('answerCallbackQuery ошибка:', err);
    }
}

async function showProfile(chatId) {
    const user = db.prepare('SELECT balance, level, xp, xp_next, referrals_count, referrer_id FROM users WHERE telegram_id = ?').get(chatId);
    const balance = user ? user.balance : 0;
    const level = user ? user.level : 1;
    const xp = user ? user.xp : 0;
    const xpNext = user ? user.xp_next : 100;
    const refCount = user ? user.referrals_count : 0;

    const text = `👤 <b>Ваш профиль:</b>\n\n` +
                 `⭐ Баланс: ${balance}\n` +
                 `🎚 Уровень: ${level}\n` +
                 `🔹 Опыт: ${xp}/${xpNext}\n` +
                 `👥 Рефералов: ${refCount}\n` +
                 `💰 Бонус за реферала: 30% от пополнения`;

    await sendMessage(chatId, text, {
        parse_mode: 'HTML',
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
        if (data.ok) {
            await sendMessage(chatId, `Счёт на ${amount} ⭐ готов:\n[Оплатить](${data.result})`, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } else {
            console.error('Ошибка создания счёта:', data);
            await sendMessage(chatId, 'Ошибка создания счёта. Попробуйте позже.');
        }
    } catch (err) {
        console.error('createInvoice ошибка:', err);
    }
}

// ---------- Запуск ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Бэкенд запущен на порту ${PORT}`));
