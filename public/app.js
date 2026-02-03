/**
 * Cursor Admin API Dashboard — клиентская логика
 * Документация: https://cursor.com/docs/account/teams/admin-api
 */
const ADMIN_ENDPOINTS = [
  { path: '/teams/members', method: 'GET', label: 'Team Members', snapshotOnly: true },
  { path: '/teams/audit-logs', method: 'GET', label: 'Audit Logs', useDates: true, dateParamNames: ['startTime', 'endTime'], paginated: true },
  { path: '/teams/daily-usage-data', method: 'POST', label: 'Daily Usage Data', useDates: true, bodyEpoch: true },
  { path: '/teams/spend', method: 'POST', label: 'Spending Data', snapshotOnly: true },
  { path: '/teams/filtered-usage-events', method: 'POST', label: 'Usage Events', useDates: true, bodyEpoch: true, paginated: true },
];

let lastErrors = [];
let apiKeyConfigured = false;

function addError(label, message) {
  lastErrors.push({ label, message });
  renderErrors();
}

function clearErrors() {
  lastErrors = [];
  renderErrors();
}

function renderErrors() {
  const el = document.getElementById('errorsBlock');
  if (!el) return;
  if (lastErrors.length === 0) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `
    <h3>Последние ошибки</h3>
    <ul>${lastErrors.map(e => `<li><strong>${escapeHtml(e.label)}</strong>: ${escapeHtml(e.message)}</li>`).join('')}</ul>
  `;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

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
    const r = await fetch('/api/config');
    const data = await r.json();
    applyApiKeyConfig(data.apiKeyConfigured);
  } catch (_) {
    applyApiKeyConfig(false);
  }
  if (!apiKeyConfigured) {
    const saved = sessionStorage.getItem('cursor_api_key');
    if (saved) document.getElementById('apiKey').value = saved;
  }

  document.getElementById('btnSaveApiKey').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKey').value.trim();
    if (!apiKey) { alert('Введите API key'); return; }
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      applyApiKeyConfig(true);
      alert('Ключ сохранён в data/api-key.txt. Больше вводить не нужно.');
    } catch (e) {
      alert(e.message || 'Ошибка сохранения');
    }
  });

  const grid = document.getElementById('endpointsGrid');
  ADMIN_ENDPOINTS.forEach((ep, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" class="ep-check" data-idx="${idx}"> ${escapeHtml(ep.label)}`;
    grid.appendChild(label);
  });

  document.getElementById('btnSelectAll').onclick = () => document.querySelectorAll('.ep-check').forEach(c => c.checked = true);
  document.getElementById('btnSelectNone').onclick = () => document.querySelectorAll('.ep-check').forEach(c => c.checked = false);

  const syncStart = document.getElementById('syncStartDate');
  if (syncStart && !syncStart.value) {
    syncStart.value = '2025-09-01';
  }
  document.getElementById('btnSync').addEventListener('click', runSync);
  document.getElementById('btnRefreshCoverage').addEventListener('click', loadCoverage);
  loadCoverage();
}

async function loadCoverage() {
  const el = document.getElementById('coverageList');
  if (!el) return;
  try {
    const r = await fetch('/api/analytics/coverage');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const cov = data.coverage || [];
    if (cov.length === 0) {
      el.innerHTML = '<span class="muted">БД пуста. Запустите «Загрузить и сохранить в БД».</span>';
      return;
    }
    el.innerHTML = `
      <table>
        <thead><tr><th>Эндпоинт</th><th>С</th><th>По</th><th>Дней</th></tr></thead>
        <tbody>
          ${cov.map(c => `<tr><td>${escapeHtml(c.endpoint)}</td><td>${escapeHtml(c.min_date)}</td><td>${escapeHtml(c.max_date)}</td><td>${c.days}</td></tr>`).join('')}
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
  resultEl.innerHTML = `
    ${escapeHtml(data.message)}<br>
    ${data.skipped && data.skipped.length ? '<br>Пропущено (функция не включена): ' + data.skipped.map(s => escapeHtml(s.endpoint)).join(', ') : ''}
    ${data.errors && data.errors.length ? '<br>Ошибки по эндпоинтам: ' + data.errors.map(e => escapeHtml(e.endpoint + ': ' + e.error)).join('; ') : ''}
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

  progressRow.style.display = 'block';
  resultEl.style.display = 'none';
  btnSync.disabled = true;
  progressText.textContent = 'Подготовка...';
  if (progressBar) progressBar.style.width = '0%';
  if (progressDetail) progressDetail.textContent = '';

  const headers = { 'Content-Type': 'application/json' };
  if (!apiKeyConfigured) headers['X-API-Key'] = document.getElementById('apiKey').value.trim();

  try {
    const r = await fetch('/api/sync-stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({ startDate, endDate }),
    });
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
          if (event.type === 'progress') {
            const pct = event.totalSteps > 0 ? Math.round((event.currentStep / event.totalSteps) * 100) : 0;
            progressText.textContent = `Загрузка: ${event.currentStep} из ${event.totalSteps} шагов`;
            if (progressBar) progressBar.style.width = pct + '%';
            const detail = event.chunkLabel
              ? `${event.endpointLabel} · ${event.chunkLabel} · записей: +${event.savedInStep} (всего ${event.totalSaved})`
              : `${event.endpointLabel} · записей: ${event.savedInStep} (всего ${event.totalSaved})`;
            if (progressDetail) progressDetail.textContent = detail;
          } else if (event.type === 'done') {
            progressRow.style.display = 'none';
            btnSync.disabled = false;
            progressText.textContent = '';
            if (progressBar) progressBar.style.width = '100%';
            showSyncResult(resultEl, event, false);
            loadCoverage();
            return;
          } else if (event.type === 'error') {
            progressRow.style.display = 'none';
            btnSync.disabled = false;
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
