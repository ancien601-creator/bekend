import os
import uuid
import yt_dlp

DOWNLOAD_DIR = "downloads"
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# Telegram Bot API limit for files sent via bot is 50MB
MAX_FILESIZE = 50 * 1024 * 1024


def is_supported_url(url: str) -> bool:
    """Проверяет, поддерживает ли бот ссылку."""
    url = url.lower()
    return any(domain in url for domain in (
        "tiktok.com",
        "youtube.com",
        "youtu.be",
    ))


def download_video(url: str) -> str:
    """
    Downloads a video from TikTok/YouTube and returns the local file path.
    Raises an exception if the download fails or the file is too large.
    """
    out_template = os.path.join(DOWNLOAD_DIR, f"{uuid.uuid4()}.%(ext)s")

    ydl_opts = {
        "outtmpl": out_template,
        
        # 🛠 Умный поиск: если нет целого файла, качаем видео и звук отдельно и клеим (ffmpeg поможет)
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        
        # 🍪 Куки для обхода защиты от ботов
        "cookiefile": "cookies.txt"
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        filename = ydl.prepare_filename(info)

        # Проверяем расширение после склейки
        if not os.path.exists(filename):
            base, _ = os.path.splitext(filename)
            for ext in (".mp4", ".webm", ".mkv", ".3gp"):
                candidate = base + ext
                if os.path.exists(candidate):
                    filename = candidate
                    break

        if not os.path.exists(filename):
            raise FileNotFoundError("Не вдалося знайти завантажений файл")

        # Проверка размера
        if os.path.getsize(filename) > MAX_FILESIZE:
            os.remove(filename)  # Удаляем слишком большой файл
            raise ValueError("Відео занадто велике для Telegram (більше 50 МБ).")

        return filename
        
