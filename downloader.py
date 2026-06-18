import os
import uuid
import subprocess
import logging
import yt_dlp

logger = logging.getLogger(__name__)

DOWNLOAD_DIR = "downloads"
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

MAX_FILESIZE = 50 * 1024 * 1024


def is_supported_url(url: str) -> bool:
    url = url.lower()
    return any(domain in url for domain in ("tiktok.com", "youtube.com", "youtu.be"))


def download_video(url: str) -> str:
    out_template = os.path.join(DOWNLOAD_DIR, f"{uuid.uuid4()}.%(ext)s")
    
    cookies_source = "cookies.txt"
    cookies_cleaned = os.path.join(DOWNLOAD_DIR, "clean_cookies.txt")
    
    if os.path.exists(cookies_source):
        logger.info(f"[COOKIES] Файл {cookies_source} НАЙДЕН. Очищаем от BOM...")
        with open(cookies_source, "r", encoding="utf-8-sig", errors="ignore") as f:
            content = f.read()
        cleaned_content = content.lstrip()
        with open(cookies_cleaned, "w", encoding="utf-8") as f:
            f.write(cleaned_content)
    else:
        logger.warning("[COOKIES] Файл cookies.txt отсутствует, пробуем без него.")
        cookies_cleaned = None

    # Базовые настройки маскировки под мобильное устройство
    base_opts = {
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "http_headers": {
            "User-Agent": "com.google.android.youtube/19.21.34 (Linux; U; Android 14; gda Build/UQ1A.240205.002) gzip",
            "Accept-Language": "en-US,en;q=0.9",
        }
    }

    # Меняем тактику: используем клиенты с самой слабой проверкой IP дата-центров
    strategies = [
        # 1. Android клиент + Куки (самый высокий шанс пробить бан IP)
        {
            "format": "best",
            "cookiefile": cookies_cleaned,
            "extractor_args": {"youtube": {"player_client": ["android"]}}
        },
        # 2. Web Embedded (имитация плеера, встроенного в сторонний сайт)
        {
            "format": "best",
            "cookiefile": cookies_cleaned,
            "extractor_args": {"youtube": {"player_client": ["web_embedded"]}}
        },
        # 3. IOS клиент (как резерв)
        {
            "format": "best",
            "cookiefile": cookies_cleaned,
            "extractor_args": {"youtube": {"player_client": ["ios"]}}
        },
        # 4. Чистый Android без кук (если куки заблокированы из-за геолокации)
        {
            "format": "best",
            "extractor_args": {"youtube": {"player_client": ["android"]}}
        }
    ]

    filename = None
    download_info = None
    last_error = None

    for i, strat in enumerate(strategies, start=1):
        if "cookiefile" in strat and not cookies_cleaned:
            continue
            
        opts = {**base_opts, **strat}
        try:
            logger.info(f"[DOWNLOAD] Пробуем стратегию обхода №{i} ({strat['extractor_args']['youtube']['player_client']})...")
            with yt_dlp.YoutubeDL(opts) as ydl:
                download_info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(download_info)
                
                if filename and not os.path.exists(filename):
                    base, _ = os.path.splitext(filename)
                    for ext in (".mp4", ".webm", ".mkv", ".3gp"):
                        candidate = base + ext
                        if os.path.exists(candidate):
                            filename = candidate
                            break
                            
                if filename and os.path.exists(filename):
                    logger.info(f"[DOWNLOAD] Успешно скачано стратегией №{i}")
                    break
        except Exception as e:
            logger.warning(f"[DOWNLOAD] Стратегия №{i} провалилась: {e}")
            last_error = e
            continue

    if not filename or not os.path.exists(filename):
        raise last_error or FileNotFoundError("YouTube полностью заблокировал доступ к потокам видео.")

    duration = download_info.get("duration", 0) if download_info else 0

    if os.path.getsize(filename) > MAX_FILESIZE:
        if duration > 0:
            compressed_filename = os.path.join(DOWNLOAD_DIR, f"compressed_{uuid.uuid4()}.mp4")
            target_size_bits = 46 * 1024 * 1024 * 8
            target_bitrate = int(target_size_bits / duration)
            
            audio_bitrate = 64000
            video_bitrate = target_bitrate - audio_bitrate
            if video_bitrate < 150000:
                video_bitrate = 150000

            cmd = [
                "ffmpeg", "-y", "-i", filename,
                "-b:v", str(video_bitrate),
                "-c:v", "libx264", "-preset", "veryfast",
                "-c:a", "aac", "-b:a", "64k",
                compressed_filename
            ]
            
            try:
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                os.remove(filename)
                filename = compressed_filename
            except Exception:
                if os.path.getsize(filename) > MAX_FILESIZE:
                    os.remove(filename)
                    raise ValueError("Файл слишком большой для Telegram.")
        else:
            os.remove(filename)
            raise ValueError("Файл слишком большой, длина неизвестна.")

    return filename
