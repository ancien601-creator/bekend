import os
import uuid
import subprocess
import yt_dlp

DOWNLOAD_DIR = "downloads"
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# Лимит Telegram Bot API (50 МБ)
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
    Скачивает видео, используя каскад из 4 стратегий обхода блокировок YouTube.
    Задействует Smart-TV клиенты для обхода JS-челленджей (n-challenge).
    """
    out_template = os.path.join(DOWNLOAD_DIR, f"{uuid.uuid4()}.%(ext)s")
    
    # Очистка куки от BOM-маркеров
    cookies_source = "cookies.txt"
    cookies_cleaned = os.path.join(DOWNLOAD_DIR, "clean_cookies.txt")
    
    if os.path.exists(cookies_source):
        with open(cookies_source, "r", encoding="utf-8-sig", errors="ignore") as f:
            content = f.read()
        cleaned_content = content.lstrip()
        with open(cookies_cleaned, "w", encoding="utf-8") as f:
            f.write(cleaned_content)
    else:
        cookies_cleaned = None

    # Базовые неизменяемые настройки для всех попыток
    base_opts = {
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 2,
    }

    # Каскад стратегий от идеальной к аварийной
    strategies = [
        # Стратегия 1: Максимальное качество (1080p/720p) через Android/Web с куками
        {
            "format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
            "merge_output_format": "mp4",
            "cookiefile": cookies_cleaned,
            "extractor_args": {"youtube": {"player_client": ["android", "web"]}}
        },
        # Стратегия 2: Обход JS-челленджа через Smart-TV (720p) с куками
        {
            "format": "bestvideo[height<=720]+bestaudio/best",
            "merge_output_format": "mp4",
            "cookiefile": cookies_cleaned,
            "extractor_args": {"youtube": {"player_client": ["tv_downgraded", "android_embedded"]}}
        },
        # Стратегия 3: ТВ-клиент БЕЗ кук (на случай, если куки забанены Ютубом)
        {
            "format": "bestvideo[height<=720]+bestaudio/best",
            "merge_output_format": "mp4",
            "extractor_args": {"youtube": {"player_client": ["tv_downgraded", "android_embedded"]}}
        },
        # Стратегия 4: Жесткий аварийный режим — забираем любой цельный готовый поток
        {
            "format": "best",
            "extractor_args": {"youtube": {"player_client": ["tv"]}}
        }
    ]

    filename = None
    download_info = None
    last_error = None

    # Перебираем стратегии, пока одна из них не сработает
    for i, strat in enumerate(strategies, start=1):
        # Если стратегия требует куки, а файла cookies.txt нет — пропускаем её
        if "cookiefile" in strat and not cookies_cleaned:
            continue
            
        opts = {**base_opts, **strat}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                download_info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(download_info)
                
                # Защитная проверка расширений файла на диске
                if filename and not os.path.exists(filename):
                    base, _ = os.path.splitext(filename)
                    for ext in (".mp4", ".webm", ".mkv", ".3gp"):
                        candidate = base + ext
                        if os.path.exists(candidate):
                            filename = candidate
                            break
                            
                if filename and os.path.exists(filename):
                    break  # Успешно скачали, выходим из цикла стратегий!
        except Exception as e:
            last_error = e
            continue

    # Если ни одна стратегия не помогла — выбрасываем ошибку наружу
    if not filename or not os.path.exists(filename):
        raise last_error or FileNotFoundError("Ютуб заблокировал все доступные методы обхода.")

    # Получаем длительность для последующего сжатия
    duration = download_info.get("duration", 0) if download_info else 0

    # --- ШАГ 4: Умное сжатие через FFmpeg (только если файл > 50MB) ---
    if os.path.getsize(filename) > MAX_FILESIZE:
        if duration > 0:
            compressed_filename = os.path.join(DOWNLOAD_DIR, f"compressed_{uuid.uuid4()}.mp4")
            target_size_bits = 46 * 1024 * 1024 * 8
            target_bitrate = int(target_size_bits / duration)
            
            audio_bitrate = 128000
            video_bitrate = target_bitrate - audio_bitrate
            
            if video_bitrate < 150000:
                video_bitrate = 150000

            cmd = [
                "ffmpeg", "-y", "-i", filename,
                "-b:v", str(video_bitrate),
                "-maxrate", str(int(video_bitrate * 1.2)),
                "-bufsize", str(int(video_bitrate * 2)),
                "-c:v", "libx264", "-preset", "veryfast",
                "-c:a", "aac", "-b:a", "128k",
                compressed_filename
            ]
            
            try:
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                os.remove(filename)
                filename = compressed_filename
            except Exception:
                if os.path.getsize(filename) > MAX_FILESIZE:
                    os.remove(filename)
                    raise ValueError("Не вдалося стиснути відео під лимит Telegram.")
        else:
            os.remove(filename)
            raise ValueError("Відео занадто велике (>50 МБ), не вдалося визначити тривалість.")

    return filename
