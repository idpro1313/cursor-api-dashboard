/**
 * Сводный отчёт по счетам: по периодам биллинга и по типам начислений.
 * Требует common.js (escapeHtml, fetchWithAuth, formatCostCents).
 */
(function () {
  'use strict';

  var CHARGE_TYPE_LABELS = {
    monthly_subscription: 'Ежемесячная подписка',
    fast_premium_per_seat: 'Fast Premium (тариф)',
    fast_premium_usage: 'Fast Premium (сверх 500/мес)',
    proration_charge: 'Начисление (добавление мест)',
    proration_refund: 'Возврат (снятие мест)',
    token_fee: 'Комиссия за токены',
    token_usage: 'Использование токенов',
    other: 'Прочее',
  };

  /** Дата счёта YYYY-MM-DD → ключ периода биллинга YYYY-MM (период заканчивается 5-го числа этого месяца). */
  function getBillingPeriodKey(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    var parts = dateStr.split('-').map(Number);
    var y = parts[0], m = parts[1], d = parts[2];
    if (d >= 6) {
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return y + '-' + String(m).padStart(2, '0');
  }

  /** Ключ YYYY-MM → подпись периода "6 янв – 5 фев 2026" (цикл с 6-го по 5-е включительно). */
  function getBillingPeriodLabel(key) {
    if (!key || key.length < 7) return key || '—';
    var parts = key.split('-').map(Number);
    var endYear = parts[0], endMonth = parts[1];
    var startMonth = endMonth === 1 ? 12 : endMonth - 1;
    var startYear = endMonth === 1 ? endYear - 1 : endYear;
    var mon = function (m) {
      return new Date(2020, m - 1, 1).toLocaleDateString('ru-RU', { month: 'short' });
    };
    return '6 ' + mon(startMonth) + ' – 5 ' + mon(endMonth) + ' ' + endYear;
  }

  function aggregate(items) {
    var byPeriod = {};
    var byType = {};
    items.forEach(function (it) {
      var date = it.invoice_issue_date || it.issue_date;
      var periodKey = getBillingPeriodKey(date);
      var type = it.charge_type || 'other';
      var cents = it.amount_cents != null ? Number(it.amount_cents) : 0;

      if (periodKey) {
        if (!byPeriod[periodKey]) {
          byPeriod[periodKey] = { totalCents: 0, count: 0, byType: {} };
        }
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
    if (keys.length === 0) {
      return '<p class="muted">Нет данных по периодам.</p>';
    }
    var totalCentsAll = 0;
    var rows = keys.map(function (key) {
      var p = byPeriod[key];
      totalCentsAll += p.totalCents;
      var totalDollar = (p.totalCents / 100).toFixed(2);
      return '<tr><td>' + escapeHtml(getBillingPeriodLabel(key)) + '</td><td class="num">' + p.count + '</td><td class="num">' + totalDollar + '</td></tr>';
    });
    rows.push('<tr class="total-row"><td>Итого</td><td class="num">—</td><td class="num">' + (totalCentsAll / 100).toFixed(2) + '</td></tr>');
    return (
      '<table class="report-table data-table">' +
      '<thead><tr><th>Период</th><th class="num">Позиций</th><th class="num">Сумма ($)</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table>'
    );
  }

  function renderByType(byType) {
    var typeOrder = [
      'monthly_subscription', 'fast_premium_per_seat', 'fast_premium_usage',
      'proration_charge', 'proration_refund', 'token_fee', 'token_usage', 'other',
    ];
    var totalCentsAll = 0;
    Object.keys(byType).forEach(function (t) {
      totalCentsAll += byType[t].totalCents;
    });
    var rows = [];
    typeOrder.forEach(function (type) {
      var data = byType[type];
      if (!data) return;
      var pct = totalCentsAll !== 0 ? ((data.totalCents / totalCentsAll) * 100).toFixed(1) : '0';
      var label = CHARGE_TYPE_LABELS[type] || type;
      rows.push(
        '<tr><td>' + escapeHtml(label) + '</td><td class="num">' + data.count + '</td><td class="num">' + (data.totalCents / 100).toFixed(2) + '</td><td class="num">' + pct + '%</td></tr>'
      );
    });
    Object.keys(byType).forEach(function (type) {
      if (typeOrder.indexOf(type) >= 0) return;
      var data = byType[type];
      var pct = totalCentsAll !== 0 ? ((data.totalCents / totalCentsAll) * 100).toFixed(1) : '0';
      rows.push(
        '<tr><td>' + escapeHtml(type) + '</td><td class="num">' + data.count + '</td><td class="num">' + (data.totalCents / 100).toFixed(2) + '</td><td class="num">' + pct + '%</td></tr>'
      );
    });
    rows.push('<tr class="total-row"><td>Итого</td><td class="num">—</td><td class="num">' + (totalCentsAll / 100).toFixed(2) + '</td><td class="num">100%</td></tr>');
    return (
      '<table class="report-table data-table">' +
      '<thead><tr><th>Тип начисления</th><th class="num">Позиций</th><th class="num">Сумма ($)</th><th class="num">% от общей</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table>'
    );
  }

  function renderMatrix(byPeriod, byType) {
    var periodKeys = Object.keys(byPeriod).sort();
    var typeOrder = [
      'monthly_subscription', 'fast_premium_per_seat', 'fast_premium_usage',
      'proration_charge', 'proration_refund', 'token_fee', 'token_usage', 'other',
    ];
    var typesInData = {};
    periodKeys.forEach(function (k) {
      Object.keys(byPeriod[k].byType || {}).forEach(function (t) {
        typesInData[t] = true;
      });
    });
    var types = typeOrder.filter(function (t) {
      return typesInData[t];
    });
    Object.keys(typesInData).forEach(function (t) {
      if (types.indexOf(t) < 0) types.push(t);
    });
    if (periodKeys.length === 0 || types.length === 0) {
      return '<p class="muted">Нет данных для матрицы.</p>';
    }
    var headerCells = '<th>Период</th>' + types.map(function (t) {
      return '<th class="num">' + escapeHtml(CHARGE_TYPE_LABELS[t] || t) + '</th>';
    }).join('') + '<th class="num">Итого</th>';
    var rows = periodKeys.map(function (key) {
      var p = byPeriod[key];
      var byTypeRow = p.byType || {};
      var cells = types.map(function (t) {
        var c = byTypeRow[t] || 0;
        return '<td class="num">' + (c !== 0 ? (c / 100).toFixed(2) : '—') + '</td>';
      });
      var total = p.totalCents;
      return (
        '<tr><td>' + escapeHtml(getBillingPeriodLabel(key)) + '</td>' +
        cells.join('') +
        '<td class="num">' + (total / 100).toFixed(2) + '</td></tr>'
      );
    });
    var totalRowCents = {};
    periodKeys.forEach(function (k) {
      var byT = byPeriod[k].byType || {};
      types.forEach(function (t) {
        totalRowCents[t] = (totalRowCents[t] || 0) + (byT[t] || 0);
      });
    });
    var grandTotal = periodKeys.reduce(function (sum, k) {
      return sum + byPeriod[k].totalCents;
    }, 0);
    var totalCells = types.map(function (t) {
      var c = totalRowCents[t] || 0;
      return '<td class="num">' + (c !== 0 ? (c / 100).toFixed(2) : '—') + '</td>';
    });
    rows.push(
      '<tr class="total-row"><td>Итого</td>' + totalCells.join('') + '<td class="num">' + (grandTotal / 100).toFixed(2) + '</td></tr>'
    );
    return (
      '<table class="report-table data-table">' +
      '<thead><tr>' + headerCells + '</tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table>'
    );
  }

  function runReport() {
    var loadingEl = document.getElementById('reportLoading');
    var errorEl = document.getElementById('reportError');
    var contentEl = document.getElementById('reportContent');
    var byPeriodEl = document.getElementById('byPeriodTable');
    var byTypeEl = document.getElementById('byTypeTable');
    var matrixEl = document.getElementById('matrixTable');

    loadingEl.style.display = 'block';
    errorEl.style.display = 'none';
    contentEl.style.display = 'none';

    window.fetchWithAuth('/api/invoices/all-items')
      .then(function (r) {
        if (!r) return Promise.reject(new Error('Нет доступа'));
        return r.json();
      })
      .then(function (data) {
        loadingEl.style.display = 'none';
        var items = data.items || [];
        if (items.length === 0) {
          contentEl.style.display = 'block';
          byPeriodEl.innerHTML = '<p class="muted">Нет загруженных позиций. Загрузите счета в <a href="data.html#invoices">Данные → Счета</a>.</p>';
          byTypeEl.innerHTML = '';
          matrixEl.innerHTML = '';
          return;
        }
        var agg = aggregate(items);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runReport);
  } else {
    runReport();
  }
})();
