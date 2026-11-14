#!/usr/bin/env python3
"""Convert products.xlsx / products.csv into products.json for the Price Check site.

Usage (run from the price-check folder):
    python tools/excel_to_json.py                 # uses products.xlsx, else products.csv
    python tools/excel_to_json.py my_list.xlsx    # any .xlsx or .csv file

Reads the FIRST sheet, finds the barcode / name / price columns by their
header names, keeps barcodes as exact text, and writes products.json.
Needs:  pip install openpyxl   (only for .xlsx files)
"""
import csv
import json
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "products.json"

# Header keywords, best match first.
BARCODE_KEYS = ["barcode", "barcodenumber", "upc", "upca", "ean", "ean13", "gtin", "barcodeupc",
                "upccode", "itemcode", "productcode", "code", "plu", "sku"]
NAME_KEYS = ["productname", "name", "itemname", "item", "description", "itemdescription",
             "product", "productdescription", "desc", "title"]
PRICE_KEYS = ["price", "sellingprice", "saleprice", "retailprice", "unitprice", "mrp", "retail",
              "sellprice", "pricecad", "priceusd", "amount", "rate", "cost"]


def norm_header(h):
    return re.sub(r"[^a-z0-9]", "", str(h or "").lower())


def pick_column(headers, keys, taken):
    """Return the index of the best-matching header (exact match beats 'contains')."""
    normed = [norm_header(h) for h in headers]
    for k in keys:
        for i, h in enumerate(normed):
            if i not in taken and h == k:
                return i
    for k in keys:
        if len(k) < 3:
            continue
        for i, h in enumerate(normed):
            if i not in taken and h and k in h:
                return i
    return None


def read_rows(path):
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        try:
            import openpyxl
        except ImportError:
            sys.exit("openpyxl is needed for Excel files. Run:  pip install openpyxl")
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.worksheets[0]
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        wb.close()
        return rows
    if path.suffix.lower() == ".csv":
        for enc in ("utf-8-sig", "cp1252"):
            try:
                with open(path, newline="", encoding=enc) as f:
                    return [row for row in csv.reader(f)]
            except UnicodeDecodeError:
                continue
        sys.exit(f"Could not read {path} (unknown text encoding).")
    sys.exit(f"Unsupported file type: {path.name} (use .xlsx or .csv)")


def barcode_text(v):
    """Return the barcode as clean digit/letter text, or (None, reason)."""
    if v is None:
        return None, "empty barcode"
    if isinstance(v, bool):
        return None, "invalid barcode"
    if isinstance(v, int):
        return str(v), None
    if isinstance(v, float):
        if not v.is_integer():
            return None, f"barcode looks like a decimal number ({v})"
        return str(int(v)), None
    s = str(v).strip().replace(" ", "")
    if s.startswith("'"):
        s = s[1:]
    if re.fullmatch(r"\d+\.0+", s):
        s = s.split(".")[0]
    if re.fullmatch(r"[\d.]+[eE][+-]?\d+", s):
        # e.g. 7.62221E+12 in a CSV -- the real digits are already lost.
        return None, f"barcode is in scientific notation ({s}); format the column as Text/Number in Excel and re-save"
    if not s:
        return None, "empty barcode"
    return s, None


def price_value(v):
    if v is None or (isinstance(v, str) and not v.strip()):
        return None, "empty price"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        d = Decimal(str(v))
    else:
        s = re.sub(r"[^\d.,\-]", "", str(v)).replace(",", "")
        try:
            d = Decimal(s)
        except InvalidOperation:
            return None, f"price is not a number ({v!r})"
    if d < 0:
        return None, f"negative price ({v})"
    return float(d.quantize(Decimal("0.01"))), None


def main():
    if len(sys.argv) > 1:
        src = Path(sys.argv[1])
        if not src.is_absolute() and not src.exists():
            src = ROOT / src
    else:
        src = next((p for p in (ROOT / "products.xlsx", ROOT / "products.csv") if p.exists()), None)
        if src is None:
            sys.exit(f"No products.xlsx or products.csv found in {ROOT}")
    if not src.exists():
        sys.exit(f"File not found: {src}")

    try:
        rows = read_rows(src)
    except PermissionError:
        sys.exit(f"Can't open {src.name} - it's probably still open in Excel.\n"
                 "Save and CLOSE the file in Excel, then run this again.")

    # Find the header row (first row within the first 15 that has barcode + price columns).
    header_idx = cols = None
    for i, row in enumerate(rows[:15]):
        taken = set()
        b = pick_column(row, BARCODE_KEYS, taken); taken.add(b)
        p = pick_column(row, PRICE_KEYS, taken); taken.add(p)
        n = pick_column(row, NAME_KEYS, taken)
        if b is not None and p is not None and n is not None:
            header_idx, cols = i, (b, n, p)
            break
    if header_idx is None:
        first = rows[0] if rows else []
        sys.exit("Could not find barcode / name / price columns.\n"
                 f"Header row seen: {first}\n"
                 "Rename the headers to e.g. 'Barcode', 'Product Name', 'Price'.")

    headers = rows[header_idx]
    b_col, n_col, p_col = cols
    print(f"Reading {src.name}")
    print(f"  barcode column: {headers[b_col]!r}")
    print(f"  name column:    {headers[n_col]!r}")
    print(f"  price column:   {headers[p_col]!r}")

    products, skipped, seen = [], [], {}
    for r_i, row in enumerate(rows[header_idx + 1:], start=header_idx + 2):
        cell = lambda c: row[c] if c < len(row) else None
        if all(v is None or str(v).strip() == "" for v in row):
            continue  # blank line
        code, err = barcode_text(cell(b_col))
        name = str(cell(n_col) or "").strip()
        price, perr = price_value(cell(p_col))
        reason = err or ("empty name" if not name else None) or perr
        if reason:
            skipped.append((r_i, reason, row))
            continue
        if code in seen:
            products[seen[code]] = {"barcode": code, "name": name, "price": price}
            skipped.append((r_i, f"duplicate barcode {code} (this later row replaced row {seen[code] + header_idx + 2}'s data)", None))
            continue
        seen[code] = len(products)
        products.append({"barcode": code, "name": name, "price": price})

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("[\n")
        f.write(",\n".join("  " + json.dumps(p, ensure_ascii=False) for p in products))
        f.write("\n]\n")

    print(f"\nImported {len(products)} products -> {OUT.name}")
    if skipped:
        print(f"\n{len(skipped)} row(s) skipped or flagged:")
        for r_i, reason, row in skipped:
            extra = f"  {[v for v in row if v not in (None, '')]}" if row else ""
            print(f"  row {r_i}: {reason}{extra}")
    else:
        print("No rows skipped.")


if __name__ == "__main__":
    main()
