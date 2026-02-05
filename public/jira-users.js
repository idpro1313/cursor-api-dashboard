/**
 * Страница «Пользователи Jira». Требует common.js (escapeHtml, fetchWithAuth, getAllKeys).
 */
function renderTable(users) {
  if (!users || users.length === 0) {
    return '<p class="muted">Нет данных. Загрузите CSV.</p>';
  }
  const keys = getAllKeys(users);
  const thead = keys.map((k) => `<th>${escapeHtml(k)}</th>`).join('');
  const rows = users.map((u) => {
    return '<tr>' + keys.map((k) => {
      let v = u[k];
      if (v != null && typeof v === 'object') v = JSON.stringify(v);
      return '<td>' + escapeHtml(v != null ? String(v) : '') + '</td>';
    }).join('') + '</tr>';
  }).join('');
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${thead}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function loadUsers() {
  const container = document.getElementById('usersContainer');
  const summary = document.getElementById('usersSummary');
  if (!container) return;
  try {
    const r = await fetchWithAuth('/api/jira-users');
    if (!r) return;
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const users = data.users || [];
    if (summary) summary.textContent = `Записей: ${users.length}`;
    container.innerHTML = renderTable(users);
  } catch (e) {
    container.innerHTML = '<span class="error">' + escapeHtml(e.message) + '</span>';
    if (summary) summary.textContent = '';
  }
}

function init() {
  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) btnRefresh.addEventListener('click', loadUsers);
  document.getElementById('btnClearJira')?.addEventListener('click', async () => {
    if (!confirm('Очистить все данные Jira из БД? Данные API не затронуты. Действие нельзя отменить.')) return;
    try {
      const r = await fetch('/api/clear-jira', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
      if (r.status === 401) { window.location.href = '/login.html'; return; }
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      alert(data.message || 'Данные Jira очищены.');
      loadUsers();
    } catch (e) {
      alert(e.message || 'Ошибка очистки');
    }
  });
  const btnUpload = document.getElementById('btnUpload');
  if (btnUpload) btnUpload.addEventListener('click', async () => {
    const input = document.getElementById('csvFile');
    if (!input || !input.files || !input.files[0]) {
      alert('Выберите файл CSV');
      return;
    }
    const file = input.files[0];
    const resultEl = document.getElementById('uploadResult');
    resultEl.style.display = 'none';
    try {
      const text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
        reader.readAsText(file, 'UTF-8');
      });
      const r = await fetchWithAuth('/api/jira-users/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text }),
      });
      if (!r) return;
      const data = await r.json();
      resultEl.style.display = 'block';
      if (!r.ok) {
        resultEl.className = 'sync-result error';
        resultEl.textContent = data.error || r.statusText;
        return;
      }
      resultEl.className = 'sync-result ok';
      resultEl.textContent = data.message || `Загружено ${data.count} записей.`;
      input.value = '';
      loadUsers();
    } catch (e) {
      resultEl.style.display = 'block';
      resultEl.className = 'sync-result error';
      resultEl.textContent = e.message || 'Ошибка загрузки';
    }
  });
  loadUsers();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
