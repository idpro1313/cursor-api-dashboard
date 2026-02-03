/**
 * Дашборд использования Cursor: наглядная статистика по пользователям
 */
function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function formatWeekLabel(weekStr) {
  const d = new Date(weekStr + 'T12:00:00');
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  const fmt = (x) => x.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return fmt(d) + '–' + fmt(end);
}

/** Считаем итоги по пользователю за весь период */
function getUserTotals(user) {
  let requests = 0, activeDays = 0, linesAdded = 0, linesDeleted = 0;
  for (const a of user.weeklyActivity || []) {
    requests += a.requests || 0;
    activeDays += a.activeDays || 0;
    linesAdded += a.linesAdded || 0;
    linesDeleted += a.linesDeleted || 0;
  }
  return { requests, activeDays, linesAdded, linesDeleted, linesTotal: linesAdded + linesDeleted };
}

/** Фильтр и сортировка пользователей */
function prepareUsers(data, sortBy, showOnlyActive) {
  let users = (data.users || []).slice();
  users = users.map((u) => ({ ...u, totals: getUserTotals(u) }));
  if (showOnlyActive) {
    users = users.filter((u) => u.totals.requests > 0 || u.totals.activeDays > 0 || u.totals.linesTotal > 0);
  }
  const cmp = (a, b) => {
    switch (sortBy) {
      case 'requests': return (b.totals.requests || 0) - (a.totals.requests || 0);
      case 'activeDays': return (b.totals.activeDays || 0) - (a.totals.activeDays || 0);
      case 'lines': return (b.totals.linesTotal || 0) - (a.totals.linesTotal || 0);
      case 'name':
      default:
        return String(a.displayName || a.email || '').localeCompare(String(b.displayName || b.email || ''), 'ru');
    }
  };
  users.sort(cmp);
  return users;
}

/** Интенсивность 0..1 для цвета (по максимуму среди всех ячеек) */
function getIntensity(value, maxValue) {
  if (!maxValue || maxValue <= 0) return 0;
  return Math.min(1, value / maxValue);
}

function renderSummary(data, preparedUsers) {
  const allUsers = data.users || [];
  let totalRequests = 0, totalLinesAdded = 0, totalLinesDeleted = 0, activeUserCount = 0;
  const withActivity = (data.users || []).map((u) => ({ ...u, totals: u.totals || getUserTotals(u) }))
    .filter((u) => (u.totals.requests || 0) > 0 || (u.totals.activeDays || 0) > 0 || (u.totals.linesTotal || 0) > 0);
  for (const u of withActivity) {
    totalRequests += u.totals.requests || 0;
    totalLinesAdded += u.totals.linesAdded || 0;
    totalLinesDeleted += u.totals.linesDeleted || 0;
    activeUserCount++;
  }
  const top = withActivity.length ? withActivity.sort((a, b) => (b.totals.requests || 0) - (a.totals.requests || 0))[0] : null;
  const topLabel = top ? (top.displayName || top.email || '—') : '—';
  return `
    <div class="stat-card">
      <span class="stat-value">${allUsers.length}</span>
      <span class="stat-label">всего в Jira</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">${activeUserCount}</span>
      <span class="stat-label">с активностью в Cursor</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">${totalRequests.toLocaleString('ru-RU')}</span>
      <span class="stat-label">запросов за период</span>
    </div>
    <div class="stat-card">
      <span class="stat-value stat-green">+${totalLinesAdded.toLocaleString('ru-RU')}</span>
      <span class="stat-label">строк добавлено</span>
    </div>
    <div class="stat-card">
      <span class="stat-value stat-red">−${totalLinesDeleted.toLocaleString('ru-RU')}</span>
      <span class="stat-label">строк удалено</span>
    </div>
    <div class="stat-card stat-card-highlight">
      <span class="stat-value">${escapeHtml(topLabel)}</span>
      <span class="stat-label">самый активный по запросам</span>
    </div>
  `;
}

/** Карточки пользователей: имя, метрики, полоска недель */
function renderCards(preparedUsers, weeks, viewMetric) {
  if (!weeks.length) return '<p class="muted">Нет недель в периоде.</p>';
  let maxVal = 0;
  for (const u of preparedUsers) {
    for (const a of u.weeklyActivity || []) {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      if (v > maxVal) maxVal = v;
    }
  }
  const cards = preparedUsers.map((u) => {
    const name = escapeHtml(u.displayName || u.email || '—');
    const email = u.email ? `<span class="user-card-email">${escapeHtml(u.email)}</span>` : '';
    const t = u.totals || getUserTotals(u);
    const weekCells = (u.weeklyActivity || []).map((a) => {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      const intensity = getIntensity(v, maxVal);
      const pct = Math.round(intensity * 100);
      const title = `${formatWeekLabel(a.week)}: дн. ${a.activeDays}, запросов ${a.requests}, строк +${a.linesAdded}/−${a.linesDeleted}`;
      return `<span class="week-cell" style="--intensity:${intensity}" title="${escapeHtml(title)}">${v > 0 ? v : ''}</span>`;
    }).join('');
    return `
      <div class="user-card">
        <div class="user-card-header">
          <div class="user-card-name">${name}</div>
          ${email}
        </div>
        <div class="user-card-stats">
          <span class="user-card-stat"><strong>${t.requests}</strong> запросов</span>
          <span class="user-card-stat"><strong>${t.activeDays}</strong> дн. активности</span>
          <span class="user-card-stat stat-add">+${t.linesAdded}</span>
          <span class="user-card-stat stat-del">−${t.linesDeleted}</span>
        </div>
        <div class="user-card-weeks" title="Активность по неделям">${weekCells}</div>
      </div>
    `;
  }).join('');
  return `<div class="users-cards-grid">${cards}</div>`;
}

/** Тепловая карта: строки = пользователи, столбцы = недели */
function renderHeatmap(preparedUsers, weeks, viewMetric) {
  if (!weeks.length) return '<p class="muted">Нет недель в периоде.</p>';
  let maxVal = 0;
  const grid = [];
  for (const u of preparedUsers) {
    const row = [];
    for (const a of u.weeklyActivity || []) {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      row.push(v);
      if (v > maxVal) maxVal = v;
    }
    grid.push({ user: u, values: row });
  }
  const weekHeaders = weeks.map((w) => `<th class="heatmap-th">${escapeHtml(formatWeekLabel(w))}</th>`).join('');
  const rows = grid.map(({ user, values }) => {
    const name = escapeHtml(user.displayName || user.email || '—');
    const cells = values.map((v) => {
      const intensity = getIntensity(v, maxVal);
      const title = v > 0 ? `Неделя: ${v}` : '';
      return `<td class="heatmap-td" style="--intensity:${intensity}" title="${title}">${v > 0 ? v : ''}</td>`;
    }).join('');
    return `<tr><th class="heatmap-th-name">${name}</th>${cells}</tr>`;
  }).join('');
  return `
    <table class="dashboard-heatmap">
      <thead><tr><th>Пользователь</th>${weekHeaders}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** Таблица по неделям (как раньше, но с цветом ячеек и итогами) */
function renderTable(preparedUsers, weeks, viewMetric) {
  const weekHeaders = weeks.map((w) => `<th title="${w}">${escapeHtml(formatWeekLabel(w))}</th>`).join('');
  let maxVal = 0;
  for (const u of preparedUsers) {
    for (const a of u.weeklyActivity || []) {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      if (v > maxVal) maxVal = v;
    }
  }
  const rows = preparedUsers.map((u) => {
    const name = escapeHtml(u.displayName || u.email || '—');
    const email = u.email ? `<br><span class="muted" style="font-size:0.8em">${escapeHtml(u.email)}</span>` : '';
    const t = u.totals || getUserTotals(u);
    const cells = (u.weeklyActivity || []).map((a) => {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      const intensity = getIntensity(v, maxVal);
      const title = `${a.activeDays} дн., запросов: ${a.requests}, +${a.linesAdded}/−${a.linesDeleted}`;
      const text = viewMetric === 'lines' ? `+${a.linesAdded}/−${a.linesDeleted}` : v;
      return `<td class="table-cell-intensity" style="--intensity:${intensity}" title="${escapeHtml(title)}">${text}</td>`;
    }).join('');
    return `<tr>
      <td class="table-user-cell">${name}${email}<div class="table-user-totals">Запросов: ${t.requests} · Дней: ${t.activeDays}</div></td>
      ${cells}
    </tr>`;
  }).join('');
  return `
    <div class="table-wrap">
      <table class="data-table users-dashboard-table">
        <thead>
          <tr>
            <th>Пользователь</th>
            ${weekHeaders}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function setDefaultDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 60);
  const elEnd = document.getElementById('endDate');
  const elStart = document.getElementById('startDate');
  if (elEnd && !elEnd.value) elEnd.value = end.toISOString().slice(0, 10);
  if (elStart && !elStart.value) elStart.value = start.toISOString().slice(0, 10);
}

async function load() {
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const viewMode = document.getElementById('viewMode').value;
  const sortBy = document.getElementById('sortBy').value;
  const showOnlyActive = document.getElementById('showOnlyActive').checked;
  const statusEl = document.getElementById('loadStatus');
  const summaryPanel = document.getElementById('summaryPanel');
  const contentPanel = document.getElementById('contentPanel');
  const emptyState = document.getElementById('emptyState');
  const tableContainer = document.getElementById('tableContainer');
  const heatmapContainer = document.getElementById('heatmapContainer');
  const cardsContainer = document.getElementById('cardsContainer');
  const summaryStats = document.getElementById('summaryStats');
  const tableSummary = document.getElementById('tableSummary');

  if (!startDate || !endDate) {
    statusEl.textContent = 'Укажите начальную и конечную дату.';
    statusEl.className = 'meta error';
    return;
  }
  statusEl.textContent = 'Загрузка...';
  statusEl.className = 'meta';
  summaryPanel.style.display = 'none';
  contentPanel.style.display = 'none';
  emptyState.style.display = 'block';
  try {
    const r = await fetch('/api/users/activity-by-week?' + new URLSearchParams({ startDate, endDate }));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);

    const users = data.users || [];
    const weeks = data.weeks || [];
    if (!users.length) {
      tableContainer.innerHTML = '<p class="muted">Нет пользователей из Jira. Загрузите CSV на странице <a href="jira-users.html">Пользователи Jira</a>.</p>';
      emptyState.style.display = 'none';
      contentPanel.style.display = 'block';
      contentPanel.querySelector('#contentTitle').textContent = 'Активность по пользователям';
      statusEl.textContent = '';
      return;
    }
    if (!weeks.length) {
      tableContainer.innerHTML = '<p class="muted">Нет данных по активности за выбранный период. Загрузите Daily Usage в БД на <a href="index.html">главной</a>.</p>';
      emptyState.style.display = 'none';
      contentPanel.style.display = 'block';
      statusEl.textContent = '';
      return;
    }

    const preparedUsers = prepareUsers(data, sortBy, showOnlyActive);
    summaryStats.innerHTML = renderSummary(data, preparedUsers);
    summaryPanel.style.display = 'block';
    contentPanel.style.display = 'block';
    emptyState.style.display = 'none';

    const viewMetric = sortBy === 'lines' ? 'lines' : sortBy === 'activeDays' ? 'activeDays' : 'requests';
    tableContainer.style.display = 'none';
    heatmapContainer.style.display = 'none';
    heatmapContainer.innerHTML = '';
    cardsContainer.style.display = 'none';
    cardsContainer.innerHTML = '';

    if (viewMode === 'cards') {
      cardsContainer.innerHTML = renderCards(preparedUsers, weeks, viewMetric);
      cardsContainer.style.display = 'block';
    } else if (viewMode === 'heatmap') {
      heatmapContainer.innerHTML = renderHeatmap(preparedUsers, weeks, viewMetric);
      heatmapContainer.style.display = 'block';
    } else {
      tableContainer.innerHTML = renderTable(preparedUsers, weeks, viewMetric);
      tableContainer.style.display = 'block';
    }

    tableSummary.textContent = `Пользователей: ${preparedUsers.length}, недель: ${weeks.length}.`;
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = e.message || 'Ошибка загрузки';
    statusEl.className = 'meta error';
    summaryPanel.style.display = 'none';
    contentPanel.style.display = 'none';
    emptyState.style.display = 'block';
    tableSummary.textContent = '';
  }
}

function init() {
  setDefaultDates();
  document.getElementById('btnLoad').addEventListener('click', load);
  const refresh = () => {
    if (document.getElementById('startDate').value && document.getElementById('endDate').value) load();
  };
  document.getElementById('viewMode').addEventListener('change', refresh);
  document.getElementById('sortBy').addEventListener('change', refresh);
  document.getElementById('showOnlyActive').addEventListener('change', refresh);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
