#!/usr/bin/env python3
"""
Опциональный парсер PDF-счёта через PaddleOCR (PP-StructureV3).
Вывод: JSON-массив строк в stdout.

Установка: pip install "paddleocr[doc-parser]"
Запуск:  python scripts/parse_invoice_paddleocr.py /path/to/invoice.pdf

При ошибке или отсутствии paddleocr выводит [] и завершается с кодом 1.
Node при ненулевом коде или пустом выводе использует встроенный парсер.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def run_paddleocr(pdf_path: str) -> list[dict]:
    try:
        from paddleocr import PPStructureV3
    except ImportError:
        return []

    pipeline = PPStructureV3(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
    )
    output = pipeline.predict(input=pdf_path)
    if not output:
        return []

    # Сохраняем во временную папку и читаем JSON
    with tempfile.TemporaryDirectory() as tmp:
        for res in output:
            if hasattr(res, "save_to_json"):
                res.save_to_json(save_path=tmp)
                break
        for name in os.listdir(tmp):
            if name.endswith(".json"):
                with open(os.path.join(tmp, name), "r", encoding="utf-8") as f:
                    data = json.load(f)
                return extract_invoice_rows(data)
    return []


def extract_invoice_rows(data: dict | list) -> list[dict]:
    """Из JSON PP-StructureV3 извлечь строки таблицы счёта (Description, Qty, Unit price, Amount)."""
    rows_out = []
    if isinstance(data, list):
        for item in data:
            rows_out.extend(extract_invoice_rows(item))
        return rows_out
    if not isinstance(data, dict):
        return []

    # Ищем таблицы в типичных полях вывода
    tables = data.get("table_recognition_res") or data.get("tables") or data.get("table_res")
    if isinstance(data.get("type"), str) and "table" in data.get("type", "").lower():
        tables = tables or [data]
    if not tables:
        for v in data.values():
            if isinstance(v, (list, dict)):
                rows_out.extend(extract_invoice_rows(v))
        return rows_out

    for tbl in tables if isinstance(tables, list) else [tables]:
        cells = tbl.get("cells") or tbl.get("res", {}).get("cells") or []
        if not cells and isinstance(tbl.get("res"), dict):
            cells = tbl["res"].get("cells", [])
        if not cells:
            continue
        # Собираем текст по ячейкам; предполагаем структуру строк/столбцов
        header_found = False
        col_desc = col_qty = col_unit = col_tax = col_amount = -1
        for idx, cell in enumerate(cells):
            text = (cell.get("text") or cell.get("content") or "").strip().lower()
            if not text:
                continue
            if "description" in text:
                col_desc = idx
            if text == "qty":
                col_qty = idx
            if "unit" in text or "price" in text:
                col_unit = idx
            if text == "tax":
                col_tax = idx
            if "amount" in text:
                col_amount = idx
        if col_desc >= 0 and col_amount >= 0:
            header_found = True
        if not header_found:
            continue
        # Упрощённо: если cells — плоский список, считаем по порядку колонок (5 колонок)
        ncol = 5
        for start in range(0, len(cells), ncol):
            chunk = cells[start : start + ncol]
            if len(chunk) < 4:
                continue
            desc = (chunk[0].get("text") or chunk[0].get("content") or "").strip()
            if desc.lower() in ("description", "qty", "amount") or not desc:
                continue
            qty = parse_num(chunk[1].get("text") or chunk[1].get("content"))
            unit = parse_num(chunk[2].get("text") if len(chunk) > 2 else None)
            tax = parse_num(chunk[3].get("text") if len(chunk) > 3 else None)
            amount = parse_currency_to_cents(chunk[4].get("text") if len(chunk) > 4 else chunk[3].get("text"))
            if amount is None and len(chunk) >= 4:
                amount = parse_currency_to_cents(chunk[3].get("text") or chunk[3].get("content"))
            if amount is not None or (qty is not None and desc):
                rows_out.append({
                    "row_index": len(rows_out),
                    "description": desc or None,
                    "quantity": int(qty) if qty is not None and 0 <= qty < 10000 else None,
                    "unit_price_cents": int(round(unit * 100)) if unit is not None else None,
                    "tax_pct": tax if tax is not None and 0 <= tax <= 100 else None,
                    "amount_cents": amount,
                    "raw_columns": [qty, unit, tax, amount],
                })
        if rows_out:
            return rows_out
    return rows_out


def parse_currency_to_cents(s: str | None) -> int | None:
    if not s:
        return None
    s = str(s).replace("$", "").replace(",", "").replace(" ", "").strip()
    if not s or s in ("-", "\u2014", "\u2013"):
        return None
    try:
        return round(float(s) * 100)
    except ValueError:
        return None


def parse_num(s: str | None):
    if s is None or (isinstance(s, str) and not s.strip()) or s in ("-", "\u2014"):
        return None
    s = str(s).strip().replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def main():
    if len(sys.argv) < 2:
        print("[]", flush=True)
        sys.exit(1)
    pdf_path = Path(sys.argv[1]).resolve()
    if not pdf_path.is_file():
        print("[]", flush=True)
        sys.exit(1)
    try:
        rows = run_paddleocr(str(pdf_path))
        print(json.dumps(rows, ensure_ascii=False), flush=True)
        sys.exit(0 if rows else 1)
    except Exception as e:
        print("[]", flush=True)
        sys.stderr.write(str(e) + "\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
