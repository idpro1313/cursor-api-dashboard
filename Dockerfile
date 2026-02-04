# Cursor API Dashboard — образ приложения
# В образ включена Java 17 (JRE) для парсинга PDF-счетов через OpenDataLoader.
FROM node:20-alpine

WORKDIR /app

# Сборка better-sqlite3 + Java 17 для OpenDataLoader PDF
RUN apk add --no-cache python3 make g++ sqlite-dev openjdk17-jre-headless

COPY package.json ./
RUN npm install --omit=dev

# Код приложения (отдельные слои — точечная инвалидация кэша)
COPY server.js db.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public

EXPOSE 3333

ENV PORT=3333
ENV NODE_ENV=production
CMD ["node", "server.js"]
