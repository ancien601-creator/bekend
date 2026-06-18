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
    Скачивает видео в нормальном качестве (до 720p) с автоматическим
    каскадным перебором клиентов, если YouTube начинает капризничать.
    """
    out_template = os.path.join(DOWNLOAD_DIR, f"{uuid.uuid4()}.%(ext)s")
    
    # Очистка куки от BOM-маркеров (если файл cookies.txt добавлен)
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

    base_opts = {
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
    }

    # Возвращаем нормальный человеческий формат (до 720p)
    # Если 720р нет, он просто возьмет лучшее из доступных
    standard_fmt = "bestvideo[height<=720]+bestaudio/best[height<=720]/best"

    strategies = [
        # 1. Основная стратегия: Стандартный Android/Web (работает в 90% случаев)
        {
            "format": standard_fmt,
            "merge_output_format": "mp4",
            "cookiefile": cookies_cleaned,
            "extractor_args": {"youtube": {"player_client": ["android", "web"]}}
        },
        # 2. Аварийная стратегия: Переключение на iOS клиент (у него другие алгоритмы проверки)
        {
            "format": standard_fmt,
            "merge_output_format": "mp4",
            "cookiefile": cookies_cleaned,
            "extractor_args": {"youtube": {"player_client": ["ios"]}}
        },
        # 3. На крайний случай: ТВ-клиент, который вообще не проверяет JS-коды
        {
            "format": "best",
            "extractor_args": {"youtube": {"player_client": ["tv_downgraded"]}}
        }
    ]

    filename = None
    download_info = None
    last_error = None

    for strat in strategies:
        # Пропускаем стратегии с куками, если самого файла cookies.txt нет
        if "cookiefile" in strat and not cookies_cleaned:
            continue
            
        opts = {**base_opts, **strat}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                download_info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(download_info)
                
                # Проверка расширений файла на диске
                if filename and not os.path.exists(filename):
                    base, _ = os.path.splitext(filename)
                    for ext in (".mp4", ".webm", ".mkv", ".3gp"):
                        candidate = base + ext
                        if os.path.exists(candidate):
                            filename = candidate
                            break
                            
                if filename and os.path.exists(filename):
                    break
        except Exception as e:
            last_error = e
            continue

    if not filename or not os.path.exists(filename):
        raise last_error or FileNotFoundError("Не вдалося завантажити відео через жодну стратегию.")

    duration = download_info.get("duration", 0) if download_info else 0

    # Интеллектуальное сжатие через FFmpeg, если файл превысил 50 МБ
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
                    raise ValueError("Не вдалося стиснути відео під ліміт Telegram.")
        else:
            os.remove(filename)
            raise ValueError("Відео занадто велике, а его длительность неизвестна.")

    return filename
