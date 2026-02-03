/**
 * Дашборд использования Cursor: наглядная статистика по пользователям
 */
function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

/** Подпись месяца: "янв 2025" */
function formatMonthLabel(monthStr) {
  if (!monthStr || monthStr.length < 7) return monthStr || '—';
  const [y, m] = monthStr.split('-').map(Number);
  const d = new Date(y, (m || 1) - 1, 1);
  return d.toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' });
}

/** Считаем итоги по пользователю за весь период */
function getUserTotals(user) {
  const activity = user.monthlyActivity || user.weeklyActivity || [];
  let requests = 0, activeDays = 0, linesAdded = 0, linesDeleted = 0, applies = 0, accepts = 0;
  for (const a of activity) {
    requests += a.requests || 0;
    activeDays += a.activeDays || 0;
    linesAdded += a.linesAdded || 0;
    linesDeleted += a.linesDeleted || 0;
    applies += a.applies || 0;
    accepts += a.accepts || 0;
  }
  return { requests, activeDays, linesAdded, linesDeleted, linesTotal: linesAdded + linesDeleted, applies, accepts };
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

/** Карточки пользователей: имя, метрики, полоска месяцев */
function renderCards(preparedUsers, months, viewMetric) {
  if (!months.length) return '<p class="muted">Нет месяцев в периоде.</p>';
  const activityKey = preparedUsers.length && preparedUsers[0].monthlyActivity ? 'monthlyActivity' : 'weeklyActivity';
  const monthKey = activityKey === 'monthlyActivity' ? 'month' : 'week';
  let maxVal = 0;
  for (const u of preparedUsers) {
    for (const a of u[activityKey] || []) {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      if (v > maxVal) maxVal = v;
    }
  }
  const cards = preparedUsers.map((u) => {
    const name = escapeHtml(u.displayName || u.email || '—');
    const email = u.email ? `<span class="user-card-email">${escapeHtml(u.email)}</span>` : '';
    const t = u.totals || getUserTotals(u);
    const act = u[activityKey] || [];
    const monthCells = act.map((a) => {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      const intensity = getIntensity(v, maxVal);
      const label = monthKey === 'month' ? formatMonthLabel(a[monthKey]) : a[monthKey];
      const title = `${label}: дн. ${a.activeDays}, запросов ${a.requests}, строк +${a.linesAdded}/−${a.linesDeleted}`;
      return `<span class="week-cell" style="--intensity:${intensity}" title="${escapeHtml(title)}">${v > 0 ? v : ''}</span>`;
    }).join('');
    const applyAccept = (t.applies || t.accepts) ? ` <span class="user-card-stat">применений: ${t.applies || 0} / принято: ${t.accepts || 0}</span>` : '';
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
          <span class="user-card-stat stat-del">−${t.linesDeleted}</span>${applyAccept}
        </div>
        <div class="user-card-weeks" title="Активность по месяцам">${monthCells}</div>
      </div>
    `;
  }).join('');
  return `<div class="users-cards-grid">${cards}</div>`;
}

/** Тепловая карта: строки = пользователи, столбцы = месяцы */
function renderHeatmap(preparedUsers, months, viewMetric) {
  if (!months.length) return '<p class="muted">Нет месяцев в периоде.</p>';
  const activityKey = preparedUsers.length && preparedUsers[0].monthlyActivity ? 'monthlyActivity' : 'weeklyActivity';
  let maxVal = 0;
  const grid = [];
  for (const u of preparedUsers) {
    const row = [];
    for (const a of u[activityKey] || []) {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      row.push(v);
      if (v > maxVal) maxVal = v;
    }
    grid.push({ user: u, values: row });
  }
  const monthHeaders = months.map((m) => `<th class="heatmap-th">${escapeHtml(formatMonthLabel(m))}</th>`).join('');
  const rows = grid.map(({ user, values }) => {
    const name = escapeHtml(user.displayName || user.email || '—');
    const cells = values.map((v) => {
      const intensity = getIntensity(v, maxVal);
      const title = v > 0 ? `Месяц: ${v}` : '';
      return `<td class="heatmap-td" style="--intensity:${intensity}" title="${title}">${v > 0 ? v : ''}</td>`;
    }).join('');
    return `<tr><th class="heatmap-th-name">${name}</th>${cells}</tr>`;
  }).join('');
  return `
    <table class="dashboard-heatmap">
      <thead><tr><th>Пользователь</th>${monthHeaders}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/** Таблица по месяцам с цветом ячеек и итогами */
function renderTable(preparedUsers, months, viewMetric) {
  const activityKey = preparedUsers.length && preparedUsers[0].monthlyActivity ? 'monthlyActivity' : 'weeklyActivity';
  const monthKey = activityKey === 'monthlyActivity' ? 'month' : 'week';
  const monthHeaders = months.map((m) => `<th title="${m}">${escapeHtml(formatMonthLabel(m))}</th>`).join('');
  let maxVal = 0;
  for (const u of preparedUsers) {
    for (const a of u[activityKey] || []) {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      if (v > maxVal) maxVal = v;
    }
  }
  const rows = preparedUsers.map((u) => {
    const name = escapeHtml(u.displayName || u.email || '—');
    const email = u.email ? `<br><span class="muted" style="font-size:0.8em">${escapeHtml(u.email)}</span>` : '';
    const t = u.totals || getUserTotals(u);
    const cells = (u[activityKey] || []).map((a) => {
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
            ${monthHeaders}
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
  start.setDate(start.getDate() - 90);
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
    const r = await fetch('/api/users/activity-by-month?' + new URLSearchParams({ startDate, endDate }));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);

    const users = data.users || [];
    const months = data.months || [];
    if (!users.length) {
      tableContainer.innerHTML = '<p class="muted">Нет данных по пользователям за выбранный период. Убедитесь, что в БД загружены <strong>Daily Usage Data</strong> (кнопка «Загрузить и сохранить в БД» на <a href="index.html">главной</a>). Опционально можно загрузить <a href="jira-users.html">пользователей Jira</a> для отображения имён вместо email.</p>';
      emptyState.style.display = 'none';
      contentPanel.style.display = 'block';
      contentPanel.querySelector('#contentTitle').textContent = 'Активность по пользователям';
      statusEl.textContent = '';
      return;
    }
    if (!weeks.length) {
      tableContainer.innerHTML = '<p class="muted">Нет записей Daily Usage за выбранный период. Проверьте диапазон дат или загрузите данные на <a href="index.html">главной</a>. Что уже есть в БД — смотрите на <a href="data.html">Данные в БД</a>.</p>';
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
      cardsContainer.innerHTML = renderCards(preparedUsers, months, viewMetric);
      cardsContainer.style.display = 'block';
    } else if (viewMode === 'heatmap') {
      heatmapContainer.innerHTML = renderHeatmap(preparedUsers, months, viewMetric);
      heatmapContainer.style.display = 'block';
    } else {
      tableContainer.innerHTML = renderTable(preparedUsers, months, viewMetric);
      tableContainer.style.display = 'block';
    }

    tableSummary.textContent = `Пользователей: ${preparedUsers.length}, месяцев: ${months.length}.`;
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
