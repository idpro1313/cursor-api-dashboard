/**
 * Парсинг таблицы позиций из PDF-счёта Cursor по структуре документа (координаты текста).
 * Сначала распознаём таблицу по строкам/столбцам, затем берём ячейки: Description, Qty, Unit price, Tax, Amount.
 */
(function () {
  if (typeof global !== 'undefined' && !global.navigator) {
    global.navigator = { userAgent: 'node' };
  }
  if (typeof window !== 'undefined' && !window.navigator) {
    window.navigator = { userAgent: 'node' };
  }
})();

const { PdfReader } = require('pdfreader');

const ROW_Y_TOLERANCE = 2.5;   // один ряд — элементы с y в пределах ±2.5
const COL_X_GAP = 15;         // мин. расстояние между столбцами для границы

function parseCurrencyToCents(str) {
  if (str == null || str === '') return null;
  const s = String(str).replace(/[$,\s]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : Math.round(n * 100);
}

function parseNum(str) {
  if (str == null || str === '') return null;
  const s = String(str).replace(/\s/g, '').replace(',', '.').split(String.fromCharCode(0x2014)).join('').trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

var EM_DASH = String.fromCharCode(0x2014);

function trimDescription(s) {
  if (!s || typeof s !== 'string') return null;
  var t = s.replace(/\s+/g, ' ').trim();
  while (t.length && (t.charAt(0) === ' ' || t.charAt(0) === EM_DASH)) t = t.slice(1);
  while (t.length && (t.charAt(t.length - 1) === ' ' || t.charAt(t.length - 1) === EM_DASH)) t = t.slice(0, -1);
  return t || null;
}

function isOnlySpacesAndDashes(s) {
  if (!s || typeof s !== 'string') return true;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== EM_DASH) return false;
  }
  return true;
}

/** Собрать все текстовые элементы из PDF с координатами. */
function parsePdfItems(buffer) {
  return new Promise((resolve, reject) => {
    const items = [];
    let currentPage = 1;
    new PdfReader().parseBuffer(buffer, (err, item) => {
      if (err) return reject(err);
      if (item == null) return resolve({ items, pages: currentPage });
      if (item.page != null) currentPage = item.page;
      if (item.text != null && String(item.text).trim() !== '') {
        items.push({
          page: currentPage,
          x: Number(item.x) || 0,
          y: Number(item.y) || 0,
          w: Number(item.w) || 0,
          text: String(item.text).trim(),
        });
      }
    });
  });
}

/** Группировка элементов по строкам (по y). Строки отсортированы сверху вниз (y по убыванию в PDF часто сверху вниз). */
function groupIntoRows(items) {
  if (items.length === 0) return [];
  const byRow = new Map();
  for (const it of items) {
    const y = it.y;
    let rowKey = null;
    for (const key of byRow.keys()) {
      if (Math.abs(key - y) <= ROW_Y_TOLERANCE) {
        rowKey = key;
        break;
      }
    }
    if (rowKey == null) rowKey = y;
    if (!byRow.has(rowKey)) byRow.set(rowKey, []);
    byRow.get(rowKey).push(it);
  }
  const rows = Array.from(byRow.entries())
    .map(([y, cells]) => ({ y, cells: cells.sort((a, b) => a.x - b.x) }))
    .sort((a, b) => b.y - a.y);
  return rows;
}

/** По заголовку вычислить границы столбцов. Возвращает { boundaries, hasTaxColumn }.
 * Если колонки Tax нет (4 колонки: Description, Qty, Unit price, Amount), boundaries — массив из 4 элементов. */
function getColumnBoundaries(headerCells) {
  const cells = headerCells.slice().sort((a, b) => a.x - b.x);
  const texts = cells.map((c) => c.text.toLowerCase());
  const xs = cells.map((c) => c.x);
  const qtyIdx = texts.findIndex((t) => t.trim() === 'qty');
  const unitIdx = texts.findIndex((t) => t.includes('unit') || t.includes('price'));
  const taxIdx = texts.findIndex((t) => t.trim() === 'tax' || t.startsWith('tax '));
  const amountIdx = texts.findIndex((t) => t.includes('amount'));
  const descStart = xs[0] != null ? xs[0] : 0;
  const qtyStart = qtyIdx >= 0 ? xs[qtyIdx] : (unitIdx >= 0 ? xs[unitIdx] - 30 : descStart + 200);
  const unitStart = unitIdx >= 0 ? xs[unitIdx] : (amountIdx >= 0 ? xs[amountIdx] - 60 : qtyStart + 40);
  const amountStart = amountIdx >= 0 ? xs[amountIdx] : unitStart + 50;
  if (taxIdx >= 0) {
    const taxStart = xs[taxIdx];
    return { boundaries: [descStart, qtyStart, unitStart, taxStart, amountStart], hasTaxColumn: true };
  }
  return { boundaries: [descStart, qtyStart, unitStart, amountStart], hasTaxColumn: false };
}

/** Отнести элемент к столбцу по x и границам. */
function columnIndex(x, boundaries) {
  var col = 0;
  for (var i = 1; i < boundaries.length; i++) {
    if (x >= boundaries[i] - COL_X_GAP / 2) col = i;
    else break;
  }
  return Math.min(col, boundaries.length - 1);
}

/** Текст строки по столбцам. При hasTaxColumn=false колонка 3 = Amount (Tax нет). */
function getRowCells(rowCells, boundaries, hasTaxColumn) {
  if (!boundaries || boundaries.length < 2) {
    var desc = rowCells.map(function(c) { return c.text; }).join(' ');
    return { desc: desc, qty: null, unit: null, tax: null, amount: null };
  }
  var ncol = boundaries.length;
  var cols = [];
  for (var k = 0; k < ncol; k++) cols.push([]);
  for (var i = 0; i < rowCells.length; i++) {
    var c = rowCells[i];
    var col = columnIndex(c.x, boundaries);
    cols[col].push(c.text);
  }
  if (hasTaxColumn && ncol >= 5) {
    return {
      desc: cols[0].join(' ').trim() || null,
      qty: cols[1].join(' ').trim() || null,
      unit: cols[2].join(' ').trim() || null,
      tax: cols[3].join(' ').trim() || null,
      amount: cols[4].join(' ').trim() || null,
    };
  }
  if (ncol >= 4) {
    return {
      desc: cols[0].join(' ').trim() || null,
      qty: cols[1].join(' ').trim() || null,
      unit: cols[2].join(' ').trim() || null,
      tax: null,
      amount: cols[3].join(' ').trim() || null,
    };
  }
  return { desc: cols[0] ? cols[0].join(' ').trim() : null, qty: null, unit: null, tax: null, amount: null };
}

/** Проверка: строка похожа на заголовок таблицы счёта. */
function isHeaderRow(cells) {
  const full = cells.map((c) => c.text).join(' ').toLowerCase();
  return full.includes('description') && (full.includes('qty') || full.includes('amount'));
}

/** Проверка: строка — итог (Subtotal / Total), не позиция. */
function isSubtotalRow(cells) {
  const full = cells.map((c) => c.text).join(' ').toLowerCase();
  const hasSubtotal = cells.some((c) => /^subtotal\s*$/i.test(String(c.text).trim()));
  return hasSubtotal || /total\s+excluding\s+tax/i.test(full) || /amount\s+due/i.test(full) || /^\s*total\s*$/i.test(full.trim());
}

/** Строка похожа на продолжение описания (диапазон дат и т.п.) — не считать её строкой с Qty/Amount. */
function looksLikeDescriptionContinuation(desc) {
  if (!desc || typeof desc !== 'string') return false;
  var t = desc.trim();
  if (t.length === 0) return false;
  var lower = t.toLowerCase();
  var months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (var m = 0; m < months.length; m++) {
    if (lower.indexOf(months[m]) >= 0) return true;
  }
  if (lower.indexOf('2026') >= 0 || lower.indexOf('2025') >= 0) return true;
  return false;
}

/** Строка amount похожа на сумму в долларах ($12.34 или 1120). */
function looksLikeAmount(str) {
  if (str == null || str === '') return false;
  var s = String(str).trim();
  if (s.indexOf('$') >= 0) return true;
  var n = parseFloat(s.replace(/[,]/g, '.'));
  return !Number.isNaN(n) && n >= 0 && n < 10000000;
}

/** Извлечь таблицу позиций из уже собранных по строкам данных. */
function extractTableFromRows(rows) {
  var headerRowIndex = -1;
  var boundaries = null;
  var hasTaxColumn = false;
  for (var i = 0; i < rows.length; i++) {
    if (isHeaderRow(rows[i].cells)) {
      var colResult = getColumnBoundaries(rows[i].cells);
      if (colResult && colResult.boundaries && colResult.boundaries.length >= 2) {
        boundaries = colResult.boundaries;
        hasTaxColumn = colResult.hasTaxColumn === true;
        headerRowIndex = i;
        break;
      }
    }
  }
  if (headerRowIndex < 0 || !boundaries) return [];

  var out = [];
  var pendingDescription = [];
  var rowIndex = 0;

  for (var j = headerRowIndex + 1; j < rows.length; j++) {
    var cells = rows[j].cells;
    var rowData = getRowCells(cells, boundaries, hasTaxColumn);
    var desc = rowData.desc;
    var qty = rowData.qty;
    var unit = rowData.unit;
    var tax = rowData.tax;
    var amount = rowData.amount;

    if (isSubtotalRow(cells)) break;

    if (desc && looksLikeDescriptionContinuation(desc)) {
      pendingDescription.push(desc);
      continue;
    }

    var amountCents = parseCurrencyToCents(amount);
    var qtyVal = parseNum(qty);
    var taxPct = parseNum(tax);
    var unitVal = parseNum(unit);
    var isAmountRow = looksLikeAmount(amount) && amountCents != null;
    var hasValidQty = qtyVal != null && qtyVal >= 0 && qtyVal < 10000;
    var hasValidUnit = unitVal != null && unitVal >= 0;
    var isDataRow = isAmountRow && (hasValidQty || hasValidUnit) && !looksLikeDescriptionContinuation(desc || '');

    if (isDataRow) {
      var lastPendingDateLike = pendingDescription.length > 0 && looksLikeDescriptionContinuation(pendingDescription[pendingDescription.length - 1]);
      var smallAmount = amountCents != null && amountCents < 1000;
      if (lastPendingDateLike && smallAmount) {
        pendingDescription.push(desc || '');
        continue;
      }
      var description = pendingDescription.length ? pendingDescription.join(' ').trim() : (desc || null);
      var cleanDesc = description ? trimDescription(description) : null;
      out.push({
        row_index: rowIndex++,
        description: cleanDesc || null,
        quantity: hasValidQty ? qtyVal : null,
        unit_price_cents: unitVal != null ? Math.round(unitVal * 100) : null,
        tax_pct: taxPct != null && taxPct >= 0 && taxPct <= 100 ? taxPct : null,
        amount_cents: amountCents,
        raw_columns: [qtyVal, unitVal != null ? unitVal : null, taxPct, amountCents].filter(function(v) { return v != null; }),
      });
      pendingDescription = [];
    } else {
      if (desc && !isOnlySpacesAndDashes(desc)) pendingDescription.push(desc);
    }
  }

  if (pendingDescription.length > 0) {
    out.push({
      row_index: rowIndex++,
      description: pendingDescription.join(' ').trim().replace(/\s+/g, ' ').trim() || null,
      quantity: null,
      unit_price_cents: null,
      tax_pct: null,
      amount_cents: null,
      raw_columns: pendingDescription,
    });
  }
  return out;
}

/**
 * Парсинг PDF-буфера: распознаём таблицу по координатам, извлекаем строки между Description/Subtotal.
 * Возвращает массив { row_index, description, quantity, unit_price_cents, tax_pct, amount_cents, raw_columns }.
 */
async function parseCursorInvoicePdfFromStructure(buffer) {
  const { items } = await parsePdfItems(buffer);
  if (items.length === 0) return [];

  const rows = groupIntoRows(items);
  return extractTableFromRows(rows);
}

module.exports = {
  parseCursorInvoicePdfFromStructure,
  parsePdfItems,
  groupIntoRows,
  extractTableFromRows,
};
