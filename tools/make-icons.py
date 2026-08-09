#!/usr/bin/env python3
"""ぼぶる のアプリアイコンを生成する。

iOS Safari は apple-touch-icon に data: URI を受け付けないため、実ファイルの
PNG が要る。ここで作った PNG をリポジトリ直下に置き、index.html から相対パスで
参照している。

  python3 tools/make-icons.py

依存: Pillow  /  フォント: IPAGothic (fonts-japanese-gothic)
"""

from PIL import Image, ImageDraw, ImageFont
import os

FONT = "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

NAVY = (28, 36, 50)       # #1c2432  地
GOLD = (201, 162, 39)     # #c9a227  チャート線
WHITE = (242, 244, 248)   # #f2f4f8  文字

# 180pt 基準で設計し、各サイズへ等倍スケールする
BASE = 180.0


def render(size, text, *, chart=True, ss=4):
    """size 四方のアイコンを描く。ss 倍で描いてから縮小してアンチエイリアスする。"""
    s = size * ss
    k = s / BASE  # 180pt 基準の座標をこの画像のピクセルへ

    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 角丸の地。iOS 側でもマスクされるが、他所で四角のまま出ても困らないよう自前で丸める
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=40 * k, fill=NAVY)

    # 文字。角丸に食い込まないよう幅の 78% に収める
    lo, hi = 1, int(120 * k)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        f = ImageFont.truetype(FONT, mid)
        l, t, r, b = d.textbbox((0, 0), text, font=f)
        if (r - l) <= s * 0.78 and (b - t) <= s * (0.34 if chart else 0.46):
            lo = mid
        else:
            hi = mid - 1
    font = ImageFont.truetype(FONT, lo)

    l, t, r, b = d.textbbox((0, 0), text, font=font)
    # チャート線を入れる時は上寄せ、単独なら中央
    cy = s * (0.40 if chart else 0.50)
    d.text((s / 2 - (l + r) / 2, cy - (t + b) / 2), text, font=font, fill=WHITE)

    if chart:
        pts = [(34, 140), (68, 116), (96, 129), (146, 100)]
        d.line([(x * k, y * k) for x, y in pts],
               fill=GOLD, width=int(round(8 * k)), joint="curve")
        # joint="curve" は端を丸めないので、両端に円を置いて線端を揃える
        rr = 4 * k
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x * k - rr, y * k - rr, x * k + rr, y * k + rr], fill=GOLD)

    return img.resize((size, size), Image.LANCZOS)


def main():
    jobs = [
        # ホーム画面・PWA 用。フルネームを出す
        ("apple-touch-icon.png", 180, "ぼぶる", True),
        ("icon-192.png", 192, "ぼぶる", True),
        ("icon-512.png", 512, "ぼぶる", True),
        # タブ用。この寸法で3文字は潰れるので1文字＋線なし
        ("favicon-32.png", 32, "ぼ", False),
    ]
    for name, size, text, chart in jobs:
        path = os.path.join(OUT, name)
        render(size, text, chart=chart).save(path, "PNG", optimize=True)
        print(f"{name:24} {size}x{size}  {os.path.getsize(path):>6,} bytes")


if __name__ == "__main__":
    main()
