/**
 * Страница аудита: события Audit Logs с фильтрами по дате и типу
 */
function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function formatAuditDate(ts) {
  if (ts == null) return '—';
  const d = new Date(typeof ts === 'number' ? ts : Number(ts) || ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

async function loadEventTypes() {
  try {
    const r = await fetch('/api/audit-events?limit=1', { credentials: 'same-origin' });
    if (r.status === 401) { window.location.href = '/login.html'; return; }
    const data = await r.json();
    const types = data.eventTypes || [];
    const select = document.getElementById('auditEventType');
    if (!select) return;
    while (select.options.length > 1) select.removeChild(select.options[1]);
    types.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      select.appendChild(opt);
    });
  } catch (_) {}
}

async function loadAudit() {
  const startDate = document.getElementById('auditStartDate').value || undefined;
  const endDate = document.getElementById('auditEndDate').value || undefined;
  const eventType = document.getElementById('auditEventType').value.trim() || undefined;
  const limit = document.getElementById('auditLimit').value || '50';
  const statusEl = document.getElementById('auditStatus');
  const resultsPanel = document.getElementById('auditResultsPanel');
  const resultsContainer = document.getElementById('auditResultsContainer');
  const resultsSummary = document.getElementById('auditResultsSummary');
  const emptyState = document.getElementById('auditEmptyState');

  statusEl.textContent = 'Загрузка...';
  statusEl.className = 'meta';
  emptyState.style.display = 'block';
  resultsPanel.style.display = 'none';
  try {
    const params = new URLSearchParams({ limit });
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (eventType) params.set('eventType', eventType);
    const r = await fetch('/api/audit-events?' + params, { credentials: 'same-origin' });
    if (r.status === 401) { window.location.href = '/login.html'; return; }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const events = data.events || [];
    const total = data.total != null ? data.total : events.length;
    statusEl.textContent = '';
    emptyState.style.display = 'none';
    resultsPanel.style.display = 'block';
    resultsSummary.textContent = `Показано: ${events.length} из ${total} событий.`;
    if (events.length === 0) {
      resultsContainer.innerHTML = '<p class="muted">Нет событий по выбранным фильтрам.</p>';
      return;
    }
    const rows = events.map((e) => {
      const date = formatAuditDate(e.timestamp);
      const user = escapeHtml((e.userEmail || e.email || e.user_email || e.actor || '—').toString());
      const action = escapeHtml((e.type || e.action || e.eventType || e.name || '—').toString());
      const details = (e.details || e.metadata) ? escapeHtml(JSON.stringify(e.details || e.metadata)) : '';
      return `<tr><td>${date}</td><td>${user}</td><td>${action}</td><td class="audit-details">${details}</td></tr>`;
    }).join('');
    resultsContainer.innerHTML = `
      <div class="table-wrap">
        <table class="data-table audit-table">
          <thead><tr><th>Дата</th><th>Пользователь</th><th>Действие</th><th>Детали</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  } catch (e) {
    statusEl.textContent = e.message || 'Ошибка';
    statusEl.className = 'meta error';
    resultsPanel.style.display = 'none';
    emptyState.style.display = 'block';
  }
}

function init() {
  loadEventTypes();
  const btn = document.getElementById('auditBtnLoad');
  if (btn) btn.addEventListener('click', loadAudit);
  const coverageEl = document.getElementById('auditStartDate');
  if (coverageEl && !coverageEl.value) {
    fetch('/api/analytics/coverage', { credentials: 'same-origin' })
      .then((r) => { if (r.status === 401) { window.location.href = '/login.html'; return null; } return r.json(); })
      .then((data) => {
        if (!data) return;
        const cov = data.coverage || [];
        const audit = cov.find((c) => c.endpoint === '/teams/audit-logs');
        if (audit && audit.min_date && audit.max_date) {
          document.getElementById('auditStartDate').value = audit.min_date;
          document.getElementById('auditEndDate').value = audit.max_date;
        } else {
          const end = new Date();
          const start = new Date();
          start.setDate(start.getDate() - 30);
          document.getElementById('auditStartDate').value = start.toISOString().slice(0, 10);
          document.getElementById('auditEndDate').value = end.toISOString().slice(0, 10);
        }
      })
      .catch(() => {});
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
