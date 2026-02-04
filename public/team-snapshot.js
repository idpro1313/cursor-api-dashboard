/**
 * Дашборд «Участники команды и расходы» — запрос Team Members и Spending Data к Cursor API
 */
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

function renderMembersTable(members) {
  if (!members || members.length === 0) {
    return '<p class="muted">Нет данных.</p>';
  }
  const rows = members.map((m) => `<tr><td>${escapeHtml(m.name || '—')}</td><td class="muted">${escapeHtml(m.email || '')}</td></tr>`).join('');
  return `
    <table class="data-table">
      <thead><tr><th>Имя</th><th>Email</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSpendTable(spendList) {
  if (!spendList || spendList.length === 0) {
    return '<p class="muted">Нет данных.</p>';
  }
  const rows = spendList
    .sort((a, b) => (b.cents || 0) - (a.cents || 0))
    .map((s) => `<tr><td>${escapeHtml(s.email)}</td><td class="num">$${formatCostCents(s.cents)}</td></tr>`)
    .join('');
  return `
    <table class="data-table">
      <thead><tr><th>Email</th><th>Расходы</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function load() {
  const statusEl = document.getElementById('loadStatus');
  const resultPanel = document.getElementById('resultPanel');
  const summaryStats = document.getElementById('summaryStats');
  const membersContainer = document.getElementById('membersContainer');
  const spendContainer = document.getElementById('spendContainer');

  statusEl.textContent = 'Запрос к Cursor API...';
  statusEl.className = 'meta';
  resultPanel.style.display = 'none';

  try {
    const r = await fetch('/api/teams/snapshot');
    const data = await r.json();
    if (!r.ok) {
      throw new Error(data.error || r.statusText);
    }
    summaryStats.innerHTML = renderSummary(data);
    membersContainer.innerHTML = renderMembersTable(data.teamMembers || []);
    spendContainer.innerHTML = renderSpendTable(data.teamMemberSpend || []);
    resultPanel.style.display = 'block';
    statusEl.textContent = '';
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
