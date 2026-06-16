import logging
import os
import math
import subprocess

from telegram import Update, LabeledPrice
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    PreCheckoutQueryHandler,
    ContextTypes,
    filters,
)

from db import (
    init_db,
    get_or_create_user,
    get_free_left,
    decrement_free,
    set_pending_url,
    get_pending_url,
    clear_pending_url,
    FREE_DOWNLOADS_DEFAULT,
)
from downloader import is_supported_url, download_video, MAX_FILESIZE

# Bot token: set as env variable BOT_TOKEN, or paste it directly here
BOT_TOKEN = os.environ.get("BOT_TOKEN")

PRICE_STARS = 1  # price per video after free downloads run out

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    get_or_create_user(user_id)
    free_left = get_free_left(user_id)
    await update.message.reply_text(
        "👋 Привет! Я бот для скачивания видео из TikTok и YouTube.\n\n"
        "🎬 Как я работаю:\n"
        "1. Ты присылаешь мне ссылку на видео из TikTok или YouTube\n"
        "2. Я скачиваю его без водяных знаков и лишней рекламы\n"
        "3. Отправляю готовое видео прямо тебе в чат\n\n"
        f"🎁 У тебя есть {free_left} бесплатных скачиваний.\n"
        f"После того как они закончатся, каждое следующее видео будет стоить "
        f"{PRICE_STARS} ⭐ (Telegram Stars).\n\n"
        "Просто отправь ссылку — и я всё сделаю сам 🚀"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    get_or_create_user(user_id)
    free_left = get_free_left(user_id)
    await update.message.reply_text(
        "ℹ️ О боте\n\n"
        "Я умею скачивать видео из TikTok и YouTube по ссылке — без водяных "
        "знаков, без рекламы и без необходимости заходить в приложение.\n\n"
        "📌 Как пользоваться:\n"
        "— Скопируй ссылку на видео из TikTok или YouTube\n"
        "— Отправь её мне в чат\n"
        "— Дождись, пока я скачаю и пришлю готовый файл\n\n"
        f"💰 Тариф: {FREE_DOWNLOADS_DEFAULT} первых скачиваний — бесплатно, "
        f"далее {PRICE_STARS} ⭐ за каждое видео.\n"
        f"Осталось бесплатных скачиваний: {free_left}\n\n"
        "⚠️ Ограничение: видео не должно превышать 50MB."
    )


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (update.message.text or "").strip()
    user_id = update.effective_user.id
    get_or_create_user(user_id)

    if not is_supported_url(text):
        await update.message.reply_text(
            "Пожалуйста, отправь корректную ссылку на видео из TikTok или YouTube."
        )
        return

    free_left = get_free_left(user_id)

    if free_left > 0:
        ok = await process_download(update, context, text)
        if ok:
            decrement_free(user_id)
            remaining = free_left - 1
            if remaining > 0:
                await update.message.reply_text(
                    f"Осталось бесплатных скачиваний: {remaining}"
                )
            else:
                await update.message.reply_text(
                    "Бесплатные скачивания закончились. "
                    f"Следующие видео будут стоить {PRICE_STARS} ⭐."
                )
    else:
        # Save the URL so we can download it after successful payment
        set_pending_url(user_id, text)
        await update.message.reply_invoice(
            title="Скачивание видео",
            description="Оплата за скачивание одного видео из TikTok/YouTube",
            payload=f"video_download_{user_id}",
            provider_token="",  # empty string is required for Telegram Stars
            currency="XTR",
            prices=[LabeledPrice("Скачивание видео", PRICE_STARS)],
        )


async def precheckout_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.pre_checkout_query
    await query.answer(ok=True)


async def successful_payment_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    url = get_pending_url(user_id)

    if not url:
        await update.message.reply_text(
            "Спасибо за оплату! Пожалуйста, отправь ссылку на видео ещё раз."
        )
        return

    await update.message.reply_text("Спасибо за оплату ⭐! Скачиваю видео...")
    await process_download(update, context, url)
    clear_pending_url(user_id)


def split_video(filepath: str, max_size_bytes: int) -> list[str]:
    """Разрезает видео на части, если оно превышает лимит. Использует FFmpeg."""
    total_size = os.path.getsize(filepath)

    # Получаем длительность видео с помощью ffprobe
    cmd_probe = [
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', filepath
    ]
    probe_result = subprocess.run(cmd_probe, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
    total_duration = float(probe_result.stdout.strip())

    # Считаем, на сколько частей нужно разбить
    num_parts = math.ceil(total_size / max_size_bytes)
    part_duration = total_duration / num_parts

    base, ext = os.path.splitext(filepath)
    output_pattern = f"{base}_part_%03d{ext}"

    # Команда для быстрой нарезки без потери качества (-c copy)
    cmd_split = [
        'ffmpeg', '-y', '-i', filepath,
        '-c', 'copy',
        '-f', 'segment',
        '-segment_time', str(part_duration),
        '-reset_timestamps', '1',
        output_pattern
    ]
    subprocess.run(cmd_split, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

    # Собираем пути к созданным частям
    dir_name = os.path.dirname(filepath) or '.'
    prefix = os.path.basename(base) + "_part_"
    parts = [
        os.path.join(dir_name, f)
        for f in os.listdir(dir_name)
        if f.startswith(prefix) and f.endswith(ext)
    ]
    return sorted(parts)


async def process_download(update: Update, context: ContextTypes.DEFAULT_TYPE, url: str) -> bool:
    """Downloads the video and sends it to the user. Splits if too large."""
    chat_id = update.effective_chat.id
    status_msg = await update.message.reply_text("⏳ Скачиваю видео, подожди немного...")

    filepath = None
    video_parts = []
    try:
        filepath = download_video(url)
        file_size = os.path.getsize(filepath)

        # Если файл больше лимита (50MB)
        if file_size > MAX_FILESIZE:
            await status_msg.edit_text("🎬 Видео больше 50 МБ. Нарезаю на части, подожди...")

            # Берем 48 МБ с запасом, чтобы Telegram точно пропустил
            safe_limit = 48 * 1024 * 1024
            video_parts = split_video(filepath, safe_limit)

            if not video_parts:
                await status_msg.edit_text("❌ Не удалось разделить видео на части.")
                return False

            await status_msg.edit_text(f"📦 Отправляю видео по частям (всего частей: {len(video_parts)})...")

            for i, part_path in enumerate(video_parts):
                with open(part_path, "rb") as f:
                    await context.bot.send_video(
                        chat_id=chat_id,
                        video=f,
                        supports_streaming=True,
                        caption=f"Часть {i + 1} из {len(video_parts)}"
                    )

            await status_msg.delete()
            return True

        # Если файл маленький, отправляем как обычно
        else:
            with open(filepath, "rb") as f:
                await context.bot.send_video(
                    chat_id=chat_id,
                    video=f,
                    supports_streaming=True,
                )
            await status_msg.delete()
            return True

    except FileNotFoundError:
        logger.exception("FFmpeg missing")
        await status_msg.edit_text("❌ Ошибка: На сервере не установлен или не настроен FFmpeg для нарезки видео.")
        return False
    except Exception as e:
        logger.exception("Download/send error")
        await status_msg.edit_text(f"❌ Не удалось скачать или отправить видео: {e}")
        return False

    finally:
        # Удаляем оригинальный файл
        if filepath and os.path.exists(filepath):
            os.remove(filepath)
        # Удаляем нарезанные части, если они остались
        for part_path in video_parts:
            if os.path.exists(part_path):
                os.remove(part_path)


def main():
    init_db()

    


    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(PreCheckoutQueryHandler(precheckout_callback))
    app.add_handler(MessageHandler(filters.SUCCESSFUL_PAYMENT, successful_payment_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Bot started")
    app.run_polling()


if __name__ == "__main__":
    main()
