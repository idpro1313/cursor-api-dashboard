#!/bin/bash
# Просмотр логов контейнера Cursor API Dashboard
#
# Использование:
#   chmod +x scripts/view-logs.sh
#   ./scripts/view-logs.sh [опции]
#
# Опции:
#   -f, --follow       - Следить за логами в реальном времени
#   -n, --lines NUM    - Показать последние NUM строк (по умолчанию 50)
#   -e, --error        - Показать только ошибки
#   -a, --activity     - Показать только логи ACTIVITY-BY-MONTH
#   -r, --request ID   - Показать логи для конкретного requestId
#   -h, --help         - Показать эту справку

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR_PARENT="$(dirname "$(dirname "$SCRIPT_DIR")")"
DATA_DIR="${DATA_DIR:-$DATA_DIR_PARENT/data}"
LOG_FILE="$DATA_DIR/logs/app.log"

# Поддержка docker compose (v2) и docker-compose (v1)
if docker compose version > /dev/null 2>&1; then
  DCC="docker compose"
else
  DCC="docker-compose"
fi

cd "$PROJECT_DIR"

# Парсинг аргументов
FOLLOW=false
LINES=50
FILTER=""
REQUEST_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -f|--follow)
      FOLLOW=true
      shift
      ;;
    -n|--lines)
      LINES="$2"
      shift 2
      ;;
    -e|--error)
      FILTER="ERROR"
      shift
      ;;
    -a|--activity)
      FILTER="ACTIVITY-BY-MONTH"
      shift
      ;;
    -r|--request)
      REQUEST_ID="$2"
      shift 2
      ;;
    -h|--help)
      echo "Просмотр логов Cursor API Dashboard"
      echo ""
      echo "Использование: $0 [опции]"
      echo ""
      echo "Опции:"
      echo "  -f, --follow         Следить за логами в реальном времени"
      echo "  -n, --lines NUM      Показать последние NUM строк (по умолчанию 50)"
      echo "  -e, --error          Показать только ошибки"
      echo "  -a, --activity       Показать только логи ACTIVITY-BY-MONTH"
      echo "  -r, --request ID     Показать логи для конкретного requestId"
      echo "  -h, --help           Показать эту справку"
      echo ""
      echo "Примеры:"
      echo "  $0 -f                          # Следить за логами"
      echo "  $0 -e                          # Показать ошибки"
      echo "  $0 -a -n 100                   # Последние 100 строк ACTIVITY-BY-MONTH"
      echo "  $0 -r abc123xyz                # Логи для requestId=abc123xyz"
      exit 0
      ;;
    *)
      echo "Неизвестная опция: $1"
      echo "Используйте -h для справки"
      exit 1
      ;;
  esac
done

# Проверка существования лог-файла
if [ ! -f "$LOG_FILE" ]; then
  echo "Лог-файл не найден: $LOG_FILE"
  echo "Используем логи Docker контейнера..."
  if [ "$FOLLOW" = true ]; then
    $DCC logs -f app
  else
    $DCC logs --tail="$LINES" app
  fi
  exit 0
fi

echo "Просмотр логов: $LOG_FILE"
echo "---"

# Фильтрация и вывод
if [ -n "$REQUEST_ID" ]; then
  echo "Фильтр: requestId=$REQUEST_ID"
  if [ "$FOLLOW" = true ]; then
    tail -f "$LOG_FILE" | grep --line-buffered "\"requestId\":\"$REQUEST_ID\""
  else
    grep "\"requestId\":\"$REQUEST_ID\"" "$LOG_FILE" | tail -n "$LINES"
  fi
elif [ -n "$FILTER" ]; then
  echo "Фильтр: $FILTER"
  if [ "$FOLLOW" = true ]; then
    tail -f "$LOG_FILE" | grep --line-buffered "$FILTER"
  else
    grep "$FILTER" "$LOG_FILE" | tail -n "$LINES"
  fi
else
  if [ "$FOLLOW" = true ]; then
    tail -f "$LOG_FILE"
  else
    tail -n "$LINES" "$LOG_FILE"
  fi
fi
