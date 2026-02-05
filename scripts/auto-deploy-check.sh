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

cd "$PROJECT_DIR"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "[$(date -Iseconds)] Ошибка: $PROJECT_DIR не git-репозиторий."
  exit 1
fi

git fetch origin
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null)" || { echo "[$(date -Iseconds)] Ветка origin/$BRANCH не найдена."; exit 0; }

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "[$(date -Iseconds)] Найдены новые коммиты (local=$LOCAL, origin/$BRANCH=$REMOTE). Запуск deploy..."
exec "$SCRIPT_DIR/deploy.sh"
