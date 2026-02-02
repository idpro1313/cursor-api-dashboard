/**
 * Дашборд пользователей: Jira + активность Cursor по неделям
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

function getMetricValue(activity, metric) {
  switch (metric) {
    case 'activeDays':
      return activity.activeDays;
    case 'requests':
      return activity.requests;
    case 'lines':
      return (activity.linesAdded || 0) + '/' + (activity.linesDeleted || 0);
    default:
      return activity.activeDays;
  }
}

function renderTable(data, metric) {
  const { users, weeks } = data;
  if (!users || users.length === 0) {
    return '<p class="muted">Нет пользователей из Jira. Загрузите CSV на странице <a href="jira-users.html">Пользователи Jira</a>.</p>';
  }
  if (!weeks || weeks.length === 0) {
    return '<p class="muted">Нет данных по активности за выбранный период. Загрузите Daily Usage в БД на <a href="index.html">главной</a>.</p>';
  }
  const weekHeaders = weeks.map((w) => `<th title="${w}">${escapeHtml(formatWeekLabel(w))}</th>`).join('');
  const rows = users.map((u) => {
    const name = escapeHtml(u.displayName || u.email || '—');
    const email = u.email ? `<br><span class="muted" style="font-size:0.8em">${escapeHtml(u.email)}</span>` : '';
    const cells = u.weeklyActivity.map((a) => {
      const v = getMetricValue(a, metric);
      const title = `${a.activeDays} дн., запросов: ${a.requests}`;
      return `<td title="${title}">${escapeHtml(String(v))}</td>`;
    }).join('');
    return `<tr><td>${name}${email}</td>${cells}</tr>`;
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
  const metric = document.getElementById('metric').value;
  const statusEl = document.getElementById('loadStatus');
  const tableEl = document.getElementById('tableContainer');
  const summaryEl = document.getElementById('tableSummary');
  if (!startDate || !endDate) {
    statusEl.textContent = 'Укажите начальную и конечную дату.';
    statusEl.className = 'meta error';
    return;
  }
  statusEl.textContent = 'Загрузка...';
  statusEl.className = 'meta';
  try {
    const r = await fetch('/api/users/activity-by-week?' + new URLSearchParams({ startDate, endDate }));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    tableEl.innerHTML = renderTable(data, metric);
    summaryEl.textContent = `Пользователей: ${(data.users || []).length}, недель: ${(data.weeks || []).length}.`;
    statusEl.textContent = '';
  } catch (e) {
    statusEl.textContent = e.message || 'Ошибка загрузки';
    statusEl.className = 'meta error';
    tableEl.innerHTML = '';
    summaryEl.textContent = '';
  }
}

function init() {
  setDefaultDates();
  document.getElementById('btnLoad').addEventListener('click', load);
  document.getElementById('metric').addEventListener('change', () => {
    const start = document.getElementById('startDate').value;
    const end = document.getElementById('endDate').value;
    if (start && end) load();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
