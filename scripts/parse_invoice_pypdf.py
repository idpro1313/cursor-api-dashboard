#!/usr/bin/env python3
"""
Извлечение текста из PDF-счёта через pypdf (https://github.com/py-pdf/pypdf).
Выводит в stdout один JSON-объект с полем "text" — полный текст документа.
Node.js использует этот текст для extractInvoiceTableFromText().

Установка: pip install pypdf
Запуск:  python scripts/parse_invoice_pypdf.py /path/to/invoice.pdf
"""
from __future__ import annotations

import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        return 1
    pdf_path = sys.argv[1]
    try:
        from pypdf import PdfReader
    except ImportError:
        return 1
    try:
        reader = PdfReader(pdf_path)
        parts = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                parts.append(t)
        text = "\n".join(parts)
        out = {"text": text}
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    sys.exit(main())
