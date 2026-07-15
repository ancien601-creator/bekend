import asyncio
import os
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo, LabeledPrice, PreCheckoutQuery
from dotenv import load_dotenv
from models import init_db, async_session, User, Transaction, AdminSettings
from sqlalchemy import select

load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_IDS = [123456789]  # список админов
WEBAPP_URL = "https://yourdomain.com/webapp"

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# ------- Клавиатуры -------
def main_keyboard():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="💰 Кошелёк", web_app=WebAppInfo(url=f"{WEBAPP_URL}?tab=wallet"))],
        [InlineKeyboardButton(text="📈 Рынок", web_app=WebAppInfo(url=f"{WEBAPP_URL}?tab=market"))],
        [InlineKeyboardButton(text="🛒 Купить монеты", callback_data="buy_coins")],
        [InlineKeyboardButton(text="👤 Профиль", callback_data="profile")],
        [InlineKeyboardButton(text="📜 История", callback_data="history")],
        [InlineKeyboardButton(text="ℹ️ О проекте", callback_data="about")]
    ])

# ------- Старт -------
@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    async with async_session() as session:
        user = await session.get(User, message.from_user.id)
        if not user:
            user = User(id=message.from_user.id, balance=0, total_purchased=0)
            session.add(user)
            await session.commit()
    await message.answer("🚀 Добро пожаловать в Moneta Bot!\n"
                         "Здесь вы можете купить цифровые монеты и следить за их курсом.",
                         reply_markup=main_keyboard())

# ------- Покупка монет (через Stars) -------
@dp.callback_query(lambda c: c.data == "buy_coins")
async def buy_coins_prompt(callback: types.CallbackQuery):
    # Проверяем, разрешена ли покупка
    async with async_session() as session:
        setting = await session.get(AdminSettings, "buying_enabled")
        if setting and setting.value == "false":
            await callback.answer("⛔ Покупка монет временно отключена администратором.", show_alert=True)
            return
    await callback.message.answer("Введите количество монет (1 монета = 7 ⭐):")

@dp.message(lambda m: m.text.isdigit() and m.chat.type == "private")
async def process_coin_amount(message: types.Message):
    amount = int(message.text)
    if amount <= 0:
        return await message.answer("Введите положительное число.")
    # Создаём счёт
    prices = [LabeledPrice(label="Moneta Coin", amount=amount * 7)]
    await bot.send_invoice(
        chat_id=message.chat.id,
        title="Покупка Moneta",
        description=f"{amount} MONETA = {amount * 7} Telegram Stars",
        payload="buy_moneta",
        currency="XTR",
        prices=prices,
        provider_token=""  # для XTR не нужен
    )

@dp.pre_checkout_query()
async def process_pre_checkout(pre_checkout_query: PreCheckoutQuery):
    await pre_checkout_query.answer(ok=True)

@dp.message(content_types=types.ContentType.SUCCESSFUL_PAYMENT)
async def successful_payment(message: types.Message):
    payload = message.successful_payment.invoice_payload
    if payload == "buy_moneta":
        # Вычисляем количество монет (из total_amount)
        total_amount = message.successful_payment.total_amount  # в Stars (целое число)
        amount_moneta = total_amount // 7
        async with async_session() as session:
            user = await session.get(User, message.from_user.id)
            user.balance += amount_moneta
            user.total_purchased += total_amount
            # Запись транзакции
            tx = Transaction(user_id=user.id, type="purchase", amount=amount_moneta,
                             stars_amount=total_amount, price_at_moment=7.0)  # фиксированная цена
            session.add(tx)
            await session.commit()
        await message.answer(f"✅ Куплено {amount_moneta} MONETA! Ваш баланс: {user.balance}")

# ------- Профиль и история (заглушки) -------
@dp.callback_query(lambda c: c.data in ["profile", "history", "about"])
async def show_profile_history(callback: types.CallbackQuery):
    if callback.data == "profile":
        async with async_session() as session:
            user = await session.get(User, callback.from_user.id)
            text = f"👤 Профиль\nID: {user.id}\nМонет: {user.balance}\nКуплено всего: {user.total_purchased} ⭐\nДата регистрации: {user.registered_at.strftime('%d.%m.%Y')}"
    elif callback.data == "history":
        async with async_session() as session:
            txs = (await session.execute(
                select(Transaction).where(Transaction.user_id == callback.from_user.id).order_by(Transaction.timestamp.desc()).limit(10)
            )).scalars().all()
            text = "📜 Последние операции:\n" + "\n".join(
                f"{'🟢' if tx.type=='purchase' else '🔴'} {tx.amount} MON ({tx.stars_amount or 0} ⭐) – {tx.timestamp.strftime('%d.%m %H:%M')}"
                for tx in txs
            ) if txs else "Пока нет операций."
    else:
        text = "ℹ️ Moneta — цифровая валюта внутри Telegram."
    await callback.message.edit_text(text, reply_markup=main_keyboard())

# ------- Админ-панель -------
@dp.message(Command("admin"))
async def admin_panel(message: types.Message):
    if message.from_user.id not in ADMIN_IDS:
        return await message.answer("Нет доступа")
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📊 Статистика", callback_data="admin_stats")],
        [InlineKeyboardButton(text="🪙 Начислить/списать", callback_data="admin_balance")],
        [InlineKeyboardButton(text="📈 Управление курсом", callback_data="admin_rate")],
        [InlineKeyboardButton(text="✅ Вкл/выкл покупки", callback_data="admin_toggle_buy")],
    ])
    await message.answer("Админ-панель", reply_markup=kb)

@dp.callback_query(lambda c: c.data == "admin_toggle_buy")
async def admin_toggle_buy(callback: types.CallbackQuery):
    async with async_session() as session:
        setting = await session.get(AdminSettings, "buying_enabled")
        if setting is None:
            setting = AdminSettings(key="buying_enabled", value="true")
            session.add(setting)
        else:
            setting.value = "false" if setting.value == "true" else "true"
        await session.commit()
        status = "разрешена ✅" if setting.value == "true" else "запрещена ❌"
    await callback.message.edit_text(f"Покупка теперь {status}")
