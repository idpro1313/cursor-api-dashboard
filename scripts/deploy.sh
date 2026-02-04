#!/bin/bash
# Обновление сайта из GitHub и пересборка Docker-контейнера (Ubuntu)
#
# Использование:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
#
# Каталог данных на хосте по умолчанию: на 2 уровня выше скрипта (scripts/ → проект → …/data).
# Переопределение: PROJECT_DIR=/path/to/project или DATA_DIR=/path/to/data ./scripts/deploy.sh
# Переменные окружения контейнера задаются в docker-compose.yml (в образе есть Java 17, парсинг PDF-счетов включён по умолчанию).
set -e

# Каталог проекта (где лежит docker-compose.yml). По умолчанию — родитель папки scripts
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"
# Каталог данных — на два уровня выше скрипта (например .../scripts/ → .../data)
# Скрипт в /opt/cursor/cursor-api-dashboard/scripts/ → данные в /opt/cursor/data
DATA_DIR_PARENT="$(dirname "$(dirname "$SCRIPT_DIR")")"
DATA_DIR="${DATA_DIR:-$DATA_DIR_PARENT/data}"

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

# Создание каталога данных на хосте (монтируется в контейнер). Путь передаётся в docker-compose через HOST_DATA_DIR
export HOST_DATA_DIR="$DATA_DIR"
if [ ! -d "$DATA_DIR" ]; then
  echo "--- Создание каталога данных: $DATA_DIR ---"
  sudo mkdir -p "$DATA_DIR"
  sudo chown "$(id -u):$(id -g)" "$DATA_DIR" 2>/dev/null || true
fi

# Без --no-cache Docker переиспользует кэш слоёв: при изменении только кода (server.js, db.js, lib/*, public/*)
# пересоберётся только последний слой, npm install не перезапускается.
# Для полной пересборки (после смены package.json или Dockerfile): FULL_REBUILD=1 ./scripts/deploy.sh
echo "--- Сборка и перезапуск контейнера ---"
if [ "${FULL_REBUILD}" = "1" ]; then
  $DCC build --no-cache
else
  $DCC build
fi
$DCC up -d

# После пересборки старый образ остаётся как dangling (<none>:<none>). Удаляем его.
echo "--- Удаление старого образа контейнера ---"
docker image prune -f

echo "--- Готово ---"
$DCC ps
