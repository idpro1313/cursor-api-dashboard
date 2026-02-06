/**
 * Дашборд использования Cursor. Требует js/common.js.
 */

/** Считаем итоги по пользователю за весь период (в т.ч. стоимость по моделям). */
function getUserTotals(user) {
  const activity = user.monthlyActivity || user.weeklyActivity || [];
  let requests = 0, activeDays = 0, linesAdded = 0, linesDeleted = 0, applies = 0, accepts = 0;
  let usageEventsCount = 0, usageCostCents = 0;
  let usageInputTokens = 0, usageOutputTokens = 0, usageCacheWriteTokens = 0, usageCacheReadTokens = 0, usageTokenCents = 0;
  const usageCostByModel = {};
  let includedEventsCount = 0, includedCostCents = 0;
  const includedCostByModel = {};
  for (const a of activity) {
    requests += a.requests || 0;
    activeDays += a.activeDays || 0;
    linesAdded += a.linesAdded || 0;
    linesDeleted += a.linesDeleted || 0;
    applies += a.applies || 0;
    accepts += a.accepts || 0;
    usageEventsCount += a.usageEventsCount || 0;
    usageCostCents += a.usageCostCents || 0;
    usageInputTokens += a.usageInputTokens || 0;
    usageOutputTokens += a.usageOutputTokens || 0;
    usageCacheWriteTokens += a.usageCacheWriteTokens || 0;
    usageCacheReadTokens += a.usageCacheReadTokens || 0;
    usageTokenCents += a.usageTokenCents || 0;
    includedEventsCount += a.includedEventsCount || 0;
    includedCostCents += a.includedCostCents || 0;
    const byModel = a.usageCostByModel || {};
    for (const [model, cents] of Object.entries(byModel)) {
      usageCostByModel[model] = (usageCostByModel[model] || 0) + cents;
    }
    const inclByModel = a.includedCostByModel || {};
    for (const [model, cents] of Object.entries(inclByModel)) {
      includedCostByModel[model] = (includedCostByModel[model] || 0) + cents;
    }
  }
  return { requests, activeDays, linesAdded, linesDeleted, linesTotal: linesAdded + linesDeleted, applies, accepts, usageEventsCount, usageCostCents, usageInputTokens, usageOutputTokens, usageCacheWriteTokens, usageCacheReadTokens, usageTokenCents, usageCostByModel, includedEventsCount, includedCostCents, includedCostByModel };
}

/** Направление сортировки по имени (таблица/тепловая карта). */
let tableSortNameDir = 'asc';
/** Состояние сортировки таблицы «Затраты по проекту». */
let costByProjectSort = { key: 'project', dir: 'asc' };
/** Данные для повторного рендера таблицы затрат по проекту при смене сортировки. */
let costByProjectData = null;
/** Состояние сортировки таблицы «Стоимость по моделям». */
let summaryCostByModelSort = { key: 'cost', dir: 'desc' };
/** Данные для повторного рендера таблицы стоимости по моделям. */
let summaryCostByModelData = { entries: [] };

/** Фильтр и сортировка пользователей */
function prepareUsers(data, sortBy, showOnlyActive) {
  let users = (data.users || []).slice();
  users = users.map((u) => ({ ...u, totals: getUserTotals(u) }));
  if (showOnlyActive) {
    users = users.filter((u) => u.totals.requests > 0 || u.totals.activeDays > 0 || u.totals.linesTotal > 0 || u.totals.usageEventsCount > 0 || u.totals.includedEventsCount > 0);
  }
  const cmp = (a, b) => {
    switch (sortBy) {
      case 'requests': return (b.totals.requests || 0) - (a.totals.requests || 0);
      case 'activeDays': return (b.totals.activeDays || 0) - (a.totals.activeDays || 0);
      case 'lines': return (b.totals.linesTotal || 0) - (a.totals.linesTotal || 0);
      case 'usageEvents': return (b.totals.usageEventsCount || 0) - (a.totals.usageEventsCount || 0);
      case 'usageCost': return (b.totals.usageCostCents || 0) - (a.totals.usageCostCents || 0);
      case 'name':
      default:
        return String(a.displayName || a.email || '').localeCompare(String(b.displayName || b.email || ''), 'ru');
    }
  };
  users.sort(cmp);
  if (sortBy === 'name' && tableSortNameDir === 'desc') users.reverse();
  return users;
}

/** Интенсивность 0..1 для цвета (по максимуму среди всех ячеек) */
function getIntensity(value, maxValue) {
  if (!maxValue || maxValue <= 0) return 0;
  return Math.min(1, value / maxValue);
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

/** Состояние сортировки таблицы «Активные в Jira, но не используют Cursor» */
let inactiveCursorSort = { key: 'lastActivityMonth', dir: 'asc' };
let inactiveCursorList = [];

function sortInactiveCursorList(list, key, dir) {
  const arr = [...(list || [])];
  const asc = dir === 'asc';
  arr.sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    if (key === 'lastActivityMonth') {
      const da = a.lastActivityDate || a.lastActivityMonth || '';
      const db = b.lastActivityDate || b.lastActivityMonth || '';
      const na = !da || String(da).trim() === '';
      const nb = !db || String(db).trim() === '';
      if (na && nb) return 0;
      if (na) return asc ? -1 : 1;
      if (nb) return asc ? 1 : -1;
      return asc ? (da || '').localeCompare(db || '') : (db || '').localeCompare(da || '');
    }
    if (key === 'totalRequestsInPeriod' || key === 'teamSpendCents') {
      va = Number(va) || 0;
      vb = Number(vb) || 0;
      return asc ? va - vb : vb - va;
    }
    if (key === 'jiraConnectedAt') {
      va = (va || '').toString();
      vb = (vb || '').toString();
      return asc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    va = (va != null ? String(va) : '').toLowerCase();
    vb = (vb != null ? String(vb) : '').toLowerCase();
    const cmp = va.localeCompare(vb, 'ru');
    return asc ? cmp : -cmp;
  });
  return arr;
}

const INACTIVE_CURSOR_COLUMNS = [
  { key: 'displayName', label: 'Пользователь' },
  { key: 'email', label: 'Email' },
  { key: 'jiraProject', label: 'Проект' },
  { key: 'jiraConnectedAt', label: 'Дата подключения' },
  { key: 'lastActivityMonth', label: 'Последняя активность' },
  { key: 'totalRequestsInPeriod', label: 'Запросов за период' },
  { key: 'teamSpendCents', label: 'Расходы текущего месяца' },
];

/** Блок: активные в Jira, но не/редко используют Cursor (с сортировкой по клику на заголовок) */
function renderInactiveCursorList(list, sortState) {
  inactiveCursorList = Array.isArray(list) ? list : [];
  const key = (sortState && sortState.key) || inactiveCursorSort.key;
  const dir = (sortState && sortState.dir) || inactiveCursorSort.dir;
  inactiveCursorSort = { key, dir };

  if (inactiveCursorList.length === 0) {
    return '<p class="muted">Нет таких пользователей за выбранный период.</p>';
  }
  const sorted = sortInactiveCursorList(inactiveCursorList, key, dir);
  const rows = sorted.map((u) => {
    const name = escapeHtml(u.displayName || u.email || '—');
    const email = escapeHtml(u.email || '');
    const project = u.jiraProject ? escapeHtml(u.jiraProject) : '—';
    const connectedAt = u.jiraConnectedAt ? formatJiraDate(u.jiraConnectedAt) : '—';
    const lastActive = u.lastActivityDate ? formatJiraDate(u.lastActivityDate) : (u.lastActivityMonth ? formatMonthShort(u.lastActivityMonth) : 'нет активности');
    const req = u.totalRequestsInPeriod != null ? u.totalRequestsInPeriod : 0;
    const spend = u.teamSpendCents > 0 ? `$${formatCostCents(u.teamSpendCents)}` : '—';
    return `<tr><td>${name}</td><td class="muted">${email}</td><td>${project}</td><td>${connectedAt}</td><td>${lastActive}</td><td>${req}</td><td>${spend}</td></tr>`;
  }).join('');
  const ths = INACTIVE_CURSOR_COLUMNS.map((col) => {
    const isActive = col.key === key;
    const arrow = isActive ? (dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th class="sortable ${isActive ? 'sort-active' : ''}" data-sort="${col.key}" title="Сортировать">${escapeHtml(col.label)}${arrow}</th>`;
  }).join('');
  return `
    <div class="inactive-cursor-block">
      <div class="table-actions">
        <button type="button" class="btn btn-icon btn-copy-table" data-copy-target="#inactiveCursorTableWrap" title="Копировать в буфер" aria-label="Копировать">${COPY_ICON_SVG}</button>
        <span class="copy-feedback" id="inactiveCursorCopyFeedback" aria-live="polite"></span>
      </div>
      <div class="table-wrap" id="inactiveCursorTableWrap">
        <table class="data-table inactive-cursor-table">
          <thead><tr>${ths}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function setupInactiveCursorSort() {
  const wrap = document.getElementById('inactiveCursorTableWrap');
  if (!wrap) return;
  wrap.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th || inactiveCursorList.length === 0) return;
    const key = th.getAttribute('data-sort');
    const dir = inactiveCursorSort.key === key && inactiveCursorSort.dir === 'asc' ? 'desc' : 'asc';
    const container = document.getElementById('inactiveCursorContainer');
    if (container) {
      container.innerHTML = renderInactiveCursorList(inactiveCursorList, { key, dir });
      setupInactiveCursorSort();
    }
  });
}

/** Блок: затраты по проекту помесячно (с сортировкой по клику на заголовок). */
function renderCostByProject(costByProjectByMonth, projectTotals, months, sortState) {
  let projects = Object.keys(costByProjectByMonth || {});
  if (!projects.length) {
    return '<p class="muted">Нет данных по проектам. Загрузите <a href="settings.html#jira">пользователей Jira</a> (Настройки → Jira) с полем «Проект».</p>';
  }
  const state = sortState || costByProjectSort;
  const dir = state.dir === 'desc' ? -1 : 1;
  projects = projects.slice().sort((a, b) => {
    if (state.key === 'project') {
      return dir * String(a).localeCompare(String(b), 'ru');
    }
    const va = projectTotals && projectTotals[a] ? projectTotals[a] : 0;
    const vb = projectTotals && projectTotals[b] ? projectTotals[b] : 0;
    return dir * (va - vb);
  });
  const monthHeaders = (months || []).map((m) => `<th title="${m}">${formatMonthShort(m)}</th>`).join('');
  const projectArrow = state.key === 'project' ? (state.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const spendArrow = state.key === 'spend' ? (state.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const rows = projects.map((project) => {
    const byMonth = costByProjectByMonth[project] || {};
    const cells = (months || []).map((month) => {
      const cur = byMonth[month];
      const cents = cur && cur.usageCostCents ? cur.usageCostCents : 0;
      return `<td class="num">${cents > 0 ? '$' + formatCostCents(cents) : '—'}</td>`;
    }).join('');
    const totalSpend = projectTotals && projectTotals[project] ? formatCostCents(projectTotals[project]) : '—';
    return `<tr><th class="project-name">${escapeHtml(project)}</th>${cells}<td class="num" title="Сумма за отображаемый период">${totalSpend !== '—' ? '$' + totalSpend : '—'}</td></tr>`;
  }).join('');
  return `
    <div class="table-block-with-copy">
      <div class="table-actions">
        <button type="button" class="btn btn-icon btn-copy-table" data-copy-target="#costByProjectTableWrap" title="Копировать в буфер" aria-label="Копировать">${COPY_ICON_SVG}</button>
        <span class="copy-feedback" aria-live="polite"></span>
      </div>
      <div class="table-wrap cost-by-project-table-wrap" id="costByProjectTableWrap">
        <table class="data-table cost-by-project-table">
          <thead>
            <tr>
              <th class="sortable" data-sort="project" title="Сортировать">Проект${projectArrow}</th>
              ${monthHeaders}
              <th class="sortable" data-sort="spend" title="Сортировать">Сумма за период${spendArrow}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

/** Таблица «Стоимость по моделям ($)» в сводке (с сортировкой по клику на заголовок). */
function renderSummaryCostByModelTable(entries, sortState) {
  const state = sortState || summaryCostByModelSort;
  const dir = state.dir === 'desc' ? -1 : 1;
  const inclEntries = (summaryCostByModelData.includedEntries || []);
  const inclMap = {};
  for (var ie = 0; ie < inclEntries.length; ie++) { inclMap[inclEntries[ie][0]] = inclEntries[ie][1]; }
  var hasIncl = inclEntries.length > 0;
  // Merge all model keys
  var allModels = new Set(entries.map(function (e) { return e[0]; }));
  inclEntries.forEach(function (e) { allModels.add(e[0]); });
  var merged = Array.from(allModels).map(function (model) {
    var onDemand = 0;
    for (var i = 0; i < entries.length; i++) { if (entries[i][0] === model) { onDemand = entries[i][1]; break; } }
    var incl = inclMap[model] || 0;
    return [model, onDemand, incl];
  });
  const sorted = merged.sort((a, b) => {
    if (state.key === 'model') {
      return dir * String(a[0]).localeCompare(String(b[0]), 'ru');
    }
    return dir * (a[1] - b[1]);
  });
  const modelArrow = state.key === 'model' ? (state.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const costArrow = state.key === 'cost' ? (state.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const inclHeader = hasIncl ? '<th class="num included-col">Included</th>' : '';
  return `
    <div class="summary-cost-by-model-label">Стоимость по моделям</div>
    <div class="table-actions">
      <button type="button" class="btn btn-icon btn-copy-table" data-copy-target="#summaryCostByModelTableWrap" title="Копировать в буфер" aria-label="Копировать">${COPY_ICON_SVG}</button>
      <span class="copy-feedback" aria-live="polite"></span>
    </div>
    <div class="table-wrap summary-cost-by-model-table-wrap" id="summaryCostByModelTableWrap">
      <table class="data-table summary-cost-by-model-table">
        <thead><tr>
          <th class="sortable" data-sort="model" title="Сортировать">Модель${modelArrow}</th>
          <th class="sortable num" data-sort="cost" title="Сортировать">$ on-demand${costArrow}</th>
          ${inclHeader}
        </tr></thead>
        <tbody>
          ${sorted.map(([model, cents, inclCents]) => `<tr><td>${escapeHtml(model)}</td><td class="num">$${formatCostCents(cents)}</td>${hasIncl ? '<td class="num included-col">($' + formatCostCents(inclCents) + ')</td>' : ''}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSummary(data, preparedUsers) {
  const allUsers = data.users || [];
  let totalRequests = 0, totalLinesAdded = 0, totalLinesDeleted = 0, activeUserCount = 0;
  let totalUsageEvents = 0, totalUsageCostCents = 0;
  let totalIncludedEvents = 0, totalIncludedCostCents = 0;
  const withActivity = (data.users || []).map((u) => ({ ...u, totals: u.totals || getUserTotals(u) }))
    .filter((u) => (u.totals.requests || 0) > 0 || (u.totals.activeDays || 0) > 0 || (u.totals.linesTotal || 0) > 0 || (u.totals.usageEventsCount || 0) > 0 || (u.totals.includedEventsCount || 0) > 0);
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheWrite = 0, totalCacheRead = 0;
  for (const u of withActivity) {
    totalRequests += u.totals.requests || 0;
    totalLinesAdded += u.totals.linesAdded || 0;
    totalLinesDeleted += u.totals.linesDeleted || 0;
    totalUsageEvents += u.totals.usageEventsCount || 0;
    totalUsageCostCents += u.totals.usageCostCents || 0;
    totalIncludedEvents += u.totals.includedEventsCount || 0;
    totalIncludedCostCents += u.totals.includedCostCents || 0;
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
      <span class="stat-label">событий (on-demand)</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">$${formatCostCents(totalUsageCostCents)}</span>
      <span class="stat-label">стоимость (on-demand)</span>
    </div>
  ` : '';
  const includedCards = totalIncludedEvents > 0 || totalIncludedCostCents > 0 ? `
    <div class="stat-card stat-card-included">
      <span class="stat-value">${totalIncludedEvents.toLocaleString('ru-RU')}</span>
      <span class="stat-label">событий (included)</span>
    </div>
    <div class="stat-card stat-card-included">
      <span class="stat-value">($${formatCostCents(totalIncludedCostCents)})</span>
      <span class="stat-label">условная стоимость (included)</span>
    </div>
  ` : '';
  const snapshotLinkCard = `
    <a href="team-snapshot.html" class="stat-card stat-card-link" title="Отдельный дашборд: запрос Team Members и Spending Data к Cursor API">
      <span class="stat-value">→</span>
      <span class="stat-label">Участники и расходы</span>
    </a>
  `;
  const totalByModel = {};
  const totalInclByModel = {};
  for (const u of withActivity) {
    const t = u.totals || getUserTotals(u);
    const byModel = t.usageCostByModel || {};
    for (const [model, cents] of Object.entries(byModel)) {
      totalByModel[model] = (totalByModel[model] || 0) + cents;
    }
    const inclByModel = t.includedCostByModel || {};
    for (const [model, cents] of Object.entries(inclByModel)) {
      totalInclByModel[model] = (totalInclByModel[model] || 0) + cents;
    }
  }
  const costByModelEntries = Object.entries(totalByModel).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  summaryCostByModelData.entries = costByModelEntries.slice();
  summaryCostByModelData.includedEntries = Object.entries(totalInclByModel).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const costByModelHtml = costByModelEntries.length
    ? `<div id="summaryCostByModelBlock" class="summary-cost-by-model">${renderSummaryCostByModelTable(costByModelEntries, summaryCostByModelSort)}</div>`
    : '';
  return `
    <div class="stat-card">
      <span class="stat-value">${allUsers.length}</span>
      <span class="stat-label">всего в Jira</span>
    </div>
    ${snapshotLinkCard}
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
    ${includedCards}
    <div class="stat-card stat-card-highlight">
      <span class="stat-value">${escapeHtml(topLabel)}</span>
      <span class="stat-label">самый активный по запросам</span>
    </div>
    ${costByModelHtml}
  `;
}

/** Данные для вида «карточки» (мастер–деталь): при клике обновляем только деталь. */
let cardsViewData = { preparedUsers: [], months: [], viewMetric: 'requests', maxVal: 0 };
let cardsSelectedIndex = 0;

/** Общая сумма расходов пользователя в центах (Usage Events + Spend API). */
function getUserTotalSpendCents(user) {
  const t = user.totals || getUserTotals(user);
  return (t.usageCostCents || 0) + (user.teamSpendCents || 0);
}

/** Компактная карточка в левой колонке: ФИО, статус, сумма в $. */
function renderCompactUserCard(user, index, isSelected) {
  const name = escapeHtml(user.displayName || user.email || '—');
  const statusBadge = formatJiraStatusBadge(user);
  const totalCents = getUserTotalSpendCents(user);
  const totalStr = totalCents > 0 ? `$${formatCostCents(totalCents)}` : '—';
  const active = isSelected ? ' user-card-compact-active' : '';
  return `
    <div class="user-card-compact${active}" data-index="${index}" role="button" tabindex="0">
      <div class="user-card-compact-name">${name}</div>
      <div class="user-card-compact-meta">${statusBadge} <span class="user-card-compact-total">${totalStr}</span></div>
    </div>
  `;
}

/** Одна полная карточка пользователя (правая колонка): структурированные блоки и график расходов по месяцам в $. */
function renderUserCardDetail(user, months, viewMetric, maxVal) {
  if (!user) return '<p class="muted">Выберите пользователя слева.</p>';
  const activityKey = user.monthlyActivity ? 'monthlyActivity' : 'weeklyActivity';
  const monthKey = activityKey === 'monthlyActivity' ? 'month' : 'week';
  const name = escapeHtml(user.displayName || user.email || '—');
  const email = user.email ? `<span class="user-card-email">${escapeHtml(user.email)}</span>` : '';
  const statusAndDates = formatUserStatusAndDates(user);
  const t = user.totals || getUserTotals(user);
  const act = user[activityKey] || [];

  // Максимум расходов по месяцам для шкалы графика
  let maxCostCents = 0;
  for (const a of act) {
    if ((a.usageCostCents || 0) > maxCostCents) maxCostCents = a.usageCostCents;
  }
  const monthlyBars = act.map((a) => {
    const cents = a.usageCostCents || 0;
    const inclCents = a.includedCostCents || 0;
    const intensity = maxCostCents > 0 ? getIntensity(cents, maxCostCents) : 0;
    const label = monthKey === 'month' ? formatMonthShort(a[monthKey]) : a[monthKey];
    const valueStr = cents > 0 ? `$${formatCostCents(cents)}` : '—';
    const inclStr = inclCents > 0 ? `, included ($${formatCostCents(inclCents)})` : '';
    const eventsStr = (a.usageEventsCount || 0) > 0 ? `, событий ${a.usageEventsCount}` : '';
    const inclEvStr = (a.includedEventsCount || 0) > 0 ? `, included ${a.includedEventsCount}` : '';
    const title = `${monthKey === 'month' ? formatMonthLabel(a[monthKey]) : a[monthKey]}: ${valueStr}${inclStr}${eventsStr}${inclEvStr}`;
    return `<div class="user-card-chart-bar" style="--intensity:${intensity}" title="${escapeHtml(title)}">
      <span class="user-card-chart-value">${valueStr}</span>
      <span class="user-card-chart-label">${escapeHtml(label)}</span>
    </div>`;
  }).join('');

  const applyAccept = (t.applies || t.accepts) ? ` <span class="user-card-stat">применений: ${t.applies || 0} / принято: ${t.accepts || 0}</span>` : '';
  const usageStats = (t.usageEventsCount > 0 || t.usageCostCents > 0) ? ` <span class="user-card-stat">событий: ${t.usageEventsCount || 0} - $${formatCostCents(t.usageCostCents)}</span>` : '';
  const includedStats = (t.includedEventsCount > 0 || t.includedCostCents > 0) ? ` <span class="user-card-stat user-card-stat-included">included: ${t.includedEventsCount || 0} - ($${formatCostCents(t.includedCostCents)})</span>` : '';
  const hasTokens = t.usageInputTokens > 0 || t.usageOutputTokens > 0 || t.usageCacheWriteTokens > 0 || t.usageCacheReadTokens > 0;
  const tokenStats = hasTokens ? `
    <div class="user-card-tokens-wrap">
      <table class="user-card-tokens-table" title="input / output / cache write / cache read (М — млн, К — тыс)">
        <tbody>
          <tr><td>in</td><td class="num">${formatTokensShort(t.usageInputTokens)}</td></tr>
          <tr><td>out</td><td class="num">${formatTokensShort(t.usageOutputTokens)}</td></tr>
          <tr><td>cW</td><td class="num">${formatTokensShort(t.usageCacheWriteTokens)}</td></tr>
          <tr><td>cR</td><td class="num">${formatTokensShort(t.usageCacheReadTokens)}</td></tr>
        </tbody>
      </table>
    </div>
  ` : '';
  const teamSpendStat = (user.teamSpendCents > 0) ? ` <span class="user-card-stat">Расходы текущего месяца: $${formatCostCents(user.teamSpendCents)}</span>` : '';
  const allModelKeys = new Set([...Object.keys(t.usageCostByModel || {}), ...Object.keys(t.includedCostByModel || {})]);
  const hasIncludedModels = t.includedCostByModel && Object.keys(t.includedCostByModel).some(function (k) { return (t.includedCostByModel[k] || 0) > 0; });
  const byModelRows = allModelKeys.size > 0 ? Array.from(allModelKeys).map(function (model) {
    const onDemand = (t.usageCostByModel || {})[model] || 0;
    const incl = (t.includedCostByModel || {})[model] || 0;
    return { model: model, onDemand: onDemand, incl: incl, total: onDemand + incl };
  }).filter(function (r) { return r.total > 0; }).sort(function (a, b) { return b.total - a.total; }).map(function (r) {
    return '<tr><td>' + escapeHtml(r.model) + '</td><td class="num">$' + formatCostCents(r.onDemand) + '</td>' + (hasIncludedModels ? '<td class="num included-col">($' + formatCostCents(r.incl) + ')</td>' : '') + '</tr>';
  }).join('') : '';
  const modelTheadIncl = hasIncludedModels ? '<th class="num included-col">Included</th>' : '';
  const costByModelBlock = byModelRows ? '<div class="user-card-section user-card-section-models"><div class="user-card-section-title">Стоимость по моделям</div><div class="user-card-cost-by-model-wrap"><table class="user-card-cost-by-model-table"><thead><tr><th>Модель</th><th class="num">$</th>' + modelTheadIncl + '</tr></thead><tbody>' + byModelRows + '</tbody></table></div></div>' : '';

  return `
    <div class="user-card user-card-detail">
      <div class="user-card-header">
        <div class="user-card-name">${name} ${statusAndDates}</div>
        ${email}
      </div>
      <div class="user-card-detail-grid">
        <div class="user-card-section user-card-section-activity">
          <div class="user-card-section-title">Активность</div>
          <div class="user-card-stats user-card-stats-block">
            <span class="user-card-stat"><strong>${t.requests}</strong> запросов</span>
            <span class="user-card-stat"><strong>${t.activeDays}</strong> дн. активности</span>
            <span class="user-card-stat stat-add">+${t.linesAdded}</span>
            <span class="user-card-stat stat-del">−${t.linesDeleted}</span>
            ${applyAccept}
          </div>
        </div>
        <div class="user-card-section user-card-section-spend">
          <div class="user-card-section-title">Расходы</div>
          <div class="user-card-stats user-card-stats-block">
            ${(usageStats || includedStats || teamSpendStat) ? [usageStats, includedStats, teamSpendStat].filter(Boolean).join('') : '<span class="muted">Нет данных</span>'}
          </div>
        </div>
        <div class="user-card-section user-card-section-tokens">
          <div class="user-card-section-title">Токены</div>
          ${tokenStats || '<p class="muted user-card-no-tokens">Нет данных</p>'}
        </div>
        ${costByModelBlock}
      </div>
      <div class="user-card-section user-card-section-monthly">
        <div class="user-card-section-title">Расход по месяцам ($)</div>
        <div class="user-card-chart-bars">${monthlyBars}</div>
      </div>
    </div>
  `;
}

/** Карточки: слева — стопка компактных (ФИО, статус, сумма $), справа — детали выбранного. */
function renderCards(preparedUsers, months, viewMetric, selectedIndex) {
  if (!months.length) return '<p class="muted">Нет месяцев в периоде.</p>';
  const activityKey = preparedUsers.length && preparedUsers[0].monthlyActivity ? 'monthlyActivity' : 'weeklyActivity';
  let maxVal = 0;
  for (const u of preparedUsers) {
    for (const a of u[activityKey] || []) {
      const v = viewMetric === 'requests' ? (a.requests || 0) : viewMetric === 'lines' ? (a.linesAdded || 0) + (a.linesDeleted || 0) : (a.activeDays || 0);
      if (v > maxVal) maxVal = v;
    }
  }
  cardsViewData = { preparedUsers, months, viewMetric, maxVal };
  cardsSelectedIndex = selectedIndex == null ? 0 : Math.min(selectedIndex, preparedUsers.length - 1);
  const sel = cardsSelectedIndex;
  const leftCards = preparedUsers.map((u, i) => renderCompactUserCard(u, i, i === sel)).join('');
  const selectedUser = preparedUsers[sel] || null;
  const detailHtml = renderUserCardDetail(selectedUser, months, viewMetric, maxVal);
  return `
    <div class="cards-master-detail">
      <div class="cards-master" aria-label="Список пользователей">
        <div class="cards-master-list">${leftCards}</div>
      </div>
      <div class="cards-detail" aria-label="Подробные данные пользователя">
        <div id="cardsDetailContainer">${detailHtml}</div>
      </div>
    </div>
  `;
}

function setupCardsSelection() {
  const master = document.querySelector('.cards-master-list');
  const detailContainer = document.getElementById('cardsDetailContainer');
  if (!master || !detailContainer) return;
  master.addEventListener('click', (e) => {
    const card = e.target.closest('.user-card-compact[data-index]');
    if (!card) return;
    const index = parseInt(card.getAttribute('data-index'), 10);
    if (isNaN(index)) return;
    const { preparedUsers, months, viewMetric, maxVal } = cardsViewData;
    if (!preparedUsers.length) return;
    cardsSelectedIndex = Math.min(index, preparedUsers.length - 1);
    master.querySelectorAll('.user-card-compact').forEach((el) => el.classList.remove('user-card-compact-active'));
    card.classList.add('user-card-compact-active');
    const user = preparedUsers[cardsSelectedIndex] || null;
    detailContainer.innerHTML = renderUserCardDetail(user, months, viewMetric, maxVal);
  });
  master.querySelectorAll('.user-card-compact').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      el.click();
    });
  });
}

/** Сортировка по клику на заголовок «Пользователь» в таблице или тепловой карте. */
function setupMainTableSort() {
  const tableWrap = document.getElementById('usersTableWrap');
  const heatmap = document.querySelector('.dashboard-heatmap');
  const thead = (tableWrap && tableWrap.querySelector('thead')) || (heatmap && heatmap.querySelector('thead'));
  if (!thead) return;
  thead.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort="name"]');
    if (!th) return;
    const sortByEl = document.getElementById('sortBy');
    if (sortByEl) sortByEl.value = 'name';
    tableSortNameDir = tableSortNameDir === 'asc' ? 'desc' : 'asc';
    load();
  });
}

/** Сортировка по клику на заголовки таблицы «Затраты по проекту». */
function setupCostByProjectSort() {
  const wrap = document.getElementById('costByProjectTableWrap');
  if (!wrap || !costByProjectData) return;
  wrap.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.getAttribute('data-sort');
    if (key !== 'project' && key !== 'spend') return;
    if (costByProjectSort.key === key) {
      costByProjectSort.dir = costByProjectSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      costByProjectSort = { key, dir: 'asc' };
    }
    const container = document.getElementById('costByProjectContainer');
    if (container) {
      container.innerHTML = renderCostByProject(costByProjectData.costByProjectByMonth, costByProjectData.projectTotals, costByProjectData.months, costByProjectSort);
      setupCostByProjectSort();
    }
  });
}

/** Сортировка по клику на заголовки таблицы «Стоимость по моделям». */
function setupSummaryCostByModelSort() {
  const block = document.getElementById('summaryCostByModelBlock');
  if (!block || !summaryCostByModelData.entries.length) return;
  const table = block.querySelector('.summary-cost-by-model-table');
  if (!table) return;
  const thead = table.querySelector('thead');
  if (!thead) return;
  thead.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.getAttribute('data-sort');
    if (key !== 'model' && key !== 'cost') return;
    if (summaryCostByModelSort.key === key) {
      summaryCostByModelSort.dir = summaryCostByModelSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      summaryCostByModelSort = { key, dir: key === 'cost' ? 'desc' : 'asc' };
    }
    block.innerHTML = renderSummaryCostByModelTable(summaryCostByModelData.entries, summaryCostByModelSort);
    setupSummaryCostByModelSort();
  });
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
  const nameSortArrow = tableSortNameDir === 'desc' ? ' ↓' : ' ↑';
  const rows = grid.map(({ user, values }) => {
    const name = escapeHtml(user.displayName || user.email || '—');
    const statusAndDates = formatUserStatusAndDates(user);
    const act = user[activityKey] || [];
    const cells = values.map((v, i) => {
      const intensity = getIntensity(v, maxVal);
      const a = act[i];
      const usagePart = (a && (a.usageEventsCount > 0 || a.usageCostCents > 0)) ? `; событий ${a.usageEventsCount || 0}, $${formatCostCents(a.usageCostCents)}` : '';
      const inclPart = (a && (a.includedEventsCount > 0 || a.includedCostCents > 0)) ? `; included ${a.includedEventsCount || 0}, ($${formatCostCents(a.includedCostCents)})` : '';
      const title = v > 0 ? `Месяц: ${v}${usagePart}${inclPart}` : '';
      return `<td class="heatmap-td" style="--intensity:${intensity}" title="${title}">${v > 0 ? v : ''}</td>`;
    }).join('');
    return `<tr><th class="heatmap-th-name">${name} ${statusAndDates}</th>${cells}</tr>`;
  }).join('');
  return `
    <div class="table-block-with-copy">
      <div class="table-actions">
        <button type="button" class="btn btn-icon btn-copy-table" data-copy-target="#heatmapTableWrap" title="Копировать в буфер" aria-label="Копировать">${COPY_ICON_SVG}</button>
        <span class="copy-feedback" aria-live="polite"></span>
      </div>
      <div class="table-wrap dashboard-heatmap-wrap" id="heatmapTableWrap">
        <table class="dashboard-heatmap">
          <thead><tr><th class="sortable heatmap-th-name" data-sort="name" title="Сортировать">Пользователь${nameSortArrow}</th>${monthHeaders}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

/** Таблица по месяцам с цветом ячеек и итогами */
function renderTable(preparedUsers, months, viewMetric) {
  const activityKey = preparedUsers.length && preparedUsers[0].monthlyActivity ? 'monthlyActivity' : 'weeklyActivity';
  const monthKey = activityKey === 'monthlyActivity' ? 'month' : 'week';
  const nameSortArrow = tableSortNameDir === 'desc' ? ' ↓' : ' ↑';
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
      const inclPart = (a.includedEventsCount > 0 || a.includedCostCents > 0) ? `; included ${a.includedEventsCount || 0}, ($${formatCostCents(a.includedCostCents)})` : '';
      const title = `${a.activeDays} дн., запросов: ${a.requests}, +${a.linesAdded}/−${a.linesDeleted}${usagePart}${inclPart}`;
      const text = viewMetric === 'lines' ? `+${a.linesAdded}/−${a.linesDeleted}` : v;
      return `<td class="table-cell-intensity" style="--intensity:${intensity}" title="${escapeHtml(title)}">${text}</td>`;
    }).join('');
    const usageTotals = (t.usageEventsCount > 0 || t.usageCostCents > 0) ? ` · Событий: ${t.usageEventsCount} · $${formatCostCents(t.usageCostCents)}` : '';
    const inclTotals = (t.includedEventsCount > 0 || t.includedCostCents > 0) ? ` · Included: ${t.includedEventsCount} · ($${formatCostCents(t.includedCostCents)})` : '';
    const hasTokenTotals = t.usageInputTokens > 0 || t.usageOutputTokens > 0 || t.usageCacheWriteTokens > 0 || t.usageCacheReadTokens > 0;
    const tokenTotals = hasTokenTotals ? ` · Токены: in ${formatTokensShort(t.usageInputTokens)}, out ${formatTokensShort(t.usageOutputTokens)}, cW ${formatTokensShort(t.usageCacheWriteTokens)}, cR ${formatTokensShort(t.usageCacheReadTokens)}` : '';
    const teamSpendLine = (u.teamSpendCents > 0) ? ` · Расходы текущего месяца: $${formatCostCents(u.teamSpendCents)}` : '';
    const byModel = t.usageCostByModel && Object.keys(t.usageCostByModel).length ? Object.entries(t.usageCostByModel).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([model, cents]) => `${model}: $${formatCostCents(cents)}`).join('; ') : '';
    const costByModelLine = byModel ? `<div class="table-user-cost-by-model" title="Стоимость по моделям">${escapeHtml(byModel)}</div>` : '';
    return `<tr>
      <td class="table-user-cell">${name} ${statusAndDates}${email}<div class="table-user-totals">Запросов: ${t.requests} · Дней: ${t.activeDays}${usageTotals}${inclTotals}${tokenTotals}${teamSpendLine}</div>${costByModelLine}</td>
      ${cells}
    </tr>`;
  }).join('');
  return `
    <div class="table-block-with-copy">
      <div class="table-actions">
        <button type="button" class="btn btn-icon btn-copy-table" data-copy-target="#usersTableWrap" title="Копировать в буфер" aria-label="Копировать">${COPY_ICON_SVG}</button>
        <span class="copy-feedback" aria-live="polite"></span>
      </div>
      <div class="table-wrap" id="usersTableWrap">
        <table class="data-table users-dashboard-table">
          <thead>
            <tr>
              <th class="sortable" data-sort="name" title="Сортировать">Пользователь${nameSortArrow}</th>
              ${monthHeaders}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

/** Кэш последних загруженных данных: при смене сортировки/вида обновляем только блок пользователей. */
let lastDashboardData = null;

/** Обновляет только блок «Активность по пользователям» (без повторного запроса к API). */
function updateContentBlockOnly() {
  if (!lastDashboardData) return;
  const viewModeEl = document.getElementById('viewMode');
  const sortByEl = document.getElementById('sortBy');
  const showOnlyActiveEl = document.getElementById('showOnlyActive');
  const viewMode = viewModeEl ? viewModeEl.value : 'cards';
  const sortBy = sortByEl ? sortByEl.value : 'requests';
  const showOnlyActive = showOnlyActiveEl ? showOnlyActiveEl.checked : true;
  const data = lastDashboardData;
  const months = data.months || [];
  const users = data.users || [];
  if (!users.length || !months.length) return;
  const tableContainer = document.getElementById('tableContainer');
  const heatmapContainer = document.getElementById('heatmapContainer');
  const cardsContainer = document.getElementById('cardsContainer');
  const tableSummary = document.getElementById('tableSummary');
  if (!tableContainer || !heatmapContainer || !cardsContainer) return;

  const preparedUsers = prepareUsers(data, sortBy, showOnlyActive);
  const viewMetric = sortBy === 'lines' ? 'lines' : sortBy === 'activeDays' ? 'activeDays' : 'requests';

  tableContainer.style.display = 'none';
  heatmapContainer.style.display = 'none';
  heatmapContainer.innerHTML = '';
  cardsContainer.style.display = 'none';
  cardsContainer.innerHTML = '';

  if (viewMode === 'cards') {
    cardsContainer.innerHTML = renderCards(preparedUsers, months, viewMetric, 0);
    cardsContainer.style.display = 'block';
    setupCardsSelection();
  } else if (viewMode === 'heatmap') {
    heatmapContainer.innerHTML = renderHeatmap(preparedUsers, months, viewMetric);
    heatmapContainer.style.display = 'block';
    setupMainTableSort();
  } else {
    tableContainer.innerHTML = renderTable(preparedUsers, months, viewMetric);
    tableContainer.style.display = 'block';
    setupMainTableSort();
  }

  if (tableSummary) tableSummary.textContent = `Пользователей: ${preparedUsers.length}, месяцев: ${months.length}.`;
}

/** По умолчанию подставить период по данным в БД: min из всех эндпоинтов … max из всех; если пусто — последние 90 дней. */
async function setDefaultDates() {
  const elEnd = document.getElementById('endDate');
  const elStart = document.getElementById('startDate');
  if (!elEnd || !elStart) return;
  try {
    const r = await fetchWithAuth('/api/analytics/coverage');
    if (!r) {
      setFallbackDates(elStart, elEnd);
      return;
    }
    const data = await r.json();
    const coverage = data.coverage || [];
    if (coverage.length) {
      const mins = coverage.map((c) => c.min_date).filter(Boolean).sort();
      const maxs = coverage.map((c) => c.max_date).filter(Boolean).sort();
      if (mins.length && maxs.length) {
        elStart.value = mins[0];
        elEnd.value = maxs[maxs.length - 1];
        return;
      }
    }
    setFallbackDates(elStart, elEnd);
  } catch (_) {
    setFallbackDates(elStart, elEnd);
  }
}

function setFallbackDates(elStart, elEnd) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  if (!elStart.value) elStart.value = start.toISOString().slice(0, 10);
  if (!elEnd.value) elEnd.value = end.toISOString().slice(0, 10);
}

function showDataFreshness(dataEndDate) {
  const freshnessEl = document.getElementById('dataFreshness');
  const freshnessText = document.getElementById('dataFreshnessText');
  if (!freshnessEl || !freshnessText) return;
  if (!dataEndDate) {
    freshnessEl.style.display = 'none';
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(dataEndDate);
  endDate.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today - endDate) / (1000 * 60 * 60 * 24));
  let message = '';
  if (diffDays === 0) {
    message = '✓ Данные актуальны (обновлено сегодня)';
    freshnessEl.style.background = 'var(--accent-light)';
  } else if (diffDays === 1) {
    message = 'Данные актуальны на вчера (' + formatJiraDate(dataEndDate) + ')';
    freshnessEl.style.background = 'var(--accent-light)';
  } else if (diffDays <= 7) {
    message = 'Данные за ' + formatJiraDate(dataEndDate) + ' (' + diffDays + ' дн. назад)';
    freshnessEl.style.background = '#fff3cd';
  } else {
    message = '⚠ Данные устарели: ' + formatJiraDate(dataEndDate) + ' (' + diffDays + ' дн. назад)';
    freshnessEl.style.background = '#f8d7da';
  }
  freshnessText.textContent = message;
  freshnessEl.style.display = 'block';
}

async function load() {
  const startDate = (document.getElementById('startDate') || {}).value;
  const endDate = (document.getElementById('endDate') || {}).value;
  const viewModeEl = document.getElementById('viewMode');
  const sortByEl = document.getElementById('sortBy');
  const showOnlyActiveEl = document.getElementById('showOnlyActive');
  const viewMode = viewModeEl ? viewModeEl.value : 'cards';
  const sortBy = sortByEl ? sortByEl.value : 'requests';
  const showOnlyActive = showOnlyActiveEl ? showOnlyActiveEl.checked : true;
  const statusEl = document.getElementById('loadStatus');
  const summaryPanel = document.getElementById('summaryPanel');
  const contentPanel = document.getElementById('contentPanel');
  const tableContainer = document.getElementById('tableContainer');
  const heatmapContainer = document.getElementById('heatmapContainer');
  const cardsContainer = document.getElementById('cardsContainer');
  const summaryStats = document.getElementById('summaryStats');
  const tableSummary = document.getElementById('tableSummary');

  if (!startDate || !endDate) {
    if (statusEl) statusEl.textContent = 'Укажите начальную и конечную дату.';
    if (statusEl) statusEl.className = 'meta error';
    return;
  }
  if (statusEl) statusEl.textContent = 'Загрузка...';
  if (statusEl) statusEl.className = 'meta';
  if (summaryPanel) summaryPanel.style.display = 'none';
  if (contentPanel) contentPanel.style.display = 'none';
  var inactPanelH = document.getElementById('inactiveCursorPanel');
  var costPanelH = document.getElementById('costByProjectPanel');
  if (inactPanelH) inactPanelH.style.display = 'none';
  if (costPanelH) costPanelH.style.display = 'none';
  try {
    const r = await fetchWithAuth('/api/users/activity-by-month?' + new URLSearchParams({ startDate, endDate }));
    if (!r) return;
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);

    lastDashboardData = data;

    const users = data.users || [];
    const months = data.months || [];
    if (!users.length) {
      if (tableContainer) tableContainer.innerHTML = '<p class="muted">Нет данных по пользователям за выбранный период. Убедитесь, что в БД загружены <strong>Daily Usage Data</strong> (Настройки → Загрузка в БД). Опционально загрузите <a href="settings.html#jira">пользователей Jira</a> для отображения имён вместо email.</p>';
      if (contentPanel) contentPanel.style.display = 'block';
      if (statusEl) statusEl.textContent = '';
      return;
    }
    if (!months.length) {
      if (tableContainer) tableContainer.innerHTML = '<p class="muted">Нет записей Daily Usage за выбранный период. Проверьте диапазон дат или загрузите данные в <a href="settings.html#admin">Настройки → Загрузка в БД</a>. Что уже есть в БД — <a href="settings.html#data">Настройки → Данные в БД</a>.</p>';
      if (contentPanel) contentPanel.style.display = 'block';
      if (statusEl) statusEl.textContent = '';
      return;
    }

    const preparedUsers = prepareUsers(data, sortBy, showOnlyActive);
    if (summaryStats) summaryStats.innerHTML = renderSummary(data, preparedUsers);
    if (summaryPanel) summaryPanel.style.display = 'block';
    if (contentPanel) contentPanel.style.display = 'block';
    setupSummaryCostByModelSort();

    const inactiveCursorPanel = document.getElementById('inactiveCursorPanel');
    const inactiveCursorContainer = document.getElementById('inactiveCursorContainer');
    const costByProjectPanel = document.getElementById('costByProjectPanel');
    const costByProjectContainer = document.getElementById('costByProjectContainer');
    if (inactiveCursorPanel && inactiveCursorContainer) {
      inactiveCursorSort = { key: 'lastActivityMonth', dir: 'asc' };
      inactiveCursorContainer.innerHTML = renderInactiveCursorList(data.activeJiraButInactiveCursor || []);
      inactiveCursorPanel.style.display = 'block';
      setupInactiveCursorSort();
    }
    if (costByProjectPanel && costByProjectContainer) {
      costByProjectData = { costByProjectByMonth: data.costByProjectByMonth || {}, projectTotals: data.projectTotals || {}, months: data.months || [] };
      costByProjectContainer.innerHTML = renderCostByProject(costByProjectData.costByProjectByMonth, costByProjectData.projectTotals, costByProjectData.months, costByProjectSort);
      costByProjectPanel.style.display = 'block';
      setupCostByProjectSort();
    }

    const viewMetric = sortBy === 'lines' ? 'lines' : sortBy === 'activeDays' ? 'activeDays' : 'requests';
    tableContainer.style.display = 'none';
    heatmapContainer.style.display = 'none';
    heatmapContainer.innerHTML = '';
    cardsContainer.style.display = 'none';
    cardsContainer.innerHTML = '';

    if (viewMode === 'cards') {
      cardsContainer.innerHTML = renderCards(preparedUsers, months, viewMetric, 0);
      cardsContainer.style.display = 'block';
      setupCardsSelection();
    } else if (viewMode === 'heatmap') {
      heatmapContainer.innerHTML = renderHeatmap(preparedUsers, months, viewMetric);
      heatmapContainer.style.display = 'block';
      setupMainTableSort();
    } else {
      tableContainer.innerHTML = renderTable(preparedUsers, months, viewMetric);
      tableContainer.style.display = 'block';
      setupMainTableSort();
    }

    if (tableSummary) tableSummary.textContent = `Пользователей: ${preparedUsers.length}, месяцев: ${months.length}.`;
    if (statusEl) statusEl.textContent = '';
    showDataFreshness(endDate);
  } catch (e) {
    if (statusEl) { statusEl.textContent = e.message || 'Ошибка загрузки'; statusEl.className = 'meta error'; }
    if (summaryPanel) summaryPanel.style.display = 'none';
    if (contentPanel) contentPanel.style.display = 'none';
    var inactP = document.getElementById('inactiveCursorPanel');
    var costP = document.getElementById('costByProjectPanel');
    if (inactP) inactP.style.display = 'none';
    if (costP) costP.style.display = 'none';
    if (tableSummary) tableSummary.textContent = '';
  }
}

function init() {
  setDefaultDates().then(() => {
    const startEl = document.getElementById('startDate');
    const endEl = document.getElementById('endDate');
    if (startEl && endEl && startEl.value && endEl.value) load();
  });
  const btnLoad = document.getElementById('btnLoad');
  if (btnLoad) btnLoad.addEventListener('click', load);
  const viewModeEl = document.getElementById('viewMode');
  const sortByEl = document.getElementById('sortBy');
  const showOnlyActiveEl = document.getElementById('showOnlyActive');
  if (viewModeEl) viewModeEl.addEventListener('change', updateContentBlockOnly);
  if (sortByEl) sortByEl.addEventListener('change', updateContentBlockOnly);
  if (showOnlyActiveEl) showOnlyActiveEl.addEventListener('change', updateContentBlockOnly);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
