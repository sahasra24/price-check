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

## Staff alerts ("Need help? Call a staff member")

The button only appears while someone is on shift. When a customer taps it:
1. Everyone **on shift right now** gets an urgent ntfy alert ("Customer needs help - Aisle 3") with an **Accept** button.
2. The first person to tap **Accept** gets the job. The alert on everyone else's phone changes to
   "Shyam is helping the customer at Aisle 3", and their phones stop ringing.
3. The customer's screen shows "✓ Shyam is on the way".
4. If nobody accepts, everyone is reminded every 30 seconds. After 3 minutes the customer is asked to go to the counter.

**Points:** 3 for accepting within 30 seconds, 2 within 1 minute, 1 after that.

| Page | Link | Who |
|---|---|---|
| Shift editor | https://price-check-help.triveni-waxhaw.workers.dev/admin | Owner only (owner PIN) |
| Points leaderboard | https://price-check-help.triveni-waxhaw.workers.dev/board | Staff (points PIN) |

**Changing shifts each week:** open the shift editor, enter the owner PIN, and set each person's start and end
time per day. Leave a day empty for a day off. Tap **Save shifts**; it's live straight away. You can also
add or remove people, pause someone who's on leave, and send a test alert to check their phone.

**Setting up a staff phone (once per person):**
1. Install the free **ntfy** app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) /
   [iPhone](https://apps.apple.com/app/ntfy/id1625396347)) and allow notifications.
2. Tap **+** and type the person's **ntfy code** from the shift editor, e.g. `triveni-shyam-xxxxxxxxxx`.
3. **Android:** in ntfy Settings, turn on **Keep alerting for highest priority** so the phone keeps ringing
   until someone accepts. Also turn on **Instant delivery**.
   **iPhone:** Settings → Notifications → ntfy: allow notifications, sounds and Time Sensitive. On iPhone,
   tap the alert to open it, then tap **Accept**.
4. In the shift editor, tap **Send test alert** for that person.

The staff list, shifts and ntfy codes are private. They live in the help service's database, not on this public site.

**The help service** is the `worker/` folder, running free on Cloudflare (account skoppal@gitam.in).
To update its code: `cd worker`, then `npx wrangler deploy`.

## Other files

- `qr.png` and `sign.pdf` are the QR code and the printable in-store sign. To regenerate them, run `python tools/make_sign.py`.
- `index.html`, `style.css` and `app.js` make up the website. There's no build step.
- To test on your computer, run `python -m http.server 8000` and open http://localhost:8000
