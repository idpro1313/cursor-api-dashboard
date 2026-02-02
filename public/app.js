/**
 * Cursor Admin API Dashboard — клиентская логика
 * Документация: https://cursor.com/docs/account/teams/admin-api
 */
const ADMIN_ENDPOINTS = [
  { path: '/teams/members', method: 'GET', label: 'Team Members' },
  { path: '/teams/audit-logs', method: 'GET', label: 'Audit Logs', useDates: true, dateParamNames: ['startTime', 'endTime'], paginated: true },
  { path: '/teams/daily-usage-data', method: 'POST', label: 'Daily Usage Data', useDates: true, bodyEpoch: true },
  { path: '/teams/spend', method: 'POST', label: 'Spending Data' },
  { path: '/teams/filtered-usage-events', method: 'POST', label: 'Usage Events', useDates: true, bodyEpoch: true, paginated: true },
  { path: '/teams/groups', method: 'GET', label: 'Billing Groups' },
  { path: '/settings/repo-blocklists/repos', method: 'GET', label: 'Repo Blocklists' },
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

function dateToEpochMs(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getTime();
}
function endOfDayEpochMs(dateStr) {
  return new Date(dateStr + 'T23:59:59.999Z').getTime();
}

function buildParams(ep, startDate, endDate, page = 1, pageSize = 100) {
  const params = {};
  if (ep.useDates && startDate && endDate) {
    if (ep.dateParamNames) {
      params[ep.dateParamNames[0]] = startDate;
      params[ep.dateParamNames[1]] = endDate;
    } else if (ep.bodyEpoch) {
      params.startDate = dateToEpochMs(startDate);
      params.endDate = endOfDayEpochMs(endDate);
    }
  }
  if (ep.paginated) {
    params.page = page;
    params.pageSize = pageSize;
  }
  return params;
}

async function proxy(path, method, params = {}, signal = null) {
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) throw new Error('Введите API key');
  sessionStorage.setItem('cursor_api_key', apiKey);
  const opts = { headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' } };
  if (signal) opts.signal = signal;
  let r;
  if (method === 'POST') {
    opts.method = 'POST';
    opts.body = JSON.stringify({ path, ...params });
    r = await fetch('/api/proxy', opts);
  } else {
    const q = new URLSearchParams({ path, ...params });
    r = await fetch('/api/proxy?' + q, opts);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || r.statusText);
  return data;
}

async function fetchPaginated(ep, startDate, endDate, signal) {
  let allEvents = [];
  let page = 1;
  const pageSize = 100;
  let hasNext = true;
  while (hasNext) {
    const params = buildParams(ep, startDate, endDate, page, pageSize);
    const res = await proxy(ep.path, ep.method, params, signal);
    if (ep.path === '/teams/audit-logs' && Array.isArray(res.events)) {
      allEvents = allEvents.concat(res.events);
      hasNext = res.pagination?.hasNextPage === true;
    } else if (ep.path === '/teams/filtered-usage-events' && Array.isArray(res.usageEvents)) {
      allEvents = allEvents.concat(res.usageEvents);
      hasNext = res.pagination?.hasNextPage === true;
    } else {
      hasNext = false;
    }
    page++;
  }
  if (ep.path === '/teams/audit-logs') return { events: allEvents, params: {} };
  if (ep.path === '/teams/filtered-usage-events') return { usageEvents: allEvents, period: {} };
  return { events: allEvents };
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
  ADMIN_ENDPOINTS.forEach((ep, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" class="ep-check" data-idx="${idx}"> ${escapeHtml(ep.label)}`;
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
  const checked = [...document.querySelectorAll('.ep-check:checked')];
  if (!checked.length) {
    addError('Эндпоинты', 'Выберите хотя бы один эндпоинт');
    alert('Выберите хотя бы один эндпоинт');
    return;
  }
  const needsDates = checked.some((c) => {
    const ep = ADMIN_ENDPOINTS[parseInt(c.dataset.idx, 10)];
    return ep && ep.useDates;
  });
  if (needsDates && (!startDate || !endDate)) {
    addError('Настройки', 'Укажите период (для выбранных эндпоинтов с датами)');
    alert('Укажите период');
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

    const ep = ADMIN_ENDPOINTS[parseInt(checked[i].dataset.idx, 10)];
    const label = ep ? ep.label : checked[i].parentElement.textContent.trim();
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
      if (ep.paginated && ep.useDates) {
        data = await fetchPaginated(ep, startDate, endDate, signal);
      } else {
        const params = buildParams(ep, startDate, endDate);
        data = await proxy(ep.path, ep.method, params, signal);
      }
      const jsonStr = JSON.stringify(data, null, 2);
      section.setAttribute('data-result-json', jsonStr);
      section.querySelector('.content').innerHTML = '<pre>' + escapeHtml(jsonStr) + '</pre>';
      const meta = section.querySelector('.meta');
      meta.textContent = 'OK.' + (data.events ? ` Событий: ${data.events.length}.` : '') + (data.usageEvents ? ` Событий: ${data.usageEvents.length}.` : '') + (data.pagination ? ` Страниц: ${data.pagination.totalPages || data.pagination.numPages}.` : '');
      meta.classList.add('ok');

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
