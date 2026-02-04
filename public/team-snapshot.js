/**
 * Дашборд «Участники команды и расходы» — одна таблица с обогащением из Jira, сортировка, копирование
 */
const COPY_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function formatCostCents(cents) {
  if (cents == null || cents === 0) return '0';
  const d = (cents / 100).toFixed(2);
  return d.replace(/\.?0+$/, '') || '0';
}

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
    const cents = spendByEmail.get(email) || 0;
    rows.push({ name, email, project, cents });
  }
  for (const [email, cents] of spendByEmail) {
    if (seen.has(email)) continue;
    seen.add(email);
    const jira = jiraByEmail.get(email);
    const name = (jira && getJiraDisplayName(jira)) || email;
    const project = (jira && getJiraProjectFromRow(jira)) || '—';
    rows.push({ name, email, project, cents });
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
    if (key === 'name' || key === 'email' || key === 'project') {
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

function renderTable(rows) {
  tableRows = rows;
  const sorted = sortRows(rows, tableSortState.key, tableSortState.dir);
  const nameArrow = tableSortState.key === 'name' ? (tableSortState.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const emailArrow = tableSortState.key === 'email' ? (tableSortState.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const projectArrow = tableSortState.key === 'project' ? (tableSortState.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const spendArrow = tableSortState.key === 'cents' ? (tableSortState.dir === 'asc' ? ' ↑' : ' ↓') : '';

  const bodyRows = sorted.map((r) => `
    <tr>
      <td>${escapeHtml(r.name || '—')}</td>
      <td class="muted">${escapeHtml(r.email)}</td>
      <td>${escapeHtml(r.project || '—')}</td>
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
              <th class="sortable num" data-sort="cents" title="Сортировать">Расходы${spendArrow}</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function tableToTsv(table) {
  const rows = [];
  table.querySelectorAll('tr').forEach((tr) => {
    const cells = [];
    tr.querySelectorAll('th, td').forEach((cell) => {
      const text = (cell.textContent || '').trim().replace(/\s+/g, ' ').replace(/\t/g, ' ').replace(/\n/g, ' ');
      cells.push(text);
    });
    if (cells.length) rows.push(cells.join('\t'));
  });
  return rows.join('\n');
}

function showCopyFeedback(btn, message) {
  const feedback = btn.parentElement && btn.parentElement.querySelector('.copy-feedback');
  if (feedback) {
    feedback.textContent = message;
    feedback.classList.add('visible');
    setTimeout(() => { feedback.textContent = ''; feedback.classList.remove('visible'); }, 2000);
  }
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

  statusEl.textContent = 'Запрос к Cursor API и загрузка Jira...';
  statusEl.className = 'meta';
  resultPanel.style.display = 'none';

  try {
    const [snapshotRes, jiraRes] = await Promise.all([
      fetch('/api/teams/snapshot'),
      fetch('/api/jira-users'),
    ]);
    const snapshotData = await snapshotRes.json();
    if (!snapshotRes.ok) throw new Error(snapshotData.error || snapshotRes.statusText);

    let jiraUsers = [];
    if (jiraRes.ok) {
      const jiraData = await jiraRes.json();
      jiraUsers = jiraData.users || [];
    }

    const rows = mergeTableRows(snapshotData, jiraUsers);
    summaryStats.innerHTML = renderSummary(snapshotData);
    tableContainer.innerHTML = renderTable(rows);
    resultPanel.style.display = 'block';
    statusEl.textContent = '';
    setupSort(); // делегирование на teamTableContainer
    setupCopyButton();
  } catch (e) {
    statusEl.textContent = e.message || 'Ошибка загрузки';
    statusEl.className = 'meta error';
  }
}

function init() {
  document.getElementById('btnLoad').addEventListener('click', load);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
