"""Generate the installer artwork: wizard side image, small header image and the app icon.

Run: python installer/make_art.py   (needs Pillow)
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
GREEN = (30, 215, 96)
BLUE = (76, 195, 255)
BG = (10, 14, 12)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(w, h, c1, c2):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = lerp(c1, c2, (x / w + y / h) / 2)
    return img


def logo_mask(size):
    """The DJ Mix crossover mark, drawn as two thick crossing curves."""
    s = 4  # supersample
    m = Image.new("L", (size * s, size * s), 0)
    d = ImageDraw.Draw(m)
    W = size * s
    lw = int(W * 0.11)
    for flip in (1, -1):
        pts = []
        for i in range(101):
            t = i / 100
            x = W * (0.12 + 0.76 * t)
            y = W * (0.5 - flip * 0.3 * math.cos(t * math.pi))
            pts.append((x, y))
        d.line(pts, fill=255, width=lw, joint="curve")
        for p in (pts[0], pts[-1]):
            d.ellipse([p[0] - lw / 2, p[1] - lw / 2, p[0] + lw / 2, p[1] + lw / 2], fill=255)
    return m.resize((size, size), Image.LANCZOS)


def font(size, bold=True):
    for name in (("segoeuib.ttf" if bold else "segoeui.ttf"), "arialbd.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", name), size)
        except OSError:
            continue
    return ImageFont.load_default()


def tile(size, radius_frac=0.24):
    t = gradient(size, size, GREEN, BLUE).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_frac), fill=255)
    t.putalpha(mask)
    mark = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    inner = int(size * 0.62)
    off = (size - inner) // 2
    t.paste(mark.resize((inner, inner)), (off, off), logo_mask(inner))
    return t


def wizard_large(scale=1):
    w, h = 164 * scale, 314 * scale
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    # beat bars, like a waveform fading from green to blue
    n = 26
    for i in range(n):
        t = i / (n - 1)
        bh = (0.25 + 0.75 * abs(math.sin(i * 0.7) * math.cos(i * 0.23))) * h * 0.28
        x = int(w * 0.06 + t * w * 0.88)
        bw = max(2, int(w * 0.022))
        y0 = int(h * 0.80 - bh / 2)
        d.rounded_rectangle([x, y0, x + bw, int(y0 + bh)], radius=bw // 2, fill=lerp(GREEN, BLUE, t))
    t = tile(int(76 * scale))
    img.paste(t, ((w - t.width) // 2, int(46 * scale)), t)
    f1, f2 = font(int(26 * scale)), font(int(11 * scale), bold=False)
    for text, f, y, col in (("DJ Mix", f1, 136, (255, 255, 255)), ("for Spotify", f2, 170, (180, 190, 185))):
        tw = d.textlength(text, font=f)
        d.text(((w - tw) / 2, y * scale), text, font=f, fill=col)
    return img


def main():
    for scale, suffix in ((1, ""), (2, "@2x")):
        wizard_large(scale).save(os.path.join(HERE, f"wizard-large{suffix}.bmp"))
    small = Image.new("RGB", (110, 110), (255, 255, 255))
    t = tile(110, 0.22)
    small.paste(t, (0, 0), t)
    small.resize((55, 55), Image.LANCZOS).save(os.path.join(HERE, "wizard-small.bmp"))
    small.save(os.path.join(HERE, "wizard-small@2x.bmp"))
    tile(256).save(os.path.join(HERE, "djmix.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    tile(512).save(os.path.join(HERE, "..", "assets", "app-icon.png"))
    print("art written")


if __name__ == "__main__":
    main()
