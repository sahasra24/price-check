#!/usr/bin/env python3
"""Generate qr.png and sign.pdf for the Price Check site.

Usage:  python tools/make_sign.py
Needs:  pip install "qrcode[pil]" reportlab
"""
from pathlib import Path

import qrcode
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

URL = "https://sahasra24.github.io/price-check/"
ROOT = Path(__file__).resolve().parent.parent
QR_PATH = ROOT / "qr.png"
PDF_PATH = ROOT / "sign.pdf"


def make_qr():
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=40, border=4)
    qr.add_data(URL)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    img.save(QR_PATH)
    print(f"Wrote {QR_PATH.name} ({img.size[0]}x{img.size[1]} px)")


def make_pdf():
    w, h = letter
    c = canvas.Canvas(str(PDF_PATH), pagesize=letter)
    c.setTitle("Price Check sign")
    dark, muted, accent = HexColor("#111111"), HexColor("#555555"), HexColor("#1f6feb")

    c.setFillColor(accent)
    c.rect(0, h - 0.35 * inch, w, 0.35 * inch, stroke=0, fill=1)

    c.setFillColor(dark)
    c.setFont("Helvetica-Bold", 58)
    c.drawCentredString(w / 2, h - 1.45 * inch, "No price label?")
    c.setFillColor(muted)
    c.setFont("Helvetica", 26)
    c.drawCentredString(w / 2, h - 2.0 * inch, "Check the price yourself in seconds")

    size = 5.0 * inch
    c.drawImage(str(QR_PATH), (w - size) / 2, h - 2.3 * inch - size, size, size)

    steps = [
        "1.  Scan this code with your phone camera",
        "2.  Tap 'Scan to see the price'",
        "3.  Point your camera at the item's barcode",
    ]
    c.setFillColor(dark)
    c.setFont("Helvetica", 21)
    y = h - 2.3 * inch - size - 0.55 * inch
    left = 1.35 * inch
    for s in steps:
        c.drawString(left, y, s)
        y -= 0.45 * inch

    c.setFillColor(muted)
    c.setFont("Helvetica", 15)
    c.drawCentredString(w / 2, 0.6 * inch, "No app or account needed · Final price confirmed at checkout")
    c.showPage()
    c.save()
    print(f"Wrote {PDF_PATH.name} (Letter size)")


if __name__ == "__main__":
    make_qr()
    make_pdf()
