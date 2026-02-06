# Настройка сервера Ubuntu для логирования

## 📋 Текущая настройка

Приложение запущено на Ubuntu сервере в Docker с автообновлением через crontab.

## 🔧 Настройка crontab для логирования

### 1. Откройте crontab

```bash
crontab -e
```

### 2. Обновите задачу автодеплоя

Замените существующую строку на:

```bash
*/5 * * * * cd /opt/cursor/cursor-api-dashboard && ./scripts/auto-deploy-check.sh >> /var/log/cursor-deploy.log 2>&1
```

Или добавьте логирование в отдельный файл:

```bash
*/5 * * * * cd /opt/cursor/cursor-api-dashboard && ./scripts/auto-deploy-check.sh >> /var/log/cursor-auto-deploy.log 2>&1
```

### 3. Убедитесь, что директории существуют

```bash
# Создайте директорию для логов приложения
sudo mkdir -p /opt/cursor/data/logs
sudo chown -R $USER:$USER /opt/cursor/data/logs

# Создайте файл для логов cron
sudo touch /var/log/cursor-deploy.log
sudo chown $USER:$USER /var/log/cursor-deploy.log
```

## 📊 Просмотр логов на сервере

### Логи автодеплоя (cron)

```bash
# Последние 50 строк
tail -f /var/log/cursor-deploy.log

# Только ошибки
grep -i error /var/log/cursor-deploy.log

# Последний деплой
grep "Запуск deploy" /var/log/cursor-deploy.log | tail -1
```

### Логи приложения

```bash
# Логи Docker контейнера
cd /opt/cursor/cursor-api-dashboard
docker compose logs -f app

# Логи из файла
tail -f /opt/cursor/data/logs/app.log

# Только ошибки
grep ERROR /opt/cursor/data/logs/app.log

# Логи конкретного запроса
grep '"requestId":"abc123xyz"' /opt/cursor/data/logs/app.log

# Используйте скрипты
cd /opt/cursor/cursor-api-dashboard
./scripts/view-logs.sh -f
./scripts/analyze-logs.sh
```

## 🔍 Анализ ошибок после автодеплоя

### Если после обновления возникла ошибка:

1. **Проверьте статус контейнера:**
   ```bash
   cd /opt/cursor/cursor-api-dashboard
   docker compose ps
   ```

2. **Просмотрите логи деплоя:**
   ```bash
   tail -100 /var/log/cursor-deploy.log
   ```

3. **Просмотрите логи приложения:**
   ```bash
   docker compose logs --tail=100 app
   ```

4. **Проанализируйте ошибки:**
   ```bash
   cd /opt/cursor/cursor-api-dashboard
   ./scripts/analyze-logs.sh
   ```

5. **Экспортируйте логи для анализа:**
   ```bash
   # Сохранить в файл
   grep ERROR /opt/cursor/data/logs/app.log > /tmp/errors.log
   
   # Скопировать на локальную машину
   scp user@server:/tmp/errors.log ./
   ```

## 🛠️ Ручное обновление с логированием

Если нужно обновить вручную:

```bash
# Перейдите в директорию проекта
cd /opt/cursor/cursor-api-dashboard

# Запустите deploy с выводом в консоль
./scripts/deploy.sh 2>&1 | tee /tmp/deploy-$(date +%Y%m%d-%H%M%S).log

# Или используйте auto-deploy-check вручную
./scripts/auto-deploy-check.sh
```

## 📁 Структура логов на сервере

```
/opt/cursor/
├── cursor-api-dashboard/          # Код приложения
│   ├── scripts/
│   │   ├── auto-deploy-check.sh   # Скрипт автообновления
│   │   ├── deploy.sh              # Скрипт деплоя
│   │   ├── view-logs.sh           # Просмотр логов
│   │   └── analyze-logs.sh        # Анализ логов
│   └── docker-compose.yml
└── data/                          # Данные и логи
    ├── analytics.db               # База данных
    ├── sync.log                   # Логи синхронизации API
    └── logs/                      # Логи приложения
        ├── app.log                # Текущие логи
        └── app-before-deploy-*.log # Резервные копии перед деплоем

/var/log/
└── cursor-deploy.log              # Логи cron автодеплоя
```

## 🔄 Ротация логов

### Настройка logrotate

Создайте конфигурацию:

```bash
sudo nano /etc/logrotate.d/cursor-api-dashboard
```

Содержимое:

```
/opt/cursor/data/logs/app.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    missingok
    copytruncate
    su youruser yourgroup
}

/var/log/cursor-deploy.log {
    weekly
    rotate 8
    compress
    delaycompress
    notifempty
    missingok
    copytruncate
}
```

Замените `youruser` и `yourgroup` на вашего пользователя.

Проверка конфигурации:

```bash
sudo logrotate -d /etc/logrotate.d/cursor-api-dashboard
```

## 🚨 Мониторинг и уведомления

### Простой мониторинг через email

Создайте скрипт мониторинга:

```bash
sudo nano /usr/local/bin/cursor-monitor.sh
```

Содержимое:

```bash
#!/bin/bash
LOG_FILE="/opt/cursor/data/logs/app.log"
ALERT_EMAIL="admin@example.com"

# Проверка критических ошибок за последние 5 минут
ERRORS=$(find "$LOG_FILE" -mmin -5 -exec grep -c "ERROR" {} \; 2>/dev/null || echo 0)

if [ "$ERRORS" -gt 5 ]; then
    echo "Обнаружено $ERRORS ошибок за последние 5 минут" | \
    mail -s "Cursor API Dashboard: Критические ошибки" "$ALERT_EMAIL"
fi
```

Добавьте в crontab:

```bash
*/5 * * * * /usr/local/bin/cursor-monitor.sh
```

### Проверка доступности

```bash
#!/bin/bash
# /usr/local/bin/cursor-healthcheck.sh

URL="http://localhost:3333"
ALERT_EMAIL="admin@example.com"

if ! curl -sf "$URL" > /dev/null; then
    echo "Приложение недоступно на $URL" | \
    mail -s "Cursor API Dashboard: Сервис недоступен" "$ALERT_EMAIL"
    
    # Попытка перезапуска
    cd /opt/cursor/cursor-api-dashboard
    docker compose restart app
fi
```

Добавьте в crontab:

```bash
*/10 * * * * /usr/local/bin/cursor-healthcheck.sh
```

## 📊 Анализ производительности

### Мониторинг использования ресурсов

```bash
# Использование памяти контейнером
docker stats cursor-api-dashboard-app-1 --no-stream

# Размер логов
du -sh /opt/cursor/data/logs/

# Размер базы данных
du -sh /opt/cursor/data/analytics.db
```

### Просмотр медленных запросов

```bash
# Запросы, которые выполнялись долго
grep -E "RESPONSE_SENT.*[0-9]{4,}" /opt/cursor/data/logs/app.log
```

## 🔐 Безопасность логов

### Ограничение доступа

```bash
# Только владелец может читать логи
chmod 600 /opt/cursor/data/logs/app.log
chmod 600 /var/log/cursor-deploy.log

# Или разрешить группе
chmod 640 /opt/cursor/data/logs/app.log
chown youruser:yourgroup /opt/cursor/data/logs/app.log
```

### Очистка старых логов

```bash
# Удалить логи старше 30 дней
find /opt/cursor/data/logs -name "*.log" -mtime +30 -delete

# Удалить резервные копии старше 7 дней (уже в auto-deploy-check.sh)
find /opt/cursor/data/logs -name "app-before-deploy-*.log" -mtime +7 -delete
```

## 📝 Полезные алиасы

Добавьте в `~/.bashrc`:

```bash
# Cursor API Dashboard aliases
alias cursor-logs='docker compose -f /opt/cursor/cursor-api-dashboard/docker-compose.yml logs -f app'
alias cursor-status='docker compose -f /opt/cursor/cursor-api-dashboard/docker-compose.yml ps'
alias cursor-restart='docker compose -f /opt/cursor/cursor-api-dashboard/docker-compose.yml restart app'
alias cursor-deploy='cd /opt/cursor/cursor-api-dashboard && ./scripts/deploy.sh'
alias cursor-analyze='cd /opt/cursor/cursor-api-dashboard && ./scripts/analyze-logs.sh'
alias cursor-tail='tail -f /opt/cursor/data/logs/app.log'
alias cursor-errors='grep ERROR /opt/cursor/data/logs/app.log | tail -20'
```

Применить:

```bash
source ~/.bashrc
```

## 🆘 Troubleshooting

### Контейнер не запускается после обновления

```bash
# Проверьте логи
cd /opt/cursor/cursor-api-dashboard
docker compose logs app

# Проверьте последний деплой
tail -50 /var/log/cursor-deploy.log

# Откатитесь на предыдущую версию
git log --oneline -5
git checkout <previous-commit-hash>
./scripts/deploy.sh
```

### Логи не создаются

```bash
# Проверьте права
ls -la /opt/cursor/data/logs/

# Создайте директорию
sudo mkdir -p /opt/cursor/data/logs
sudo chown -R $USER:$USER /opt/cursor/data/logs

# Перезапустите контейнер
docker compose restart app
```

### Cron не работает

```bash
# Проверьте статус cron
sudo systemctl status cron

# Проверьте логи cron
sudo tail -f /var/log/syslog | grep CRON

# Проверьте права на скрипт
chmod +x /opt/cursor/cursor-api-dashboard/scripts/auto-deploy-check.sh
```
