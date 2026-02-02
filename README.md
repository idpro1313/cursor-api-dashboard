# Cursor Admin API — дашборд

Сайт забирает данные по [Cursor Admin API](https://cursor.com/docs/account/teams/admin-api): участники команды, аудит-логи, ежедневное использование, траты, события использования, биллинг-группы, блоклисты репозиториев.

## Требования

- API key команды Cursor. Создать: [cursor.com/settings](https://cursor.com/settings).  
  Можно один раз ввести ключ на сайте и нажать **«Сохранить ключ в файл»** — он сохранится в `data/api-key.txt`, и вводить его снова не нужно. Либо создать файл `data/api-key.txt` вручную и вписать туда ключ одной строкой.

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
2. Укажите период **startDate** и **endDate** (для эндпоинтов с датами; макс. 30 дней по лимитам API).
3. Отметьте нужные эндпоинты или нажмите «Выбрать все».
4. Нажмите **«Загрузить выбранные эндпоинты»**.

Результаты выводятся по каждому эндпоинту в свёрнутых блоках (JSON). Для audit-logs и usage events данные подгружаются постранично.

**Дополнительно:** во время загрузки отображается прогресс «N из M» и кнопка **«Остановить»**; ошибки показываются в блоке «Последние ошибки»; у каждого результата есть **«Скачать JSON»**, а **«Скачать всё (JSON)»** сохраняет один файл со всеми выбранными эндпоинтами.

### Сохранение в локальную БД

В разделе **«Сохранение в локальную БД»** можно одной кнопкой загрузить данные по [эндпоинтам Admin API](https://cursor.com/docs/account/teams/admin-api#endpoints) (members, audit-logs, daily-usage-data, spend, filtered-usage-events, groups, repo-blocklists) с указанной даты по сегодня и сохранить в SQLite (файл `data/analytics.db`). При повторной загрузке данные по уже загруженным дням **обновляются без дублирования** (один ряд на эндпоинт и день). Покрытие БД (какие эндпоинты и за какие даты сохранены) отображается в том же разделе.

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

## Эндпоинты Admin API

**Чтение (GET/POST):** Team Members, Audit Logs, Daily Usage Data, Spending Data, Usage Events. Документация: https://cursor.com/docs/account/teams/admin-api
