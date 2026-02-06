# Docker Logging Guide / Руководство по логированию в Docker

## Просмотр логов

### 1. Логи Docker контейнера (stdout/stderr)

```bash
# Последние 50 строк
docker compose logs --tail=50 app

# В реальном времени
docker compose logs -f app

# С временными метками
docker compose logs -f --timestamps app

# Только за последний час
docker compose logs --since 1h app
```

### 2. Логи приложения из файла

Все логи дублируются в файл `/data/logs/app.log` (в контейнере) или `${HOST_DATA_DIR}/logs/app.log` (на хосте).

```bash
# На хосте (по умолчанию)
tail -f /var/cursor/data/logs/app.log

# Или используйте скрипт
./scripts/view-logs.sh -f

# Последние 100 строк
./scripts/view-logs.sh -n 100

# Только ошибки
./scripts/view-logs.sh -e

# Только логи ACTIVITY-BY-MONTH
./scripts/view-logs.sh -a

# Логи конкретного запроса
./scripts/view-logs.sh -r abc123xyz
```

## Анализ логов

### Автоматический анализ

```bash
./scripts/analyze-logs.sh
```

Скрипт покажет:
- Статистику запросов
- Последние ошибки
- Полный трейс последней ошибки
- Сохранит трейс в `/tmp/cursor-last-error.log`

### Ручной анализ

#### Найти все ошибки
```bash
grep 'ERROR' /var/cursor/data/logs/app.log
```

#### Найти логи конкретного requestId
```bash
grep '"requestId":"abc123xyz"' /var/cursor/data/logs/app.log
```

#### Подсчитать количество запросов
```bash
grep -c 'REQUEST_START' /var/cursor/data/logs/app.log
```

#### Найти запросы, которые не завершились
```bash
# Получить все requestId с REQUEST_START
grep 'REQUEST_START' /var/cursor/data/logs/app.log | grep -o '"requestId":"[^"]*"' > /tmp/starts.txt

# Получить все requestId с RESPONSE_SENT
grep 'RESPONSE_SENT' /var/cursor/data/logs/app.log | grep -o '"requestId":"[^"]*"' > /tmp/ends.txt

# Найти разницу
comm -23 <(sort /tmp/starts.txt) <(sort /tmp/ends.txt)
```

## Настройка логирования

### Изменить уровень логирования

В `docker-compose.yml` раскомментируйте/добавьте:

```yaml
environment:
  - DEBUG=cursor:*  # Включить debug логи (если поддерживается)
  - LOG_LEVEL=debug # Уровень логирования
```

### Изменить размер лог-файлов Docker

В `docker-compose.yml`:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "100m"  # Максимальный размер файла
    max-file: "10"    # Количество файлов ротации
```

### Ротация логов приложения

Создайте logrotate конфигурацию на хосте:

```bash
sudo nano /etc/logrotate.d/cursor-api-dashboard
```

Содержимое:
```
/var/cursor/data/logs/app.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    missingok
    copytruncate
}
```

## Очистка логов

### Очистка Docker логов
```bash
# Остановить контейнер
docker compose stop app

# Удалить лог-файлы Docker
sudo truncate -s 0 $(docker inspect --format='{{.LogPath}}' cursor-api-dashboard-app-1)

# Или удалить контейнер и пересоздать
docker compose down
docker compose up -d
```

### Очистка логов приложения
```bash
# Очистить файл
> /var/cursor/data/logs/app.log

# Или удалить старые логи
find /var/cursor/data/logs -name "app.log.*" -mtime +7 -delete
```

## Экспорт логов для анализа

### Экспорт последней ошибки
```bash
# Используйте скрипт
./scripts/analyze-logs.sh

# Результат в /tmp/cursor-last-error.log
cat /tmp/cursor-last-error.log
```

### Экспорт всех логов за период
```bash
# Все логи за сегодня
grep "$(date +%Y-%m-%d)" /var/cursor/data/logs/app.log > /tmp/today-logs.txt

# Все логи с ошибками за последние 7 дней
find /var/cursor/data/logs -name "*.log*" -mtime -7 -exec grep 'ERROR' {} \; > /tmp/week-errors.txt
```

## Мониторинг в реальном времени

### Следить за ошибками
```bash
tail -f /var/cursor/data/logs/app.log | grep --line-buffered 'ERROR'
```

### Следить за конкретным эндпоинтом
```bash
tail -f /var/cursor/data/logs/app.log | grep --line-buffered 'ACTIVITY-BY-MONTH'
```

### Уведомления о критичных ошибках
```bash
# Создайте скрипт мониторинга
cat > /usr/local/bin/cursor-monitor.sh << 'EOF'
#!/bin/bash
tail -f /var/cursor/data/logs/app.log | while read line; do
  if echo "$line" | grep -q 'ERROR'; then
    echo "$(date): CRITICAL ERROR DETECTED" | mail -s "Cursor API Error" admin@example.com
    echo "$line" >> /var/log/cursor-critical.log
  fi
done
EOF

chmod +x /usr/local/bin/cursor-monitor.sh

# Запустите как systemd service (опционально)
```

## Интеграция с системами мониторинга

### Prometheus + Grafana

Экспорт метрик через Docker:
```bash
docker compose --profile monitoring up -d
```

### ELK Stack (Elasticsearch, Logstash, Kibana)

Настройте Filebeat для отправки логов:
```yaml
# filebeat.yml
filebeat.inputs:
- type: log
  enabled: true
  paths:
    - /var/cursor/data/logs/*.log
  json.keys_under_root: true
  json.add_error_key: true

output.elasticsearch:
  hosts: ["localhost:9200"]
```

## Troubleshooting

### Логи не создаются
```bash
# Проверить, что директория существует и доступна
ls -la /var/cursor/data/logs/

# Проверить права доступа
sudo chown -R $(id -u):$(id -g) /var/cursor/data/logs/

# Проверить, что контейнер запущен
docker compose ps
```

### Логи слишком большие
```bash
# Включить ротацию (см. выше)
# Или уменьшить max-size в docker-compose.yml
```

### Не видны логи в реальном времени
```bash
# Проверить буферизацию stdout
# В docker-compose.yml добавьте:
tty: true
stdin_open: true
```
