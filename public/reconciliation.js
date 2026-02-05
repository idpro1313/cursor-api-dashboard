/**
 * Отчёт-сверка: сопоставление Usage Events и данных из счетов по периодам биллинга.
 * Требует common.js (escapeHtml, fetchWithAuth, formatCostCents).
 */
(function () {
  'use strict';

  function formatDollars(cents) {
    if (cents == null) return '—';
    return (Number(cents) / 100).toFixed(2);
  }

  function renderTable(comparison, totals) {
    if (!comparison || comparison.length === 0) {
      return '<p class="muted">Нет данных для сверки. Загрузите Usage Events и счета за один и тот же период.</p>';
    }
    var rows = comparison.map(function (row) {
      var diff = row.diffCents;
      var diffClass = diff === 0 ? 'diff-ok' : (Math.abs(diff) < 100 ? 'diff-warn' : 'diff-bad');
      var diffStr = diff === 0 ? '0' : (diff > 0 ? '+' : '') + formatDollars(diff);
      return (
        '<tr>' +
        '<td>' + escapeHtml(row.periodLabel) + '</td>' +
        '<td class="num">' + row.usageEventCount + '</td>' +
        '<td class="num">' + formatDollars(row.usageCostCents) + '</td>' +
        '<td class="num">' + row.invoiceItemCount + '</td>' +
        '<td class="num">' + formatDollars(row.invoiceCostCents) + '</td>' +
        '<td class="num ' + diffClass + '">' + diffStr + '</td>' +
        '</tr>'
      );
    });
    var totalRow = '';
    if (totals) {
      var t = totals.totalDiffCents;
      var tClass = t === 0 ? 'diff-ok' : (Math.abs(t) < 100 ? 'diff-warn' : 'diff-bad');
      totalRow = '<tr class="total-row">' +
        '<td><strong>Итого</strong></td>' +
        '<td class="num">—</td>' +
        '<td class="num">' + formatDollars(totals.totalUsageCents) + '</td>' +
        '<td class="num">—</td>' +
        '<td class="num">' + formatDollars(totals.totalInvoiceCents) + '</td>' +
        '<td class="num ' + tClass + '">' + (t === 0 ? '0' : (t > 0 ? '+' : '') + formatDollars(t)) + '</td>' +
        '</tr>';
    }
    return (
      '<table class="recon-table data-table">' +
      '<thead><tr>' +
      '<th>Период</th>' +
      '<th class="num">Событий (Usage)</th>' +
      '<th class="num">Сумма Usage ($)</th>' +
      '<th class="num">Позиций (счёт)</th>' +
      '<th class="num">Сумма счёт ($)</th>' +
      '<th class="num">Разница ($)</th>' +
      '</tr></thead>' +
      '<tbody>' + rows.join('') + totalRow + '</tbody></table>'
    );
  }

  function run() {
    var loadingEl = document.getElementById('reconLoading');
    var errorEl = document.getElementById('reconError');
    var contentEl = document.getElementById('reconContent');
    var tableEl = document.getElementById('reconTable');

    loadingEl.style.display = 'block';
    errorEl.style.display = 'none';
    contentEl.style.display = 'none';

    window.fetchWithAuth('/api/reconciliation')
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
        tableEl.innerHTML = renderTable(data.comparison || [], data.totals || null);
        contentEl.style.display = 'block';
      })
      .catch(function (e) {
        loadingEl.style.display = 'none';
        errorEl.textContent = 'Ошибка: ' + (e.message || String(e));
        errorEl.style.display = 'block';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
