#!/usr/bin/env python3
"""
Standardise auction photos: 1200 x 900 (4:3), cropped to fill, upright, lightly
enhanced, high-quality JPEG (~150-300 KB). Originals are never modified.

Usage: python3 standardise_photos.py <input_folder> <output_folder> [mapping.csv]
       python3 standardise_photos.py --logos <input_folder> <output_folder> [mapping.csv]
  --logos: logos are NOT cropped. Blank margins are trimmed, then the logo is fitted
           within 600 x 300 keeping its shape and transparency, saved as logo-07.png.
  mapping.csv (optional): original_filename,lot_no  -> output named lot-07.jpg etc.
  Without a mapping, a lot number is taken from the filename (e.g. "Lot 7.jpg", "07 - wine.png").
Also writes contact-sheet.jpg and report.csv (with flags for photos to double-check).
"""
import csv, re, sys
from pathlib import Path
from PIL import Image, ImageOps, ImageFilter, ImageStat, ImageDraw, ImageFont

W, H = 1200, 900
QUALITY = 85
EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp', '.gif'}

try:  # iPhone HEIC support if available
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass


def lot_from_name(name):
    m = re.search(r'(?i)lot[\s_-]*0*(\d+)', name) or re.match(r'0*(\d+)', name)
    return int(m.group(1)) if m else None


def trim_edge_strips(im, max_frac=0.02):
    """Remove thin uniform strips (e.g. white lines from screenshots) at the edges, max 2% per side."""
    from PIL import ImageChops
    w, h = im.size
    box = [0, 0, w, h]
    for side in range(4):
        limit = int((h if side in (0, 2) else w) * max_frac)
        for k in range(limit):
            if side == 0: strip = im.crop((0, box[1], w, box[1] + 1))
            elif side == 2: strip = im.crop((0, box[3] - 1, w, box[3]))
            elif side == 1: strip = im.crop((box[0], 0, box[0] + 1, h))
            else: strip = im.crop((box[2] - 1, 0, box[2], h))
            lo, hi = zip(*strip.getextrema())
            if max(hi[i] - lo[i] for i in range(3)) > 12: break
            if side == 0: box[1] += 1
            elif side == 2: box[3] -= 1
            elif side == 1: box[0] += 1
            else: box[2] -= 1
    return im.crop(tuple(box)) if box != [0, 0, w, h] else im


def fit_on_background(src, dst):
    """Alternative for items on plain backgrounds: whole item visible, background extended in its own colour."""
    im = trim_edge_strips(ImageOps.exif_transpose(Image.open(src)).convert('RGB'))
    corners = [im.getpixel(p) for p in [(2, 2), (im.width - 3, 2), (2, im.height - 3), (im.width - 3, im.height - 3)]]
    bg = tuple(sorted(c[i] for c in corners)[1] for i in range(3))
    canvas = Image.new('RGB', (W, H), bg)
    t = im.copy(); t.thumbnail((W, H), Image.LANCZOS)
    # soften the seam: blend edges of the photo into the background
    mask = Image.new('L', t.size, 255); d = ImageDraw.Draw(mask)
    for k in range(24): d.rectangle([k, k, t.width - 1 - k, t.height - 1 - k], outline=int(255 * k / 24))
    canvas.paste(t, ((W - t.width) // 2, (H - t.height) // 2), mask)
    canvas = Image.blend(canvas, ImageOps.autocontrast(canvas, cutoff=0.5, preserve_tone=True), 0.5)
    canvas.filter(ImageFilter.UnsharpMask(radius=1.2, percent=50, threshold=3)).save(dst, 'JPEG', quality=QUALITY, optimize=True, progressive=True)
    return canvas


def process(src, dst):
    im = Image.open(src)
    im = ImageOps.exif_transpose(im)                      # fix sideways phone photos
    if im.mode in ('RGBA', 'LA', 'P'):                    # flatten transparency onto white
        im = im.convert('RGBA')
        bg = Image.new('RGB', im.size, 'white'); bg.paste(im, mask=im.split()[-1]); im = bg
    im = im.convert('RGB')
    im = trim_edge_strips(im)                             # thin screenshot borders
    ow, oh = im.size
    kept = min((ow / oh) / (W / H), (W / H) / (ow / oh))   # share of the photo kept after cropping
    im = ImageOps.fit(im, (W, H), Image.LANCZOS, centering=(0.5, 0.45))  # crop to fill, slightly above centre
    im = Image.blend(im, ImageOps.autocontrast(im, cutoff=0.5, preserve_tone=True), 0.5)  # gentle levels (half strength)
    im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=50, threshold=3))
    im.save(dst, 'JPEG', quality=QUALITY, optimize=True, progressive=True)  # no EXIF (removes GPS etc.)
    bright = ImageStat.Stat(im.convert('L')).mean[0]
    flags = []
    if min(ow, oh) < 700: flags.append(f'low resolution ({ow}x{oh}), may look soft')
    if kept < 0.7: flags.append(f'heavy crop ({round((1 - kept) * 100)}% trimmed), check nothing important is cut off')
    if bright < 60: flags.append('quite dark')
    if bright > 240: flags.append('very bright / washed out')
    return (ow, oh), dst.stat().st_size, flags, im


def process_logo(src, dst):
    im = ImageOps.exif_transpose(Image.open(src)).convert('RGBA')
    ow, oh = im.size
    # trim blank margins (transparent or near-white)
    alpha_box = im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    rgb = Image.new('RGB', im.size, 'white'); rgb.paste(im, mask=im.getchannel('A'))
    white_box = ImageOps.invert(rgb.convert('L')).point(lambda v: 255 if v > 12 else 0).getbbox()
    box = white_box if alpha_box == (0, 0, ow, oh) else alpha_box
    if box: im = im.crop(box)
    im.thumbnail((600, 300), Image.LANCZOS)
    im.save(dst, 'PNG', optimize=True)
    flags = []
    if max(ow, oh) < 250: flags.append(f'small logo ({ow}x{oh}), may look blurry; ask the donor for a larger version')
    preview = Image.new('RGB', (W, H), 'white')
    t = im.copy(); t.thumbnail((W - 200, H - 200), Image.LANCZOS)
    preview.paste(t, ((W - t.width) // 2, (H - t.height) // 2), t)
    return (ow, oh), dst.stat().st_size, flags, preview


def contact_sheet(entries, path, cols=4):
    tw, th, pad, lab = 300, 225, 12, 34
    rows = (len(entries) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * (tw + pad) + pad, rows * (th + lab + pad) + pad), 'white')
    d = ImageDraw.Draw(sheet)
    try: font = ImageFont.truetype('DejaVuSans.ttf', 15)
    except Exception: font = ImageFont.load_default()
    for i, (label, im, flagged) in enumerate(entries):
        x = pad + (i % cols) * (tw + pad); y = pad + (i // cols) * (th + lab + pad)
        sheet.paste(im.resize((tw, th), Image.LANCZOS), (x, y))
        if flagged: d.rectangle([x - 3, y - 3, x + tw + 2, y + th + 2], outline=(200, 40, 30), width=3)
        d.text((x, y + th + 7), label + ('  (check)' if flagged else ''), fill=(200, 40, 30) if flagged else (20, 40, 55), font=font)
    sheet.save(path, 'JPEG', quality=85)


def main():
    args = sys.argv[1:]
    logos = args[:1] == ['--logos']
    if logos: args = args[1:]
    sys.argv = [sys.argv[0]] + args
    src_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    mapping = {}
    if len(sys.argv) > 3:
        with open(sys.argv[3], newline='', encoding='utf-8-sig') as f:
            for row in csv.reader(f):
                if len(row) >= 2 and row[1].strip().isdigit(): mapping[row[0].strip().lower()] = int(row[1])
    files = sorted(p for p in src_dir.rglob('*') if p.suffix.lower() in EXTS and not p.name.startswith('.'))
    report, sheet, used = [], [], {}
    for p in files:
        lot = mapping.get(p.name.lower(), lot_from_name(p.stem))
        prefix = 'logo' if logos else 'lot'
        base = f'{prefix}-{lot:02d}' if lot is not None else re.sub(r'[^a-z0-9]+', '-', p.stem.lower()).strip('-')
        used[base] = used.get(base, 0) + 1
        name = base + (f'-{used[base]}' if used[base] > 1 else '') + ('.png' if logos else '.jpg')   # extra photos of same lot: lot-07-2.jpg
        try:
            (ow, oh), size, flags, im = (process_logo if logos else process)(p, out_dir / name)
        except Exception as e:
            report.append([p.name, '', '', '', f'could not open: {e}']); continue
        if lot is None: flags.append('no lot number found in filename')
        report.append([p.name, name, f'{ow}x{oh}', f'{size // 1024} KB', '; '.join(flags)])
        sheet.append((name, im, bool(flags)))
    with open(out_dir / 'report.csv', 'w', newline='') as f:
        csv.writer(f).writerows([['Original', 'Standardised', 'Original size', 'New file size', 'Check']] + report)
    sheet.sort(key=lambda e: e[0])
    if sheet: contact_sheet(sheet, out_dir / 'contact-sheet.jpg')
    print(f'{len(sheet)} photos done, {sum(1 for r in report if r[4])} flagged. See {out_dir}/report.csv')


if __name__ == '__main__':
    main()
