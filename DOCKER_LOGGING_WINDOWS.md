# Docker Logging Guide для Windows

## Просмотр логов в Windows

### 1. Логи Docker контейнера

```powershell
# Последние 50 строк
docker compose logs --tail=50 app

# В реальном времени
docker compose logs -f app

# С временными метками
docker compose logs -f --timestamps app
```

### 2. Логи приложения из файла (PowerShell)

Используйте PowerShell скрипты:

```powershell
# Следить за логами
.\scripts\view-logs.ps1 -Follow

# Последние 100 строк
.\scripts\view-logs.ps1 -Lines 100

# Только ошибки
.\scripts\view-logs.ps1 -Error

# Только логи ACTIVITY-BY-MONTH
.\scripts\view-logs.ps1 -Activity

# Логи конкретного запроса
.\scripts\view-logs.ps1 -RequestId "abc123xyz"
```

## Анализ логов

### Автоматический анализ

```powershell
.\scripts\analyze-logs.ps1
```

Скрипт покажет:
- Статистику запросов
- Последние ошибки
- Полный трейс последней ошибки
- Сохранит трейс в `%TEMP%\cursor-last-error.log`

### Ручной анализ (PowerShell)

#### Найти все ошибки
```powershell
Get-Content "$env:USERPROFILE\..\..\data\logs\app.log" | Select-String -Pattern "ERROR"
```

#### Найти логи конкретного requestId
```powershell
Get-Content "$env:USERPROFILE\..\..\data\logs\app.log" | Select-String -Pattern 'requestId":"abc123xyz'
```

#### Подсчитать количество запросов
```powershell
(Get-Content "$env:USERPROFILE\..\..\data\logs\app.log" | Select-String -Pattern "REQUEST_START").Count
```

## Запуск с логированием

### Через npm (локально, без Docker)

```powershell
# Запуск с записью логов
npm run start:log

# Просмотр логов в реальном времени (в другом окне)
npm run logs:view

# Поиск ошибок
npm run logs:error

# Фильтр по ACTIVITY-BY-MONTH
npm run logs:activity
```

### Через Docker Compose

```powershell
# Пересоздать контейнер с новыми настройками логирования
docker compose up -d --build

# Просмотр логов
docker compose logs -f app
```

## Где находятся логи

### В Docker контейнере
- `/data/logs/app.log` - основной лог-файл приложения

### На хосте (Windows)

По умолчанию (если используете именованный том):
```
\\wsl$\docker-desktop-data\data\docker\volumes\cursor_data\_data\logs\app.log
```

Если примонтирована локальная папка:
```
C:\cursor\data\logs\app.log
```

### Docker логи (системные)

```powershell
# Найти путь к лог-файлу контейнера
docker inspect --format='{{.LogPath}}' cursor-api-dashboard-app-1
```

## Настройка для Windows

### Использование именованного тома

В `docker-compose.yml` раскомментируйте:

```yaml
volumes:
  - cursor_data:/data

volumes:
  cursor_data:
```

### Монтирование локальной папки Windows

```yaml
volumes:
  - C:/cursor/data:/data
```

Или через переменную окружения:

```powershell
$env:HOST_DATA_DIR = "C:\cursor\data"
docker compose up -d
```

## Очистка логов

### Очистка Docker логов
```powershell
# Остановить контейнер
docker compose stop app

# Удалить контейнер и логи
docker compose down
docker compose up -d
```

### Очистка логов приложения
```powershell
# Очистить файл
Clear-Content "C:\cursor\data\logs\app.log"

# Или удалить старые логи
Get-ChildItem "C:\cursor\data\logs" -Filter "app.log.*" | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item
```

## Экспорт логов для анализа

### Экспорт последней ошибки
```powershell
# Используйте скрипт
.\scripts\analyze-logs.ps1

# Результат в %TEMP%\cursor-last-error.log
Get-Content "$env:TEMP\cursor-last-error.log"

# Скопировать в буфер обмена
Get-Content "$env:TEMP\cursor-last-error.log" | Set-Clipboard
```

### Экспорт всех логов за период
```powershell
# Все логи за сегодня
$Today = Get-Date -Format "yyyy-MM-dd"
Get-Content "C:\cursor\data\logs\app.log" | Select-String -Pattern $Today | Out-File "$env:TEMP\today-logs.txt"

# Все логи с ошибками за последние 7 дней
Get-ChildItem "C:\cursor\data\logs" -Filter "*.log*" | Where-Object {$_.LastWriteTime -gt (Get-Date).AddDays(-7)} | ForEach-Object { Get-Content $_.FullName | Select-String -Pattern "ERROR" } | Out-File "$env:TEMP\week-errors.txt"
```

## Мониторинг в реальном времени

### Следить за ошибками
```powershell
Get-Content "C:\cursor\data\logs\app.log" -Wait -Tail 50 | Select-String -Pattern "ERROR"
```

### Следить за конкретным эндпоинтом
```powershell
Get-Content "C:\cursor\data\logs\app.log" -Wait -Tail 50 | Select-String -Pattern "ACTIVITY-BY-MONTH"
```

## Troubleshooting

### Логи не создаются

```powershell
# Проверить, что директория существует
Test-Path "C:\cursor\data\logs"

# Создать директорию если нет
New-Item -ItemType Directory -Path "C:\cursor\data\logs" -Force

# Проверить, что контейнер запущен
docker compose ps

# Проверить логи Docker
docker compose logs app
```

### Не видны логи в реальном времени

Убедитесь, что в `docker-compose.yml` есть:
```yaml
tty: true
stdin_open: true
```

### Проблемы с правами доступа (WSL2)

```powershell
# Если используете WSL2 backend
wsl -d docker-desktop
chmod -R 777 /data/logs
exit
```
