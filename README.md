# Price Check

Customers scan the QR code in the store, then scan a product's barcode to see its name and price,
including any sale price. They can also see store hours and contacts, and call a staff member who is on shift.

**Live site:** https://sahasra24.github.io/price-check/

## How to update prices

1. Edit **`products.xlsx`** in this folder. It needs three columns: **Barcode**, **Product Name**, **Price**.
   The header names can vary (`UPC`, `Item`, `MRP` and similar all work). Format the Barcode column
   as **Text** so Excel doesn't turn barcodes into `7.62E+12`.
   **The Excel file is private.** It's listed in `.gitignore`, so it is never uploaded. Keep any
   extra columns (cost, supplier, stock) there. Only barcode, name, price and sale columns reach the website.
2. Open a terminal in this folder and run:
   ```
   python tools/excel_to_json.py
   ```
   It prints how many products it imported, which columns it kept private, and any rows it skipped or warned about.
3. Publish the change:
   ```
   git add products.json
   git commit -m "Update prices"
   git push
   ```
4. Wait about a minute. The live site shows the new prices. Phones fetch a fresh copy every time
   the page opens, so nobody has to clear their cache.

## Sales

Add these optional columns to `products.xlsx`. Leave them empty for items that aren't on sale.

| Column | Example | Meaning |
|---|---|---|
| **Sale Price** | `3.49` | The sale price. Must be lower than Price. |
| **Sale Start** | `2026-11-21` | First day of the sale. Optional. |
| **Sale End** | `2026-11-22` | Last day of the sale. Optional. |
| **Sale Days** | `Weekend`, `Sat, Sun`, `Fri-Sun` | Only on these days of the week. Optional. |

The sale price shows automatically on the right days, based on store time. Customers see the regular
price crossed out, the sale price and how much they save. After the sale ends, the regular price comes
back by itself. Examples:
- **One weekend only:** Sale Start `2026-11-21`, Sale End `2026-11-22`.
- **Every weekend:** Sale Days `Weekend`, with no dates.

## Store details: `store.json`

Edit the text between the quotes, then commit and push `store.json`. Anything left as `""` is hidden.
- `name`, `address`, `map_url` (optional; a Google Maps link is made from the address otherwise)
- `timezone`: the store's time zone, used for sales, shifts and "Open now". For example `America/Toronto`.
- `hours`: per day, like `"09:00-21:00"`, or `"Closed"`. Use 24-hour times.
- `help_desk` and `manager`: `phone`, `email` and `name`
- `notes`: anything else, such as parking

Everything in `store.json` is public. Use work phone numbers and emails, not personal ones.

## Staff alerts: `staff.json`

The "Need help? Call a staff member" button only appears while someone is on shift. Tapping it sends
an urgent alert with sound **only to the people scheduled right now**. Nobody is alerted on their days off.

**Each staff member, once:**
1. Install the free **ntfy** app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) /
   [iPhone](https://apps.apple.com/app/ntfy/id1625396347)) and allow notifications.
2. Tap **+** (Subscribe to topic) and type their own topic name from `staff.json`, e.g. `triveni-ravi-8f3k2q`.
3. On Android, also turn on "Instant delivery" for faster alerts.

**Schedule format.** Each person has a unique topic and their weekly shifts:
```json
{
  "server": "https://ntfy.sh",
  "staff": [
    { "name": "Ravi", "topic": "triveni-ravi-8f3k2q",
      "shifts": [ { "days": ["Sat", "Sun"], "start": "09:00", "end": "18:00" } ] },
    { "name": "Priya", "topic": "triveni-priya-x71mzd",
      "shifts": [ { "days": ["Mon", "Tue", "Wed"], "start": "09:00", "end": "17:00" },
                  { "days": ["Fri"], "start": "12:00", "end": "21:00" } ] }
  ]
}
```
- `days` can also be `"Weekend"`, `"Weekdays"` or `"Daily"`. A shift like `22:00` to `06:00` runs overnight.
- To pause someone (leave, holiday), add `"active": false` to their entry.
- After editing, commit and push `staff.json`. The change is live in about a minute.

`staff.json` is public, so anyone could read the schedule or the topic names. Make topic names hard to
guess, and change a topic if a staff member leaves. The button also has a 1-minute cooldown, so a
customer can't spam alerts.

## Other files

- `qr.png` and `sign.pdf` are the QR code and the printable in-store sign. To regenerate them, run `python tools/make_sign.py`.
- `index.html`, `style.css` and `app.js` make up the website. There's no build step.
- To test on your computer, run `python -m http.server 8000` and open http://localhost:8000
