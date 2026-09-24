#!/usr/bin/env python3
"""金の足を鍵なしで取る（Yahoo Finance の COMEX 金先物 GC=F）。

XAUUSD（スポット）そのものは鍵なしでは取れないので、先物の足を使い、
build_brief.py 側で「スポットの現在値 − 先物の現在値」（ベーシス）だけ全体をずらして使う。
値動きの形（向き・BOB EDGE・EMA の傾き）は先物とスポットでほぼ同じ。
価格の節目（前日高安など）は TradingView の値（levels.json）があればそちらを優先する。

使い方: python3 fetch_bars.py <dir>   → <dir>/bars_15m.json bars_1h.json bars_4h.json bars_1D.json
"""
import json, sys, os, urllib.request, subprocess, datetime as dt
from zoneinfo import ZoneInfo

UA = {"User-Agent": "Mozilla/5.0"}
NY = ZoneInfo("America/New_York")

def get_json(url):
    """curl があればそれで（Mac の python.org 版 Python は証明書が無く urllib が失敗するため）。無ければ urllib"""
    try:
        out = subprocess.run(["curl", "-s", "-A", UA["User-Agent"], "--max-time", "30", url], capture_output=True, text=True, timeout=40)
        if out.returncode == 0 and out.stdout.strip(): return json.loads(out.stdout)
    except Exception: pass
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.load(r)

def yahoo(interval, rng):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval={interval}&range={rng}"
    j = get_json(url)
    res = j["chart"]["result"][0]
    ts, q = res["timestamp"], res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(ts):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c): continue
        out.append({"t": int(t), "o": float(o), "h": float(h), "l": float(l), "c": float(c)})
    return out

def day_start_utc(t):
    """Fintokei の1日（NY 17:00 区切り）の開始時刻（UTC 秒）"""
    x = dt.datetime.fromtimestamp(t, dt.timezone.utc).astimezone(NY)
    base = x.replace(hour=17, minute=0, second=0, microsecond=0)
    if x < base: base -= dt.timedelta(days=1)
    return int(base.timestamp())

def aggregate(bars, seconds, anchor):
    """1時間足を、NY 17:00 起点で seconds ごとにまとめる（TradingView の 4h と同じ区切り）"""
    out = {}
    for b in bars:
        d0 = anchor(b["t"])
        k = d0 + ((b["t"] - d0) // seconds) * seconds
        x = out.get(k)
        if not x: out[k] = {"t": k, "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"]}
        else: x["h"] = max(x["h"], b["h"]); x["l"] = min(x["l"], b["l"]); x["c"] = b["c"]
    return [out[k] for k in sorted(out)]

def main(d):
    os.makedirs(d, exist_ok=True)
    m15 = yahoo("15m", "7d"); h1 = yahoo("1h", "60d"); d1 = yahoo("1d", "2y")
    h4 = aggregate(h1, 4 * 3600, day_start_utc)
    for name, bars in (("15m", m15), ("1h", h1), ("4h", h4), ("1D", d1)):
        json.dump({"bars": bars, "source": "yahoo GC=F", "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat()}, open(os.path.join(d, f"bars_{name}.json"), "w"))
        print(name, len(bars), "bars, last close", bars[-1]["c"])

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/asa")
