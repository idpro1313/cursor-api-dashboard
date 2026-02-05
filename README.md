# Cursor API Dashboard

Дашборд и настройки для работы с [Cursor Admin API](https://cursor.com/docs/account/teams/admin-api): загрузка аналитики в локальную БД, просмотр статистики по пользователям и использованию Cursor командой.

## Возможности

- **Главная страница (дашборд)** — без входа: активность по пользователям и месяцам (запросы, строки кода, события и стоимость Usage Events, токены, расходы текущего месяца (Spend API)), сводка по моделям, блок «Активные в Jira, но не используют Cursor», затраты по проекту помесячно. Источники: Daily Usage Data, Usage Events, Jira (CSV), Team Members, Spending Data.
- **Структура (по логину и паролю):**
  - **Настройки и загрузки** (одна страница) — API key, загрузка данных из Cursor API в БД, загрузка CSV (Jira) и PDF-счетов, покрытие БД, очистка.
  - **Просмотр данных:** Дашборд, Участники и расходы, **Данные** (одна страница с вкладками: Данные в БД, Jira, Счета, Аудит — таблицы с копированием и сортировкой).

Логин и пароль хранятся в файле **`data/auth.json`**. При первом запуске создаётся файл с учётными данными по умолчанию: **admin** / **admin** (рекомендуется сменить).

## Требования

- Node.js 18+ (рекомендуется 20)
- API key команды Cursor: [cursor.com/settings](https://cursor.com/settings). Ключ вводится в разделе «Настройки и загрузка» и сохраняется в БД.

## Запуск

### Локально

```bash
npm install
npm start
```

Откройте в браузере: **http://localhost:3333**

- Главная — дашборд (доступ без входа).
- Ссылка **«Настройки и загрузки»** → страница входа → после входа: одна страница для всех загрузок (API, Jira CSV, PDF-счета). Просмотр: Дашборд, Участники и расходы, Данные (вкладки БД, Jira, Счета, Аудит).
- Для загрузки PDF-счетов при локальном запуске нужна **Java 11+** в PATH (например [Adoptium](https://adoptium.net/) или OpenJDK); иначе будет ошибка «Ошибка OpenDataLoader (требуется Java 11+)».

### Docker

```bash
docker compose up --build
```

Данные (БД, `auth.json`, сессия, логи) хранятся в каталоге хоста **/var/cursor/data** (монтируется в контейнер). При первом запуске на Linux создайте каталог: `sudo mkdir -p /var/cursor/data`. На Windows можно использовать именованный том Docker — в `docker-compose.yml` закомментирован вариант `cursor_data:/data`.

### Автоматизация деплоя на сервере

Чтобы не запускать `deploy.sh` вручную после каждого `git push`:

**Вариант 1: Cron на сервере** — периодическая проверка обновлений и деплой при появлении новых коммитов:

```bash
chmod +x scripts/auto-deploy-check.sh
# Добавить в crontab (каждые 5 минут):
# */5 * * * * cd /opt/cursor/cursor-api-dashboard && ./scripts/auto-deploy-check.sh >> /var/log/cursor-deploy.log 2>&1
```

Переменные: `PROJECT_DIR` — каталог проекта на сервере; `DEPLOY_BRANCH` — ветка для сравнения (по умолчанию текущая).

**Вариант 2: Push + деплой с локальной машины** — одна команда вместо «push, затем зайти на сервер и запустить deploy»:

```bash
export DEPLOY_HOST="user@your-server"   # один раз или в ~/.bashrc
export DEPLOY_PATH="/opt/cursor/cursor-api-dashboard"   # если путь на сервере другой
chmod +x scripts/push-and-deploy.sh
./scripts/push-and-deploy.sh
```

Скрипт делает `git push` и по SSH запускает `./scripts/deploy.sh` на сервере. Нужен SSH-доступ по ключу без пароля.

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `PORT` | Порт HTTP (по умолчанию 3333). |
| `DATA_DIR` | Каталог для БД и файлов (по умолчанию `./data`; в Docker — `/data`). |
| `CURSOR_API_KEY` | API key команды (если не вводить в интерфейсе). |
| `CORS_ORIGIN` | Разрешённые origins через запятую. |
| `SESSION_SECRET` | Секрет для подписи сессии (опционально). |
| `USE_OPENDATALOADER` | По умолчанию включено: парсинг PDF-счетов через [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf). Требуется **Java 11+** в PATH. Отключить: `0` или `false`. |
| `OPENDATALOADER_TABLE_METHOD` | Метод детекции таблиц: `default` (по границам) или `cluster`. По умолчанию не задаётся. |
| `OPENDATALOADER_USE_STRUCT_TREE` | Если `1` или `true` — использовать структуру тегов PDF (tagged PDF) для порядка чтения. |
| `INVOICE_LOGS_DIR` | Каталог логов загрузки счетов (по умолчанию `DATA_DIR/invoice-logs`). Для каждого счёта создаётся файл с именем как у файла счёта + `.log`; при удалении счёта лог удаляется. |

### Парсинг PDF-счетов (OpenDataLoader)

Используется [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf): вызов `convert()` по [Quick Start Node.js](https://opendataloader.org/docs/quick-start-nodejs), вывод в формате JSON по [JSON Schema](https://opendataloader.org/docs/json-schema). Из JSON извлекается таблица с заголовками Description / Qty / Unit price / Tax / Amount. **Требуется Java 11+** в PATH (локально); в Docker-образ включена Java 17, парсинг включён по умолчанию.

## Структура данных

- **data/analytics.db** — SQLite: таблицы `analytics` (данные по эндпоинтам и датам), `jira_users` (CSV Jira), `settings` (API key), `cursor_invoices` и `cursor_invoice_items` (загруженные PDF-счета и позиции).
- **data/auth.json** — логин и пароль для входа в настройки (`{"login": "admin", "password": "admin"}`).
- **data/session_secret** — секрет сессии (создаётся автоматически).
- **data/sync.log** — лог синхронизации API (при загрузке данных в БД).
- **data/invoice-logs/** — лог загрузки по каждому счёту отдельно (имя файла = имя счёта + `.log`); при удалении счёта соответствующий лог удаляется.

Подробнее: [DOCUMENTATION.md](DOCUMENTATION.md).

## Лимиты Cursor Admin API

- Большинство эндпоинтов: 20 запросов/мин.
- Сервер при загрузке соблюдает лимиты и не запрашивает уже загруженные дни повторно.
