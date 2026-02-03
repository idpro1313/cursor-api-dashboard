#!/bin/bash
# Обновление сайта из GitHub и пересборка Docker-контейнера (Ubuntu)
#
# Использование:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
# Или из каталога проекта с другим путём:
#   PROJECT_DIR=/opt/cursor-dashboard ./scripts/deploy.sh
set -e

# Каталог проекта (где лежит docker-compose.yml). По умолчанию — родитель папки scripts
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"

cd "$PROJECT_DIR"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Ошибка: $PROJECT_DIR не является git-репозиторием."
  exit 1
fi

echo "Каталог проекта: $PROJECT_DIR"
echo "--- Обновление из GitHub ---"
git fetch origin
git pull origin "$(git branch --show-current)"

# Поддержка и docker compose (v2), и docker-compose (v1)
if docker compose version > /dev/null 2>&1; then
  DCC="docker compose"
else
  DCC="docker-compose"
fi

echo "--- Пересборка и перезапуск контейнера ---"
$DCC build --no-cache
$DCC up -d

echo "--- Готово ---"
$DCC ps
