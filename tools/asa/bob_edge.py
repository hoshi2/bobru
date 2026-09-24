#!/usr/bin/env python3
"""BOB EDGE v1.8 の線を、TradingView と同じ式で計算する（確定足のみ）。

入力: bars = [{t,o,h,l,c}, ...]（古い順）。最後の足が未確定なら呼ぶ側で落とす。
出力: {a,b,c,purple:[r1..r5],spread,slope,trend,cross}（値は最後の確定足）。

Pine の式:
  f_d(len) = sma(sma(stoch(close,high,low,len), 3), max(1, round(len*0.6)))
  a=5, b=15, c=38, 紫=80,92,107,132,160
  pAvg = 紫5本の平均, slope = pAvg - pAvg[5], up: slope>2, down: slope<-2
  spread = max(紫) - min(紫)
"""
import json, sys, math

A_LEN, B_LEN, C_LEN = 5, 15, 38
PURPLE = [80, 92, 107, 132, 160]
SMK, TREND_LB, DEAD = 3, 5, 2.0
LO_BAND, HI_BAND = (20, 35), (65, 80)

def stoch(c, h, l, n):
    out = [None] * len(c)
    for i in range(n - 1, len(c)):
        hh = max(h[i - n + 1:i + 1]); ll = min(l[i - n + 1:i + 1])
        out[i] = 100.0 * (c[i] - ll) / (hh - ll) if hh != ll else 50.0
    return out

def sma(x, n):
    out = [None] * len(x)
    for i in range(len(x)):
        w = x[i - n + 1:i + 1] if i >= n - 1 else None
        if w is None or any(v is None for v in w): continue
        out[i] = sum(w) / n
    return out

def f_d(c, h, l, n):
    return sma(sma(stoch(c, h, l, n), SMK), max(1, round(n * 0.6)))

def compute(bars):
    c = [b["c"] for b in bars]; h = [b["h"] for b in bars]; l = [b["l"] for b in bars]
    need = max(PURPLE) + round(max(PURPLE) * 0.6) + SMK + TREND_LB + 2   # 266本
    if len(bars) < need:
        return {"error": f"bars too few: {len(bars)} < {need}"}
    aD, bD, cD = f_d(c, h, l, A_LEN), f_d(c, h, l, B_LEN), f_d(c, h, l, C_LEN)
    R = [f_d(c, h, l, n) for n in PURPLE]
    i = len(bars) - 1
    purple = [r[i] for r in R]
    pavg = [sum(r[k] for r in R) / 5 if all(r[k] is not None for r in R) else None for k in range(len(bars))]
    slope = pavg[i] - pavg[i - TREND_LB]
    trend = "up" if slope > DEAD else ("down" if slope < -DEAD else "flat")
    # 帯の中の ab クロス（最後の確定足で起きたか）
    cross = None
    if aD[i - 1] is not None and bD[i - 1] is not None:
        up = aD[i - 1] <= bD[i - 1] and aD[i] > bD[i]
        dn = aD[i - 1] >= bD[i - 1] and aD[i] < bD[i]
        if up and LO_BAND[0] <= bD[i] <= LO_BAND[1]: cross = "buy_trend" if trend == "up" else "buy_counter"
        if dn and HI_BAND[0] <= bD[i] <= HI_BAND[1]: cross = "sell_trend" if trend == "down" else "sell_counter"
    r = lambda v: None if v is None else round(v, 1)
    return {"a": r(aD[i]), "b": r(bD[i]), "c": r(cD[i]), "purple": [r(v) for v in purple],
            "spread": r(max(purple) - min(purple)), "slope": r(slope), "trend": trend, "cross": cross,
            "bar_t": bars[i]["t"]}

if __name__ == "__main__":
    bars = json.load(open(sys.argv[1]))
    bars = bars.get("bars", bars)
    if len(sys.argv) > 2 and sys.argv[2] == "--drop-last":   # 最後の足は未確定
        bars = bars[:-1]
    print(json.dumps(compute(bars), ensure_ascii=False))
