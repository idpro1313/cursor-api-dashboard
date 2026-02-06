/**
 * Счета и учёт: одна страница с табами Счета | Отчёт | Сверка.
 * Требует common.js (escapeHtml, formatCentsDollar, fetchWithAuth).
 */
(function () {
  'use strict';

  var REPORT_CHARGE_TYPE_LABELS = {
    monthly_subscription: 'Ежемесячная подписка',
    fast_premium_per_seat: 'Fast Premium (тариф)',
    fast_premium_usage: 'Fast Premium (сверх 500/мес)',
    proration_charge: 'Начисление (добавление мест)',
    proration_refund: 'Возврат (снятие мест)',
    token_fee: 'Комиссия за токены',
    token_usage: 'Использование токенов',
    other: 'Прочее',
  };

  function getBillingPeriodKey(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    var parts = dateStr.split('-').map(Number);
    var y = parts[0], m = parts[1], d = parts[2];
    if (d >= 6) { m += 1; if (m > 12) { m = 1; y += 1; } }
    return y + '-' + String(m).padStart(2, '0');
  }

  function getBillingPeriodLabel(key) {
    if (!key || key.length < 7) return key || '—';
    var parts = key.split('-').map(Number);
    var endYear = parts[0], endMonth = parts[1];
    var startMonth = endMonth === 1 ? 12 : endMonth - 1;
    var startYear = endMonth === 1 ? endYear - 1 : endYear;
    var mon = function (m) { return new Date(2020, m - 1, 1).toLocaleDateString('ru-RU', { month: 'short' }); };
    return '6 ' + mon(startMonth) + ' – 5 ' + mon(endMonth) + ' ' + endYear;
  }

  // —— Табы ——
  function getTab() {
    var hash = (window.location.hash || '#invoices').slice(1);
    return hash === 'report' || hash === 'reconciliation' ? hash : 'invoices';
  }

  function switchTab(tabId) {
    tabId = tabId || getTab();
    document.querySelectorAll('.page-tabs a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-tab') === tabId);
    });
    document.querySelectorAll('.tab-pane').forEach(function (p) {
      p.classList.toggle('active', p.id === 'pane-' + tabId);
    });
    window.location.hash = tabId;
    if (tabId === 'report' && !window.__reportLoaded) {
      window.__reportLoaded = true;
      runReport();
    }
    if (tabId === 'reconciliation' && !window.__reconLoaded) {
      window.__reconLoaded = true;
      runReconciliation();
    }
  }

  // —— Счета (invoices) ——
  function showResult(el, message, isError) {
    el.style.display = 'block';
    el.className = isError ? 'sync-result error' : 'sync-result ok';
    el.textContent = message;
  }

  async function loadInvoices() {
    var listEl = document.getElementById('invoicesList');
    var summaryEl = document.getElementById('invoicesSummary');
    var btnClearAll = document.getElementById('btnClearAllInvoices');
    if (!listEl) return;
    try {
      var r = await fetchWithAuth('/api/invoices');
      if (!r) return;
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      var invoices = data.invoices || [];
      summaryEl.textContent = 'Счетов: ' + invoices.length;
      if (btnClearAll) btnClearAll.style.display = invoices.length > 0 ? 'inline-block' : 'none';
      if (invoices.length === 0) {
        listEl.innerHTML = '<p class="muted">Нет загруженных счетов.</p>';
        return;
      }
      listEl.innerHTML = invoices.map(function (inv) {
        return '<div class="invoice-card" data-id="' + inv.id + '" role="button" tabindex="0">' +
          '<span class="invoice-card-title">' + escapeHtml(inv.filename) + '</span>' +
          '<span class="invoice-card-meta">' + inv.items_count + ' поз. · ' + escapeHtml(inv.parsed_at || '') + '</span>' +
          '<div class="invoice-card-actions"><button type="button" class="btn btn-small btn-danger invoice-delete" data-id="' + inv.id + '" title="Удалить счёт">Удалить</button></div></div>';
      }).join('');
      listEl.querySelectorAll('.invoice-card').forEach(function (card) {
        var id = parseInt(card.getAttribute('data-id'), 10);
        var title = (card.querySelector('.invoice-card-title') || {}).textContent || '';
        card.addEventListener('click', function (e) {
          if (e.target.classList.contains('invoice-delete')) return;
          listEl.querySelectorAll('.invoice-card').forEach(function (c) { c.classList.remove('selected'); });
          card.classList.add('selected');
          showInvoiceItems(id, title);
        });
        card.querySelectorAll('.invoice-delete').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            deleteInvoice(id, card);
          });
        });
      });
    } catch (e) {
      listEl.innerHTML = '<p class="error">' + escapeHtml(e.message) + '</p>';
      summaryEl.textContent = '';
      if (btnClearAll) btnClearAll.style.display = 'none';
    }
  }

  async function deleteInvoice(id, cardEl) {
    if (!confirm('Удалить этот счёт из списка? Позиции будут удалены безвозвратно.')) return;
    try {
      var r = await fetchWithAuth('/api/invoices/' + id, { method: 'DELETE' });
      if (!r) return;
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      resetInvoiceDetailPanel();
      loadInvoices();
    } catch (e) {
      alert(e.message || 'Ошибка удаления');
    }
  }

  function resetInvoiceDetailPanel() {
    var placeholder = document.getElementById('invoiceDetailPlaceholder');
    var content = document.getElementById('invoiceDetailContent');
    if (placeholder) placeholder.style.display = 'block';
    if (content) content.style.display = 'none';
  }

  async function showInvoiceItems(id, title) {
    var placeholder = document.getElementById('invoiceDetailPlaceholder');
    var content = document.getElementById('invoiceDetailContent');
    var titleEl = document.getElementById('invoiceDetailTitle');
    var tableEl = document.getElementById('invoiceItemsTable');
    if (placeholder) placeholder.style.display = 'none';
    if (content) content.style.display = 'block';
    try {
      var r = await fetchWithAuth('/api/invoices/' + id + '/items');
      if (!r) return;
      var data = await r.json();
      if (!r.ok) {
        tableEl.innerHTML = '<p class="error">' + escapeHtml(data.error || r.statusText) + '</p>';
        if (titleEl) titleEl.textContent = title || 'Позиции счёта';
        return;
      }
      var items = data.items || [];
      titleEl.textContent = title || 'Позиции счёта';
      if (items.length === 0) {
        tableEl.innerHTML = '<p class="muted">Нет позиций.</p>';
      } else {
        var formatQty = function (q) { return (q != null && q !== '') ? Number(q) : '—'; };
        var formatTax = function (t) { return (t != null && t !== '') ? (Number(t) + '%') : '—'; };
        var rows = items.map(function (it) {
          return '<tr><td>' + escapeHtml(it.description || '—') + '</td><td class="num">' + formatQty(it.quantity) + '</td><td class="num">' + formatCentsDollar(it.unit_price_cents) + '</td><td class="num">' + formatTax(it.tax_pct) + '</td><td class="num">' + formatCentsDollar(it.amount_cents) + '</td></tr>';
        }).join('');
        tableEl.innerHTML = '<table class="data-table"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>';
      }
    } catch (e) {
      tableEl.innerHTML = '<p class="error">' + escapeHtml(e.message) + '</p>';
    }
  }

  async function uploadPdf() {
    var input = document.getElementById('pdfFile');
    var resultEl = document.getElementById('uploadResult');
    if (!input.files || !input.files[0]) {
      showResult(resultEl, 'Выберите файл PDF.', true);
      return;
    }
    var formData = new FormData();
    formData.append('pdf', input.files[0]);
    resultEl.style.display = 'block';
    resultEl.textContent = 'Загрузка...';
    try {
      var r = await fetchWithAuth('/api/invoices/upload', { method: 'POST', body: formData });
      if (!r) return;
      var data = await r.json();
      if (!r.ok) {
        if (r.status === 409 && data.alreadyUploaded) {
          var name = data.existing_invoice && data.existing_invoice.filename ? data.existing_invoice.filename : '';
          showResult(resultEl, (data.error || 'Этот счёт уже был загружен.') + (name ? ' Файл: ' + name : ''), true);
        } else {
          throw new Error(data.error || r.statusText);
        }
        return;
      }
      showResult(resultEl, 'Загружено: ' + data.filename + ', позиций: ' + data.items_count + '.');
      input.value = '';
      loadInvoices();
    } catch (e) {
      showResult(resultEl, e.message || 'Ошибка', true);
    }
  }

  async function clearAllInvoices() {
    if (!confirm('Удалить все счета из БД? Действие нельзя отменить.')) return;
    try {
      var r = await fetchWithAuth('/api/invoices/clear', { method: 'POST' });
      if (!r) return;
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      resetInvoiceDetailPanel();
      loadInvoices();
      alert(data.message || 'Все счета удалены.');
    } catch (e) {
      alert(e.message || 'Ошибка');
    }
  }

  // —— Отчёт (report) ——
  function aggregateReport(items) {
    var byPeriod = {};
    var byType = {};
    items.forEach(function (it) {
      var date = it.invoice_issue_date || it.issue_date;
      var periodKey = getBillingPeriodKey(date);
      var type = it.charge_type || 'other';
      var cents = it.amount_cents != null ? Number(it.amount_cents) : 0;
      if (periodKey) {
        if (!byPeriod[periodKey]) byPeriod[periodKey] = { totalCents: 0, count: 0, byType: {} };
        byPeriod[periodKey].totalCents += cents;
        byPeriod[periodKey].count += 1;
        byPeriod[periodKey].byType[type] = (byPeriod[periodKey].byType[type] || 0) + cents;
      }
      if (!byType[type]) byType[type] = { totalCents: 0, count: 0 };
      byType[type].totalCents += cents;
      byType[type].count += 1;
    });
    return { byPeriod: byPeriod, byType: byType };
  }

  function renderByPeriod(byPeriod) {
    var keys = Object.keys(byPeriod).sort();
    if (keys.length === 0) return '<p class="muted">Нет данных по периодам.</p>';
    var totalCentsAll = 0;
    var rows = keys.map(function (key) {
      var p = byPeriod[key];
      totalCentsAll += p.totalCents;
      return '<tr><td>' + escapeHtml(getBillingPeriodLabel(key)) + '</td><td class="num">' + p.count + '</td><td class="num">' + (p.totalCents / 100).toFixed(2) + '</td></tr>';
    });
    rows.push('<tr class="total-row"><td>Итого</td><td class="num">—</td><td class="num">' + (totalCentsAll / 100).toFixed(2) + '</td></tr>');
    return '<table class="report-table data-table"><thead><tr><th>Период</th><th class="num">Позиций</th><th class="num">Сумма ($)</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function renderByType(byType) {
    var typeOrder = ['monthly_subscription', 'fast_premium_per_seat', 'fast_premium_usage', 'proration_charge', 'proration_refund', 'token_fee', 'token_usage', 'other'];
    var totalCentsAll = 0;
    Object.keys(byType).forEach(function (t) { totalCentsAll += byType[t].totalCents; });
    var rows = [];
    typeOrder.forEach(function (type) {
      var data = byType[type];
      if (!data) return;
      var pct = totalCentsAll !== 0 ? ((data.totalCents / totalCentsAll) * 100).toFixed(1) : '0';
      rows.push('<tr><td>' + escapeHtml(REPORT_CHARGE_TYPE_LABELS[type] || type) + '</td><td class="num">' + data.count + '</td><td class="num">' + (data.totalCents / 100).toFixed(2) + '</td><td class="num">' + pct + '%</td></tr>');
    });
    Object.keys(byType).forEach(function (type) {
      if (typeOrder.indexOf(type) >= 0) return;
      var data = byType[type];
      var pct = totalCentsAll !== 0 ? ((data.totalCents / totalCentsAll) * 100).toFixed(1) : '0';
      rows.push('<tr><td>' + escapeHtml(type) + '</td><td class="num">' + data.count + '</td><td class="num">' + (data.totalCents / 100).toFixed(2) + '</td><td class="num">' + pct + '%</td></tr>');
    });
    rows.push('<tr class="total-row"><td>Итого</td><td class="num">—</td><td class="num">' + (totalCentsAll / 100).toFixed(2) + '</td><td class="num">100%</td></tr>');
    return '<table class="report-table data-table"><thead><tr><th>Тип начисления</th><th class="num">Позиций</th><th class="num">Сумма ($)</th><th class="num">% от общей</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function renderMatrix(byPeriod, byType) {
    var periodKeys = Object.keys(byPeriod).sort();
    var typeOrder = ['monthly_subscription', 'fast_premium_per_seat', 'fast_premium_usage', 'proration_charge', 'proration_refund', 'token_fee', 'token_usage', 'other'];
    var typesInData = {};
    periodKeys.forEach(function (k) {
      Object.keys(byPeriod[k].byType || {}).forEach(function (t) { typesInData[t] = true; });
    });
    var types = typeOrder.filter(function (t) { return typesInData[t]; });
    Object.keys(typesInData).forEach(function (t) { if (types.indexOf(t) < 0) types.push(t); });
    if (periodKeys.length === 0 || types.length === 0) return '<p class="muted">Нет данных для матрицы.</p>';
    var headerCells = '<th>Период</th>' + types.map(function (t) { return '<th class="num">' + escapeHtml(REPORT_CHARGE_TYPE_LABELS[t] || t) + '</th>'; }).join('') + '<th class="num">Итого</th>';
    var rows = periodKeys.map(function (key) {
      var p = byPeriod[key];
      var byTypeRow = p.byType || {};
      var cells = types.map(function (t) {
        var c = byTypeRow[t] || 0;
        return '<td class="num">' + (c !== 0 ? (c / 100).toFixed(2) : '—') + '</td>';
      });
      return '<tr><td>' + escapeHtml(getBillingPeriodLabel(key)) + '</td>' + cells.join('') + '<td class="num">' + (p.totalCents / 100).toFixed(2) + '</td></tr>';
    });
    var totalRowCents = {};
    periodKeys.forEach(function (k) {
      var byT = byPeriod[k].byType || {};
      types.forEach(function (t) { totalRowCents[t] = (totalRowCents[t] || 0) + (byT[t] || 0); });
    });
    var grandTotal = periodKeys.reduce(function (sum, k) { return sum + byPeriod[k].totalCents; }, 0);
    var totalCells = types.map(function (t) {
      var c = totalRowCents[t] || 0;
      return '<td class="num">' + (c !== 0 ? (c / 100).toFixed(2) : '—') + '</td>';
    });
    rows.push('<tr class="total-row"><td>Итого</td>' + totalCells.join('') + '<td class="num">' + (grandTotal / 100).toFixed(2) + '</td></tr>');
    return '<table class="report-table data-table"><thead><tr>' + headerCells + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  function runReport() {
    var loadingEl = document.getElementById('reportLoading');
    var errorEl = document.getElementById('reportError');
    var contentEl = document.getElementById('reportContent');
    var byPeriodEl = document.getElementById('byPeriodTable');
    var byTypeEl = document.getElementById('byTypeTable');
    var matrixEl = document.getElementById('matrixTable');
    if (!loadingEl) return;
    loadingEl.style.display = 'block';
    errorEl.style.display = 'none';
    contentEl.style.display = 'none';
    fetchWithAuth('/api/invoices/all-items')
      .then(function (r) {
        if (!r) return Promise.reject(new Error('Нет доступа'));
        return r.json();
      })
      .then(function (data) {
        loadingEl.style.display = 'none';
        var items = data.items || [];
        if (items.length === 0) {
          contentEl.style.display = 'block';
          byPeriodEl.innerHTML = '<p class="muted">Нет загруженных позиций. Загрузите счета во вкладке «Счета».</p>';
          byTypeEl.innerHTML = '';
          matrixEl.innerHTML = '';
          return;
        }
        var agg = aggregateReport(items);
        byPeriodEl.innerHTML = renderByPeriod(agg.byPeriod);
        byTypeEl.innerHTML = renderByType(agg.byType);
        matrixEl.innerHTML = renderMatrix(agg.byPeriod, agg.byType);
        contentEl.style.display = 'block';
      })
      .catch(function (e) {
        loadingEl.style.display = 'none';
        errorEl.textContent = 'Ошибка загрузки: ' + (e.message || String(e));
        errorEl.style.display = 'block';
      });
  }

  // —— Сверка (reconciliation) ——
  function formatDollars(cents) {
    if (cents == null) return '—';
    return (Number(cents) / 100).toFixed(2);
  }

  function renderReconTable(comparison, totals) {
    if (!comparison || comparison.length === 0) {
      return '<p class="muted">Нет данных для сверки. Загрузите Usage Events и счета за один и тот же период.</p>';
    }
    var rows = comparison.map(function (row) {
      var diff = row.diffCents;
      var diffClass = diff === 0 ? 'diff-ok' : (Math.abs(diff) < 100 ? 'diff-warn' : 'diff-bad');
      var diffStr = diff === 0 ? '0' : (diff > 0 ? '+' : '') + formatDollars(diff);
      return '<tr><td>' + escapeHtml(row.periodLabel) + '</td><td class="num">' + row.usageEventCount + '</td><td class="num">' + formatDollars(row.usageCostCents) + '</td><td class="num">' + row.invoiceItemCount + '</td><td class="num">' + formatDollars(row.invoiceCostCents) + '</td><td class="num ' + diffClass + '">' + diffStr + '</td></tr>';
    });
    var totalRow = '';
    if (totals) {
      var t = totals.totalDiffCents;
      var tClass = t === 0 ? 'diff-ok' : (Math.abs(t) < 100 ? 'diff-warn' : 'diff-bad');
      totalRow = '<tr class="total-row"><td><strong>Итого</strong></td><td class="num">—</td><td class="num">' + formatDollars(totals.totalUsageCents) + '</td><td class="num">—</td><td class="num">' + formatDollars(totals.totalInvoiceCents) + '</td><td class="num ' + tClass + '">' + (t === 0 ? '0' : (t > 0 ? '+' : '') + formatDollars(t)) + '</td></tr>';
    }
    return '<table class="recon-table data-table"><thead><tr><th>Период</th><th class="num">Событий (Usage)</th><th class="num">Сумма Usage ($)</th><th class="num">Позиций (счёт)</th><th class="num">Сумма счёт ($)</th><th class="num">Разница ($)</th></tr></thead><tbody>' + rows.join('') + totalRow + '</tbody></table>';
  }

  function runReconciliation() {
    var loadingEl = document.getElementById('reconLoading');
    var errorEl = document.getElementById('reconError');
    var contentEl = document.getElementById('reconContent');
    var tableEl = document.getElementById('reconTable');
    if (!loadingEl) return;
    loadingEl.style.display = 'block';
    errorEl.style.display = 'none';
    contentEl.style.display = 'none';
    fetchWithAuth('/api/reconciliation')
      .then(function (r) {
        if (!r) return Promise.reject(new Error('Нет доступа'));
        return r.json();
      })
      .then(function (data) {
        loadingEl.style.display = 'none';
        if (data.error) {
          errorEl.textContent = data.error;
          errorEl.style.display = 'block';
          return;
        }
        tableEl.innerHTML = renderReconTable(data.comparison || [], data.totals || null);
        contentEl.style.display = 'block';
      })
      .catch(function (e) {
        loadingEl.style.display = 'none';
        errorEl.textContent = 'Ошибка: ' + (e.message || String(e));
        errorEl.style.display = 'block';
      });
  }

  // —— Инициализация ——
  function init() {
    var tabs = document.getElementById('accounting-tabs');
    if (tabs) {
      tabs.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          switchTab(a.getAttribute('data-tab'));
        });
      });
    }
    window.addEventListener('hashchange', function () { switchTab(getTab()); });
    switchTab(getTab());

    var btnUpload = document.getElementById('btnUploadPdf');
    if (btnUpload) btnUpload.addEventListener('click', uploadPdf);
    var btnClearAll = document.getElementById('btnClearAllInvoices');
    if (btnClearAll) btnClearAll.addEventListener('click', clearAllInvoices);
    loadInvoices();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
