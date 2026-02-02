# Cursor Analytics API — дашборд загрузки аналитики

Сайт забирает данные по [Cursor Analytics API](https://cursor.com/docs/account/teams/analytics-api) на максимальную глубину: все team-эндпоинты и все by-user эндпоинты с пагинацией.

## Требования

- API key команды Cursor (Enterprise). Создать: [cursor.com/settings](https://cursor.com/settings).

## Запуск в Docker (рекомендуется)

```bash
cd cursor-api-dashboard
docker compose up --build
```

Или без docker-compose:

```bash
docker build -t cursor-api-dashboard .
docker run -p 3333:3333 cursor-api-dashboard
```

Откройте в браузере: **http://localhost:3333**

## Запуск без Docker

- Node.js 18+

```bash
cd cursor-api-dashboard
npm install
npm start
```

Откройте в браузере: **http://localhost:3333**

## Использование

1. Вставьте **API key** (из настроек команды Cursor).
2. Укажите период **startDate** и **endDate** (макс. 30 дней по лимитам API).
3. Отметьте нужные эндпоинты или нажмите «Выбрать все».
4. Нажмите **«Загрузить выбранные эндпоинты»**.

Результаты выводятся по каждому эндпоинту в свёрнутых блоках (JSON). Для by-user эндпоинтов данные подгружаются постранично (до 500 пользователей на страницу), пока есть следующая страница.

**Дополнительно:** во время загрузки отображается прогресс «N из M» и кнопка **«Остановить»**; ошибки показываются в блоке «Последние ошибки»; у каждого результата есть **«Скачать JSON»**, а **«Скачать всё (JSON)»** сохраняет один файл со всеми выбранными эндпоинтами.

### Сохранение в локальную БД

В разделе **«Сохранение в локальную БД»** можно одной кнопкой загрузить **всю** аналитику по [всем эндпоинтам API](https://cursor.com/docs/account/teams/analytics-api#available-endpoints) с указанной даты по сегодня и сохранить в SQLite (файл `data/analytics.db`). При повторной загрузке данные по уже загруженным дням **обновляются без дублирования** (один ряд на эндпоинт и день). Покрытие БД (какие эндпоинты и за какие даты сохранены) отображается в том же разделе.

- **API для чтения:** `GET /api/analytics?endpoint=...&startDate=...&endDate=...` — выборка из БД.
- **Покрытие:** `GET /api/analytics/coverage` — список эндпоинтов и диапазонов дат.

При запуске в Docker для сохранения БД между перезапусками смонтируйте каталог данных:

```bash
docker run -p 3333:3333 -v cursor-analytics-data:/app/data cursor-api-dashboard
```

## Переменные окружения (опционально)

| Переменная | Описание |
|------------|----------|
| `CURSOR_API_KEY` | API key команды (если не вводить на сайте). |
| `CORS_ORIGIN` | Разрешённые origins через запятую (например `http://localhost:3333`). По умолчанию — все. |
| `PROXY_TIMEOUT_MS` | Таймаут запроса к Cursor API в мс (по умолчанию 60000). |
| `RATE_LIMIT_MAX` | Макс. запросов с одного IP в минуту (по умолчанию 120). |

## Эндпоинты

**Team (сводка по команде):** Agent Edits, Tab Usage, DAU, Client Versions, Model Usage, Top File Extensions, MCP, Commands, Plans, Ask Mode, Leaderboard.

**By-user (по пользователям с пагинацией):** Agent Edits, Tabs, Models, Top File Extensions, Client Versions, MCP, Commands, Plans, Ask Mode.

Документация API: https://cursor.com/docs/account/teams/analytics-api
