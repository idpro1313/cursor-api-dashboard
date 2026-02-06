# Исправление прав доступа к скриптам

## Проблема

При попытке запустить скрипт возникает ошибка:
```
-bash: ./scripts/analyze-logs.sh: Permission denied
```

## Решение

### Вариант 1: Автоматическое исправление

На сервере выполните:

```bash
cd /opt/cursor/cursor-api-dashboard

# Сделайте исполняемым скрипт исправления
chmod +x scripts/fix-permissions.sh

# Запустите его
./scripts/fix-permissions.sh
```

### Вариант 2: Ручное исправление

```bash
cd /opt/cursor/cursor-api-dashboard

# Установите права на выполнение для всех скриптов
chmod +x scripts/*.sh

# Проверьте
ls -la scripts/*.sh
```

### Вариант 3: Исправление для конкретных скриптов

```bash
cd /opt/cursor/cursor-api-dashboard

# Только необходимые скрипты
chmod +x scripts/deploy.sh
chmod +x scripts/auto-deploy-check.sh
chmod +x scripts/view-logs.sh
chmod +x scripts/analyze-logs.sh
chmod +x scripts/fix-permissions.sh
```

## Проверка прав

После исправления проверьте:

```bash
ls -la scripts/*.sh
```

Должно быть `-rwxr-xr-x` (с `x` - исполняемый).

## Если проблема повторяется после git pull

Git не сохраняет права на выполнение в некоторых случаях. 

### Решение 1: Автоматизация через deploy.sh

В скрипт `scripts/deploy.sh` уже добавлена автоматическая установка прав.
При каждом деплое права будут восстанавливаться.

### Решение 2: Git hook

Создайте git hook для автоматической установки прав после pull:

```bash
cd /opt/cursor/cursor-api-dashboard

# Создайте post-merge hook
cat > .git/hooks/post-merge << 'EOF'
#!/bin/bash
echo "Установка прав на скрипты после git pull..."
chmod +x scripts/*.sh
EOF

# Сделайте hook исполняемым
chmod +x .git/hooks/post-merge
```

### Решение 3: Добавьте в crontab

Измените задачу cron, чтобы устанавливать права перед запуском:

```bash
crontab -e
```

Измените строку:
```bash
*/5 * * * * cd /opt/cursor/cursor-api-dashboard && chmod +x scripts/*.sh && ./scripts/auto-deploy-check.sh >> /var/log/cursor-deploy.log 2>&1
```

## Запуск скриптов без прав на выполнение

Если не можете изменить права, запускайте через bash:

```bash
# Вместо ./scripts/analyze-logs.sh
bash scripts/analyze-logs.sh

# Вместо ./scripts/view-logs.sh -f
bash scripts/view-logs.sh -f

# Вместо ./scripts/deploy.sh
bash scripts/deploy.sh
```

## Проверка, что права установлены правильно

```bash
# Все скрипты должны быть исполняемыми
ls -la scripts/*.sh | grep -v "x"

# Если ничего не выводит - всё хорошо
# Если выводит файлы - у них нет прав на выполнение
```

## Для Windows Git

Если вы работаете с репозиторием на Windows и пушите в Git:

### В Git Bash на Windows:

```bash
cd /c/Users/iyatsishen/OneDrive/Cursor/cursor-api-dashboard

# Установить права в Git
git update-index --chmod=+x scripts/deploy.sh
git update-index --chmod=+x scripts/auto-deploy-check.sh
git update-index --chmod=+x scripts/view-logs.sh
git update-index --chmod=+x scripts/analyze-logs.sh
git update-index --chmod=+x scripts/fix-permissions.sh

# Закоммитить изменения
git commit -m "fix: add execute permissions to scripts"
git push
```

### Проверить в Git:

```bash
git ls-files --stage scripts/*.sh
```

Должно быть `100755` вместо `100644`:
```
100755 hash scripts/deploy.sh
100755 hash scripts/analyze-logs.sh
...
```

## Альтернатива: использование sudo

Если у вас нет прав менять файлы:

```bash
sudo chmod +x /opt/cursor/cursor-api-dashboard/scripts/*.sh
```

## После исправления

Теперь можно запускать:

```bash
cd /opt/cursor/cursor-api-dashboard

# Анализ логов
./scripts/analyze-logs.sh

# Просмотр логов
./scripts/view-logs.sh -f

# Деплой
./scripts/deploy.sh

# Автопроверка обновлений
./scripts/auto-deploy-check.sh
```
