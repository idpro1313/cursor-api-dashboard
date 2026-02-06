# Cursor API Dashboard — образ приложения
# В образ включена Java 17 (JRE) для парсинга PDF-счетов через OpenDataLoader.
FROM node:20-alpine

WORKDIR /app

# Репозиторий community для openjdk17 (версия Alpine — как в базовом образе)
RUN V=$(cat /etc/alpine-release 2>/dev/null | sed -n 's/^\([0-9]*\.[0-9]*\).*/\1/p') && \
    echo "http://dl-cdn.alpinelinux.org/alpine/v${V:-3.19}/community" >> /etc/apk/repositories

# Сборка better-sqlite3 + Java 17 для OpenDataLoader PDF
RUN apk add --no-cache python3 make g++ sqlite-dev openjdk17-jre-headless

# Java в PATH: пакет ставит java в /usr/lib/jvm/java-17-openjdk/bin, добавляем в начало PATH
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk
ENV PATH=/usr/lib/jvm/java-17-openjdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN java -version

COPY package.json ./
RUN npm install --omit=dev

# Код приложения (отдельные слои — точечная инвалидация кэша)
COPY server.js db.js ./
COPY scripts ./scripts
COPY public ./public

EXPOSE 3333

ENV PORT=3333
ENV NODE_ENV=production

# Разрешаем запись логов, создаем директорию
RUN mkdir -p /app/logs && chmod 777 /app/logs

# Запуск с перенаправлением логов (stdout + stderr) в файл + консоль
# Используем tee для дублирования логов
CMD ["sh", "-c", "node server.js 2>&1 | tee -a /data/logs/app.log"]
