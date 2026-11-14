#!/usr/bin/env python3
"""Convert products.xlsx / products.csv into products.json for the Price Check site.

Usage (run from the price-check folder):
    python tools/excel_to_json.py                 # uses products.xlsx, else products.csv
    python tools/excel_to_json.py my_list.xlsx    # any .xlsx or .csv file

Reads the FIRST sheet and finds the columns by their header names:
  required:  Barcode | Product Name | Price
  optional:  Sale Price | Sale Start | Sale End | Sale Days
Only these columns are published. Any other column (cost, supplier, stock...) stays private.
Needs:  pip install openpyxl   (only for .xlsx files)
"""
import csv
import json
import re
import sys
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "products.json"

# Header keywords, best match first. (exact match is tried before "contains")
BARCODE_KEYS = ["barcode", "barcodenumber", "upc", "upca", "ean", "ean13", "gtin", "barcodeupc",
                "upccode", "itemcode", "productcode", "code", "plu", "sku"]
NAME_KEYS = ["productname", "name", "itemname", "item", "description", "itemdescription",
             "product", "productdescription", "desc", "title"]
PRICE_KEYS = ["price", "regularprice", "sellingprice", "retailprice", "unitprice", "mrp", "retail",
              "sellprice", "normalprice", "pricecad", "priceusd", "amount", "rate"]
SALE_PRICE_KEYS = ["saleprice", "sale", "offerprice", "offer", "promoprice", "promo", "discountprice",
                   "discountedprice", "specialprice", "special", "weekendprice"]
SALE_START_KEYS = ["salestart", "salestartdate", "salefrom", "offerstart", "promostart", "startdate", "start", "from"]
SALE_END_KEYS = ["saleend", "saleenddate", "saleto", "saleuntil", "offerend", "promoend", "enddate", "end", "until", "to"]
SALE_DAYS_KEYS = ["saledays", "saleday", "offerdays", "promodays", "days"]

# Never publish a column whose header contains one of these words, even as a fallback.
PRIVATE_WORDS = ["cost", "wholesale", "purchase", "buy", "margin", "supplier", "vendor", "profit"]

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def norm_header(h):
    return re.sub(r"[^a-z0-9]", "", str(h or "").lower())


def pick_column(headers, keys, taken, min_len=3):
    """Return the index of the best-matching header (exact match beats 'contains')."""
    normed = [norm_header(h) for h in headers]
    ok = lambda i, h: i not in taken and h and not any(w in h for w in PRIVATE_WORDS)
    for k in keys:
        for i, h in enumerate(normed):
            if ok(i, h) and h == k:
                return i
    for k in keys:
        if len(k) < min_len:
            continue
        for i, h in enumerate(normed):
            if ok(i, h) and k in h:
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


def blank(v):
    return v is None or (isinstance(v, str) and not v.strip())


def barcode_text(v):
    """Return (barcode text, None) or (None, reason)."""
    if blank(v):
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


def money(v, what="price"):
    """Return (float, None) or (None, reason)."""
    if blank(v):
        return None, f"empty {what}"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        d = Decimal(str(v))
    else:
        s = re.sub(r"[^\d.,\-]", "", str(v)).replace(",", "")
        try:
            d = Decimal(s)
        except InvalidOperation:
            return None, f"{what} is not a number ({v!r})"
    if d < 0:
        return None, f"negative {what} ({v})"
    return float(d.quantize(Decimal("0.01"))), None


DATE_FORMATS = ["%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d.%m.%Y", "%d %b %Y", "%d %B %Y", "%b %d %Y", "%B %d %Y",
                "%b %d, %Y", "%B %d, %Y"]


def date_text(v):
    """Return (YYYY-MM-DD, None), (None, None) for blank, or (None, reason)."""
    if blank(v):
        return None, None
    if isinstance(v, datetime):
        return v.date().isoformat(), None
    if isinstance(v, date):
        return v.isoformat(), None
    s = str(v).strip()
    s = re.sub(r"\s00:00:00$", "", s)
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat(), None
        except ValueError:
            pass
    return None, f"can't read date {s!r} (use a real Excel date, or YYYY-MM-DD)"


def days_list(v):
    """'Weekend' / 'Sat, Sun' / 'Fri-Sun' -> ['Sat','Sun'] ; returns (list, None) or (None, reason)."""
    if blank(v):
        return [], None
    out = []
    for raw in re.split(r"[,;/&]+|\s+and\s+|\s+", str(v).strip()):
        s = raw.strip().lower()
        if not s:
            continue
        if s in ("weekend", "weekends"):
            out += ["Sat", "Sun"]; continue
        if s in ("weekday", "weekdays"):
            out += DAYS[:5]; continue
        if s in ("daily", "everyday", "all"):
            out += DAYS; continue
        if "-" in s:
            a, _, b = s.partition("-")
            a, b = a[:3].title(), b[:3].title()
            if a in DAYS and b in DAYS:
                i = DAYS.index(a)
                while True:
                    out.append(DAYS[i])
                    if DAYS[i] == b:
                        break
                    i = (i + 1) % 7
                continue
            return None, f"can't read sale days {v!r}"
        d = s[:3].title()
        if d not in DAYS:
            return None, f"can't read sale days {v!r} (use e.g. 'Weekend', 'Sat, Sun' or 'Fri-Sun')"
        out.append(d)
    return list(dict.fromkeys(out)), None


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

    # Find the header row (first row within the first 15 that has barcode + name + price columns).
    header_idx = cols = None
    for i, row in enumerate(rows[:15]):
        taken = set()
        b = pick_column(row, BARCODE_KEYS, taken); taken.add(b)
        sp = pick_column(row, SALE_PRICE_KEYS, taken, min_len=6); taken.add(sp)
        p = pick_column(row, PRICE_KEYS, taken); taken.add(p)
        n = pick_column(row, NAME_KEYS, taken); taken.add(n)
        if b is not None and p is not None and n is not None:
            ss = pick_column(row, SALE_START_KEYS, taken, min_len=6); taken.add(ss)
            se = pick_column(row, SALE_END_KEYS, taken, min_len=6); taken.add(se)
            sd = pick_column(row, SALE_DAYS_KEYS, taken, min_len=6); taken.add(sd)
            header_idx, cols = i, dict(barcode=b, name=n, price=p, sale_price=sp, sale_start=ss, sale_end=se, sale_days=sd)
            break
    if header_idx is None:
        first = rows[0] if rows else []
        sys.exit("Could not find barcode / name / price columns.\n"
                 f"Header row seen: {first}\n"
                 "Rename the headers to e.g. 'Barcode', 'Product Name', 'Price'.")

    headers = rows[header_idx]
    print(f"Reading {src.name}")
    for key, label in [("barcode", "barcode"), ("name", "name"), ("price", "price"), ("sale_price", "sale price"),
                       ("sale_start", "sale start"), ("sale_end", "sale end"), ("sale_days", "sale days")]:
        if cols[key] is not None:
            print(f"  {label + ' column:':19}{headers[cols[key]]!r}")
    used = {c for c in cols.values() if c is not None}
    private = [h for i, h in enumerate(headers) if i not in used and not blank(h)]
    if private:
        print(f"  kept private (not published): {', '.join(repr(h) for h in private)}")

    products, skipped, notes, seen = [], [], [], {}
    for r_i, row in enumerate(rows[header_idx + 1:], start=header_idx + 2):
        cell = lambda key: (row[cols[key]] if cols[key] is not None and cols[key] < len(row) else None)
        if all(blank(v) for v in row):
            continue  # blank line
        code, err = barcode_text(cell("barcode"))
        name = str(cell("name") or "").strip()
        price, perr = money(cell("price"))
        reason = err or ("empty name" if not name else None) or perr
        if reason:
            skipped.append((r_i, reason, row))
            continue

        item = {"barcode": code, "name": name, "price": price}

        # Optional sale
        if not blank(cell("sale_price")):
            sp, serr = money(cell("sale_price"), "sale price")
            start, e1 = date_text(cell("sale_start"))
            end, e2 = date_text(cell("sale_end"))
            days, e3 = days_list(cell("sale_days"))
            problem = serr or e1 or e2 or e3
            if not problem and sp >= price:
                problem = f"sale price {sp:.2f} is not lower than the regular price {price:.2f}"
            if not problem and start and end and end < start:
                problem = f"sale ends ({end}) before it starts ({start})"
            if problem:
                notes.append((r_i, f"{code}: sale ignored - {problem}"))
            else:
                item["sale_price"] = sp
                if start: item["sale_start"] = start
                if end: item["sale_end"] = end
                if days: item["sale_days"] = days
        elif any(not blank(cell(k)) for k in ("sale_start", "sale_end", "sale_days")):
            notes.append((r_i, f"{code}: sale dates/days given but no Sale Price - no sale shown"))

        if code in seen:
            products[seen[code]] = item
            notes.append((r_i, f"duplicate barcode {code} - this row replaced the earlier one"))
            continue
        seen[code] = len(products)
        products.append(item)

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("[\n")
        f.write(",\n".join("  " + json.dumps(p, ensure_ascii=False) for p in products))
        f.write("\n]\n")

    on_sale = sum(1 for p in products if "sale_price" in p)
    print(f"\nImported {len(products)} products -> {OUT.name}" + (f"  ({on_sale} with a sale price)" if on_sale else ""))
    if skipped:
        print(f"\n{len(skipped)} row(s) SKIPPED:")
        for r_i, reason, row in skipped:
            print(f"  row {r_i}: {reason}  {[v for v in row if not blank(v)]}")
    if notes:
        print(f"\n{len(notes)} warning(s):")
        for r_i, msg in notes:
            print(f"  row {r_i}: {msg}")
    if not skipped and not notes:
        print("No rows skipped.")


if __name__ == "__main__":
    main()
