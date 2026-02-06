#!/bin/bash
# Проверка новых коммитов в origin и запуск deploy.sh при наличии обновлений.
# Запускается по cron на сервере, например каждые 5 минут:
#   */5 * * * * cd /opt/cursor/cursor-api-dashboard && ./scripts/auto-deploy-check.sh >> /var/log/cursor-deploy.log 2>&1
#
# Или однократно: ./scripts/auto-deploy-check.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"
BRANCH="${DEPLOY_BRANCH:-$(git -C "$PROJECT_DIR" branch --show-current)}"
DATA_DIR_PARENT="$(dirname "$(dirname "$SCRIPT_DIR")")"
DATA_DIR="${DATA_DIR:-$DATA_DIR_PARENT/data}"
LOG_DIR="$DATA_DIR/logs"

cd "$PROJECT_DIR"

# Создание директории логов если её нет
mkdir -p "$LOG_DIR" 2>/dev/null || true

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "[$(date -Iseconds)] Ошибка: $PROJECT_DIR не git-репозиторий."
  exit 1
fi

echo "[$(date -Iseconds)] Проверка обновлений в ветке $BRANCH..."

git fetch origin
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null)" || { echo "[$(date -Iseconds)] Ветка origin/$BRANCH не найдена."; exit 0; }

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[$(date -Iseconds)] Обновлений нет (HEAD: ${LOCAL:0:8})"
  exit 0
fi

echo "[$(date -Iseconds)] Найдены новые коммиты (local=${LOCAL:0:8}, origin/$BRANCH=${REMOTE:0:8})"

# Сохранение текущих логов приложения перед обновлением
if [ -f "$LOG_DIR/app.log" ]; then
  BACKUP_LOG="$LOG_DIR/app-before-deploy-$(date '+%Y%m%d-%H%M%S').log"
  echo "[$(date -Iseconds)] Резервная копия логов: $BACKUP_LOG"
  cp "$LOG_DIR/app.log" "$BACKUP_LOG" 2>/dev/null || true
fi

echo "[$(date -Iseconds)] Запуск deploy.sh..."

# Экспорт переменной окружения для каталога данных
export HOST_DATA_DIR="$DATA_DIR"

# Запуск deploy
if [ -f "$SCRIPT_DIR/deploy.sh" ]; then
  "$SCRIPT_DIR/deploy.sh"
else
  echo "[$(date -Iseconds)] ОШИБКА: deploy.sh не найден в $SCRIPT_DIR"
  exit 1
fi

# Проверка статуса контейнера после деплоя
echo "[$(date -Iseconds)] Проверка статуса контейнера..."
sleep 5

# Поддержка docker compose v1 и v2
if docker compose version > /dev/null 2>&1; then
  DCC="docker compose"
else
  DCC="docker-compose"
fi

cd "$PROJECT_DIR"

if $DCC ps | grep -q "Up"; then
  echo "[$(date -Iseconds)] ✓ Контейнер успешно запущен"
  
  # Показываем последние логи для проверки
  echo "[$(date -Iseconds)] Последние 10 строк логов:"
  $DCC logs --tail=10 app
  
  # Проверяем наличие ошибок в последних логах
  if $DCC logs --tail=50 app | grep -qi "error"; then
    echo "[$(date -Iseconds)] ⚠ Внимание: обнаружены ошибки в логах после деплоя!"
    echo "[$(date -Iseconds)] Проверьте логи командой: $DCC logs app"
  fi
else
  echo "[$(date -Iseconds)] ✗ ОШИБКА: Контейнер не запустился!"
  $DCC ps
  echo "[$(date -Iseconds)] Последние 50 строк логов:"
  $DCC logs --tail=50 app
  exit 1
fi

# Очистка старых резервных копий логов (старше 7 дней)
find "$LOG_DIR" -name "app-before-deploy-*.log" -mtime +7 -delete 2>/dev/null || true

echo "[$(date -Iseconds)] Проверка завершена. Логи приложения: $LOG_DIR/app.log"
