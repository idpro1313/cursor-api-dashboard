# Быстрое получение логов на сервере (Ubuntu)

## ✅ Логи теперь создаются автоматически!

Приложение автоматически пишет все логи в `/opt/cursor/data/logs/app.log`

## 🔥 Если скрипты не работают (Permission Denied)

Подключитесь к серверу и выполните:

```bash
cd /opt/cursor/cursor-api-dashboard

# Способ 1: Быстрое исправление одной командой
chmod +x scripts/*.sh

# Способ 2: Через bash (временно, на один раз)
bash scripts/analyze-logs.sh

# Способ 3: Используйте скрипт исправления
chmod +x scripts/fix-permissions.sh
./scripts/fix-permissions.sh
```

## 📊 Получение логов после исправления

```bash
cd /opt/cursor/cursor-api-dashboard

# Анализ последней ошибки
./scripts/analyze-logs.sh

# Результат сохранён в
cat /tmp/cursor-last-error.log

# Скопировать на локальную машину
# На вашем компьютере (PowerShell):
# scp user@server:/tmp/cursor-last-error.log C:\temp\
```

## 🔍 Просмотр логов без скриптов

### Последние логи контейнера:
```bash
cd /opt/cursor/cursor-api-dashboard
docker compose logs --tail=100 app
```

### Логи из файла:
```bash
tail -100 /opt/cursor/data/logs/app.log
```

### Только ошибки:
```bash
grep ERROR /opt/cursor/data/logs/app.log | tail -20
```

### Логи конкретного запроса (из ошибки браузера):
```bash
# Замените abc123xyz на requestId из ошибки
grep '"requestId":"abc123xyz"' /opt/cursor/data/logs/app.log
```

## 📋 Копирование логов для анализа

### Вариант 1: Последние 200 строк с ошибками
```bash
grep -A 5 -B 5 ERROR /opt/cursor/data/logs/app.log | tail -200 > /tmp/error-context.log
cat /tmp/error-context.log
```

### Вариант 2: Все логи ACTIVITY-BY-MONTH за последние 10 минут
```bash
# Получить текущее время минус 10 минут
TIME_10MIN_AGO=$(date -d '10 minutes ago' '+%Y-%m-%d %H:%M')

# Фильтр по времени и типу
awk -v start="$TIME_10MIN_AGO" '$0 >= start' /opt/cursor/data/logs/app.log | \
  grep 'ACTIVITY-BY-MONTH' > /tmp/recent-activity.log

cat /tmp/recent-activity.log
```

### Вариант 3: Последний полный трейс ошибки
```bash
# Найти последний requestId с ошибкой
LAST_REQUEST=$(grep '\[ACTIVITY-BY-MONTH\] ERROR' /opt/cursor/data/logs/app.log | \
  tail -1 | grep -o '"requestId":"[^"]*"' | cut -d'"' -f4)

# Извлечь все логи для этого requestId
grep "\"requestId\":\"$LAST_REQUEST\"" /opt/cursor/data/logs/app.log > /tmp/last-error-trace.log

echo "RequestId: $LAST_REQUEST"
echo "Лог сохранён в /tmp/last-error-trace.log"
cat /tmp/last-error-trace.log
```

## 🔄 После получения обновлений

Каждый раз после `git pull` или автообновления:

```bash
cd /opt/cursor/cursor-api-dashboard

# Убедитесь, что права установлены
chmod +x scripts/*.sh

# Или добавьте в crontab перед запуском auto-deploy-check.sh
```

## 📝 Обновление crontab (опционально)

Чтобы права устанавливались автоматически:

```bash
crontab -e
```

Измените строку на:
```cron
*/5 * * * * cd /opt/cursor/cursor-api-dashboard && chmod +x scripts/*.sh && ./scripts/auto-deploy-check.sh >> /var/log/cursor-deploy.log 2>&1
```

## 🚀 Проверка работы

После исправления прав:

```bash
# Проверить права
ls -la scripts/*.sh

# Должно быть -rwxr-xr-x (с x)

# Запустить анализ
./scripts/analyze-logs.sh

# Следить за логами
./scripts/view-logs.sh -f
```

## 💡 Если скрипты всё равно не работают

Запускайте через bash явно:

```bash
bash scripts/analyze-logs.sh
bash scripts/view-logs.sh -f
bash scripts/deploy.sh
```

## 📞 Следующие шаги

1. ✅ Исправьте права: `chmod +x scripts/*.sh`
2. ✅ Запустите анализ: `./scripts/analyze-logs.sh`
3. ✅ Скопируйте результат: `cat /tmp/cursor-last-error.log`
4. ✅ Предоставьте логи для анализа
