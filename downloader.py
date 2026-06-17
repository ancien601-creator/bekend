import os
import uuid
import subprocess
import yt_dlp

DOWNLOAD_DIR = "downloads"
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# Жесткий лимит Telegram Bot API (50 МБ)
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
    Скачивает видео с YouTube/TikTok. 
    Автоматически подбирает разрешение под длительность и сжимает файл,
    если он превышает лимит в 50 МБ.
    """
    out_template = os.path.join(DOWNLOAD_DIR, f"{uuid.uuid4()}.%(ext)s")
    
    # Очистка куки от BOM-маркеров Windows
    cookies_source = "cookies.txt"
    cookies_cleaned = os.path.join(DOWNLOAD_DIR, "clean_cookies.txt")
    
    if os.path.exists(cookies_source):
        with open(cookies_source, "r", encoding="utf-8-sig", errors="ignore") as f:
            content = f.read()
        cleaned_content = content.lstrip()
        with open(cookies_cleaned, "w", encoding="utf-8") as f:
            f.write(cleaned_content)
    else:
        cookies_cleaned = cookies_source

    # --- ШАГ 1: Быстрый запрос информации о видео (без скачивания) ---
    meta_opts = {
        "quiet": True,
        "no_warnings": True,
        "cookiefile": cookies_cleaned
    }
    
    with yt_dlp.YoutubeDL(meta_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        duration = info.get("duration", 0)  # Длительность в секундах

    # --- ШАГ 2: Динамический подбор формата под длину видео ---
    if duration == 0:
        # Если длину не определить (стрим или TikTok), берем стандартное лучшее
        fmt = "bestvideo+bestaudio/best"
    elif duration <= 180:
        # До 3 минут — качаем в максимальном качестве (1080p и выше)
        fmt = "bestvideo+bestaudio/best"
    elif duration <= 600:
        # До 10 минут — ограничиваем до 720p
        fmt = "bestvideo[height<=720]+bestaudio/best[height<=720]/best"
    elif duration <= 1800:
        # До 30 минут — ограничиваем до 480p
        fmt = "bestvideo[height<=480]+bestaudio/best[height<=480]/best"
    else:
        # Больше 30 минут — жмем до 360p, чтобы точно влезть
        fmt = "bestvideo[height<=360]+bestaudio/best[height<=360]/best"

    ydl_opts = {
        "outtmpl": out_template,
        "format": fmt,
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "cookiefile": cookies_cleaned
    }

    # --- ШАГ 3: Скачивание файла ---
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        filename = ydl.prepare_filename(info)

        # Проверка расширения после склейки в mp4
        if not os.path.exists(filename):
            base, _ = os.path.splitext(filename)
            for ext in (".mp4", ".webm", ".mkv", ".3gp"):
                candidate = base + ext
                if os.path.exists(candidate):
                    filename = candidate
                    break

        if not os.path.exists(filename):
            raise FileNotFoundError("Не вдалося знайти завантажений файл")

        # --- ШАГ 4: Подстраховка через FFmpeg (если файл всё равно > 50MB) ---
        if os.path.getsize(filename) > MAX_FILESIZE:
            if duration > 0:
                compressed_filename = os.path.join(DOWNLOAD_DIR, f"compressed_{uuid.uuid4()}.mp4")
                
                # Таргет — вписать видео примерно в 45 МБ (с запасом)
                # Формула битрейта: (Размер в битах) / длительность
                target_size_bits = 45 * 1024 * 1024 * 8
                target_bitrate = int(target_size_bits / duration)
                
                # Нижний порог битрейта, чтобы видео не превратилось в пиксельное месиво
                if target_bitrate < 150000:
                    target_bitrate = 150000

                # Команда для ультрабыстрого пережатия видеосигнала
                cmd = [
                    "ffmpeg", "-y", "-i", filename,
                    "-b:v", str(target_bitrate),
                    "-maxrate", str(target_bitrate),
                    "-bufsize", str(target_bitrate * 2),
                    "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", "-b:a", "128k",
                    compressed_filename
                ]
                
                try:
                    # Запуск сжатия в фоновом режиме
                    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    os.remove(filename)  # Удаляем тяжелый оригинал
                    filename = compressed_filename
                except Exception:
                    # Если сжатие упало, проверяем оригинал и действуем по ситуации
                    if os.path.getsize(filename) > MAX_FILESIZE:
                        os.remove(filename)
                        raise ValueError("Відео занадто велике, і його не вдалося стиснути.")
            else:
                os.remove(filename)
                raise ValueError("Відео занадто велике для Telegram (більше 50 МБ).")

        return filename
                
