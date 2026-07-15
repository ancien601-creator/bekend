import asyncio
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from aiogram import Bot, Dispatcher, types
from aiogram.types import Update
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
from aiohttp import web as aio_web

from models import init_db
from api import app as api_app  # импортируем наше FastAPI приложение

BOT_TOKEN = os.getenv("BOT_TOKEN")
RAILWAY_PUBLIC_DOMAIN = os.getenv("RAILWAY_PUBLIC_DOMAIN")
ADMIN_IDS = list(map(int, os.getenv("ADMIN_IDS", "").split(",")))
WEBAPP_URL = f"https://{RAILWAY_PUBLIC_DOMAIN}/webapp" if RAILWAY_PUBLIC_DOMAIN else "http://localhost:8000/webapp"

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# Импортируем хендлеры бота
from bot_handlers import register_handlers
register_handlers(dp, bot, ADMIN_IDS, WEBAPP_URL)

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    webhook_url = f"https://{RAILWAY_PUBLIC_DOMAIN}/webhook"
    await bot.set_webhook(webhook_url)
    # Запускаем фоновую задачу курса
    asyncio.create_task(periodic_rate_update())
    yield
    await bot.delete_webhook()

app = FastAPI(lifespan=lifespan)
app.mount("/webapp", StaticFiles(directory="webapp", html=True), name="webapp")

# Монтируем все эндпоинты из api.py
from api import app as api_router
app.mount("/api", api_router)

# Обработка вебхука Telegram
@app.post("/webhook")
async def telegram_webhook(update: dict):
    tele_update = Update(**update)
    await dp.feed_webhook_update(bot, tele_update)
    return {"ok": True}

# Фоновая задача (курс)
async def periodic_rate_update():
    # импорт внутри, чтобы избежать циклических зависимостей
    from api import periodic_rate_update as rate_update
    await rate_update()
