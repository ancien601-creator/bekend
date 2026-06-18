import os
import uuid
import subprocess
import logging
import yt_dlp

logger = logging.getLogger(__name__)

DOWNLOAD_DIR = "downloads"
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

MAX_FILESIZE = 50 * 1024 * 1024

# Полный объединенный список прокси (Webshare + Бесплатные публичные прокси)
PROXIES_LIST = [
    "http://uprgysua:kmbu4o3u05kx@31.59.20.176:6754/",
    "http://uprgysua:kmbu4o3u05kx@92.113.242.158:6742/",
    "http://uprgysua:kmbu4o3u05kx@38.154.203.95:5863/",
    "http://uprgysua:kmbu4o3u05kx@198.105.121.200:6462/",
    "http://uprgysua:kmbu4o3u05kx@64.137.96.74:6641/",
    "http://uprgysua:kmbu4o3u05kx@38.154.185.97:6370/",
    "http://uprgysua:kmbu4o3u05kx@142.111.67.146:5611/",
    "http://uprgysua:kmbu4o3u05kx@191.96.254.138:6185/",
    "http://uprgysua:kmbu4o3u05kx@23.229.19.94:8689/",
    "http://uprgysua:kmbu4o3u05kx@2.57.20.2:6983/",
    "socks5://188.68.205.126:1080",
    "socks5://46.150.102.26:1080",
    "socks5://193.239.26.142:9000",
    "socks5://110.235.246.62:1080",
    "socks4://181.204.39.202:53740",
    "socks4://217.197.151.182:5678",
    "socks5://144.91.83.39:9050",
    "socks5://46.161.4.153:4444",
    "socks4://23.133.196.12:9000",
    "socks4://195.2.92.202:1080",
    "socks5://89.19.215.248:1080",
    "socks5://130.49.171.75:1080",
    "socks4://149.104.68.53:1080",
    "socks5://150.129.115.253:6667",
    "http://35.209.198.222:80",
    "socks5://2.26.115.20:1080",
    "socks4://201.184.239.75:5678",
    "socks5://193.242.222.150:33500",
    "socks4://182.253.144.75:4153",
    "socks5://168.138.9.147:1080",
    "socks5://103.150.206.77:1080",
    "socks4://190.104.143.94:4153",
    "socks4://80.78.74.56:65530",
    "socks5://62.60.236.186:1080",
    "socks5://103.138.145.228:1999",
    "http://95.66.138.21:8880",
    "http://66.175.236.184:2080",
    "socks4://122.154.71.65:1080"
]

def is_supported_url(url: str) -> bool:
    url = url.lower()
    return any(domain in url for domain in ("tiktok.com", "youtube.com", "youtu.be"))

def download_video(url: str) -> str:
    out_template = os.path.join(DOWNLOAD_DIR, f"{uuid.uuid4()}.%(ext)s")
    url_lower = url.lower()
    
    # Обработка куки файлов
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
        cookies_cleaned = None

    base_opts = {
        "outtmpl": out_template,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "retries": 2,
        "format": "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
    }

    filename = None
    download_info = None
    last_error = None

    # Если это НЕ YouTube (например, TikTok), качаем напрямую без прокси
    if not any(domain in url_lower for domain in ("youtube.com", "youtu.be")):
        logger.info("[DIRECT] Ссылка не из YouTube. Качаем напрямую через Railway...")
        try:
            with yt_dlp.YoutubeDL(base_opts) as ydl:
                download_info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(download_info)
                if filename and os.path.exists(filename):
                    return finalize_video(filename, download_info)
        except Exception as e:
            raise e

    # Если YouTube, запускаем систему ротации прокси
    logger.info(f"[ROTATE] Начинаем перебор пула из {len(PROXIES_LIST)} прокси для YouTube.")
    
    strategies = [
        {"extractor_args": {"youtube": {"player_client": ["tv_downgraded"]}}},
        {"extractor_args": {"youtube": {"player_client": ["creator"]}}},
        {"cookiefile": cookies_cleaned, "extractor_args": {"youtube": {"player_client": ["android"]}}},
        {"cookiefile": cookies_cleaned, "extractor_args": {"youtube": {"player_client": ["web_embedded"]}}}
    ]

    proxy_success = False

    for p_idx, current_proxy in enumerate(PROXIES_LIST, start=1):
        masked_proxy = current_proxy.split("@")[-1]
        logger.info(f"[PROXY] Пробуем прокси №{p_idx}/{len(PROXIES_LIST)} ({masked_proxy})")
        
        base_opts["proxy"] = current_proxy
        
        for s_idx, strat in enumerate(strategies, start=1):
            if "cookiefile" in strat and not cookies_cleaned:
                continue
                
            opts = {**base_opts, **strat}
            client_name = strat["extractor_args"]["youtube"]["player_client"][0]
            
            try:
                logger.info(f"[DOWNLOAD] Прокси №{p_idx} -> Стратегия №{s_idx} ({client_name})...")
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
                        logger.info(f"[SUCCESS] Успешно скачано через Прокси №{p_idx} и Стратегию №{s_idx}")
                        proxy_success = True
                        break
            except Exception as e:
                err_msg = str(e)
                logger.warning(f"[FAIL] Прокси №{p_idx}, Стратегия №{s_idx} дала сбой: {err_msg}")
                last_error = e
                
                # Если прокси мертв (402, 407 или туннель не отвечает) — переходим к следующему IP
                if "402" in err_msg or "Tunnel connection failed" in err_msg or "407" in err_msg:
                    logger.error(f"[PROXY DEAD] Прокси №{p_idx} недоступен. Переходим к следующему IP...")
                    break
                continue
                
        if proxy_success:
            break

    if not filename or not os.path.exists(filename):
        raise last_error or FileNotFoundError("Все прокси из списка были отклонены YouTube (возможно, нерабочие).")

    return finalize_video(filename, download_info)

def finalize_video(filename: str, download_info: dict) -> str:
    """Проверка размера и сжатие видео через ffmpeg"""
    duration = download_info.get("duration", 0) if download_info else 0

    if os.path.getsize(filename) > MAX_FILESIZE:
        if duration > 0:
            logger.info("[COMPRESS] Файл превышает 50 МБ. Запускаем сжатие...")
            compressed_filename = os.path.join(DOWNLOAD_DIR, f"compressed_{uuid.uuid4()}.mp4")
            target_size_bits = 46 * 1024 * 1024 * 8
            target_bitrate = int(target_size_bits / duration)
            
            audio_bitrate = 64000
            video_bitrate = target_bitrate - audio_bitrate
            if video_bitrate < 150000:
                video_bitrate = 150000

            cmd = [
                "ffmpeg", "-y", "-i", filename,
                "-threads", "1",
                "-vf", "scale='min(720,iw)':-2",
                "-b:v", str(video_bitrate),
                "-c:v", "libx264", 
                "-preset", "ultrafast",
                "-c:a", "aac", "-b:a", "64k",
                compressed_filename
            ]
            
            try:
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                os.remove(filename)
                filename = compressed_filename
                logger.info("[COMPRESS] Сжатие завершено успешно.")
            except Exception as compress_err:
                logger.error(f"[COMPRESS] Ошибка сжатия: {compress_err}")
                if os.path.getsize(filename) > MAX_FILESIZE:
                    os.remove(filename)
                    raise ValueError("Файл слишком большой для отправки в Telegram (>50MB).")
        else:
            os.remove(filename)
            raise ValueError("Файл превышает 50 МБ, сжатие невозможно (не определена длина).")

    return filename
