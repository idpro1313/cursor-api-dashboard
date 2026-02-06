/**
 * Дашборд «Участники команды и расходы». Требует js/common.js (escapeHtml, formatCostCents, COPY_ICON_SVG).
 */
function getEmailFromJiraRow(row) {
  const emailKeys = ['Внешний почтовый адрес', 'Email', 'email', 'E-mail', 'e-mail', 'Почта'];
  for (const k of emailKeys) {
    const v = row[k];
    if (v != null && String(v).includes('@')) return String(v).trim().toLowerCase();
  }
  for (const k of Object.keys(row || {})) {
    const v = row[k];
    if (v != null && String(v).includes('@')) return String(v).trim().toLowerCase();
  }
  return null;
}

function getJiraProjectFromRow(row) {
  const projectKeys = ['Проект', 'Project', 'Project key', 'Название проекта', 'Project name', 'Проект / Project'];
  for (const k of projectKeys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

function getJiraDisplayName(row) {
  return row['Пользователь, которому выдан доступ'] || row['Display Name'] || row['Username'] || row['Name'] || '';
}

/** Статус из Jira → 'active' | 'archived'. */
function getJiraStatusFromRow(row) {
  if (!row) return null;
  const statusKeys = ['Статус', 'Status', 'Состояние', 'State'];
  let raw = '';
  for (const k of statusKeys) {
    if (row[k] != null && String(row[k]).trim() !== '') {
      raw = String(row[k]).trim().toLowerCase();
      break;
    }
  }
  if (!raw) return 'active';
  const archivedTerms = ['архив', 'archived', 'неактив', 'inactive', 'отключ', 'disabled', 'закрыт', 'closed'];
  return archivedTerms.some((t) => raw.includes(t)) ? 'archived' : 'active';
}

/** Сырое значение даты начала подписки из Jira. */
function getJiraSubscriptionStartFromRow(row) {
  if (!row) return '';
  const keys = ['Дата начала подписки', 'Subscription start date', 'Subscription start', 'Дата подписки', 'Start date'];
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Сырое значение даты окончания подписки из Jira. */
function getJiraSubscriptionEndFromRow(row) {
  if (!row) return '';
  const keys = ['Дата окончания подписки', 'Subscription end date', 'Subscription end', 'End date', 'Дата отключения'];
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Объединить Team Members + Spending + Jira в один массив строк для таблицы */
function mergeTableRows(snapshotData, jiraUsers) {
  const members = snapshotData.teamMembers || [];
  const spendByEmail = new Map((snapshotData.teamMemberSpend || []).map((s) => [s.email, s.cents || 0]));
  const jiraByEmail = new Map();
  (jiraUsers || []).forEach((row) => {
    const email = getEmailFromJiraRow(row);
    if (email) jiraByEmail.set(email, row);
  });

  const seen = new Set();
  const rows = [];
  for (const m of members) {
    const email = (m.email || '').toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const jira = jiraByEmail.get(email);
    const name = (jira && getJiraDisplayName(jira)) || m.name || email;
    const project = (jira && getJiraProjectFromRow(jira)) || '—';
    const status = jira ? getJiraStatusFromRow(jira) : null;
    const subscriptionStart = (jira && getJiraSubscriptionStartFromRow(jira)) || '—';
    const subscriptionEnd = (jira && getJiraSubscriptionEndFromRow(jira)) || '—';
    const cents = spendByEmail.get(email) || 0;
    rows.push({ name, email, project, status, subscriptionStart, subscriptionEnd, cents });
  }
  for (const [email, cents] of spendByEmail) {
    if (seen.has(email)) continue;
    seen.add(email);
    const jira = jiraByEmail.get(email);
    const name = (jira && getJiraDisplayName(jira)) || email;
    const project = (jira && getJiraProjectFromRow(jira)) || '—';
    const status = jira ? getJiraStatusFromRow(jira) : null;
    const subscriptionStart = (jira && getJiraSubscriptionStartFromRow(jira)) || '—';
    const subscriptionEnd = (jira && getJiraSubscriptionEndFromRow(jira)) || '—';
    rows.push({ name, email, project, status, subscriptionStart, subscriptionEnd, cents });
  }
  return rows;
}

function renderSummary(data) {
  const count = data.teamMembersCount ?? 0;
  const total = data.totalSpendCents ?? 0;
  return `
    <div class="stat-card">
      <span class="stat-value">${count}</span>
      <span class="stat-label">участников в команде</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">$${formatCostCents(total)}</span>
      <span class="stat-label">расходы текущего месяца</span>
    </div>
  `;
}

let tableSortState = { key: 'name', dir: 'asc' };
let tableRows = [];

function sortRows(rows, key, dir) {
  const arr = [...rows];
  const asc = dir === 'asc';
  arr.sort((a, b) => {
    if (key === 'name' || key === 'email' || key === 'project' || key === 'status' || key === 'subscriptionStart' || key === 'subscriptionEnd') {
      const va = (a[key] || '').toString().toLowerCase();
      const vb = (b[key] || '').toString().toLowerCase();
      const cmp = va.localeCompare(vb, 'ru');
      return asc ? cmp : -cmp;
    }
    if (key === 'cents') {
      return asc ? (a.cents || 0) - (b.cents || 0) : (b.cents || 0) - (a.cents || 0);
    }
    return 0;
  });
  return arr;
}

function formatStatus(status) {
  if (status === 'archived') return 'Архивный';
  if (status === 'active') return 'Активный';
  return '—';
}

function renderTable(rows) {
  tableRows = rows;
  const sorted = sortRows(rows, tableSortState.key, tableSortState.dir);
  const arrow = (key) => (tableSortState.key === key ? (tableSortState.dir === 'asc' ? ' ↑' : ' ↓') : '');
  const nameArrow = arrow('name');
  const emailArrow = arrow('email');
  const projectArrow = arrow('project');
  const statusArrow = arrow('status');
  const startArrow = arrow('subscriptionStart');
  const endArrow = arrow('subscriptionEnd');
  const spendArrow = arrow('cents');

  const bodyRows = sorted.map((r) => `
    <tr>
      <td>${escapeHtml(r.name || '—')}</td>
      <td class="muted">${escapeHtml(r.email)}</td>
      <td>${escapeHtml(r.project || '—')}</td>
      <td>${escapeHtml(formatStatus(r.status))}</td>
      <td>${escapeHtml(r.subscriptionStart === '—' ? '—' : r.subscriptionStart)}</td>
      <td>${escapeHtml(r.subscriptionEnd === '—' ? '—' : r.subscriptionEnd)}</td>
      <td class="num">${r.cents > 0 ? '$' + formatCostCents(r.cents) : '—'}</td>
    </tr>
  `).join('');

  return `
    <div class="table-block-with-copy">
      <div class="table-actions">
        <button type="button" class="btn btn-icon btn-copy-table" data-copy-target="#teamSnapshotTableWrap" title="Копировать в буфер" aria-label="Копировать">${COPY_ICON_SVG}</button>
        <span class="copy-feedback" aria-live="polite"></span>
      </div>
      <div class="table-wrap" id="teamSnapshotTableWrap">
        <table class="data-table team-snapshot-table">
          <thead>
            <tr>
              <th class="sortable" data-sort="name" title="Сортировать">Имя${nameArrow}</th>
              <th class="sortable" data-sort="email" title="Сортировать">Email${emailArrow}</th>
              <th class="sortable" data-sort="project" title="Сортировать">Проект (Jira)${projectArrow}</th>
              <th class="sortable" data-sort="status" title="Сортировать">Статус${statusArrow}</th>
              <th class="sortable" data-sort="subscriptionStart" title="Сортировать">Дата начала подписки${startArrow}</th>
              <th class="sortable" data-sort="subscriptionEnd" title="Сортировать">Дата окончания подписки${endArrow}</th>
              <th class="sortable num" data-sort="cents" title="Сортировать">Расходы${spendArrow}</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function setupCopyButton() {
  document.getElementById('teamSnapshotTableWrap')?.closest('.table-block-with-copy')?.querySelector('.btn-copy-table')?.addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    const wrap = document.getElementById('teamSnapshotTableWrap');
    if (!wrap) return;
    const table = wrap.querySelector('table');
    if (!table) return;
    const tsv = tableToTsv(table);
    const onSuccess = () => showCopyFeedback(btn, 'Скопировано');
    const onError = () => showCopyFeedback(btn, 'Ошибка');
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(tsv).then(onSuccess).catch(onError);
      return;
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = tsv;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) onSuccess(); else onError();
    } catch (e) {
      onError();
    }
  });
}

function handleTableClick(ev) {
  const th = ev.target.closest('th.sortable[data-sort]');
  if (!th) return;
  const key = th.getAttribute('data-sort');
  if (!key) return;
  if (tableSortState.key === key) {
    tableSortState.dir = tableSortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    tableSortState.key = key;
    tableSortState.dir = key === 'cents' ? 'desc' : 'asc';
  }
  const container = document.getElementById('teamTableContainer');
  if (container) container.innerHTML = renderTable(tableRows);
  setupCopyButton();
}

function setupSort() {
  const container = document.getElementById('teamTableContainer');
  if (!container) return;
  container.removeEventListener('click', handleTableClick);
  container.addEventListener('click', handleTableClick);
}

async function load() {
  const statusEl = document.getElementById('loadStatus');
  const resultPanel = document.getElementById('resultPanel');
  const summaryStats = document.getElementById('summaryStats');
  const tableContainer = document.getElementById('teamTableContainer');

  if (statusEl) { statusEl.textContent = 'Запрос к Cursor API и загрузка Jira...'; statusEl.className = 'meta'; }
  if (resultPanel) resultPanel.style.display = 'none';

  try {
    const [snapshotRes, jiraRes] = await Promise.all([
      fetchWithAuth('/api/teams/snapshot'),
      fetchWithAuth('/api/jira-users'),
    ]);
    if (!snapshotRes) return;
    const snapshotData = await snapshotRes.json();
    if (!snapshotRes.ok) throw new Error(snapshotData.error || snapshotRes.statusText);

    let jiraUsers = [];
    if (jiraRes && jiraRes.ok) {
      const jiraData = await jiraRes.json();
      jiraUsers = jiraData.users || [];
    }

    const rows = mergeTableRows(snapshotData, jiraUsers);
    if (summaryStats) summaryStats.innerHTML = renderSummary(snapshotData);
    if (tableContainer) tableContainer.innerHTML = renderTable(rows);
    if (resultPanel) resultPanel.style.display = 'block';
    if (statusEl) statusEl.textContent = '';
    setupSort();
    setupCopyButton();
  } catch (e) {
    if (statusEl) { statusEl.textContent = e.message || 'Ошибка загрузки'; statusEl.className = 'meta error'; }
  }
}

function init() {
  var btnLoad = document.getElementById('btnLoad');
  if (btnLoad) btnLoad.addEventListener('click', load);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
