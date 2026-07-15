from fastapi import FastAPI, HTTPException, Query
from fastapi_utils.tasks import repeat_every
from fastapi.middleware.cors import CORSMiddleware
from models import async_session, User, Transaction, RateHistory, AdminSettings
from sqlalchemy import select, func
import random
import datetime
from typing import Optional

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"])

# ---------- Утилиты ----------
async def get_user(user_id: int) -> User:
    async with async_session() as session:
        result = await session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            # авто-регистрация
            user = User(id=user_id, balance=0, registered_at=datetime.datetime.now())
            session.add(user)
            await session.commit()
        return user

# ---------- Рынок ----------
@app.get("/api/market")
async def market_data(period: str = "24h"):
    """Возвращает текущий курс и историю для графика."""
    now = datetime.datetime.utcnow()
    # Определяем диапазон
    if period == "24h":
        delta = datetime.timedelta(hours=24)
        interval_min = 15
    elif period == "7d":
        delta = datetime.timedelta(days=7)
        interval_min = 60
    elif period == "30d":
        delta = datetime.timedelta(days=30)
        interval_min = 240
    else:
        raise HTTPException(400, "Invalid period")

    since = now - delta

    async with async_session() as session:
        # Выбираем записи из rate_history
        result = await session.execute(
            select(RateHistory)
            .where(RateHistory.timestamp >= since)
            .order_by(RateHistory.timestamp.asc())
        )
        history = result.scalars().all()

        if not history:
            # Если данных нет — вернуть плоскую линию с текущим курсом (из настроек или 7.00)
            result = await session.execute(select(AdminSettings).where(AdminSettings.key == "current_rate"))
            current_rate = float(result.scalar_one_or_none().value) if result else 7.00
            points = [{"timestamp": (now - datetime.timedelta(hours=i)).isoformat(), "rate": current_rate} for i in range(24)]
            return {
                "current_rate": current_rate,
                "change_percent": 0,
                "min_rate": current_rate,
                "max_rate": current_rate,
                "volume": 0,
                "points": points
            }

        points = [{"timestamp": h.timestamp.isoformat(), "rate": h.rate} for h in history]
        current = points[-1]["rate"]
        change = ((current - points[0]["rate"]) / points[0]["rate"]) * 100 if points[0]["rate"] != 0 else 0
        min_rate = min(p["rate"] for p in points)
        max_rate = max(p["rate"] for p in points)
        volume = sum(h.volume_24h for h in history)  # суммарный объём за период

    return {
        "current_rate": round(current, 2),
        "change_percent": round(change, 2),
        "min_rate": round(min_rate, 2),
        "max_rate": round(max_rate, 2),
        "volume": volume,
        "points": points
    }

# ---------- Кошелёк пользователя ----------
@app.get("/api/user/dashboard")
async def user_dashboard(user_id: int = Query(...), period: str = "7d"):
    user = await get_user(user_id)
    now = datetime.datetime.utcnow()
    since = now - datetime.timedelta(days=7)

    async with async_session() as session:
        # Получаем все транзакции пользователя за период (для построения графика баланса)
        tx_result = await session.execute(
            select(Transaction)
            .where(Transaction.user_id == user.id, Transaction.timestamp >= since)
            .order_by(Transaction.timestamp.asc())
        )
        transactions = tx_result.scalars().all()

        # Строим точки графика: начальный баланс на начало периода и все изменения
        # Вычисляем баланс на начало периода (баланс сейчас минус сумма транзакций за период)
        total_change = sum(tx.amount if tx.type in ("purchase", "admin_add") else -tx.amount for tx in transactions)
        start_balance = user.balance - total_change

        points = [{"date": since.strftime("%Y-%m-%d"), "balance": start_balance}]
        running_balance = start_balance
        for tx in transactions:
            if tx.type in ("purchase", "admin_add"):
                running_balance += tx.amount
            else:
                running_balance -= tx.amount
            points.append({"date": tx.timestamp.strftime("%Y-%m-%d %H:%M"), "balance": running_balance})
        # Добавляем текущий момент
        points.append({"date": now.strftime("%Y-%m-%d %H:%M"), "balance": user.balance})

        # Последние 10 транзакций для списка
        recent_tx = transactions[-10:]
        tx_list = [{"type": tx.type, "amount": tx.amount, "timestamp": tx.timestamp.isoformat()} for tx in recent_tx]

    return {
        "current_balance": user.balance,
        "total_topped_up": user.total_purchased,
        "points": points,
        "transactions": tx_list
    }

# ---------- Профиль ----------
@app.get("/api/user/profile")
async def user_profile(user_id: int = Query(...)):
    user = await get_user(user_id)
    return {
        "id": user.id,
        "balance": user.balance,
        "total_purchased": user.total_purchased,
        "registered_at": user.registered_at.strftime("%d.%m.%Y") if user.registered_at else "неизвестно"
    }

# ---------- История операций ----------
@app.get("/api/user/history")
async def user_history(user_id: int = Query(...), limit: int = 50):
    async with async_session() as session:
        result = await session.execute(
            select(Transaction)
            .where(Transaction.user_id == user_id)
            .order_by(Transaction.timestamp.desc())
            .limit(limit)
        )
        transactions = result.scalars().all()
    return [{"type": tx.type, "amount": tx.amount, "timestamp": tx.timestamp.isoformat()} for tx in transactions]


@app.on_event("startup")
@repeat_every(seconds=60)  # раз в минуту
async def update_virtual_rate():
    """Пересчитывает виртуальный курс на основе объёма покупок за последний час."""
    async with async_session() as session:
        # Получаем сумму покупок (stars_amount) за последний час
        one_hour_ago = datetime.datetime.utcnow() - datetime.timedelta(hours=1)
        result = await session.execute(
            select(func.sum(Transaction.stars_amount))
            .where(Transaction.type == "purchase", Transaction.timestamp >= one_hour_ago)
        )
        volume_stars = result.scalar() or 0

        # Получаем текущий курс (если есть в настройках, иначе 7.00)
        settings_result = await session.execute(select(AdminSettings).where(AdminSettings.key == "current_rate"))
        setting = settings_result.scalar_one_or_none()
        if setting and setting.value:
            current_rate = float(setting.value)
        else:
            current_rate = 7.00

        # Формула изменения: если объём > порога (например 500 Stars) – курс растёт, иначе падает
        threshold = 500
        noise = random.uniform(-0.02, 0.02)
        if volume_stars > threshold:
            change = 0.01 + noise
        else:
            change = -0.005 + noise

        new_rate = round(current_rate + change, 4)
        # Ограничиваем колебания
        new_rate = max(5.0, min(9.0, new_rate))

        # Сохраняем в настройках и в историю
        new_setting = AdminSettings(key="current_rate", value=str(new_rate))
        await session.merge(new_setting)
        history = RateHistory(rate=new_rate, volume_24h=volume_stars)
        session.add(history)
        await session.commit()
      
# ---------- Проверка статуса покупок ----------
@app.get("/api/settings/buying")
async def get_buying_status():
    async with async_session() as session:
        result = await session.execute(select(AdminSettings).where(AdminSettings.key == "buying_enabled"))
        row = result.scalar_one_or_none()
        buying_enabled = row.value == "true" if row else True
    return {"buying_enabled": buying_enabled}

# ---------- Админские методы ----------
ADMIN_KEY = "supersecretkey"  # в .env

@app.post("/api/admin/rate")
async def set_rate(rate: float, admin_key: str):
    if admin_key != ADMIN_KEY:
        raise HTTPException(403, "Forbidden")
    async with async_session() as session:
        # Сохраняем в настройках и добавляем запись в историю
        setting = AdminSettings(key="current_rate", value=str(rate))
        await session.merge(setting)
        history = RateHistory(rate=rate, volume_24h=0)
        session.add(history)
        await session.commit()
    return {"status": "ok", "rate": rate}

@app.post("/api/admin/toggle_buy")
async def toggle_buy(admin_key: str):
    if admin_key != ADMIN_KEY:
        raise HTTPException(403, "Forbidden")
    async with async_session() as session:
        result = await session.execute(select(AdminSettings).where(AdminSettings.key == "buying_enabled"))
        row = result.scalar_one_or_none()
        current = row.value == "true" if row else True
        new_value = "false" if current else "true"
        setting = AdminSettings(key="buying_enabled", value=new_value)
        await session.merge(setting)
        await session.commit()
    return {"buying_enabled": not current}

# Дополнительно: эндпоинт для начисления/списания монет (можно использовать из админки бота)
