# Быстрый старт: Логирование

## 🚀 Запуск с логированием

### Windows (локально, без Docker)

```powershell
# 1. Создайте папку для логов
New-Item -ItemType Directory -Path "logs" -Force

# 2. Запустите с логированием
npm run start:log
```

Логи будут записываться в `logs/app.log` и выводиться в консоль.

### Windows (Docker)

```powershell
# 1. Создайте папку для данных
$DataDir = "C:\cursor\data"
New-Item -ItemType Directory -Path "$DataDir\logs" -Force

# 2. Установите переменную окружения
$env:HOST_DATA_DIR = $DataDir

# 3. Пересоберите и запустите контейнер
docker compose up -d --build

# 4. Просмотр логов
docker compose logs -f app

# Или используйте PowerShell скрипт
.\scripts\view-logs.ps1 -Follow
```

### Linux/Mac (Docker)

```bash
# 1. Создайте папку для данных
sudo mkdir -p /var/cursor/data/logs
sudo chown $(id -u):$(id -g) /var/cursor/data/logs

# 2. Пересоберите и запустите контейнер
./scripts/deploy.sh

# 3. Просмотр логов
docker compose logs -f app

# Или используйте bash скрипт
./scripts/view-logs.sh -f
```

## 📊 Анализ логов

### Windows

```powershell
# Автоматический анализ последней ошибки
.\scripts\analyze-logs.ps1

# Просмотр только ошибок
.\scripts\view-logs.ps1 -Error

# Логи конкретного запроса (из ошибки браузера)
.\scripts\view-logs.ps1 -RequestId "abc123xyz"
```

### Linux/Mac

```bash
# Автоматический анализ последней ошибки
./scripts/analyze-logs.sh

# Просмотр только ошибок
./scripts/view-logs.sh --error

# Логи конкретного запроса
./scripts/view-logs.sh --request abc123xyz
```

## 🔍 При возникновении ошибки

### Шаг 1: Воспроизведите ошибку
Откройте дашборд в браузере и дождитесь появления ошибки 500.

### Шаг 2: Получите requestId
В ответе ошибки будет `requestId`, например:
```json
{"error":"Cannot read properties of undefined (reading 'default')","requestId":"abc123xyz"}
```

### Шаг 3: Извлеките логи

**Windows:**
```powershell
.\scripts\view-logs.ps1 -RequestId "abc123xyz" | Out-File "$env:TEMP\error-log.txt"
Get-Content "$env:TEMP\error-log.txt"
```

**Linux/Mac:**
```bash
./scripts/view-logs.sh --request abc123xyz > /tmp/error-log.txt
cat /tmp/error-log.txt
```

### Шаг 4: Предоставьте логи
Скопируйте содержимое файла и предоставьте для анализа.

## 📁 Где находятся логи

### Локальный запуск
- `logs/app.log` - в корне проекта

### Docker Windows
- Контейнер: `/data/logs/app.log`
- Хост: `C:\cursor\data\logs\app.log` (или путь из `HOST_DATA_DIR`)
- Docker логи: `docker compose logs app`

### Docker Linux/Mac
- Контейнер: `/data/logs/app.log`
- Хост: `/var/cursor/data/logs/app.log`
- Docker логи: `docker compose logs app`

## 🛠️ Полезные команды

### Просмотр последних 50 строк
```powershell
# Windows
.\scripts\view-logs.ps1 -Lines 50

# Linux/Mac
./scripts/view-logs.sh -n 50
```

### Следить за логами в реальном времени
```powershell
# Windows
.\scripts\view-logs.ps1 -Follow

# Linux/Mac
./scripts/view-logs.sh -f
```

### Только логи эндпоинта ACTIVITY-BY-MONTH
```powershell
# Windows
.\scripts\view-logs.ps1 -Activity

# Linux/Mac
./scripts/view-logs.sh -a
```

### Статистика и анализ
```powershell
# Windows
.\scripts\analyze-logs.ps1

# Linux/Mac
./scripts/analyze-logs.sh
```

## 📚 Подробная документация

- **Windows**: см. `DOCKER_LOGGING_WINDOWS.md`
- **Linux/Mac**: см. `DOCKER_LOGGING.md`
- **Структура логов**: см. `LOGGING_GUIDE.md`

## ❓ Частые вопросы

### Логи не создаются
```powershell
# Проверьте права доступа
# Windows
Test-Path "C:\cursor\data\logs"

# Linux
ls -la /var/cursor/data/logs/
```

### Как очистить логи
```powershell
# Windows
Clear-Content "C:\cursor\data\logs\app.log"

# Linux
> /var/cursor/data/logs/app.log
```

### Лог-файл слишком большой
Настройте ротацию в `docker-compose.yml`:
```yaml
logging:
  options:
    max-size: "50m"  # Максимальный размер
    max-file: "5"    # Количество файлов
```
