# Анализ логов для поиска ошибок (Windows PowerShell)
#
# Использование:
#   .\scripts\analyze-logs.ps1

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataDir = Join-Path (Split-Path -Parent (Split-Path -Parent $ProjectDir)) "data"
$LogFile = Join-Path $DataDir "logs\app.log"

if (-not (Test-Path $LogFile)) {
    Write-Host "Лог-файл не найден: $LogFile"
    Write-Host "Сначала запустите приложение для создания логов"
    exit 1
}

Write-Host "=== Анализ логов Cursor API Dashboard ==="
Write-Host "Файл: $LogFile"
Write-Host ""

# Размер лог-файла
$LogSize = (Get-Item $LogFile).Length / 1MB
Write-Host "Размер лог-файла: $([math]::Round($LogSize, 2)) MB"

# Количество строк
$LogLines = (Get-Content $LogFile | Measure-Object -Line).Lines
Write-Host "Всего строк: $LogLines"
Write-Host ""

# Статистика по типам логов
Write-Host "=== Статистика по типам логов ==="
$RequestStarts = (Get-Content $LogFile | Select-String -Pattern "REQUEST_START" -AllMatches).Count
$ResponseSent = (Get-Content $LogFile | Select-String -Pattern "RESPONSE_SENT" -AllMatches).Count
$Errors = (Get-Content $LogFile | Select-String -Pattern "\[ACTIVITY-BY-MONTH\] ERROR" -AllMatches).Count
$DbAnalytics = (Get-Content $LogFile | Select-String -Pattern "\[DB\] getAnalytics CALL" -AllMatches).Count
$DbJira = (Get-Content $LogFile | Select-String -Pattern "\[DB\] getJiraUsers CALL" -AllMatches).Count

Write-Host "ACTIVITY-BY-MONTH запросов: $RequestStarts"
Write-Host "Успешных ответов (RESPONSE_SENT): $ResponseSent"
Write-Host "Ошибок (ERROR): $Errors"
Write-Host "DB запросов (getAnalytics): $DbAnalytics"
Write-Host "DB запросов (getJiraUsers): $DbJira"
Write-Host ""

# Последние ошибки
if ($Errors -gt 0) {
    Write-Host "=== Последние ошибки (до 5) ==="
    $ErrorLines = Get-Content $LogFile | Select-String -Pattern "\[ACTIVITY-BY-MONTH\] ERROR" | Select-Object -Last 5
    
    foreach ($ErrorLine in $ErrorLines) {
        $Line = $ErrorLine.Line
        
        # Извлечение requestId из JSON
        if ($Line -match '"requestId":"([^"]*)"') {
            $RequestId = $Matches[1]
        } else {
            $RequestId = "N/A"
        }
        
        # Извлечение errorMessage из JSON
        if ($Line -match '"errorMessage":"([^"]*)"') {
            $ErrorMsg = $Matches[1]
        } else {
            $ErrorMsg = "N/A"
        }
        
        Write-Host ""
        Write-Host "RequestID: $RequestId"
        Write-Host "Ошибка: $ErrorMsg"
        Write-Host "Полный лог:"
        Write-Host $Line
    }
    Write-Host ""
    
    # Извлечение последнего requestId с ошибкой
    $LastErrorLine = Get-Content $LogFile | Select-String -Pattern "\[ACTIVITY-BY-MONTH\] ERROR" | Select-Object -Last 1
    if ($LastErrorLine.Line -match '"requestId":"([^"]*)"') {
        $LastRequestId = $Matches[1]
        
        Write-Host "=== Полный трейс последней ошибки (requestId: $LastRequestId) ==="
        $OutputFile = "$env:TEMP\cursor-last-error.log"
        Write-Host "Сохраняем в $OutputFile"
        
        Get-Content $LogFile | Select-String -Pattern "requestId.*$LastRequestId" | ForEach-Object { $_.Line } | Out-File -FilePath $OutputFile -Encoding UTF8
        
        Write-Host ""
        Write-Host "Содержимое:"
        Get-Content $OutputFile
        Write-Host ""
        Write-Host "Для анализа ИИ скопируйте содержимое файла:"
        Write-Host "  Get-Content $OutputFile"
    }
}
else {
    Write-Host "=== Ошибок не найдено ==="
}

Write-Host ""
Write-Host "=== Последняя активность ==="
Get-Content $LogFile -Tail 10
