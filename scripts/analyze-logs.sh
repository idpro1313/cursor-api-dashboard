#!/bin/bash
# Анализ логов для поиска ошибок
#
# Использование:
#   chmod +x scripts/analyze-logs.sh
#   ./scripts/analyze-logs.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR_PARENT="$(dirname "$(dirname "$SCRIPT_DIR")")"
DATA_DIR="${DATA_DIR:-$DATA_DIR_PARENT/data}"
LOG_FILE="$DATA_DIR/logs/app.log"

if [ ! -f "$LOG_FILE" ]; then
  echo "Лог-файл не найден: $LOG_FILE"
  echo "Сначала запустите приложение для создания логов"
  exit 1
fi

echo "=== Анализ логов Cursor API Dashboard ==="
echo "Файл: $LOG_FILE"
echo ""

# Размер лог-файла
LOG_SIZE=$(du -h "$LOG_FILE" | cut -f1)
echo "Размер лог-файла: $LOG_SIZE"

# Количество строк
LOG_LINES=$(wc -l < "$LOG_FILE")
echo "Всего строк: $LOG_LINES"
echo ""

# Статистика по типам логов
echo "=== Статистика по типам логов ==="
echo "ACTIVITY-BY-MONTH запросов: $(grep -c 'REQUEST_START' "$LOG_FILE" 2>/dev/null || echo 0)"
echo "Успешных ответов (RESPONSE_SENT): $(grep -c 'RESPONSE_SENT' "$LOG_FILE" 2>/dev/null || echo 0)"
echo "Ошибок (ERROR): $(grep -c '\[ACTIVITY-BY-MONTH\] ERROR' "$LOG_FILE" 2>/dev/null || echo 0)"
echo "DB запросов (getAnalytics): $(grep -c '\[DB\] getAnalytics CALL' "$LOG_FILE" 2>/dev/null || echo 0)"
echo "DB запросов (getJiraUsers): $(grep -c '\[DB\] getJiraUsers CALL' "$LOG_FILE" 2>/dev/null || echo 0)"
echo ""

# Последние ошибки
ERRORS_COUNT=$(grep -c '\[ACTIVITY-BY-MONTH\] ERROR' "$LOG_FILE" 2>/dev/null || echo 0)
if [ "$ERRORS_COUNT" -gt 0 ]; then
  echo "=== Последние ошибки (до 5) ==="
  grep '\[ACTIVITY-BY-MONTH\] ERROR' "$LOG_FILE" | tail -n 5 | while read -r line; do
    # Извлечение requestId из JSON
    REQUEST_ID=$(echo "$line" | grep -o '"requestId":"[^"]*"' | cut -d'"' -f4)
    ERROR_MSG=$(echo "$line" | grep -o '"errorMessage":"[^"]*"' | cut -d'"' -f4)
    echo ""
    echo "RequestID: $REQUEST_ID"
    echo "Ошибка: $ERROR_MSG"
    echo "Полный лог:"
    echo "$line"
  done
  echo ""
  
  # Извлечение последнего requestId с ошибкой
  LAST_ERROR_LINE=$(grep '\[ACTIVITY-BY-MONTH\] ERROR' "$LOG_FILE" | tail -n 1)
  LAST_REQUEST_ID=$(echo "$LAST_ERROR_LINE" | grep -o '"requestId":"[^"]*"' | cut -d'"' -f4)
  
  if [ -n "$LAST_REQUEST_ID" ]; then
    echo "=== Полный трейс последней ошибки (requestId: $LAST_REQUEST_ID) ==="
    echo "Сохраняем в /tmp/cursor-last-error.log"
    grep "\"requestId\":\"$LAST_REQUEST_ID\"" "$LOG_FILE" > /tmp/cursor-last-error.log
    echo ""
    echo "Содержимое:"
    cat /tmp/cursor-last-error.log
    echo ""
    echo "Для анализа ИИ скопируйте содержимое файла:"
    echo "  cat /tmp/cursor-last-error.log"
  fi
else
  echo "=== Ошибок не найдено ==="
fi

echo ""
echo "=== Последняя активность ==="
tail -n 10 "$LOG_FILE"
