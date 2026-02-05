/**
 * Страница «Счета Cursor». Требует common.js (escapeHtml, formatCentsDollar, formatCostCents, fetchWithAuth).
 */
function showResult(el, message, isError) {
  el.style.display = 'block';
  el.className = isError ? 'sync-result error' : 'sync-result ok';
  el.textContent = message;
}

async function loadInvoices() {
  const listEl = document.getElementById('invoicesList');
  const summaryEl = document.getElementById('invoicesSummary');
  try {
    const r = await fetchWithAuth('/api/invoices');
    if (!r) return;
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    const invoices = data.invoices || [];
    summaryEl.textContent = `Счетов: ${invoices.length}`;
    if (invoices.length === 0) {
      listEl.innerHTML = '<p class="muted">Нет загруженных счетов.</p>';
      return;
    }
    listEl.innerHTML = `
      <ul class="invoices-list">
        ${invoices.map((inv) => `
          <li>
            <button type="button" class="btn-link invoice-link" data-id="${inv.id}">
              ${escapeHtml(inv.filename)} — ${inv.items_count} поз.
            </button>
            <span class="muted">${escapeHtml(inv.parsed_at || '')}</span>
            <button type="button" class="btn btn-small btn-danger invoice-delete" data-id="${inv.id}" title="Удалить счёт">Удалить</button>
          </li>
        `).join('')}
      </ul>
    `;
    listEl.querySelectorAll('.invoice-link').forEach((btn) => {
      btn.addEventListener('click', () => showInvoiceItems(parseInt(btn.getAttribute('data-id'), 10), btn.textContent.split(' — ')[0]));
    });
    listEl.querySelectorAll('.invoice-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteInvoice(parseInt(btn.getAttribute('data-id'), 10), btn.closest('li'));
      });
    });
  } catch (e) {
    listEl.innerHTML = '<p class="error">' + escapeHtml(e.message) + '</p>';
    summaryEl.textContent = '';
  }
  loadAllItems();
}

let allItemsData = [];
let allItemsSortKey = 'invoice_issue_date';
let allItemsSortDir = 'desc';

function sortAllItems(items, key, dir) {
  return items.slice().sort((a, b) => {
    const va = a[key] != null ? String(a[key]) : '';
    const vb = b[key] != null ? String(b[key]) : '';
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

function renderAllItemsTable() {
  const tableEl = document.getElementById('allItemsTable');
  if (!tableEl || allItemsData.length === 0) return;
  const formatQty = (q) => (q != null && q !== '') ? Number(q) : '—';
  const formatTax = (t) => (t != null && t !== '') ? (Number(t) + '%') : '—';
  const sorted = sortAllItems(allItemsData, allItemsSortKey, allItemsSortDir);
  const arrow = allItemsSortDir === 'asc' ? ' ↑' : ' ↓';
  const rows = sorted.map((it) => `
    <tr>
      <td>${escapeHtml(it.invoice_filename || '—')}</td>
      <td>${escapeHtml(it.invoice_issue_date || '—')}</td>
      <td>${escapeHtml(it.description || '—')}</td>
      <td class="num">${formatQty(it.quantity)}</td>
      <td class="num">${formatCentsDollar(it.unit_price_cents)}</td>
      <td class="num">${formatTax(it.tax_pct)}</td>
      <td class="num">${it.amount_cents != null ? formatCostCents(it.amount_cents) : '—'}</td>
    </tr>
  `).join('');
  const dateOfIssueHeader = `Date of issue${allItemsSortKey === 'invoice_issue_date' ? arrow : ''}`;
  tableEl.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Счёт</th><th class="sortable" data-sort="invoice_issue_date" title="Сортировать">${dateOfIssueHeader}</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  tableEl.querySelector('th[data-sort="invoice_issue_date"]').addEventListener('click', () => {
    allItemsSortDir = allItemsSortDir === 'asc' ? 'desc' : 'asc';
    renderAllItemsTable();
  });
}

async function loadAllItems() {
  const summaryEl = document.getElementById('allItemsSummary');
  const tableEl = document.getElementById('allItemsTable');
  if (!summaryEl || !tableEl) return;
  try {
    const r = await fetchWithAuth('/api/invoices/all-items');
    if (!r) return;
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    const items = data.items || [];
    allItemsData = items;
    summaryEl.textContent = `Позиций всего: ${items.length}`;
    const downloadBtn = document.getElementById('btnDownloadAllItems');
    if (downloadBtn) {
      downloadBtn.style.display = items.length ? 'inline-block' : 'none';
    }
    if (items.length === 0) {
      tableEl.innerHTML = '<p class="muted">Нет позиций. Загрузите счета выше.</p>';
      return;
    }
    renderAllItemsTable();
  } catch (e) {
    tableEl.innerHTML = '<p class="error">' + escapeHtml(e.message) + '</p>';
    summaryEl.textContent = '';
  }
}

async function deleteInvoice(id, liEl) {
  if (!confirm('Удалить этот счёт из списка? Позиции будут удалены безвозвратно.')) return;
  try {
    const r = await fetchWithAuth('/api/invoices/' + id, { method: 'DELETE' });
    if (!r) return;
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    document.getElementById('invoiceDetail').style.display = 'none';
    loadInvoices();
    loadAllItems();
  } catch (e) {
    alert(e.message || 'Ошибка удаления');
  }
}

async function showInvoiceItems(id, title) {
  const detailEl = document.getElementById('invoiceDetail');
  const titleEl = document.getElementById('invoiceDetailTitle');
  const tableEl = document.getElementById('invoiceItemsTable');
  try {
    const r = await fetchWithAuth('/api/invoices/' + id + '/items');
    if (!r) return;
    const data = await r.json();
    if (!r.ok) {
      tableEl.innerHTML = '<p class="error">' + escapeHtml(data.error || r.statusText) + '</p>';
      detailEl.style.display = 'block';
      if (titleEl) titleEl.textContent = title || 'Позиции счёта';
      detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const items = data.items || [];
    const issueDate = data.issue_date || null;
    titleEl.textContent = title || 'Позиции счёта';
    if (items.length === 0) {
      tableEl.innerHTML = '<p class="muted">Нет позиций.</p>';
    } else {
      const formatQty = (q) => (q != null && q !== '') ? Number(q) : '—';
      const formatTax = (t) => (t != null && t !== '') ? (Number(t) + '%') : '—';
      const displayIssueDate = issueDate ? escapeHtml(issueDate) : '—';
      const rows = items.map((it) => `
        <tr>
          <td>${displayIssueDate}</td>
          <td>${escapeHtml(it.description || '—')}</td>
          <td class="num">${formatQty(it.quantity)}</td>
          <td class="num">${formatCentsDollar(it.unit_price_cents)}</td>
          <td class="num">${formatTax(it.tax_pct)}</td>
          <td class="num">${it.amount_cents != null ? formatCostCents(it.amount_cents) : '—'}</td>
        </tr>
      `).join('');
      tableEl.innerHTML = `
        <table class="data-table">
          <thead><tr><th>Date of issue</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }
    detailEl.style.display = 'block';
    detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    tableEl.innerHTML = '<p class="error">' + escapeHtml(e.message) + '</p>';
    detailEl.style.display = 'block';
    detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function uploadPdf() {
  const input = document.getElementById('pdfFile');
  const resultEl = document.getElementById('uploadResult');
  if (!input.files || !input.files[0]) {
    showResult(resultEl, 'Выберите файл PDF.', true);
    return;
  }
  const formData = new FormData();
  formData.append('pdf', input.files[0]);
  resultEl.style.display = 'block';
  resultEl.textContent = 'Загрузка...';
  try {
    const r = await fetchWithAuth('/api/invoices/upload', {
      method: 'POST',
      body: formData,
    });
    if (!r) return;
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 409 && data.alreadyUploaded) {
        const name = data.existing_invoice && data.existing_invoice.filename ? data.existing_invoice.filename : '';
        showResult(resultEl, (data.error || 'Этот счёт уже был загружен.') + (name ? ' Файл: ' + name : ''), true);
      } else {
        throw new Error(data.error || r.statusText);
      }
      return;
    }
    showResult(resultEl, `Загружено: ${data.filename}, позиций: ${data.items_count}.`);
    input.value = '';
    loadInvoices();
  } catch (e) {
    showResult(resultEl, e.message || 'Ошибка', true);
  }
}

function downloadAllItemsJson() {
  if (!allItemsData || allItemsData.length === 0) return;
  const filename = 'invoice-items_' + new Date().toISOString().slice(0, 10) + '.json';
  const blob = new Blob([JSON.stringify(allItemsData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function init() {
  const btn = document.getElementById('btnUploadPdf');
  if (btn) btn.addEventListener('click', uploadPdf);
  const downloadBtn = document.getElementById('btnDownloadAllItems');
  if (downloadBtn) downloadBtn.addEventListener('click', downloadAllItemsJson);
  loadInvoices();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
