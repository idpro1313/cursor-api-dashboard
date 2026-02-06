# Аудит проекта: структура, код, настройки

*Часть пунктов из этого отчёта уже исправлена (API report/reconciliation добавлены, settings-uploads.js удалён, parser_output переименован, report/reconciliation в навигации и защищённых страницах). Документ сохранён для истории и оставшихся рекомендаций.*

## 1. Структура проекта

**Корень:** `server.js`, `db.js`, `package.json`, `Dockerfile`, `docker-compose.yml`, `README.md`, `.dockerignore`, `.env.example`, `.gitignore`. Документация — в каталоге **`docs/`**: `DOCUMENTATION.md`, `PURPOSE-AND-VISION.md`, `AUDIT-REPORT.md`.

**public/** — статика: страницы (HTML), скрипты (JS), стили (CSS). Все нужные для основной навигации страницы присутствуют.

**scripts/** — `deploy.sh`, `auto-deploy-check.sh`. Используются для деплоя.

**Проблем:** Папки `lib/` нет (и не нужна — в Dockerfile её нет). Всё ок.

---

## 2. Лишнее в коде

### 2.1 Мёртвые страницы и API — исправлено

- **report.html + report.js** — вызывают `GET /api/invoices/all-items`. Эндпоинт **добавлен** в `server.js`.
- **reconciliation.html + reconciliation.js** — вызывают `GET /api/reconciliation`. Эндпоинт **добавлен**. Страницы добавлены в навигацию (settings.html) и в защищённые.

### 2.2 Неиспользуемый файл — исправлено

- **public/settings-uploads.js** — **удалён.**

### 2.3 Устаревшие названия в логах парсинга — исправлено

- В логах используется **parser_output** вместо pypdf_text.

---

## 3. Неоптимальности

### 3.1 Синхронизация — лишнее логирование тела запроса/ответа

В `cursorFetch()` при каждом запросе к Cursor API пишутся:
- `syncLog('request_body', { endpoint, body: JSON.stringify(requestPayload) });`
- `syncLog('response_body', { endpoint, body: ... });`

Для больших ответов (Usage Events и т.д.) это даёт очень большие логи и расход диска. Имеет смысл логировать тело только при ошибке или ограничить размер (например, первые 500–1000 символов) и/или вынести в отдельный файл с ротацией.

### 3.2 Rate limit — очистка по таймеру

`rateLimitMap` чистится раз в 60 секунд в `setInterval`. При большом числе разных IP карта может расти. Можно дополнительно удалять запись сразу при сбросе окна (`now >= bucket.resetAt`) в `checkRateLimit`, чтобы не держать устаревшие ключи.

### 3.3 Дублирование проверки защищённых страниц

Защищённые страницы проверяются дважды: в `serveProtectedPageIfAuth` (middleware) и в следующем `app.use()` для статики при запросе к тому же пути. Логика корректна, но можно оставить одну точку проверки (например, только в middleware для HTML), чтобы не дублировать вызов `requireSettingsAuth`.

### 3.4 deploy.sh — исправлено

Упоминание `lib/*` убрано из комментария.

---

## 4. Ошибки и риски — исправлено

- **GET /api/invoices/all-items** и **GET /api/reconciliation** добавлены; report и reconciliation в навигации и под защитой.

---

## 5. Окружение и контейнер

### 5.1 Dockerfile

- Базовый образ `node:20-alpine`, Java 17 для OpenDataLoader — ок.
- `COPY` только по существующим путям: `server.js`, `db.js`, `scripts/`, `public/`. Папки `lib` нет и не копируется — ок.

### 5.2 docker-compose.yml

- Порт 3333, `DATA_DIR=/data`, volume для данных — ок.
- Переменные для OpenDataLoader и логов закомментированы с пояснениями — ок.

### 5.3 .env.example

- Описаны PORT, DATA_DIR, CURSOR_API_KEY, CORS_ORIGIN, SESSION_SECRET, PROXY_TIMEOUT_MS, RATE_LIMIT_MAX, SYNC_LOG_FILE, USE_OPENDATALOADER, OPENDATALOADER_*, INVOICE_LOGS_DIR — соответствует документации.

### 5.4 .dockerignore

- Исключены `node_modules`, `.git`, `data`, `temp`, `.env`, `*.md` и т.д. — разумно. Документация в образ не попадает — ок, если не нужна внутри контейнера.

### 5.5 package.json

- Зависимости: `@opendataloader/pdf`, `better-sqlite3`, `cors`, `express`, `multer@^2.0.2` — актуально. Скрипт `parse-pdf` есть в server.js — ок.

---

## 6. Рекомендации (кратко)

1. ~~Реализовать report/reconciliation API~~ — **выполнено.**
2. ~~Удалить settings-uploads.js~~ — **выполнено.**
3. ~~parser_output в логах~~ — **выполнено.**
4. **Логи sync:** не логировать полное тело запроса/ответа к Cursor API в обычном режиме или ограничить размер и/или писать только при ошибке.
5. ~~deploy.sh lib/*~~ — **выполнено.**
6. ~~Защита и навигация report/reconciliation~~ — **выполнено.**

Оставшаяся рекомендация: уменьшить объём логирования тел запросов/ответов при синхронизации.
