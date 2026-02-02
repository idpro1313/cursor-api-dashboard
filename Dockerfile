FROM node:20-alpine

WORKDIR /app

# Сборка better-sqlite3 в Alpine требует build-base и python3
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package.json ./
RUN npm install --omit=dev

COPY server.js db.js ./
COPY public ./public

EXPOSE 3333

ENV PORT=3333
CMD ["node", "server.js"]
