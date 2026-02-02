/**
 * Cursor Analytics API Dashboard — клиентская логика
 */
const TEAM_ENDPOINTS = [
  { path: '/analytics/team/agent-edits', label: 'Team: Agent Edits' },
  { path: '/analytics/team/tabs', label: 'Team: Tab Usage' },
  { path: '/analytics/team/dau', label: 'Team: Daily Active Users' },
  { path: '/analytics/team/client-versions', label: 'Team: Client Versions' },
  { path: '/analytics/team/models', label: 'Team: Model Usage' },
  { path: '/analytics/team/top-file-extensions', label: 'Team: Top File Extensions' },
  { path: '/analytics/team/mcp', label: 'Team: MCP Adoption' },
  { path: '/analytics/team/commands', label: 'Team: Commands Adoption' },
  { path: '/analytics/team/plans', label: 'Team: Plans Adoption' },
  { path: '/analytics/team/ask-mode', label: 'Team: Ask Mode Adoption' },
  { path: '/analytics/team/leaderboard', label: 'Team: Leaderboard' },
];
const BY_USER_ENDPOINTS = [
  { path: '/analytics/by-user/agent-edits', label: 'By-user: Agent Edits', paginated: true },
  { path: '/analytics/by-user/tabs', label: 'By-user: Tabs', paginated: true },
  { path: '/analytics/by-user/models', label: 'By-user: Models', paginated: true },
  { path: '/analytics/by-user/top-file-extensions', label: 'By-user: Top File Extensions', paginated: true },
  { path: '/analytics/by-user/client-versions', label: 'By-user: Client Versions', paginated: true },
  { path: '/analytics/by-user/mcp', label: 'By-user: MCP', paginated: true },
  { path: '/analytics/by-user/commands', label: 'By-user: Commands', paginated: true },
  { path: '/analytics/by-user/plans', label: 'By-user: Plans', paginated: true },
  { path: '/analytics/by-user/ask-mode', label: 'By-user: Ask Mode', paginated: true },
];

let fetchAbortController = null;
let lastErrors = [];

function setDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  document.getElementById('endDate').value = end.toISOString().slice(0, 10);
  document.getElementById('startDate').value = start.toISOString().slice(0, 10);
}

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

function updateProgress(text, showSpinner = false) {
  const progressEl = document.getElementById('progress');
  const spinnerEl = document.getElementById('progressSpinner');
  if (progressEl) progressEl.textContent = text;
  if (spinnerEl) spinnerEl.style.display = showSpinner ? 'block' : 'none';
}

async function proxy(path, params = {}, signal = null) {
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) throw new Error('Введите API key');
  sessionStorage.setItem('cursor_api_key', apiKey);
  const q = new URLSearchParams({ path, ...params });
  const opts = { headers: { 'X-API-Key': apiKey } };
  if (signal) opts.signal = signal;
  const r = await fetch('/api/proxy?' + q, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || r.statusText);
  return data;
}

async function fetchPaginated(path, startDate, endDate, signal) {
  let allData = {};
  let page = 1;
  const pageSize = 500;
  let hasNext = true;
  while (hasNext) {
    const res = await proxy(path, { startDate, endDate, page, pageSize: String(pageSize) }, signal);
    if (res.data && typeof res.data === 'object' && !Array.isArray(res.data)) {
      Object.assign(allData, res.data);
    }
    hasNext = res.pagination?.hasNextPage === true;
    page++;
  }
  return { data: allData, pagination: { totalPages: page - 1 } };
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function slug(s) {
  return s.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() || 'data';
}

function init() {
  const saved = sessionStorage.getItem('cursor_api_key');
  if (saved) document.getElementById('apiKey').value = saved;
  setDates();

  const grid = document.getElementById('endpointsGrid');
  [...TEAM_ENDPOINTS, ...BY_USER_ENDPOINTS].forEach((ep) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" class="ep-check" data-path="${escapeHtml(ep.path)}" data-paginated="${!!ep.paginated}"> ${escapeHtml(ep.label)}`;
    grid.appendChild(label);
  });

  document.getElementById('btnSelectAll').onclick = () => document.querySelectorAll('.ep-check').forEach(c => c.checked = true);
  document.getElementById('btnSelectNone').onclick = () => document.querySelectorAll('.ep-check').forEach(c => c.checked = false);

  document.getElementById('btnFetch').addEventListener('click', runFetch);
  document.getElementById('btnStop').addEventListener('click', () => {
    if (fetchAbortController) fetchAbortController.abort();
  });
  document.getElementById('btnDownloadAll').addEventListener('click', downloadAllResults);

  const syncStart = document.getElementById('syncStartDate');
  if (syncStart) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    syncStart.value = d.toISOString().slice(0, 10);
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

async function runSync() {
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) {
    alert('Введите API key');
    return;
  }
  const startDate = document.getElementById('syncStartDate').value;
  if (!startDate) {
    alert('Укажите начальную дату');
    return;
  }
  const endDate = new Date().toISOString().slice(0, 10);
  const progressRow = document.getElementById('syncProgressRow');
  const progressText = document.getElementById('syncProgressText');
  const resultEl = document.getElementById('syncResult');
  const btnSync = document.getElementById('btnSync');
  progressRow.style.display = 'flex';
  resultEl.style.display = 'none';
  btnSync.disabled = true;
  progressText.textContent = 'Синхронизация с Cursor API...';
  try {
    const r = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ startDate, endDate }),
    });
    const data = await r.json();
    progressRow.style.display = 'none';
    btnSync.disabled = false;
    resultEl.style.display = 'block';
    if (!r.ok) {
      resultEl.className = 'sync-result error';
      resultEl.textContent = data.error || r.statusText;
      return;
    }
    resultEl.className = 'sync-result ok';
    resultEl.innerHTML = `
      ${escapeHtml(data.message)}<br>
      ${data.errors && data.errors.length ? '<br>Ошибки по эндпоинтам: ' + data.errors.map(e => escapeHtml(e.endpoint + ': ' + e.error)).join('; ') : ''}
    `;
    loadCoverage();
  } catch (e) {
    progressRow.style.display = 'none';
    btnSync.disabled = false;
    resultEl.style.display = 'block';
    resultEl.className = 'sync-result error';
    resultEl.textContent = e.message || 'Ошибка сети';
  }
}

function downloadAllResults() {
  const sections = document.querySelectorAll('#results .section[data-result-json]');
  if (!sections.length) {
    alert('Нет загруженных результатов для скачивания.');
    return;
  }
  const all = {};
  sections.forEach((section) => {
    const label = section.getAttribute('data-label') || 'item';
    try {
      const data = JSON.parse(section.getAttribute('data-result-json'));
      all[slug(label)] = data;
    } catch (_) {}
  });
  const start = document.getElementById('startDate').value || 'start';
  const end = document.getElementById('endDate').value || 'end';
  downloadJson(`cursor-analytics-${start}-${end}.json`, all);
}

async function runFetch() {
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) {
    addError('Настройки', 'Введите API key');
    alert('Введите API key');
    return;
  }
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  if (!startDate || !endDate) {
    addError('Настройки', 'Укажите период');
    alert('Укажите период');
    return;
  }

  const checked = [...document.querySelectorAll('.ep-check:checked')];
  if (!checked.length) {
    addError('Эндпоинты', 'Выберите хотя бы один эндпоинт');
    alert('Выберите хотя бы один эндпоинт');
    return;
  }

  clearErrors();
  const resultsPanel = document.getElementById('resultsPanel');
  const resultsDiv = document.getElementById('results');
  resultsPanel.style.display = 'block';
  resultsDiv.innerHTML = '';

  const btnFetch = document.getElementById('btnFetch');
  const btnStop = document.getElementById('btnStop');
  btnFetch.disabled = true;
  btnStop.style.display = 'inline-block';
  fetchAbortController = new AbortController();
  const signal = fetchAbortController.signal;

  const total = checked.length;
  let done = 0;

  for (let i = 0; i < checked.length; i++) {
    if (signal.aborted) break;

    const path = checked[i].dataset.path;
    const paginated = checked[i].dataset.paginated === 'true';
    const label = checked[i].parentElement.textContent.trim();
    updateProgress(`Загрузка ${i + 1} из ${total}: ${label}...`, true);

    const section = document.createElement('details');
    section.className = 'section';
    section.setAttribute('data-label', label);
    section.innerHTML = `
      <summary>${escapeHtml(label)}</summary>
      <div class="content"></div>
      <div class="meta"></div>
      <div class="actions"></div>
    `;
    resultsDiv.appendChild(section);

    try {
      let data;
      if (paginated) {
        data = await fetchPaginated(path, startDate, endDate, signal);
      } else {
        data = await proxy(path, { startDate, endDate }, signal);
      }
      const jsonStr = JSON.stringify(data, null, 2);
      section.setAttribute('data-result-json', jsonStr);
      section.querySelector('.content').innerHTML = '<pre>' + escapeHtml(jsonStr) + '</pre>';
      section.querySelector('.meta').textContent = 'OK. ' + (data.pagination ? `Страниц: ${data.pagination.totalPages}.` : '') + (data.params ? ` Параметры: ${JSON.stringify(data.params)}` : '');
      section.querySelector('.meta').classList.add('ok');

      const actions = section.querySelector('.actions');
      const btnDownload = document.createElement('button');
      btnDownload.className = 'btn btn-secondary';
      btnDownload.textContent = 'Скачать JSON';
      btnDownload.onclick = () => downloadJson(slug(label) + '.json', data);
      actions.appendChild(btnDownload);
    } catch (err) {
      addError(label, err.message);
      section.querySelector('.content').innerHTML = '<pre class="error">' + escapeHtml(err.message) + '</pre>';
      section.querySelector('.meta').textContent = 'Ошибка: ' + err.message;
      section.querySelector('.meta').classList.add('error');
      if (err.name === 'AbortError') break;
    }
    done++;
  }

  updateProgress(signal.aborted ? `Остановлено. Загружено ${done} из ${total}.` : `Готово. Загружено эндпоинтов: ${total}.`, false);
  btnFetch.disabled = false;
  btnStop.style.display = 'none';
  fetchAbortController = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
