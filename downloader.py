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
    Скачивает видео в высоком качестве, а если YouTube блокирует форматы —
    автоматически переключается на аварийный iOS-клиент.
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
        cookies_cleaned = cookies_source

    # Стандартная маскировка под Android/Web
    client_spoofing = {"youtube": {"player_client": ["android", "web"]}}

    # --- ШАГ 1: Попытка узнать длительность ---
    duration = 0
    meta_opts = {
        "quiet": True,
        "no_warnings": True,
        "cookiefile": cookies_cleaned,
        "extractor_args": client_spoofing
    }
    
    try:
        with yt_dlp.YoutubeDL(meta_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            duration = info.get("duration", 0)
    except Exception:
        duration = 0

    # --- ШАГ 2: Выбор целевого формата ---
    if duration == 0:
        fmt = "bestvideo[height<=720]+bestaudio/best[height<=720]/best"
    elif duration <= 600:
        fmt = "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"
    elif duration <= 1800:
        fmt = "bestvideo[height<=720]+bestaudio/best[height<=720]/best"
    else:
        fmt = "bestvideo[height<=480]+bestaudio/best[height<=480]/best"

    ydl_opts = {
        "outtmpl": out_template,
        "format": fmt,
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 3,
        "cookiefile": cookies_cleaned,
        "extractor_args": client_spoofing
    }

    filename = None
    download_info = None

    # --- ШАГ 3: Скачивание файла с защитой от блокировок ---
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            download_info = ydl.extract_info(url, download=True)
            filename = ydl.prepare_filename(download_info)
    except Exception as original_error:
        # АВАРflag_РЕЖИМ: Если YouTube заблокировал сложные форматы (SABR/PO-Token блок),
        # мы переключаемся на iOS-клиент и просим любой готовый цельный поток (best).
        try:
            emergency_opts = {
                "outtmpl": out_template,
                "format": "best", 
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
                "retries": 2,
                "cookiefile": cookies_cleaned,
                "extractor_args": {"youtube": {"player_client": ["ios"]}}
            }
            with yt_dlp.YoutubeDL(emergency_opts) as ydl:
                download_info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(download_info)
        except Exception:
            # Если даже iOS-клиент не помог, пробрасываем базовую ошибку дальше
            raise original_error

    # Проверка и подстраховка по расширениям файла
    if filename and not os.path.exists(filename):
        base, _ = os.path.splitext(filename)
        for ext in (".mp4", ".webm", ".mkv", ".3gp"):
            candidate = base + ext
            if os.path.exists(candidate):
                filename = candidate
                break

    if not filename or not os.path.exists(filename):
        raise FileNotFoundError("Не вдалося знайти завантажений файл")

    if duration == 0 and download_info:
        duration = download_info.get("duration", 0)

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
                    raise ValueError("Не вдалося стиснути відео під ліміт Telegram.")
        else:
            os.remove(filename)
            raise ValueError("Відео занадто велике (>50 МБ), і не вдалося визначити його тривалість для стиснення.")

    return filename
