# Price Check

Customers scan the QR code in the store, then scan a product's barcode to see its name and price.

**Live site:** https://sahasra24.github.io/price-check/

## How to update prices

1. Edit **`products.xlsx`** in this folder. It needs three columns: **Barcode**, **Product Name**, **Price**.
   The header names can vary (`UPC`, `Item`, `MRP` and similar all work). Format the Barcode column
   as **Text** so Excel doesn't turn barcodes into `7.62E+12`.
   **The Excel file is private.** It's listed in `.gitignore`, so it is never uploaded. Keep any
   extra columns (cost, supplier, stock) there. Only barcode, name and price reach the website.
2. Open a terminal in this folder and run:
   ```
   python tools/excel_to_json.py
   ```
   It prints how many products it imported and lists any rows it skipped, with the reason.
3. Publish the change:
   ```
   git add products.json
   git commit -m "Update prices"
   git push
   ```
4. Wait about a minute. The live site shows the new prices. Phones fetch a fresh copy every time
   the page opens, so nobody has to clear their cache.

You can also edit `products.json` directly. Each line looks like
`{"barcode": "7622210644817", "name": "Dairy Milk Fruit and Nut 100g", "price": 4.99}`.

## Other files

- `qr.png` and `sign.pdf` are the QR code and the printable in-store sign. To regenerate them, run `python tools/make_sign.py`.
- `index.html`, `style.css` and `app.js` make up the website. There's no build step.
- To test on your computer, run `python -m http.server 8000` and open http://localhost:8000
