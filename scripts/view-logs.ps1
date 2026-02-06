# Просмотр логов контейнера Cursor API Dashboard (Windows PowerShell)
#
# Использование:
#   .\scripts\view-logs.ps1 [-Follow] [-Lines 50] [-Error] [-Activity] [-RequestId "abc123"]

param(
    [switch]$Follow,
    [int]$Lines = 50,
    [switch]$Error,
    [switch]$Activity,
    [string]$RequestId = "",
    [switch]$Help
)

if ($Help) {
    Write-Host "Просмотр логов Cursor API Dashboard"
    Write-Host ""
    Write-Host "Использование: .\scripts\view-logs.ps1 [опции]"
    Write-Host ""
    Write-Host "Опции:"
    Write-Host "  -Follow          Следить за логами в реальном времени"
    Write-Host "  -Lines NUM       Показать последние NUM строк (по умолчанию 50)"
    Write-Host "  -Error           Показать только ошибки"
    Write-Host "  -Activity        Показать только логи ACTIVITY-BY-MONTH"
    Write-Host "  -RequestId ID    Показать логи для конкретного requestId"
    Write-Host "  -Help            Показать эту справку"
    Write-Host ""
    Write-Host "Примеры:"
    Write-Host "  .\scripts\view-logs.ps1 -Follow"
    Write-Host "  .\scripts\view-logs.ps1 -Error"
    Write-Host "  .\scripts\view-logs.ps1 -Activity -Lines 100"
    Write-Host "  .\scripts\view-logs.ps1 -RequestId abc123xyz"
    exit 0
}

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataDir = Join-Path (Split-Path -Parent (Split-Path -Parent $ProjectDir)) "data"
$LogFile = Join-Path $DataDir "logs\app.log"

Set-Location $ProjectDir

# Проверка существования лог-файла
if (-not (Test-Path $LogFile)) {
    Write-Host "Лог-файл не найден: $LogFile"
    Write-Host "Используем логи Docker контейнера..."
    
    if ($Follow) {
        docker compose logs -f app
    } else {
        docker compose logs --tail=$Lines app
    }
    exit 0
}

Write-Host "Просмотр логов: $LogFile"
Write-Host "---"

# Фильтрация и вывод
if ($RequestId -ne "") {
    Write-Host "Фильтр: requestId=$RequestId"
    if ($Follow) {
        Get-Content $LogFile -Wait -Tail $Lines | Select-String -Pattern "requestId.*$RequestId"
    } else {
        Get-Content $LogFile | Select-String -Pattern "requestId.*$RequestId" | Select-Object -Last $Lines
    }
}
elseif ($Error) {
    Write-Host "Фильтр: ERROR"
    if ($Follow) {
        Get-Content $LogFile -Wait -Tail $Lines | Select-String -Pattern "ERROR"
    } else {
        Get-Content $LogFile | Select-String -Pattern "ERROR" | Select-Object -Last $Lines
    }
}
elseif ($Activity) {
    Write-Host "Фильтр: ACTIVITY-BY-MONTH"
    if ($Follow) {
        Get-Content $LogFile -Wait -Tail $Lines | Select-String -Pattern "ACTIVITY-BY-MONTH"
    } else {
        Get-Content $LogFile | Select-String -Pattern "ACTIVITY-BY-MONTH" | Select-Object -Last $Lines
    }
}
else {
    if ($Follow) {
        Get-Content $LogFile -Wait -Tail $Lines
    } else {
        Get-Content $LogFile -Tail $Lines
    }
}
