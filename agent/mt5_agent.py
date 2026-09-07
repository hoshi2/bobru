#!/usr/bin/env python3
"""
ぼぶる MT5 エージェント

常時動いている場所（Windows VPS）の MetaTrader 5 から取引履歴を読み出し、
中継へ送る。ここが唯一 MT5 に触れる場所で、Mac も iPhone も MT5 に触らない。

  取れるもの : 約定（deal）と保有中の建玉。MT5 が持っている事実だけ。
  作らないもの: エントリー根拠・感情・相場観・パターン。一切埋めない。
  一意キー   : deal ticket。建玉は position ID。何度送っても二重にならない。

前提
  - Windows（MetaTrader5 パッケージは Windows 専用）
  - MT5 端末が起動していて、口座にログイン済みであること
  - pip install MetaTrader5 requests

使い方
  python mt5_agent.py --print                  標準出力に JSON（貼り付け取り込み用）
  python mt5_agent.py --once                   1回だけ中継へ送る
  python mt5_agent.py --interval 300           5分ごとに送り続ける
  python mt5_agent.py --days 30 --once         過去30日ぶんを送り直す

環境変数
  BOBRU_RELAY_URL     送り先（例 https://example.com/api/deals）
  BOBRU_RELAY_SECRET  中継と共有する署名鍵。★MT5 のパスワードではない
  MT5_TERMINAL_PATH   端末の実行ファイル（複数入れている場合だけ）

MT5 のログイン情報について
  既定では初期化に口座番号もパスワードも渡さない。すでにログイン済みの端末に
  つなぐだけなので、このスクリプトも設定ファイルもパスワードを持たない。
  無人での再ログインがどうしても必要なときだけ、環境変数
  MT5_LOGIN / MT5_SERVER / MT5_PASSWORD を使う。その場合も必ず
  「投資家パスワード（読み取り専用）」を使うこと。取引パスワードは入れない。
"""

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

STATE_FILE = os.environ.get("BOBRU_STATE_FILE", "bobru_agent_state.json")
DEFAULT_DAYS = 7

DEAL_TYPE = {0: "buy", 1: "sell", 2: "balance", 3: "credit", 4: "charge",
             5: "correction", 6: "bonus", 7: "commission"}
DEAL_ENTRY = {0: "in", 1: "out", 2: "inout", 3: "outby"}


def iso(ts):
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f)
    except Exception as e:
        print("状態ファイルを書けませんでした: %s" % e, file=sys.stderr)


def mt5_connect(mt5):
    """すでにログイン済みの端末につなぐ。パスワードは既定では使わない。"""
    kwargs = {}
    path = os.environ.get("MT5_TERMINAL_PATH")
    if path:
        kwargs["path"] = path
    login = os.environ.get("MT5_LOGIN")
    if login:
        # 無人での再ログインが要る場合だけ。必ず投資家（読み取り専用）パスワードを使う
        kwargs.update(login=int(login),
                      server=os.environ.get("MT5_SERVER", ""),
                      password=os.environ.get("MT5_PASSWORD", ""))
    if not mt5.initialize(**kwargs):
        raise SystemExit("MT5 に接続できません: %s" % (mt5.last_error(),))


def contract_sizes(mt5, symbols):
    out = {}
    for s in symbols:
        if not s:
            continue
        try:
            info = mt5.symbol_info(s)
            if info is not None:
                out[s] = float(info.trade_contract_size)
        except Exception:
            pass
    return out


def order_sl_tp(mt5, order_ticket):
    """約定は SL/TP を持たないので、その注文から拾う。取れなければ None のまま。"""
    if not order_ticket:
        return (None, None)
    try:
        orders = mt5.history_orders_get(ticket=int(order_ticket))
        if orders:
            o = orders[0]
            sl = float(o.sl) or None
            tp = float(o.tp) or None
            return (sl, tp)
    except Exception:
        pass
    return (None, None)


def account_snapshot(acc):
    """口座情報。MT5 が持っている数字だけを、そのまま写す。

    profit は保有中の建玉の含み損益（Floating P/L）。
    margin_level は証拠金維持率（%）で、建玉が無いときは 0 が返るので None にする。
    """
    if acc is None:
        return None
    lvl = float(getattr(acc, "margin_level", 0.0) or 0.0)
    return {
        "login": str(acc.login),
        "server": acc.server,
        "name": acc.name,
        "company": getattr(acc, "company", ""),
        "currency": acc.currency,
        "leverage": int(acc.leverage or 0) or None,
        "balance": float(acc.balance),
        "equity": float(acc.equity),
        "profit": float(acc.profit),                       # 含み損益
        "credit": float(getattr(acc, "credit", 0.0) or 0.0),
        "margin": float(acc.margin),
        "marginFree": float(acc.margin_free),
        "marginLevel": lvl if lvl > 0 else None,
        "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def collect(mt5, days):
    acc = mt5.account_info()
    now = datetime.now(timezone.utc)
    frm = now - timedelta(days=days)
    raw = mt5.history_deals_get(frm, now + timedelta(days=1)) or []

    symbols = {d.symbol for d in raw if d.symbol}
    sizes = contract_sizes(mt5, symbols)
    sl_tp_cache = {}

    deals = []
    for d in raw:
        key = int(d.order or 0)
        if key not in sl_tp_cache:
            sl_tp_cache[key] = order_sl_tp(mt5, key)
        sl, tp = sl_tp_cache[key]
        deals.append({
            "ticket": str(d.ticket),
            "order": str(d.order) if d.order else None,
            "positionId": str(d.position_id) if d.position_id else None,
            "time": iso(d.time),
            "type": DEAL_TYPE.get(d.type, "other"),
            "entry": DEAL_ENTRY.get(d.entry, "other"),
            "symbol": d.symbol or "",
            "volume": float(d.volume),
            "price": float(d.price),
            "profit": float(d.profit),
            "commission": float(d.commission),
            "swap": float(d.swap),
            "fee": float(getattr(d, "fee", 0.0) or 0.0),
            # SL/TP は発注時の値。約定そのものは持っていないので order から引いている
            "sl": sl,
            "tp": tp,
            "contractSize": sizes.get(d.symbol),
            "comment": d.comment or "",
            "magic": int(d.magic or 0),
            "reason": str(d.reason),
        })

    positions = []
    for p in (mt5.positions_get() or []):
        positions.append({
            "positionId": str(p.identifier or p.ticket),
            "symbol": p.symbol,
            "type": "buy" if p.type == 0 else "sell",
            "volume": float(p.volume),
            "priceOpen": float(p.price_open),
            "sl": float(p.sl) or None,
            "tp": float(p.tp) or None,
            "time": iso(p.time),
            "profit": float(p.profit),
            "swap": float(p.swap),
        })

    return {
        "app": "boburu-mt5",
        "version": 1,
        "source": "MT5 エージェント",
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "account": account_snapshot(acc),
        "deals": deals,
        "positions": positions,
        "notes": [],
    }


def post(payload, url, secret):
    import requests

    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ts = str(int(time.time()))
    # 署名は「時刻 + 本文」に対して。時刻も含めるので、盗まれた本文の使い回しが効かない
    sig = hmac.new(secret.encode("utf-8"), ts.encode("utf-8") + b"." + body,
                   hashlib.sha256).hexdigest()
    r = requests.post(url, data=body, timeout=30, headers={
        "Content-Type": "application/json",
        "X-Bobru-Timestamp": ts,
        "X-Bobru-Signature": sig,
    })
    r.raise_for_status()
    return r.json() if r.content else {}


def run_once(args):
    import MetaTrader5 as mt5

    mt5_connect(mt5)
    try:
        payload = collect(mt5, args.days)
    finally:
        mt5.shutdown()

    if args.print:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    url = args.url or os.environ.get("BOBRU_RELAY_URL", "")
    secret = os.environ.get("BOBRU_RELAY_SECRET", "")
    if not url or not secret:
        print("BOBRU_RELAY_URL と BOBRU_RELAY_SECRET を設定して下さい。", file=sys.stderr)
        return 2

    res = post(payload, url, secret)
    state = load_state()
    state["lastSync"] = payload["generatedAt"]
    state["lastCount"] = len(payload["deals"])
    save_state(state)
    print("送信しました: 約定 %d 件 / 建玉 %d 件 %s"
          % (len(payload["deals"]), len(payload["positions"]), res or ""))
    return 0


def main():
    ap = argparse.ArgumentParser(description="ぼぶる MT5 エージェント")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS,
                    help="さかのぼる日数（既定 %d）" % DEFAULT_DAYS)
    ap.add_argument("--url", default="", help="送り先（既定は BOBRU_RELAY_URL）")
    ap.add_argument("--print", action="store_true", help="送らずに JSON を標準出力へ")
    ap.add_argument("--once", action="store_true", help="1回だけ実行して終わる")
    ap.add_argument("--interval", type=int, default=0,
                    help="この秒数ごとに繰り返す（0 なら1回だけ）")
    args = ap.parse_args()

    if args.print or args.once or not args.interval:
        return run_once(args)

    while True:
        try:
            run_once(args)
        except Exception as e:                       # 一度の失敗で止めない
            print("失敗しました（次の回で取り直します）: %s" % e, file=sys.stderr)
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main() or 0)
