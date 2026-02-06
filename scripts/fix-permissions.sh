#!/bin/bash
# Исправление прав доступа для всех скриптов
# Использование: ./scripts/fix-permissions.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Установка прав на выполнение для всех скриптов в $SCRIPT_DIR..."

# Установить права на все .sh файлы
chmod +x "$SCRIPT_DIR"/*.sh

echo "Права установлены:"
ls -la "$SCRIPT_DIR"/*.sh

echo ""
echo "Теперь вы можете запускать:"
echo "  ./scripts/deploy.sh"
echo "  ./scripts/auto-deploy-check.sh"
echo "  ./scripts/view-logs.sh"
echo "  ./scripts/analyze-logs.sh"
