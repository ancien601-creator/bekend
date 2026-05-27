const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;

app.get('/health', (req, res) => res.status(200).send('OK'));

app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        console.log('Update received:', JSON.stringify(update));

        if (update.message?.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text === '/start') {
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: 'Привет! Я работаю.',
                        reply_markup: {
                            keyboard: [
                                [{ text: '🎰 Играть' }],
                                [{ text: '👤 Профиль' }]
                            ],
                            resize_keyboard: true
                        }
                    })
                });
            } else {
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: 'Напишите /start'
                    })
                });
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('Error:', e);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Listening on port ${PORT}`));
