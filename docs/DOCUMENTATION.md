# Документация: Cursor API Dashboard

Веб-приложение для работы с [Cursor Admin API](https://cursor.com/docs/account/teams/admin-api): прокси запросов, сохранение аналитики в локальную БД, дашборды по использованию Cursor командой и загрузка PDF-счетов Cursor с парсингом через OpenDataLoader.

---

## 1. Назначение и возможности

- **Прокси к Cursor Admin API** — запросы к API выполняются с сервера, API key не передаётся в браузер.
- **Синхронизация в БД** — загрузка данных по эндпоинтам (audit-logs, daily-usage-data, filtered-usage-events) с указанной даты по вчера с сохранением в SQLite. Уже загруженные дни не запрашиваются повторно; текущий день не загружается.
- **Просмотр данных в БД** — фильтрация по эндпоинту и диапазону дат, просмотр покрытия.
- **Пользователи Jira** — загрузка CSV (экспорт из Jira) для сопоставления с активностью Cursor по email.
- **Дашборд по пользователям** — статистика использования Cursor по месяцам: запросы, дни активности, строки кода, применения/принятия; виды: карточки, тепловая карта, таблица.
- **Счета Cursor (PDF)** — загрузка PDF-счетов, парсинг таблицы позиций через [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf) (требуется Java 11+). Извлекаются строки с полями Description, Qty, Unit price, Tax, Amount. Логирование каждого разбора в отдельный файл в `data/invoice-logs/`.
- **Доступ к настройкам по логину и паролю** — страницы «Счета и учёт» и «Настройки» (табы: Загрузка в БД, Данные в БД, Jira, Аудит) доступны после входа. Учётные данные хранятся в `data/auth.json`.

---

## 2. Стек и требования

| Компонент | Технология |
|-----------|------------|
| Сервер | Node.js 18+ (рекомендуется 20), Express |
| БД | SQLite (better-sqlite3) |
| Фронт | HTML, CSS, JavaScript (без фреймворков) |
| Парсинг PDF-счетов | [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf) (`@opendataloader/pdf`), **требуется Java 11+** в PATH при включённом `USE_OPENDATALOADER` |
| Контейнеризация | Docker, Docker Compose |

**Внешние зависимости:** Cursor Admin API (нужен API key команды из [cursor.com/settings](https://cursor.com/settings)). Ключ хранится в общей БД (таблица `settings`). При запуске выгрузки проверяется наличие ключа; при недействительном ключе (401 от Cursor API) предлагается ввести и сохранить новый.

**Парсинг счетов:** при включённом `USE_OPENDATALOADER` (по умолчанию и локально, и в Docker) для загрузки PDF-счетов нужна **Java 11+** в PATH. В Docker-образ входит Java 17 (JRE), парсинг включён по умолчанию; отключить в контейнере можно переменной `USE_OPENDATALOADER=0`. Резервных парсеров нет.

---

## 3. Структура проекта

```
cursor-api-dashboard/
├── server.js           # Сервер: API, прокси, синхронизация, парсинг PDF-счетов (OpenDataLoader)
├── db.js               # Работа с SQLite (analytics, jira_users, cursor_invoices)
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .gitignore
├── README.md           # Краткая инструкция по запуску (для GitHub)
├── docs/               # Документация
│   ├── DOCUMENTATION.md    # Этот файл
│   ├── PURPOSE-AND-VISION.md
│   └── AUDIT-REPORT.md
├── public/             # Статика
│   ├── index.html      # Главная: дашборд по пользователям (без входа)
│   ├── login.html      # Вход в настройки (логин/пароль)
│   ├── team-snapshot.html    # Расходы: участники и spend за месяц
│   ├── invoices.html   # Счета и учёт: табы Счета | Отчёт | Сверка (после входа)
│   ├── settings.html   # Настройки (после входа): табы Загрузка в БД | Данные в БД | Jira | Аудит
│   ├── styles.css
│   └── js/             # Скрипты (подключаются из HTML как js/…)
│       ├── common.js       # Общие утилиты, навигация, fetchWithAuth
│       ├── dashboard.js    # Логика дашборда (index.html)
│       ├── expenses.js     # Участники и расходы (team-snapshot.html)
│       ├── accounting.js   # Счета, отчёт, сверка (invoices.html)
│       ├── settings-tabs.js   # Переключение табов на странице настроек
│       ├── app.js          # Загрузка в БД (sync-stream, покрытие)
│       ├── data.js         # Просмотр данных в БД
│       ├── jira-users.js   # Пользователи Jira (CSV)
│       └── audit.js        # Аудит (события Audit Logs)
├── scripts/
│   └── deploy.sh       # Скрипт деплоя (git pull + docker compose)
└── data/               # Локально: создаётся при первом запуске. В Docker — каталог хоста /var/cursor/data
    ├── analytics.db    # SQLite (analytics, jira_users, settings, cursor_invoices, cursor_invoice_items)
    ├── auth.json       # Логин и пароль для входа в настройки (создаётся при первом запуске: admin/admin)
    ├── session_secret  # Секрет для подписи сессии (создаётся автоматически)
    ├── sync.log        # Лог синхронизации API (при SYNC_LOG_FILE)
    └── invoice-logs/   # Логи парсинга счетов: один файл на счёт (имя_файла.pdf.log); при удалении счёта лог удаляется
```

---

## 4. Запуск

### 4.1 Локально (без Docker)

```bash
npm install
npm start
```

Приложение доступно по адресу **http://localhost:3333** (порт задаётся переменной `PORT`, по умолчанию 3333).

**Доступ к настройкам:** с главной страницы ссылка «Настройки» ведёт на страницу входа. Логин и пароль задаются в файле `data/auth.json` (формат: `{"login": "admin", "password": "admin"}`). При первом запуске файл создаётся с учётными данными по умолчанию (admin/admin) — рекомендуется сменить пароль, отредактировав `data/auth.json`.

### 4.2 Docker

```bash
docker compose up --build
```

Данные (БД, настройки) хранятся в каталоге хоста **/var/cursor/data**, монтируемом в контейнер в `/data` (см. `docker-compose.yml`). Перед первым запуском на сервере можно создать каталог: `sudo mkdir -p /var/cursor/data`; скрипт `scripts/deploy.sh` создаёт его при необходимости.

### 4.3 Деплой на сервер (Ubuntu)

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

Скрипт выполняет: `git pull`, `docker compose build --no-cache`, `docker compose up -d`. Каталог проекта по умолчанию — родитель `scripts/`; при необходимости задаётся переменной `PROJECT_DIR`.

---

## 5. Страницы и разделы

### 5.1 Главная — дашборд (`index.html`), без входа

Открывается по умолчанию. Доступ **без авторизации**.
- **Период:** начало и конец (даты). По умолчанию — период по данным Daily Usage в БД. Активность агрегируется **по месяцам**.
- **Вид:** карточки пользователей / тепловая карта / таблица по месяцам.
- **Сортировка:** по запросам, дням с активностью, строкам, событиям Usage Events, стоимости, имени.
- **Фильтр:** «Показывать только тех, у кого есть активность за период».
- **Данные:** Daily Usage Data + Usage Events (события, стоимость, токены: input/output/cache, разбивка по моделям) + при наличии Jira (имена, статус Активный/Архивный, проект, даты подключения/отключения). Статус и даты в Jira определяются по записи с самой свежей «Датой начала подписки».
- **Сводка:** запросы, строки ±, события и стоимость Usage Events, токены (М/К), расходы текущего месяца (Spend API), участники команды, стоимость по моделям (таблица).
- **Активные в Jira, но не используют / редко используют Cursor:** таблица с сортировкой по столбцам (по умолчанию — по «Последняя активность», сначала кто давно не использовал).
- **Затраты по проекту (помесячно):** таблица по проектам Jira с помесячной стоимостью Usage Events и итогом Spend API.
- Ссылка **«Настройки»** ведёт на страницу входа (`login.html`).

### 5.2 Вход и страница настроек (`login.html`, `settings.html`)

- **Вход:** логин и пароль из файла `data/auth.json`. При первом запуске создаётся файл с учётными данными по умолчанию (admin/admin). Сессия хранится в cookie (24 ч).
- **После входа** открывается `settings.html` — список разделов: Настройки и загрузка, Данные в БД, Пользователи Jira, Счета, Аудит, Отчёт по счетам, Сверка. Каждый пункт — ссылка на соответствующую страницу.

### 5.3 Настройки → Загрузка в БД (только после входа)

- **Настройки:** ввод API key, сохранение в БД (кнопка «Сохранить ключ в БД»). Если ключ уже сохранён, отображается «Ключ сохранён в БД» и ссылка «Изменить ключ».
- **Сохранение в локальную БД:** поле «Начальная дата» (по умолчанию 01.09.2025), кнопка «Загрузить и сохранить в БД» — потоковая синхронизация (`/api/sync-stream`), прогресс и лог. Запрашиваются только недостающие диапазоны дат.
- **Покрытие БД:** таблица по эндпоинтам (мин/макс дата, количество дней), кнопки «Обновить» и «Полная очистка БД».
- Ссылка «← К дашборду» ведёт на главную (`index.html`).

### 5.4 Настройки → Данные в БД

- Покрытие БД, фильтры по эндпоинту и датам. Кнопка «Показать данные» — отображение карточек по датам и эндпоинтам. Для Usage Events поля `tokenUsage` развёрнуты в отдельные колонки (inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalCents).

### 5.5 Настройки → Jira

- Загрузка CSV (экспорт из Jira). При загрузке записи в `jira_users` **полностью заменяются**. Кнопка «Очистить данные Jira» — очистка только таблицы Jira (данные API не затрагиваются).
- Отображение текущего списка пользователей из БД.

### 5.6 Настройки → Аудит

- События Audit Logs из БД. Фильтры: период, тип события, лимит записей. Кнопка «Показать» — загрузка и отображение таблицы событий.

### 5.7 Счета Cursor (`invoices.html`), только после входа

- Загрузка PDF-счета: выбор файла, отправка на сервер. Парсинг выполняется **только** через OpenDataLoader; при отключённом парсере (`USE_OPENDATALOADER=0`), ошибке выполнения (нет Java или сбой OpenDataLoader) или пустом результате сервер возвращает ошибку клиенту (резервных парсеров нет).
- Дубликаты: счёт с тем же SHA-256 хешем файла не принимается (409), отображается ссылка на уже загруженный счёт.
- Список загруженных счетов с количеством позиций; просмотр позиций счёта (description, quantity, unit price, tax, amount); удаление счёта (при удалении удаляется и соответствующий лог в `data/invoice-logs/`).

### 5.8 Счета и учёт: Отчёт и Сверка (табы на `invoices.html`)

- **Отчёт по счетам:** сводка по загруженным счетам — по периодам биллинга (цикл 6–5) и по типам начислений. API: `GET /api/invoices/all-items`.
- **Сверка:** сопоставление Usage Events и позиций счетов по периодам биллинга; разница в $. API: `GET /api/reconciliation`. Доступ только после входа.

### 5.9 Редирект

- Запрос к `/users-dashboard.html` — редирект 302 на `/index.html`.

---

## 5.10 Что загружается в БД и что отображается на дашборде

| Эндпоинт (загрузка) | Где отображается | Примечание |
|--------------------|------------------|------------|
| **Daily Usage Data** | Дашборд (index) | Запросы, дни активности, строки ±, applies/accepts по пользователям и месяцам. |
| **Usage Events** (filtered-usage-events) | Дашборд (index) | События, стоимость в $, разбивка по моделям. |
| **Пользователи Jira** (CSV) | Дашборд (index), страница Jira | Имена, статус активный/архивный, проект, даты подключения/отключения. |
| **Team Members** | Дашборд (сводка), Настройки → Данные в БД | Число участников и список в сводке; сырые данные в табе «Данные в БД». |
| **Audit Logs** | Настройки → Аудит, Данные в БД | Фильтр по дате и типу во вкладке «Аудит». |
| **Spending Data** | Дашборд (сводка и по пользователям) | Расходы текущего месяца из `/teams/spend` в сводке и в карточках/таблице пользователей. |

Всё загруженное можно просмотреть на странице **«Данные в БД»**. На **главном дашборде** используются Daily Usage, Usage Events, Jira, Team Members и Spending Data.

---

## 6. API сервера (бэкенд)

Базовый URL: `http://localhost:3333` (или ваш хост).

**Авторизация настроек:** эндпоинты, помеченные «(только после входа)», требуют валидной сессии (cookie после успешного `POST /api/login`). Без сессии возвращается 401 или редирект на `/login.html`.

### 6.1 Вход и проверка сессии

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/login` | Тело: `{ login, password }`. Сверка с `data/auth.json`. При успехе — cookie сессии, ответ `{ ok: true }`. |
| POST | `/api/logout` | Сброс cookie сессии. |
| GET | `/api/auth/check` | Ответ: `{ authenticated: boolean }`. |

### 6.2 Конфигурация и прокси (только после входа)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/config` | Ответ: `{ apiKeyConfigured: boolean }`. |
| POST | `/api/config` | Тело: `{ apiKey }`. Сохраняет ключ в БД (таблица `settings`). |
| GET | `/api/proxy?path=...&startDate=...&endDate=...` | Прокси GET к Cursor API. `path` — например `/teams/members`, `/teams/audit-logs?...`. Требуется API key (заголовок `X-API-Key` или из файла/переменной). |
| POST | `/api/proxy` | Тело: `{ path, ...params }`. Прокси POST к Cursor API. |

Допустимые префиксы `path`: `/teams/`, `/settings/`. На сервере действует rate limit (по умолчанию 120 запросов с одного IP в минуту) и соблюдаются лимиты Cursor API (20/60 запр/мин в зависимости от эндпоинта).

### 6.3 Синхронизация в БД (только после входа)

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/sync` | Тело: `{ startDate, endDate }` (YYYY-MM-DD). Синхронизация в БД без потока. |
| POST | `/api/sync-stream` | То же тело. Ответ — поток SSE. События: `progress`, `done`, `error`. |

Эндпоинты синхронизации:

- **Snapshot (один запрос за запуск):** `/teams/members`, `/teams/spend`.
- **По периодам (чанки по 30 дней):** `/teams/audit-logs`, `/teams/daily-usage-data`, `/teams/filtered-usage-events`. Для каждого эндпоинта вычисляются даты, которых ещё нет в БД; по ним строятся непрерывные «дыры» и разбиваются на чанки по 30 дней. Таким образом за период больше 30 дней запрашиваются только недостающие диапазоны, без повторной загрузки уже имеющихся данных.

### 6.4 Счета Cursor (только после входа)

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/invoices/upload` | Тело: `multipart/form-data`, поле `pdf` — файл PDF. Парсинг через OpenDataLoader; при успехе — сохранение в БД, ответ `{ ok, invoice_id, filename, items_count }`. При дубликате по хешу файла — 409 и `existing_invoice`. При ошибке парсинга (OPENDATALOADER_DISABLED, OPENDATALOADER_ERROR, OPENDATALOADER_EMPTY) — 400 с сообщением. |
| GET | `/api/invoices` | Список счетов: `{ invoices: [ { id, filename, parsed_at, items_count }, ... ] }`. |
| GET | `/api/invoices/all-items` | Все позиции всех счетов для отчёта: `{ items: [ { issue_date, amount_cents, charge_type, ... }, ... ] }`. |
| GET | `/api/invoices/:id/items` | Позиции счёта: `{ items: [ { row_index, description, quantity, unit_price_cents, tax_pct, amount_cents, raw_columns }, ... ] }`. 404 если счёт не найден. |
| DELETE | `/api/invoices/:id` | Удаление счёта и всех его позиций; удаляется также лог в `INVOICE_LOGS_DIR` (имя файла счёта + `.log`). Ответ `{ ok: true }` или 404. |

### 6.5 Сверка (только после входа)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/reconciliation` | Сопоставление Usage Events и позиций счетов по периодам биллинга. Ответ: `{ comparison: [ { periodLabel, usageEventCount, usageCostCents, invoiceItemCount, invoiceCostCents, diffCents } ], totals }`. |

### 6.6 Аналитика и пользователи

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/analytics?endpoint=...&startDate=...&endDate=...` | Выборка из таблицы `analytics`. Ответ: `{ data: [ { endpoint, date, payload, updated_at }, ... ] }`. |
| GET | `/api/analytics/coverage` | Ответ: `{ coverage: [ { endpoint, min_date, max_date, days }, ... ] }`. |
| POST | `/api/clear-db` | Тело: `{ clearSettings?: boolean }`. Полная очистка БД: таблицы `analytics` и `jira_users`; при `clearSettings: true` — также `settings` (API key). Ответ: `{ ok, message }`. |
| GET | `/api/users/activity-by-month?startDate=...&endDate=...` | Агрегация Daily Usage и Usage Events по пользователям и месяцам. Ответ: `{ users, months }`. У пользователя: `displayName`, `email`, `jiraStatus`, `jiraProject`, `jiraConnectedAt`, `jiraDisconnectedAt`, `monthlyActivity: [ { month, activeDays, requests, linesAdded, linesDeleted, applies, accepts, usageEventsCount, usageCostCents, usageCostByModel }, ... ]`. Пользователи — из Jira (CSV) и/или из Cursor по email. |
| GET | `/api/jira-users` | Ответ: `{ users: [ ... ] }` — массив объектов из таблицы `jira_users`. |
| POST | `/api/jira-users/upload` | Тело: `{ csv: "строка CSV" }`. Полная замена записей в `jira_users`. |

---

## 7. База данных (SQLite)

Каталог БД задаётся переменной `DATA_DIR` (по умолчанию `./data`; в Docker в контейнере — `/data`, на хосте — `/var/cursor/data`, монтируется в `docker-compose.yml`).

### 7.1 Таблица `analytics`

| Колонка | Тип | Описание |
|---------|-----|----------|
| endpoint | TEXT | Путь эндпоинта, например `/teams/daily-usage-data`. |
| date | TEXT | Дата в формате YYYY-MM-DD. |
| payload | TEXT | JSON ответа API (или его часть, разложенная по дням). |
| updated_at | TEXT | Время последнего обновления. |

**Первичный ключ:** `(endpoint, date)`. При повторной загрузке дня запись обновляется (upsert).

### 7.2 Таблица `jira_users`

| Колонка | Тип | Описание |
|---------|-----|----------|
| id | INTEGER | AUTOINCREMENT. |
| data | TEXT | JSON одного «строки» из CSV (объект с полями вроде «Внешний почтовый адрес», «Email» и т.д.). |
| updated_at | TEXT | Время последнего обновления. |

При загрузке CSV таблица очищается и заполняется заново.

### 7.3 Таблицы счетов Cursor

**`cursor_invoices`**

| Колонка | Тип | Описание |
|---------|-----|----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT. |
| filename | TEXT | Имя загруженного файла. |
| file_path | TEXT | Не используется (оставлено для совместимости). |
| file_hash | TEXT | SHA-256 хеш файла; уникальный индекс для проверки дубликатов. |
| parsed_at | TEXT | Время загрузки/парсинга. |

**`cursor_invoice_items`**

| Колонка | Тип | Описание |
|---------|-----|----------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT. |
| invoice_id | INTEGER | FK на cursor_invoices(id), ON DELETE CASCADE. |
| row_index | INTEGER | Порядковый номер строки в таблице счёта. |
| description | TEXT | Описание позиции. |
| quantity | REAL | Количество. |
| unit_price_cents | INTEGER | Цена за единицу в центах. |
| tax_pct | REAL | Налог, %. |
| amount_cents | INTEGER | Сумма в центах. |
| raw_columns | TEXT | JSON массива сырых значений колонок. |

Уникальность: `(invoice_id, row_index)`.

### 7.4 Вспомогательные функции (db.js)

- `getExistingDates(endpoint, startDate, endDate)` — массив дат (YYYY-MM-DD), по которым уже есть данные для эндпоинта в указанном диапазоне. Используется при синхронизации для построения недостающих диапазонов: запрашиваются только чанки по «дырам» (без повторной загрузки одних и тех же дней).
- Для счетов: `getCursorInvoices`, `getCursorInvoiceById`, `getCursorInvoiceItems`, `getCursorInvoiceByFileHash`, `insertCursorInvoice`, `insertCursorInvoiceItem`, `deleteCursorInvoice`. При полной очистке БД (`clearAllData`) удаляются также `cursor_invoices` и `cursor_invoice_items`.

---

## 8. Логика синхронизации (загрузка в БД)

1. **Граница периода:** конечная дата на сервере ограничивается **вчера** (текущий день не загружается).
2. **Начальная дата:** задаётся пользователем; по умолчанию на фронте — **01.09.2025**.
3. **Чанки по 30 дней:** период от начальной даты до вчера разбивается на отрезки по 30 дней (лимит Cursor API).
4. **Пропуск уже загруженных данных:** для каждого daterange-эндпоинта запрашивается множество дат из БД в этом периоде. Чанк пропускается, если для **всех** дней этого чанка уже есть записи. Иначе чанк запрашивается у Cursor API и сохраняется (upsert по дням).
5. **Snapshot-эндпоинты** (members, spend) запрашиваются один раз за запуск синхронизации.
6. **Прогресс:** при использовании `/api/sync-stream` число шагов равно: количество snapshot-эндпоинтов + сумма по daterange-эндпоинтам числа чанков, которые реально запрашиваются (без полностью заполненных).

---

## 9. Переменные окружения

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `PORT` | Порт HTTP-сервера. | 3333 |
| `DATA_DIR` | Каталог для БД, auth.json, session_secret, sync.log, invoice-logs. | `./data` (от корня приложения) |
| `CURSOR_API_KEY` | API key команды Cursor (если не хранить в БД и не вводить на сайте). | — |
| `CORS_ORIGIN` | Разрешённые origins через запятую. | все |
| `PROXY_TIMEOUT_MS` | Таймаут запроса к Cursor API, мс. | 60000 |
| `RATE_LIMIT_MAX` | Максимум запросов с одного IP в минуту к нашему серверу. | 120 |
| `SYNC_LOG_FILE` | Путь к файлу лога синхронизации (append). | `data/sync.log` |
| `SESSION_SECRET` | Секрет для подписи сессии (если не использовать файл `data/session_secret`). | генерируется в файл |
| `USE_OPENDATALOADER` | Включить парсинг PDF-счетов через OpenDataLoader. Требуется **Java 11+** в PATH (в Docker-образе установлена Java 17). Отключить: `0` или `false`. | включено (если не `0`/`false`) |
| `OPENDATALOADER_TABLE_METHOD` | Метод детекции таблиц OpenDataLoader: `default` (по границам) или `cluster`. | не задаётся |
| `OPENDATALOADER_USE_STRUCT_TREE` | Если `1` или `true` — использовать структуру тегов PDF (tagged PDF) для порядка чтения. | не задаётся |
| `INVOICE_LOGS_DIR` | Каталог логов парсинга счетов. Для каждого счёта — файл `имя_файла.pdf.log`; при удалении счёта лог удаляется. | `DATA_DIR/invoice-logs` |

---

## 9.1 Логирование процесса загрузки (sync)

При синхронизации (кнопка «Загрузить и сохранить в БД») в stdout и при необходимости в файл (`SYNC_LOG_FILE`) пишутся строки формата:

```
[SYNC] ISO_TIMESTAMP action=... key=value ...
```

**Действия (action):**

| action | Описание |
|--------|----------|
| `start` | Старт синхронизации: startDate, endDate, endCapped, totalSteps. |
| `request` | Перед запросом к Cursor API: endpoint, method, chunkLabel, page (если есть). |
| `response` | Успешный ответ: endpoint, status, durationMs. |
| `saved` | После записи в БД: endpoint, records, days. |
| `retry` | Повтор из-за 429: endpoint, status, attempt, durationMs. |
| `error` | Ошибка запроса или эндпоинта: endpoint, status, error, durationMs. |
| `skipped` | Эндпоинт пропущен (функция не включена): endpoint, reason. |
| `complete` | Конец синхронизации: saved, okCount, errorsCount, skippedCount, errors (текст). |

**Анализ лога:** ошибки искать по `action=error` или `action=complete` с `errorsCount>0`. По `durationMs` можно находить медленные запросы. Пример (bash): `grep '\[SYNC\]' sync.log | grep 'action=error'`.

---

## 9.2 Парсинг PDF-счетов (OpenDataLoader) и логирование

**Парсер:** используется только [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf) (пакет `@opendataloader/pdf`). Вызов по [Quick Start Node.js](https://opendataloader.org/docs/quick-start-nodejs), вывод в JSON по [JSON Schema](https://opendataloader.org/docs/json-schema). Резервных парсеров нет: при `USE_OPENDATALOADER=0`, ошибке выполнения (например отсутствие Java) или пустом результате загрузка счёта возвращает ошибку клиенту.

**Извлечение таблицы:** в JSON ищется таблица с заголовками Description, Qty, Unit price (опционально), Tax (опционально), Amount. Функция `extractInvoiceRowsFromOdlTable()` определяет индексы колонок по заголовкам и для каждой строки данных извлекает: description, quantity, unit_price_cents, tax_pct, amount_cents. Поддерживаются форматы с колонкой Tax и без неё. Числа и валютные суммы парсятся с учётом символа `$` и запятых; применяется нормализация текста (в т.ч. склейка сумм, разорванных переносами строк, и нестандартных пробелов).

**Логирование:** для каждого загружаемого счёта создаётся/перезаписывается файл в `INVOICE_LOGS_DIR` с именем `имя_файла.pdf.log` (недопустимые символы в имени заменяются на `_`). В лог пишутся: timestamp, filename, parser (`opendataloader`), rows_count, код ошибки (если есть), длина и содержимое извлечённого JSON (поле `parser_output`, обрезано до 50K символов). При удалении счёта через API соответствующий лог-файл удаляется.

---

## 10. Лимиты Cursor Admin API

- Большинство эндпоинтов: **20 запросов в минуту** на команду.
- `/teams/user-spend-limit`: **60 запросов в минуту**.

Сервер при прокси и синхронизации троттлит запросы по эндпоинтам, чтобы не превышать эти лимиты.

---

## 11. Безопасность

- **Настройки:** доступ к разделам admin, data, jira-users, invoices, audit, report, reconciliation и к связанным API возможен только после входа. Логин и пароль хранятся в `data/auth.json` (каталог `data/` в `.gitignore`). Рекомендуется сменить пароль по умолчанию (admin/admin).
- **Сессия:** подпись cookie через HMAC-SHA256, секрет в `data/session_secret` или в `SESSION_SECRET`. Срок жизни сессии — 24 часа.
- **API key** не логируется и не отдаётся клиенту; хранится в БД.
- Для продакшена: задать `CORS_ORIGIN`, при необходимости ограничить доступ по сети (фаервол, обратный прокси).

---

## 12. Ссылки

- [Cursor Admin API](https://cursor.com/docs/account/teams/admin-api)
- [API Overview (аутентификация, лимиты)](https://cursor.com/docs/api)
- [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf) — парсинг PDF-счетов
- [OpenDataLoader Quick Start (Node.js)](https://opendataloader.org/docs/quick-start-nodejs)
- [OpenDataLoader JSON Schema](https://opendataloader.org/docs/json-schema)
