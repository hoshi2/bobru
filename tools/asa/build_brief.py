#!/usr/bin/env python3
"""朝の環境認識 JSON（ぼぶる の briefs/latest.json）を組み立てる。

使い方:
  python3 build_brief.py <dir>
  <dir> に以下を置く:
    bars_*.json  … fetch_bars.py が作る（先物 GC=F）。TradingView の返事を写した .csv（t,o,h,l,c）でも可
    spot.json    … {"price": スポット現在値}（TradingView から。これで先物をスポットに合わせる）
    levels.json  … {"prevHigh","prevLow","weekHigh","weekLow"}（TradingView の日足・週足から。任意、あれば優先）
    events.json  … get_economic_calendar の返事（任意）
    text.json    … Claude が書く文章 {bias, summary, scenarios:{bull,bear,noTrade}, notes:[]}
  出力: <dir>/brief.json（ぼぶる がそのまま読める形）

数字の決め方（AI の目安。手入力で上書きできる）:
  向き: 終値 > EMA75 > EMA200 かつ EMA75 が5本前より上 → up、鏡像 → down、それ以外 → range
  前日高安: Fintokei の1日の区切り（ニューヨーク 17:00）で区切った「前の1日」の高安（1時間足から）
  週足高安: 今週（月曜のニューヨーク 17:00 から）の高安。直近高安: 直近24本の1時間足
  セッション高安: 今日の各市場時間のうち、もう過ぎた分だけ（15分足から）。まだなら null
"""
import json, sys, os, datetime as dt
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bob_edge

NY, LDN, JST, UTC = ZoneInfo("America/New_York"), ZoneInfo("Europe/London"), ZoneInfo("Asia/Tokyo"), dt.timezone.utc

def load(d, name):
    p = os.path.join(d, name)
    if not os.path.exists(p): return None
    j = json.load(open(p))
    return j

def load_bars(d, tf):
    """bars_<tf>.csv（t,o,h,l,c の行。古い順でも新しい順でもよい）か bars_<tf>.json（MCP の返事そのまま）"""
    csvp = os.path.join(d, f"bars_{tf}.csv")
    if os.path.exists(csvp):
        out = []
        for line in open(csvp):
            line = line.strip()
            if not line or line.startswith("t"): continue
            t, o, h, l, c = line.split(",")[:5]
            out.append({"t": int(float(t)), "o": float(o), "h": float(h), "l": float(l), "c": float(c)})
        return sorted(out, key=lambda x: x["t"])
    j = load(d, f"bars_{tf}.json")
    if j is None: return []
    b = j.get("bars", j) if isinstance(j, dict) else j
    return sorted(b, key=lambda x: x["t"])

def ema(vals, n):
    k = 2 / (n + 1); e = None
    for v in vals:
        e = v if e is None else v * k + e * (1 - k)
    return e

def trend_of(bars):
    if len(bars) < 210: return "na"
    c = [b["c"] for b in bars]
    e75 = [ema(c[:i + 1], 75) for i in range(len(c) - 6, len(c))]
    e200 = ema(c, 200)
    last, e75n, e75p = c[-1], e75[-1], e75[0]
    if last > e75n > e200 and e75n > e75p: return "up"
    if last < e75n < e200 and e75n < e75p: return "down"
    return "range"

def trading_day(t):
    """Fintokei の1日（NY 17:00 区切り）。その足が属する日の日付（NY 日付、17:00 以降は翌日扱い）"""
    x = dt.datetime.fromtimestamp(t, UTC).astimezone(NY)
    if x.hour >= 17: x = x + dt.timedelta(days=1)
    return x.date()

def hi_lo(bars):
    if not bars: return (None, None)
    return (max(b["h"] for b in bars), min(b["l"] for b in bars))

def main(d):
    b1d, b4h, b1h, b15 = (load_bars(d, n) for n in ("1D", "4h", "1h", "15m"))
    text = load(d, "text.json") or {}
    spot = load(d, "spot.json") or {}          # {"price": スポットの現在値（TradingView）, "asOf": "..."}
    lv = load(d, "levels.json") or {}          # TradingView の節目（あれば優先）{prevHigh,prevLow,weekHigh,weekLow}
    # 先物の足しか無いときは、スポットの現在値との差（ベーシス）だけ全体をずらす
    basis = 0.0
    fut_last = b15[-1]["c"] if b15 else None
    if spot.get("price") and fut_last:
        basis = float(spot["price"]) - fut_last
        for bars in (b1d, b4h, b1h, b15):
            for b in bars:
                for k in ("o", "h", "l", "c"): b[k] = round(b[k] + basis, 3)
    events_j = load(d, "events.json") or {}
    now = dt.datetime.now(UTC)
    today_jst = now.astimezone(JST).date()
    snap = {"symbol": "XAUUSD", "date": today_jst.isoformat(), "source": "claude-code", "asOf": now.replace(microsecond=0).isoformat(),
            "price": None, "trend": {}, "ema": {"tf": "h1"}, "levels": {}, "sessions": {}, "scenarios": {}, "bias": None, "summary": None,
            "events": [], "bobEdge": {}, "notes": []}
    notes = snap["notes"]
    # 価格・向き・EMA（1時間足）
    if spot.get("price"): snap["price"] = float(spot["price"])
    elif b15: snap["price"] = b15[-1]["c"]
    if basis: notes.append(f"足は先物（GC=F）をスポットに合わせて {basis:+.2f} ずらしたもの")
    snap["trend"] = {"daily": trend_of(b1d), "h4": trend_of(b4h), "h1": trend_of(b1h), "m15": trend_of(b15)}
    if b1h:
        c = [b["c"] for b in b1h]
        snap["ema"].update({"e10": round(ema(c, 10), 2), "e75": round(ema(c, 75), 2), "e200": round(ema(c, 200), 2) if len(c) >= 200 else None})
    # 前日・今週・直近の高安
    if b1h:
        td = trading_day(b1h[-1]["t"])
        days = {}
        for b in b1h: days.setdefault(trading_day(b["t"]), []).append(b)
        prev = [dd for dd in sorted(days) if dd < td]
        if prev:
            ph, pl = hi_lo(days[prev[-1]]); snap["levels"]["prevHigh"], snap["levels"]["prevLow"] = ph, pl
        monday = td - dt.timedelta(days=td.weekday())
        wk = [b for dd, bs in days.items() if dd >= monday for b in bs]
        wh, wl = hi_lo(wk); snap["levels"]["weekHigh"], snap["levels"]["weekLow"] = wh, wl
        rh, rl = hi_lo(b1h[-24:]); snap["levels"]["recentHigh"], snap["levels"]["recentLow"] = rh, rl
    for k in ("prevHigh", "prevLow", "weekHigh", "weekLow", "recentHigh", "recentLow"):
        if lv.get(k) is not None: snap["levels"][k] = float(lv[k])
    # セッション高安（今日、もう過ぎた分）
    if b15:
        def window(tz, sh, sm, eh, em):
            base = now.astimezone(tz).date()
            s_ = dt.datetime.combine(base, dt.time(sh, sm), tz); e_ = dt.datetime.combine(base, dt.time(eh, em), tz)
            if e_ <= s_: e_ += dt.timedelta(days=1)
            bs = [b for b in b15 if s_.timestamp() <= b["t"] < min(e_, now).timestamp()]
            return {"high": hi_lo(bs)[0], "low": hi_lo(bs)[1]}
        snap["sessions"] = {"asia": window(JST, 9, 0, 15, 0), "london": window(LDN, 8, 0, 16, 30), "newyork": window(NY, 8, 0, 17, 0)}
    # BOB EDGE（最後の足は未確定なので落とす）
    for key, bars in (("m15", b15), ("h4", b4h)):
        if bars:
            r = bob_edge.compute(bars[:-1])
            if "error" in r: notes.append(f"BOB EDGE {key}: {r['error']}")
            else: snap["bobEdge"][key] = r
    # 経済指標（日本時間の時刻に直す）
    imp = {1: "high", 0: "mid", -1: "low"}
    for e in (events_j.get("result") or []):
        try:
            t = dt.datetime.fromisoformat(e["date"].replace("Z", "+00:00")).astimezone(JST)
            snap["events"].append({"time": t.strftime("%H:%M"), "name": e.get("title") or e.get("indicator") or "", "importance": imp.get(e.get("importance"), "mid")})
        except Exception: pass
    snap["events"].sort(key=lambda x: x["time"])
    # 文章（Claude が書く）
    snap["bias"] = text.get("bias"); snap["summary"] = text.get("summary")
    snap["scenarios"] = {k: (text.get("scenarios") or {}).get(k) for k in ("bull", "bear", "noTrade")}
    notes.extend(text.get("notes") or [])
    out = os.path.join(d, "brief.json")
    json.dump(snap, open(out, "w"), ensure_ascii=False, indent=1)
    print(out)

if __name__ == "__main__":
    main(sys.argv[1])
