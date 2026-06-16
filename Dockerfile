FROM python:3.10-slim

# Устанавливаем ffmpeg в систему Linux
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Устанавливаем библиотеки Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копируем весь код бота
COPY . .

# Создаем папку для постоянного хранения базы данных
RUN mkdir -p /data

CMD ["python", "bot.py"]
