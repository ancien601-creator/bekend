import sqlite3

DB_PATH = "/data/bot.db"

FREE_DOWNLOADS_DEFAULT = 10


def init_db():
    # Используем переменную DB_PATH, чтобы файл базы данных совпадал с остальными функциями
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                free_left INTEGER DEFAULT {FREE_DOWNLOADS_DEFAULT},
                pending_url TEXT
            )
        """)


def get_or_create_user(user_id: int):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.execute("SELECT free_left, pending_url FROM users WHERE user_id=?", (user_id,))
    row = cur.fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO users (user_id, free_left) VALUES (?, ?)",
            (user_id, FREE_DOWNLOADS_DEFAULT),
        )
        conn.commit()
        result = (FREE_DOWNLOADS_DEFAULT, None)
    else:
        result = row
    conn.close()
    return result


def get_free_left(user_id: int) -> int:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.execute("SELECT free_left FROM users WHERE user_id=?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return row[0] if row else 0


def decrement_free(user_id: int):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE users SET free_left = free_left - 1 WHERE user_id=?", (user_id,))
    conn.commit()
    conn.close()


def set_pending_url(user_id: int, url: str | None):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE users SET pending_url=? WHERE user_id=?", (url, user_id))
    conn.commit()
    conn.close()


def get_pending_url(user_id: int) -> str | None:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.execute("SELECT pending_url FROM users WHERE user_id=?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return row[0] if row else None


def clear_pending_url(user_id: int):
    set_pending_url(user_id, None)
