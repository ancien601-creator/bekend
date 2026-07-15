from sqlalchemy import Column, Integer, BigInteger, Float, String, DateTime, Boolean, func
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
import os

DATABASE_URL = "sqlite+aiosqlite:///./moneta.db"  # для продакшена заменить на postgresql+asyncpg://...

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(BigInteger, primary_key=True)           # Telegram user_id
    balance = Column(Integer, default=0)                # в монетах
    total_purchased = Column(Integer, default=0)        # всего куплено в Stars
    registered_at = Column(DateTime, default=func.now())
    is_admin = Column(Boolean, default=False)

class Transaction(Base):
    __tablename__ = "transactions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(BigInteger)
    type = Column(String)  # 'purchase', 'admin_add', 'admin_deduct'
    amount = Column(Integer)  # монет
    stars_amount = Column(Integer, nullable=True)  # сколько Stars заплачено (только для purchase)
    price_at_moment = Column(Float, nullable=True)
    timestamp = Column(DateTime, default=func.now())

class RateHistory(Base):
    __tablename__ = "rate_history"
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, default=func.now())
    rate = Column(Float)        # виртуальная цена
    volume_24h = Column(Integer, default=0)  # объём покупок за последние 24 часа

class AdminSettings(Base):
    __tablename__ = "admin_settings"
    key = Column(String, primary_key=True)
    value = Column(String)

# Асинхронный движок и сессия
engine = create_async_engine(DATABASE_URL, echo=False)
async_session = sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
