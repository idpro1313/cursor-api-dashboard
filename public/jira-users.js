/**
 * Страница «Пользователи Jira» — просмотр и загрузка CSV
 */
function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function getAllKeys(users) {
  const set = new Set();
  users.forEach((obj) => {
    if (obj && typeof obj === 'object') Object.keys(obj).forEach((k) => set.add(k));
  });
  return Array.from(set);
}

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
  try {
    const r = await fetch('/api/jira-users');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Ошибка загрузки');
    const users = data.users || [];
    summary.textContent = `Записей: ${users.length}`;
    container.innerHTML = renderTable(users);
  } catch (e) {
    container.innerHTML = '<span class="error">' + escapeHtml(e.message) + '</span>';
    summary.textContent = '';
  }
}

function init() {
  document.getElementById('btnRefresh').addEventListener('click', loadUsers);
  document.getElementById('btnUpload').addEventListener('click', async () => {
    const input = document.getElementById('csvFile');
    if (!input.files || !input.files[0]) {
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
      const r = await fetch('/api/jira-users/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text }),
      });
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
