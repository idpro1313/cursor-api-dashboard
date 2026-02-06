# Руководство по логированию и отладке

## Структура логов

Все логи выводятся в консоль в формате JSON для удобного анализа ИИ.

### Префиксы логов

- `[ACTIVITY-BY-MONTH]` - логи эндпоинта `/api/users/activity-by-month`
- `[DB]` - логи операций с базой данных
- `[HELPER]` - логи вспомогательных функций

### Поля логов

Каждый лог содержит:
- `requestId` - уникальный ID запроса для отслеживания
- `timestamp` - время запроса (ISO 8601)
- Специфичные для операции поля

## Последовательность логов для `/api/users/activity-by-month`

1. `REQUEST_START` - начало обработки запроса
2. `PARAMS_PARSED` - параметры распарсены
3. `FETCHING_JIRA` - начало загрузки данных Jira
4. `JIRA_FETCHED` - данные Jira загружены
5. `JIRA_MAPPED` - данные преобразованы
6. `ALL_KEYS_EXTRACTED` - извлечены ключи полей
7. `FETCHING_DAILY_USAGE` - загрузка daily usage данных
8. `DAILY_USAGE_FETCHED` - daily usage загружены
9. `PROCESSING_DAILY_USAGE` - обработка daily usage
10. `DAILY_USAGE_PROCESSED` - обработка завершена
11. `FETCHING_USAGE_EVENTS` - загрузка usage events
12. `USAGE_EVENTS_FETCHED` - usage events загружены
13. `PROCESSING_USAGE_EVENTS` - обработка usage events
14. `USAGE_EVENTS_PROCESSED` - обработка завершена
15. `CREATING_MONTHS_ARRAY` - создание массива месяцев
16. `MONTHS_CREATED` - массив создан
17. `BUILDING_JIRA_INFO_MAP` - построение карты Jira
18. `JIRA_INFO_MAP_BUILT` - карта построена
19. `BUILDING_USERS_FROM_JIRA` - создание пользователей из Jira
20. `JIRA_USERS_BUILT` - пользователи созданы
21. `FINDING_CURSOR_ONLY_USERS` - поиск пользователей только Cursor
22. `CURSOR_ONLY_USERS_ADDED` - добавлены
23. `CALCULATING_USER_STATS` - расчет статистики
24. `USER_STATS_CALCULATED` - статистика рассчитана
25. `SETTING_TEAM_SPEND` - установка team spend
26. `FILTERING_INACTIVE_USERS` - фильтрация неактивных
27. `INACTIVE_USERS_FILTERED` - фильтрация завершена
28. `CALCULATING_PROJECT_COSTS` - расчет затрат по проектам
29. `PROJECT_COSTS_CALCULATED` - расчет завершен
30. `BUILDING_RESPONSE` - формирование ответа
31. `RESPONSE_READY` - ответ готов
32. `RESPONSE_SENT` - ответ отправлен
33. `ERROR` - ошибка (если есть)

## Как просмотреть логи

### Windows PowerShell
```powershell
# Запустить сервер и сохранить логи в файл
node server.js 2>&1 | Tee-Object -FilePath logs.txt

# Или просто перенаправить в файл
node server.js > logs.txt 2>&1
```

### Linux/Mac
```bash
# Запустить сервер и сохранить логи
node server.js 2>&1 | tee logs.txt
```

### Фильтрация логов для конкретного запроса

После получения `requestId` из ошибки:
```powershell
# Windows
Select-String -Path logs.txt -Pattern "requestId"

# Linux/Mac
grep "requestId" logs.txt
```

## Анализ ошибок

### Шаги для анализа:

1. **Найдите requestId** из ответа ошибки
2. **Извлеките все логи** для этого requestId
3. **Найдите последнюю успешную операцию** перед ERROR
4. **Проверьте стек ошибки** в поле `errorStack`

### Пример анализа

```
[ACTIVITY-BY-MONTH] REQUEST_START {"requestId":"abc123",...}
[ACTIVITY-BY-MONTH] PARAMS_PARSED {"requestId":"abc123",...}
...
[ACTIVITY-BY-MONTH] FETCHING_DAILY_USAGE {"requestId":"abc123",...}
[DB] getAnalytics CALL {"options":{...}}
[DB] getAnalytics PARAMS {"endpoint":"/teams/daily-usage-data",...}
[ACTIVITY-BY-MONTH] ERROR {"requestId":"abc123","errorMessage":"Cannot read properties of undefined (reading 'default')","errorStack":"..."}
```

Ошибка произошла между FETCHING_DAILY_USAGE и ERROR.

## Общие проблемы

### "Cannot read properties of undefined (reading 'default')"

Возможные причины:
1. ES6 синтаксис (default parameters, destructuring, spread)
2. Старая версия Node.js
3. Проблемы с модулями

**Решение**: Проверьте версию Node.js (`node --version`), должна быть >= 12.0.0

### Пустые данные из БД

Проверьте логи:
- `[DB] getAnalytics ROWS_FETCHED` - сколько строк вернулось
- `[DB] getJiraUsers ROWS_FETCHED` - сколько пользователей

### Медленная обработка

Ищите большие значения в:
- `dailyRowsCount`
- `usageEventsRowsCount`
- `jiraRowsCount`

## Копирование логов для анализа

1. Запустите сервер с логированием
2. Воспроизведите ошибку
3. Скопируйте все логи с соответствующим `requestId`
4. Предоставьте ИИ для анализа
