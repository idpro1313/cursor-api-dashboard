/**
 * Страница просмотра данных из локальной БД
 */
const ENDPOINT_LABELS = {
  '/teams/members': 'Team Members',
  '/teams/audit-logs': 'Audit Logs',
  '/teams/daily-usage-data': 'Daily Usage Data',
  '/teams/spend': 'Spending Data',
  '/teams/filtered-usage-events': 'Usage Events',
};

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function getEndpointLabel(path) {
  return ENDPOINT_LABELS[path] || path;
}

async function loadCoverage() {
  const el = document.getElementById('coverageContainer');
  if (!el) return;
  try {
    const r = await fetch('/api/analytics/coverage', { credentials: 'same-origin' });
    if (r.status === 401) { window.location.href = '/login.html'; return; }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const cov = data.coverage || [];
    const select = document.getElementById('filterEndpoint');
    if (select) {
      const opts = select.querySelectorAll('option');
      for (let i = opts.length - 1; i >= 1; i--) opts[i].remove();
    }
    if (cov.length === 0) {
      el.innerHTML = '<span class="muted">БД пуста. Загрузите данные в разделе <a href="admin.html">Настройки и загрузка</a>.</span>';
      return;
    }
    el.innerHTML = `
      <table class="data-table coverage-table">
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
    if (select) {
      cov.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.endpoint;
        opt.textContent = getEndpointLabel(c.endpoint) + ' (' + c.days + ' дн.)';
        select.appendChild(opt);
      });
    }
    const first = cov[0];
    const filterStart = document.getElementById('filterStartDate');
    const filterEnd = document.getElementById('filterEndDate');
    if (first && filterStart && filterEnd && !filterStart.value) {
      filterStart.value = first.min_date;
      filterEnd.value = first.max_date;
    }
  } catch (e) {
    el.innerHTML = '<span class="error">' + escapeHtml(e.message) + '</span>';
  }
}

function getAllKeys(arr) {
  const set = new Set();
  arr.forEach((obj) => {
    if (obj && typeof obj === 'object') Object.keys(obj).forEach((k) => set.add(k));
  });
  return Array.from(set);
}

function renderTableFromArray(arr, maxRows = 500) {
  if (!Array.isArray(arr) || arr.length === 0) return '<p class="muted">Нет записей</p>';
  const keys = getAllKeys(arr.slice(0, 100));
  const slice = arr.length > maxRows ? arr.slice(0, maxRows) : arr;
  const thead = keys.map((k) => `<th>${escapeHtml(k)}</th>`).join('');
  const rows = slice.map((obj) => {
    return '<tr>' + keys.map((k) => {
      let v = obj[k];
      if (v != null && typeof v === 'object' && !Array.isArray(v)) v = JSON.stringify(v);
      return '<td>' + escapeHtml(v != null ? String(v) : '') + '</td>';
    }).join('') + '</tr>';
  }).join('');
  const more = arr.length > maxRows ? `<p class="meta">Показано ${maxRows} из ${arr.length}. Остальные в JSON.</p>` : '';
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${thead}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${more}
  `;
}

function extractArray(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) return payload;
  for (const key of ['events', 'data', 'usageEvents', 'teamMembers', 'teamMemberSpend']) {
    if (Array.isArray(payload[key])) return { key, arr: payload[key] };
  }
  return null;
}

/** Для Usage Events: разворачиваем tokenUsage в отдельные поля (inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalCents). */
function flattenUsageEvents(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.map((e) => {
    const { tokenUsage: tu, ...rest } = e;
    const t = tu || {};
    return {
      ...rest,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      cacheReadTokens: t.cacheReadTokens,
      totalCents: t.totalCents,
    };
  });
}

function renderPayload(row) {
  const { endpoint, date, payload } = row;
  const extracted = extractArray(payload);
  if (extracted) {
    const { key, arr } = extracted;
    const tableArr = key === 'usageEvents' ? flattenUsageEvents(arr) : arr;
    return renderTableFromArray(tableArr);
  }
  return '<pre class="payload-json">' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>';
}

function renderResults(rows) {
  const container = document.getElementById('resultsContainer');
  if (!rows || rows.length === 0) {
    container.innerHTML = '<p class="muted">Нет данных по выбранным фильтрам.</p>';
    return;
  }
  const byDate = {};
  rows.forEach((r) => {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  });
  const sortedDates = Object.keys(byDate).sort();
  let html = '';
  sortedDates.forEach((date) => {
    const dayRows = byDate[date];
    dayRows.forEach((row) => {
      const label = getEndpointLabel(row.endpoint);
      html += `
        <div class="data-card">
          <div class="data-card-header">
            <span class="data-card-date">${escapeHtml(date)}</span>
            <span class="data-card-endpoint">${escapeHtml(label)}</span>
          </div>
          <div class="data-card-body">
            ${renderPayload(row)}
          </div>
        </div>
      `;
    });
  });
  container.innerHTML = html;
}

async function loadData() {
  const endpoint = document.getElementById('filterEndpoint').value.trim() || undefined;
  const startDate = document.getElementById('filterStartDate').value || undefined;
  const endDate = document.getElementById('filterEndDate').value || undefined;
  const params = new URLSearchParams();
  if (endpoint) params.set('endpoint', endpoint);
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  try {
    const r = await fetch('/api/analytics?' + params, { credentials: 'same-origin' });
    if (r.status === 401) { window.location.href = '/login.html'; return; }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const rows = data.data || [];
    document.getElementById('resultsPanel').style.display = 'block';
    document.getElementById('resultsSummary').textContent =
      'Найдено записей: ' + rows.length + (endpoint ? ' (эндпоинт: ' + getEndpointLabel(endpoint) + ')' : '');
    renderResults(rows);
  } catch (e) {
    document.getElementById('resultsPanel').style.display = 'block';
    document.getElementById('resultsContainer').innerHTML =
      '<p class="error">' + escapeHtml(e.message) + '</p>';
  }
}

function init() {
  document.getElementById('btnRefreshCoverage').addEventListener('click', loadCoverage);
  document.getElementById('btnLoad').addEventListener('click', loadData);
  loadCoverage();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
