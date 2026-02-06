/**
 * Страница просмотра данных из локальной БД.
 * Использует common.js: escapeHtml, getEndpointLabel, fetchWithAuth.
 */
async function loadCoverage() {
  const el = document.getElementById('coverageContainer');
  if (!el) return;
  try {
    const r = await fetchWithAuth('/api/analytics/coverage');
    if (!r) return;
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const cov = data.coverage || [];
    const select = document.getElementById('filterEndpoint');
    if (select) {
      const opts = select.querySelectorAll('option');
      for (let i = opts.length - 1; i >= 1; i--) opts[i].remove();
    }
    if (cov.length === 0) {
      el.innerHTML = '<span class="muted">БД пуста. Загрузите данные во вкладке <a href="#admin">Загрузка в БД</a>.</span>';
      return;
    }
    el.innerHTML = `
      <table class="data-table coverage-table">
        <thead><tr><th>Эндпоинт</th><th>С</th><th>По</th><th>Дней</th><th>Выгрузка</th></tr></thead>
        <tbody>
          ${cov.map(c => `
            <tr>
              <td>${escapeHtml(getEndpointLabel(c.endpoint))}</td>
              <td>${escapeHtml(c.min_date)}</td>
              <td>${escapeHtml(c.max_date)}</td>
              <td>${c.days}</td>
              <td><button type="button" class="btn btn-secondary btn-small btn-download-coverage" data-endpoint="${escapeHtml(c.endpoint)}" data-min="${escapeHtml(c.min_date)}" data-max="${escapeHtml(c.max_date)}">Скачать JSON</button></td>
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

function sortKeysWithFirst(keys, firstKeys) {
  const set = new Set(keys);
  const first = (firstKeys || []).filter((k) => set.has(k));
  const rest = keys.filter((k) => !(firstKeys || []).includes(k)).sort();
  return first.concat(rest);
}

function renderTableFromArray(arr, maxRows, options) {
  maxRows = maxRows !== undefined ? maxRows : 500;
  options = options || {};
  if (!Array.isArray(arr) || arr.length === 0) return '<p class="muted">Нет записей</p>';
  let keys = getAllKeys(arr.slice(0, Math.max(100, Math.min(arr.length, 500))));
  if (options.keyOrder) keys = sortKeysWithFirst(keys, options.keyOrder);
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
  if (Array.isArray(payload)) return { key: null, arr: payload };
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

/** Развернуть строки API (endpoint, date, payload) в плоский список записей для выгрузки в JSON. */
function flattenRowsToRecords(rows) {
  const records = [];
  for (const row of rows) {
    const extracted = extractArray(row.payload);
    if (!extracted) continue;
    const { key, arr } = extracted;
    const list = key === 'usageEvents' ? flattenUsageEvents(arr) : arr;
    const label = getEndpointLabel(row.endpoint);
    for (const item of list) {
      if (item != null && typeof item === 'object') {
        records.push({ date: row.date, endpoint: label, ...item });
      } else {
        records.push({ date: row.date, endpoint: label, value: item });
      }
    }
  }
  return records;
}

async function downloadEndpointData(endpoint, minDate, maxDate) {
  const params = new URLSearchParams({ endpoint, startDate: minDate, endDate: maxDate });
  const r = await fetchWithAuth('/api/analytics?' + params);
  if (!r) return;
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
  const rows = data.data || [];
  const records = flattenRowsToRecords(rows);
  const slug = (endpoint || 'data').replace(/\//g, '_').replace(/_/g, '-');
  const filename = slug + '_' + minDate + '_' + maxDate + '.json';
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function onCoverageContainerClick(ev) {
  const btn = ev.target.closest('.btn-download-coverage');
  if (!btn) return;
  const endpoint = btn.getAttribute('data-endpoint');
  const min = btn.getAttribute('data-min');
  const max = btn.getAttribute('data-max');
  if (!endpoint || !min || !max) return;
  btn.disabled = true;
  btn.textContent = '…';
  downloadEndpointData(endpoint, min, max)
    .catch(function (e) {
      alert('Ошибка выгрузки: ' + (e && e.message ? e.message : String(e)));
    })
    .finally(function () {
      btn.disabled = false;
      btn.textContent = 'Скачать JSON';
    });
}

function renderResults(rows) {
  const container = document.getElementById('resultsContainer');
  if (!rows || rows.length === 0) {
    container.innerHTML = '<p class="muted">Нет данных по выбранным фильтрам.</p>';
    return;
  }
  const flatList = flattenRowsToRecords(rows);
  if (flatList.length === 0) {
    container.innerHTML = '<p class="muted">В выбранных данных нет массивов записей (events/data/usageEvents/teamMembers/teamMemberSpend).</p>';
    return;
  }
  container.innerHTML = renderTableFromArray(flatList, 2000, { keyOrder: ['date', 'endpoint'] });
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
    const r = await fetchWithAuth('/api/analytics?' + params);
    if (!r) return;
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const rows = data.data || [];
    const flatList = flattenRowsToRecords(rows);
    document.getElementById('resultsPanel').style.display = 'block';
    document.getElementById('resultsSummary').textContent =
      'Найдено записей: ' + flatList.length + (endpoint ? ' (эндпоинт: ' + getEndpointLabel(endpoint) + ')' : '');
    renderResults(rows);
  } catch (e) {
    document.getElementById('resultsPanel').style.display = 'block';
    document.getElementById('resultsContainer').innerHTML =
      '<p class="error">' + escapeHtml(e.message) + '</p>';
  }
}

function init() {
  var refreshBtn = document.getElementById('btnRefreshCoverageData') || document.getElementById('btnRefreshCoverage');
  if (refreshBtn) refreshBtn.addEventListener('click', loadCoverage);
  var loadBtn = document.getElementById('btnLoad');
  if (loadBtn) loadBtn.addEventListener('click', loadData);
  var coverageEl = document.getElementById('coverageContainer');
  if (coverageEl) coverageEl.addEventListener('click', onCoverageContainerClick);
  loadCoverage();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
