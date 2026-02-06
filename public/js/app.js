/**
 * Cursor Admin API Dashboard — клиентская логика (загрузка в БД).
 * Документация: https://cursor.com/docs/account/teams/admin-api
 * Использует common.js: getEndpointLabel, escapeHtml, fetchWithAuth.
 */

let apiKeyConfigured = false;

function showApiKeyForm(message) {
  const row = document.getElementById('apiKeyRow');
  const note = document.getElementById('apiKeySavedNote');
  const hint = document.getElementById('apiKeyHint');
  const errEl = document.getElementById('apiKeyError');
  if (row) row.style.display = 'flex';
  if (note) note.style.display = 'none';
  if (hint) hint.style.display = 'block';
  if (errEl) {
    errEl.style.display = message ? 'block' : 'none';
    errEl.textContent = message || '';
  }
  document.getElementById('apiKey')?.focus();
}

function applyApiKeyConfig(configured) {
  apiKeyConfigured = !!configured;
  const row = document.getElementById('apiKeyRow');
  const note = document.getElementById('apiKeySavedNote');
  const hint = document.getElementById('apiKeyHint');
  const errEl = document.getElementById('apiKeyError');
  if (row) row.style.display = configured ? 'none' : 'flex';
  if (note) note.style.display = configured ? 'block' : 'none';
  if (hint) hint.style.display = configured ? 'none' : 'block';
  if (errEl) errEl.style.display = 'none';
}

async function init() {
  try {
    const r = await fetchWithAuth('/api/config');
    if (!r) return;
    const data = await r.json();
    applyApiKeyConfig(data.apiKeyConfigured);
  } catch (_) {
    applyApiKeyConfig(false);
  }
  if (!apiKeyConfigured) {
    const saved = sessionStorage.getItem('cursor_api_key');
    if (saved) document.getElementById('apiKey').value = saved;
  }

  document.getElementById('btnClearApiData')?.addEventListener('click', async () => {
    if (!confirm('Очистить только данные API (аналитика по эндпоинтам)? Данные Jira и настройки не затронуты. Действие нельзя отменить.')) return;
    try {
      const r = await fetchWithAuth('/api/clear-analytics', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!r) return;
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      alert(data.message || 'Данные API очищены.');
      loadAdminCoverage();
    } catch (e) {
      alert(e.message || 'Ошибка очистки');
    }
  });

  document.getElementById('btnClearDb')?.addEventListener('click', async () => {
    const includeSettings = document.getElementById('clearDbIncludeSettings')?.checked;
    const msg = includeSettings
      ? 'Очистить всю БД (аналитика, пользователи Jira, настройки и API key)? Это действие нельзя отменить.'
      : 'Очистить аналитику и пользователей Jira? API key будет сохранён. Действие нельзя отменить.';
    if (!confirm(msg)) return;
    try {
      const r = await fetchWithAuth('/api/clear-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearSettings: includeSettings }),
      });
      if (!r) return;
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      alert(data.message || 'БД очищена.');
      if (includeSettings) applyApiKeyConfig(false);
      loadAdminCoverage();
    } catch (e) {
      alert(e.message || 'Ошибка очистки БД');
    }
  });

  document.getElementById('btnSaveApiKey').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKey').value.trim();
    if (!apiKey) { alert('Введите API key'); return; }
    try {
      const r = await fetchWithAuth('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      if (!r) return;
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      applyApiKeyConfig(true);
      alert('Ключ сохранён в БД.');
    } catch (e) {
      alert(e.message || 'Ошибка сохранения');
    }
  });

  const syncStart = document.getElementById('syncStartDate');
  if (syncStart && !syncStart.value) {
    syncStart.value = '2025-06-01';
  }
  document.getElementById('btnSync').addEventListener('click', runSync);
  document.getElementById('btnRefreshCoverage').addEventListener('click', loadAdminCoverage);
  document.getElementById('btnChangeApiKey')?.addEventListener('click', () => showApiKeyForm());
  loadAdminCoverage();
}

async function loadAdminCoverage() {
  const el = document.getElementById('coverageList');
  if (!el) return;
  try {
    const r = await fetchWithAuth('/api/analytics/coverage');
    if (!r) return;
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const cov = data.coverage || [];
    if (cov.length === 0) {
      el.innerHTML = '<span class="muted">БД пуста. Нажмите «Загрузить и сохранить в БД» — загрузятся все эндпоинты.</span>';
      return;
    }
    el.innerHTML = `
      <table class="coverage-table">
        <thead><tr><th>Эндпоинт</th><th>С</th><th>По</th><th>Дней</th></tr></thead>
        <tbody>
          ${cov.map(c => `
            <tr>
              <td>${escapeHtml(getEndpointLabel(c.endpoint))}</td>
              <td>${escapeHtml(c.min_date)}</td>
              <td>${escapeHtml(c.max_date)}</td>
              <td>${c.days}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    el.innerHTML = '<span class="error">' + escapeHtml(e.message) + '</span>';
  }
}

function showSyncResult(resultEl, data, isError) {
  resultEl.style.display = 'block';
  resultEl.className = isError ? 'sync-result error' : 'sync-result ok';
  if (isError) {
    resultEl.textContent = data.error || 'Ошибка';
    return;
  }
  const contextActions = `
    <div style="margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap;">
      <a href="index.html" class="btn btn-secondary">→ Посмотреть на дашборде</a>
      <a href="#data" class="btn btn-secondary">→ Просмотр сырых данных БД</a>
    </div>
  `;
  resultEl.innerHTML = `
    ${escapeHtml(data.message)}<br>
    ${data.skipped && data.skipped.length ? '<br>Пропущено (функция не включена): ' + data.skipped.map(s => escapeHtml(s.endpoint)).join(', ') : ''}
    ${data.errors && data.errors.length ? '<br>Ошибки по эндпоинтам: ' + data.errors.map(e => escapeHtml(e.endpoint + ': ' + e.error)).join('; ') : ''}
    ${contextActions}
  `;
}

async function runSync() {
  const apiKeyInput = document.getElementById('apiKey').value.trim();
  if (!apiKeyConfigured && !apiKeyInput) {
    showApiKeyForm('Введите и сохраните API key для выгрузки.');
    return;
  }
  const startDate = document.getElementById('syncStartDate').value;
  if (!startDate) {
    alert('Укажите начальную дату');
    return;
  }
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const endDate = yesterday.toISOString().slice(0, 10);
  const progressRow = document.getElementById('syncProgressRow');
  const progressText = document.getElementById('syncProgressText');
  const progressBar = document.getElementById('syncProgressBar');
  const progressDetail = document.getElementById('syncProgressDetail');
  const resultEl = document.getElementById('syncResult');
  const btnSync = document.getElementById('btnSync');

  const syncPlan = document.getElementById('syncPlan');
  const syncLog = document.getElementById('syncLog');
  const syncLogWrap = document.getElementById('syncLogWrap');

  progressRow.style.display = 'block';
  resultEl.style.display = 'none';
  btnSync.disabled = true;
  progressText.textContent = 'Подготовка...';
  if (progressBar) progressBar.style.width = '0%';
  if (progressDetail) progressDetail.textContent = '';
  if (syncPlan) { syncPlan.style.display = 'none'; syncPlan.innerHTML = ''; }
  if (syncLog) syncLog.innerHTML = '';
  if (syncLogWrap) syncLogWrap.style.display = 'block';

  function appendLog(className, text, sub) {
    if (!syncLog) return;
    const entry = document.createElement('div');
    entry.className = 'sync-log-entry ' + className;
    const ts = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = sub
      ? `<span class="ts">${ts}</span><span>${escapeHtml(text)}</span>`
      : `<span class="ts">${ts}</span><span>${escapeHtml(text)}</span>`;
    syncLog.appendChild(entry);
    syncLogWrap.scrollTop = syncLogWrap.scrollHeight;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (!apiKeyConfigured) headers['X-API-Key'] = document.getElementById('apiKey').value.trim();

  try {
    const r = await fetchWithAuth('/api/sync-stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({ startDate, endDate }),
    });
    if (!r) return;
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      progressRow.style.display = 'none';
      btnSync.disabled = false;
      showSyncResult(resultEl, { error: err.error || r.statusText }, true);
      return;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'plan') {
            if (syncPlan) {
              syncPlan.style.display = 'block';
              const totalDays = Math.ceil((new Date(event.endCapped + 'T00:00:00Z') - new Date(event.startDate + 'T00:00:00Z')) / (24 * 60 * 60 * 1000)) + 1;
              const breakdownList = (event.breakdown || []).map((b) => {
                if (b.type === 'snapshot') return `<li>${escapeHtml(b.endpointLabel)} — снимок</li>`;
                const chunkText = `${b.chunksCount || 0} чанков`;
                const detail = b.missingDays != null && b.rangesCount != null
                  ? ` (${b.missingDays} дней отсутствует в ${b.rangesCount} диапазонах)`
                  : ' (по 30 дней)';
                return `<li>${escapeHtml(b.endpointLabel)} — ${chunkText}${detail}</li>`;
              }).join('');
              syncPlan.innerHTML = `
                <strong>План:</strong> период ${escapeHtml(event.startDate)} – ${escapeHtml(event.endCapped)} (всего ${totalDays} дней), шагов: ${event.totalSteps || 0}
                <ul>${breakdownList}</ul>
                <span class="meta">Если чанков много при малом периоде — в БД уже есть часть данных, а отсутствующие дни разбиты на много «дыр». При пустой БД за 5 мес. будет ~6 чанков.</span>
              `;
            }
            appendLog('', `План загрузки: ${event.startDate} – ${event.endCapped}, ${event.totalSteps} шагов`);
          } else if (event.type === 'progress') {
            if (event.phase === 'requesting') {
              if (event.subPhase === 'page') {
                appendLog('page', `Страница ${event.page}`, true);
              } else {
                const label = event.chunkLabel
                  ? `${event.endpointLabel} · ${event.chunkLabel}`
                  : event.endpointLabel;
                appendLog('requesting', `${event.stepLabel || 'Запрос'}: ${label}`);
              }
            } else if (event.phase === 'saved') {
              const pct = event.totalSteps > 0 ? Math.round((event.currentStep / event.totalSteps) * 100) : 0;
              progressText.textContent = `Шаг ${event.currentStep} из ${event.totalSteps}`;
              if (progressBar) progressBar.style.width = pct + '%';
              const daysInfo = event.daysInStep != null ? ` (${event.daysInStep} дней)` : '';
              const line = event.chunkLabel
                ? `${event.endpointLabel} · ${event.chunkLabel} — сохранено записей: ${event.savedInStep}${daysInfo}, всего: ${event.totalSaved}`
                : `${event.endpointLabel} — сохранено: ${event.savedInStep} записей, всего: ${event.totalSaved}`;
              appendLog('saved', line, true);
              if (progressDetail) {
                progressDetail.textContent = event.chunkLabel
                  ? `${event.endpointLabel} · ${event.chunkLabel} · +${event.savedInStep} записей (всего ${event.totalSaved})`
                  : `${event.endpointLabel} · +${event.savedInStep} записей (всего ${event.totalSaved})`;
              }
            }
          } else if (event.type === 'done') {
            btnSync.disabled = false;
            progressText.textContent = 'Готово';
            if (progressBar) progressBar.style.width = '100%';
            appendLog('saved', `Готово. ${event.message || ''}`);
            showSyncResult(resultEl, event, false);
            loadAdminCoverage();
            progressRow.style.display = 'none';
            return;
          } else if (event.type === 'error') {
            progressRow.style.display = 'none';
            btnSync.disabled = false;
            appendLog('error', event.error || 'Ошибка');
            if (event.code === 'INVALID_API_KEY') {
              showApiKeyForm(event.error || 'API key недействителен. Введите новый ключ.');
              resultEl.style.display = 'block';
              resultEl.className = 'sync-result error';
              resultEl.textContent = event.error || '';
            } else {
              showSyncResult(resultEl, { error: event.error }, true);
            }
            return;
          }
        } catch (_) {}
      }
    }
    progressRow.style.display = 'none';
    btnSync.disabled = false;
    showSyncResult(resultEl, { error: 'Соединение закрыто без результата' }, true);
  } catch (e) {
    progressRow.style.display = 'none';
    btnSync.disabled = false;
    resultEl.style.display = 'block';
    resultEl.className = 'sync-result error';
    resultEl.textContent = e.message || 'Ошибка сети';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
