# Cursor API Dashboard — образ приложения
# В образ включена Java 17 (JRE) для парсинга PDF-счетов через OpenDataLoader.
FROM node:20-alpine

WORKDIR /app

# Репозиторий community нужен для openjdk17 (в main его нет)
RUN echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories

# Сборка better-sqlite3 + Java 17 для OpenDataLoader PDF
RUN apk add --no-cache python3 make g++ sqlite-dev openjdk17-jre-headless

# OpenDataLoader ищет Java по JAVA_HOME или PATH
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"
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
CMD ["node", "server.js"]
