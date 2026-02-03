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

/** Форматирование стоимости из центов (Usage Events). */
function formatCostCents(cents) {
  if (cents == null || cents === 0) return '0';
  const d = (cents / 100).toFixed(2);
  return d.replace(/\.?0+$/, '') || '0';
}

/** Считаем итоги по пользователю за весь период (в т.ч. стоимость по моделям). */
function getUserTotals(user) {
  const activity = user.monthlyActivity || user.weeklyActivity || [];
  let requests = 0, activeDays = 0, linesAdded = 0, linesDeleted = 0, applies = 0, accepts = 0;
  let usageEventsCount = 0, usageCostCents = 0, usageRequestsCosts = 0;
  let usageInputTokens = 0, usageOutputTokens = 0, usageCacheWriteTokens = 0, usageCacheReadTokens = 0, usageTokenCents = 0;
  const usageCostByModel = {};
  for (const a of activity) {
    requests += a.requests || 0;
    activeDays += a.activeDays || 0;
    linesAdded += a.linesAdded || 0;
    linesDeleted += a.linesDeleted || 0;
    applies += a.applies || 0;
    accepts += a.accepts || 0;
    usageEventsCount += a.usageEventsCount || 0;
    usageCostCents += a.usageCostCents || 0;
    usageRequestsCosts += a.usageRequestsCosts || 0;
    usageInputTokens += a.usageInputTokens || 0;
    usageOutputTokens += a.usageOutputTokens || 0;
    usageCacheWriteTokens += a.usageCacheWriteTokens || 0;
    usageCacheReadTokens += a.usageCacheReadTokens || 0;
    usageTokenCents += a.usageTokenCents || 0;
    const byModel = a.usageCostByModel || {};
    for (const [model, cents] of Object.entries(byModel)) {
      usageCostByModel[model] = (usageCostByModel[model] || 0) + cents;
    }
  }
  return { requests, activeDays, linesAdded, linesDeleted, linesTotal: linesAdded + linesDeleted, applies, accepts, usageEventsCount, usageCostCents, usageRequestsCosts, usageInputTokens, usageOutputTokens, usageCacheWriteTokens, usageCacheReadTokens, usageTokenCents, usageCostByModel };
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

/** Дата YYYY-MM-DD → DD.MM.YYYY */
function formatJiraDate(ymd) {
  if (!ymd || String(ymd).length < 10) return '—';
  const parts = String(ymd).slice(0, 10).split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : ymd;
}

/** Бейдж статуса из Jira: Активный / Архивный (по данным Jira, самый поздний статус). */
function formatJiraStatusBadge(user) {
  if (user.jiraStatus == null) return '';
  const label = user.jiraStatus === 'archived' ? 'Архивный' : 'Активный';
  const cls = user.jiraStatus === 'archived' ? 'jira-status jira-status-archived' : 'jira-status jira-status-active';
  return `<span class="${cls}" title="Статус в Jira">${escapeHtml(label)}</span>`;
}

/** Блок рядом с пользователем: значок статуса + даты + проект. */
function formatUserStatusAndDates(user) {
  const badge = formatJiraStatusBadge(user);
  const hasDates = user.jiraConnectedAt || user.jiraDisconnectedAt;
  const conn = user.jiraConnectedAt ? `Подкл.: ${formatJiraDate(user.jiraConnectedAt)}` : '';
  const disconn = user.jiraDisconnectedAt ? `Откл.: ${formatJiraDate(user.jiraDisconnectedAt)}` : '';
  const datesStr = [conn, disconn].filter(Boolean).join(' · ');
  const datesHtml = hasDates ? `<span class="user-meta-dates" title="Даты из Jira">${escapeHtml(datesStr)}</span>` : '';
  const projectHtml = user.jiraProject ? `<span class="user-meta-project" title="Проект в Jira">${escapeHtml(user.jiraProject)}</span>` : '';
  const parts = [badge, datesHtml, projectHtml].filter(Boolean);
  if (!parts.length) return '';
  return `<span class="user-meta-block">${parts.join(' ')}</span>`;
}

function renderSummary(data, preparedUsers) {
  const allUsers = data.users || [];
  let totalRequests = 0, totalLinesAdded = 0, totalLinesDeleted = 0, activeUserCount = 0;
  let totalUsageEvents = 0, totalUsageCostCents = 0;
  const withActivity = (data.users || []).map((u) => ({ ...u, totals: u.totals || getUserTotals(u) }))
    .filter((u) => (u.totals.requests || 0) > 0 || (u.totals.activeDays || 0) > 0 || (u.totals.linesTotal || 0) > 0 || (u.totals.usageEventsCount || 0) > 0);
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheWrite = 0, totalCacheRead = 0;
  for (const u of withActivity) {
    totalRequests += u.totals.requests || 0;
    totalLinesAdded += u.totals.linesAdded || 0;
    totalLinesDeleted += u.totals.linesDeleted || 0;
    totalUsageEvents += u.totals.usageEventsCount || 0;
    totalUsageCostCents += u.totals.usageCostCents || 0;
    totalInputTokens += u.totals.usageInputTokens || 0;
    totalOutputTokens += u.totals.usageOutputTokens || 0;
    totalCacheWrite += u.totals.usageCacheWriteTokens || 0;
    totalCacheRead += u.totals.usageCacheReadTokens || 0;
    activeUserCount++;
  }
  const top = withActivity.length ? withActivity.sort((a, b) => (b.totals.requests || 0) - (a.totals.requests || 0))[0] : null;
  const topLabel = top ? (top.displayName || top.email || '—') : '—';
  const usageCards = totalUsageEvents > 0 || totalUsageCostCents > 0 ? `
    <div class="stat-card">
      <span class="stat-value">${totalUsageEvents.toLocaleString('ru-RU')}</span>
      <span class="stat-label">событий Usage Events</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">$${formatCostCents(totalUsageCostCents)}</span>
      <span class="stat-label">стоимость (Usage Events)</span>
    </div>
  ` : '';
  const teamMembersCount = data.teamMembersCount ?? 0;
  const teamMembers = data.teamMembers || [];
  const teamMembersCard = teamMembersCount > 0 ? `
    <div class="stat-card" title="${escapeHtml(teamMembers.slice(0, 15).map((m) => m.name || m.email).join(', '))}">
      <span class="stat-value">${teamMembersCount}</span>
      <span class="stat-label">участников в команде</span>
    </div>
  ` : '';
  const totalTeamSpendCents = data.totalTeamSpendCents ?? 0;
  const spendApiCard = totalTeamSpendCents > 0 ? `
    <div class="stat-card">
      <span class="stat-value">$${formatCostCents(totalTeamSpendCents)}</span>
      <span class="stat-label">траты (Spend API)</span>
    </div>
  ` : '';
  const totalByModel = {};
  for (const u of withActivity) {
    const t = u.totals || getUserTotals(u);
    const byModel = t.usageCostByModel || {};
    for (const [model, cents] of Object.entries(byModel)) {
      totalByModel[model] = (totalByModel[model] || 0) + cents;
    }
  }
  const costByModelEntries = Object.entries(totalByModel).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const costByModelHtml = costByModelEntries.length ? `<div class="summary-cost-by-model"><span class="summary-cost-by-model-label">Стоимость по моделям ($):</span> ${costByModelEntries.map(([model, cents]) => `<span class="summary-cost-by-model-item">${escapeHtml(model)}: $${formatCostCents(cents)}</span>`).join(', ')}</div>` : '';
  return `
    <div class="stat-card">
      <span class="stat-value">${allUsers.length}</span>
      <span class="stat-label">всего в Jira</span>
    </div>
    ${teamMembersCard}
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
    ${usageCards}
    ${spendApiCard}
    <div class="stat-card stat-card-highlight">
      <span class="stat-value">${escapeHtml(topLabel)}</span>
      <span class="stat-label">самый активный по запросам</span>
    </div>
    ${costByModelHtml}
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
    const statusAndDates = formatUserStatusAndDates(u);
    const t = u.totals || getUserTotals(u);
    const act = u[activityKey] || [];
    const monthCells = act.map((a) => {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      const intensity = getIntensity(v, maxVal);
      const label = monthKey === 'month' ? formatMonthLabel(a[monthKey]) : a[monthKey];
      const usagePart = (a.usageEventsCount > 0 || a.usageCostCents > 0) ? `, событий ${a.usageEventsCount || 0}, $${formatCostCents(a.usageCostCents)}` : '';
      const title = `${label}: дн. ${a.activeDays}, запросов ${a.requests}, строк +${a.linesAdded}/−${a.linesDeleted}${usagePart}`;
      return `<span class="week-cell" style="--intensity:${intensity}" title="${escapeHtml(title)}">${v > 0 ? v : ''}</span>`;
    }).join('');
    const applyAccept = (t.applies || t.accepts) ? ` <span class="user-card-stat">применений: ${t.applies || 0} / принято: ${t.accepts || 0}</span>` : '';
    const usageStats = (t.usageEventsCount > 0 || t.usageCostCents > 0) ? ` <span class="user-card-stat">событий: ${t.usageEventsCount || 0} · $${formatCostCents(t.usageCostCents)}</span>` : '';
    const tokenStats = (t.usageInputTokens > 0 || t.usageOutputTokens > 0 || t.usageCacheWriteTokens > 0 || t.usageCacheReadTokens > 0) ? ` <span class="user-card-stat" title="input / output / cache write / cache read">токены: in ${(t.usageInputTokens || 0).toLocaleString('ru-RU')}, out ${(t.usageOutputTokens || 0).toLocaleString('ru-RU')}, cW ${(t.usageCacheWriteTokens || 0).toLocaleString('ru-RU')}, cR ${(t.usageCacheReadTokens || 0).toLocaleString('ru-RU')}</span>` : '';
    const teamSpendStat = (u.teamSpendCents > 0) ? ` <span class="user-card-stat">Spend API: $${formatCostCents(u.teamSpendCents)}</span>` : '';
    const byModel = t.usageCostByModel && Object.keys(t.usageCostByModel).length ? Object.entries(t.usageCostByModel).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([model, cents]) => `${escapeHtml(model)}: $${formatCostCents(cents)}`).join(', ') : '';
    const costByModelStats = byModel ? ` <span class="user-card-stat user-card-cost-by-model" title="Стоимость в $ по моделям">${byModel}</span>` : '';
    return `
      <div class="user-card">
        <div class="user-card-header">
          <div class="user-card-name">${name} ${statusAndDates}</div>
          ${email}
        </div>
        <div class="user-card-stats">
          <span class="user-card-stat"><strong>${t.requests}</strong> запросов</span>
          <span class="user-card-stat"><strong>${t.activeDays}</strong> дн. активности</span>
          <span class="user-card-stat stat-add">+${t.linesAdded}</span>
          <span class="user-card-stat stat-del">−${t.linesDeleted}</span>${applyAccept}${usageStats}${tokenStats}${teamSpendStat}${costByModelStats}
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
    const statusAndDates = formatUserStatusAndDates(user);
    const act = user[activityKey] || [];
    const cells = values.map((v, i) => {
      const intensity = getIntensity(v, maxVal);
      const a = act[i];
      const usagePart = (a && (a.usageEventsCount > 0 || a.usageCostCents > 0)) ? `; событий ${a.usageEventsCount || 0}, $${formatCostCents(a.usageCostCents)}` : '';
      const title = v > 0 ? `Месяц: ${v}${usagePart}` : '';
      return `<td class="heatmap-td" style="--intensity:${intensity}" title="${title}">${v > 0 ? v : ''}</td>`;
    }).join('');
    return `<tr><th class="heatmap-th-name">${name} ${statusAndDates}</th>${cells}</tr>`;
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
    const statusAndDates = formatUserStatusAndDates(u);
    const email = u.email ? `<br><span class="muted" style="font-size:0.8em">${escapeHtml(u.email)}</span>` : '';
    const t = u.totals || getUserTotals(u);
    const cells = (u[activityKey] || []).map((a) => {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      const intensity = getIntensity(v, maxVal);
      const usagePart = (a.usageEventsCount > 0 || a.usageCostCents > 0) ? `; событий ${a.usageEventsCount || 0}, $${formatCostCents(a.usageCostCents)}` : '';
      const title = `${a.activeDays} дн., запросов: ${a.requests}, +${a.linesAdded}/−${a.linesDeleted}${usagePart}`;
      const text = viewMetric === 'lines' ? `+${a.linesAdded}/−${a.linesDeleted}` : v;
      return `<td class="table-cell-intensity" style="--intensity:${intensity}" title="${escapeHtml(title)}">${text}</td>`;
    }).join('');
    const usageTotals = (t.usageEventsCount > 0 || t.usageCostCents > 0) ? ` · Событий: ${t.usageEventsCount} · $${formatCostCents(t.usageCostCents)}` : '';
    const teamSpendLine = (u.teamSpendCents > 0) ? ` · Spend API: $${formatCostCents(u.teamSpendCents)}` : '';
    const byModel = t.usageCostByModel && Object.keys(t.usageCostByModel).length ? Object.entries(t.usageCostByModel).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([model, cents]) => `${model}: $${formatCostCents(cents)}`).join('; ') : '';
    const costByModelLine = byModel ? `<div class="table-user-cost-by-model" title="Стоимость по моделям">${escapeHtml(byModel)}</div>` : '';
    return `<tr>
      <td class="table-user-cell">${name} ${statusAndDates}${email}<div class="table-user-totals">Запросов: ${t.requests} · Дней: ${t.activeDays}${usageTotals}${tokenTotals}${teamSpendLine}</div>${costByModelLine}</td>
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

const DAILY_USAGE_ENDPOINT = '/teams/daily-usage-data';

/** По умолчанию подставить период по данным в БД (Daily Usage); если пусто — последние 90 дней. */
async function setDefaultDates() {
  const elEnd = document.getElementById('endDate');
  const elStart = document.getElementById('startDate');
  if (!elEnd || !elStart) return;
  try {
    const r = await fetch('/api/analytics/coverage');
    const data = await r.json();
    const coverage = data.coverage || [];
    const daily = coverage.find((c) => c.endpoint === DAILY_USAGE_ENDPOINT);
    if (daily && daily.min_date && daily.max_date) {
      elStart.value = daily.min_date;
      elEnd.value = daily.max_date;
      return;
    }
  } catch (_) {}
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  if (!elStart.value) elStart.value = start.toISOString().slice(0, 10);
  if (!elEnd.value) elEnd.value = end.toISOString().slice(0, 10);
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
    if (!months.length) {
      tableContainer.innerHTML = '<p class="muted">Нет записей Daily Usage за выбранный период. Проверьте диапазон дат или загрузите данные в разделе <a href="admin.html">Настройки и загрузка</a>. Что уже есть в БД — смотрите на <a href="data.html">Данные в БД</a>.</p>';
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
    loadAuditPreview();
  } catch (e) {
    statusEl.textContent = e.message || 'Ошибка загрузки';
    statusEl.className = 'meta error';
    summaryPanel.style.display = 'none';
    contentPanel.style.display = 'none';
    emptyState.style.display = 'block';
    tableSummary.textContent = '';
  }
}

function formatAuditEventDate(ts) {
  if (ts == null) return '—';
  const d = new Date(typeof ts === 'number' ? ts : Number(ts) || ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

async function loadAuditPreview() {
  const container = document.getElementById('auditEventsContainer');
  const panel = document.getElementById('auditPanel');
  if (!container || !panel) return;
  try {
    const r = await fetch('/api/audit-events?limit=20');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const events = data.events || [];
    panel.style.display = 'block';
    if (events.length === 0) {
      container.innerHTML = '<p class="muted">Нет событий. Загрузите Audit Logs в разделе <a href="admin.html">Настройки и загрузка</a>.</p>';
      return;
    }
    const rows = events.map((e) => {
      const date = formatAuditEventDate(e.timestamp);
      const user = escapeHtml((e.userEmail || e.email || e.user_email || e.actor || '—').toString());
      const action = escapeHtml((e.type || e.action || e.eventType || e.name || '—').toString());
      const details = e.details || e.metadata ? escapeHtml(JSON.stringify(e.details || e.metadata || {})) : '';
      return `<tr><td>${date}</td><td>${user}</td><td>${action}</td><td class="audit-details">${details}</td></tr>`;
    }).join('');
    container.innerHTML = `
      <div class="table-wrap">
        <table class="data-table audit-table">
          <thead><tr><th>Дата</th><th>Пользователь</th><th>Действие</th><th>Детали</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (e) {
    panel.style.display = 'block';
    container.innerHTML = '<p class="muted">Не удалось загрузить события: ' + escapeHtml(e.message) + '</p>';
  }
}

function init() {
  setDefaultDates().then(() => {
    if (document.getElementById('startDate').value && document.getElementById('endDate').value) load();
    else loadAuditPreview();
  });
  document.getElementById('btnLoad').addEventListener('click', load);
  const refresh = () => {
    if (document.getElementById('startDate').value && document.getElementById('endDate').value) load();
  };
  document.getElementById('viewMode').addEventListener('change', refresh);
  document.getElementById('sortBy').addEventListener('change', refresh);
  document.getElementById('showOnlyActive').addEventListener('change', refresh);
  loadAuditPreview();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
