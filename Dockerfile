# Порядок слоёв для кэширования: при изменении только кода пересобираются
# только слои ниже изменённых файлов (npm install не перезапускается).
FROM node:20-alpine

WORKDIR /app

# Сборка better-sqlite3 в Alpine требует build-base и python3.
# py3-pip и pypdf — для опционального парсера PDF-счетов (USE_PYPDF).
RUN apk add --no-cache python3 py3-pip make g++ sqlite-dev \
  && pip3 install --break-system-packages --no-cache-dir pypdf

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
