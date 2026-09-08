# MT5 エージェントと中継

MacがOFFでも、スリープでも、MT5を開いていなくても、iPhoneだけで朝が終わる形にするための2つの部品。

```
[Windows VPS]                     [中継]                    [iPhone / PC]
 MT5端末（ログイン済み）             Cloudflare Workers        ぼぶる（index.html）
   └ mt5_agent.py  ──POST署名──▶  /api/deals  ──GET──▶  取引同期
                                  /api/ohlc   ──GET──▶  朝分析
                                     ▲
                             市場データ業者（APIキーはここだけ）
```

**MT5 のログイン情報は VPS から一歩も出ない。** 中継にもぼぶるにも渡らないし、置く場所も無い。

---

## 1. 何がどこに置かれるか

| 秘密 | 置く場所 | 置かない場所 |
|---|---|---|
| MT5 の取引パスワード | **どこにも置かない**（端末に手でログイン済みにしておく） | VPS の設定ファイル・中継・ぼぶる |
| MT5 の投資家パスワード（読み取り専用） | 無人再ログインが要るときだけ VPS の環境変数 | 中継・ぼぶる・Git |
| エージェント↔中継の署名鍵 | VPS の環境変数 と 中継の secret | ぼぶる・Git |
| ぼぶるの読み取りトークン | 中継の secret と 端末の設定欄 | Git |
| 市場データ業者の APIキー | 中継の secret | ぼぶる・VPS・Git |

`mt5_agent.py` は既定で `mt5.initialize()` に口座番号もパスワードも渡さない。
**すでにログインしている端末につなぐだけ**なので、パスワードを持たずに履歴が読める。これが一番安全。

どうしても無人での再ログインが要るなら `MT5_LOGIN` / `MT5_SERVER` / `MT5_PASSWORD` を使うが、
そのときも**必ず投資家パスワード（読み取り専用）**にする。取引パスワードは入れない。
投資家パスワードなら、鍵が漏れても他人に発注はできない。

---

## 2. VPS

MetaTrader5 の Python パッケージは **Windows 専用**なので、Windows VPS が要る。

| 案 | 中身 | 費用の目安 | 備考 |
|---|---|---|---|
| **A. 業者やプロップの無料VPS** | Fintokei / ブローカー提供の VPS | 条件つきで無料 | まずここを確認する。取引用途なので回線が近い |
| **B. Windows VPS（推奨）** | Vultr / Contabo / ForexVPS 等の Windows 2GB〜 | 月10〜20ドル | 好きに入れられる。以下はこれ前提 |
| C. 自宅の常時起動Windows | ミニPC | 電気代のみ | 回線とUPSの面倒を自分で見る |
| D. Linux + Wine | 動くが壊れやすい | 安い | 端末の更新で止まることがある。おすすめしない |

やること（1回だけ）

1. Windows VPS を建てる。自動更新の再起動時刻を取引時間から外す
2. MT5 をインストールし、Fintokei 口座にログインして「アカウント情報を保存」
3. `python -m pip install MetaTrader5 requests`
4. `mt5_agent.py` を置き、環境変数を入れる（システム環境変数。スクリプトには書かない）
   ```
   setx BOBRU_RELAY_URL    "https://<中継>/api/deals"
   setx BOBRU_RELAY_SECRET "<32バイト以上のランダム文字列>"
   ```
5. タスクスケジューラで5分ごとに `python mt5_agent.py --once` を実行する
   （常駐させたいなら `python mt5_agent.py --interval 300`）
6. RDP は既定ポートのままにせず、接続元IPを絞る。VPS のログインは2段階にする

MT5 端末は起動したままにしておく。落ちても、次の実行で取り直すだけなので履歴は欠けない
（`--days` の窓のぶんを毎回まるごと送り、中継とぼぶるが deal ticket で重複を落とす）。

---

## 3. 中継

`relay/worker.js` は Cloudflare Workers + KV の参照実装。無料枠で足りる。
VPS 上に小さな API を立ててもよいが、Workers なら VPS を外に公開せずに済む。

```
npm i -g wrangler
wrangler kv namespace create STORE          # 出た id を wrangler.toml に書く
wrangler secret put AGENT_SECRET            # VPS の BOBRU_RELAY_SECRET と同じ値
wrangler secret put READ_TOKEN              # ぼぶるに入れる読み取りトークン
wrangler secret put MARKET_API_KEY          # 市場データ業者のAPIキー（朝分析を使うなら）
wrangler deploy
```

`wrangler.toml` の `ALLOW_ORIGIN` を、ぼぶるを置いてある URL に直す。

| 口 | 誰が使う | 守り |
|---|---|---|
| `POST /api/deals` | VPS のエージェント | HMAC-SHA256 署名 ＋ 5分の時刻窓（本文の使い回しが効かない） |
| `GET /api/deals` | ぼぶる | `Authorization: Bearer <READ_TOKEN>` |
| `GET /api/ohlc` | ぼぶる | 同上。業者のAPIキーは中継の外に出ない |
| `GET /api/bars` | ぼぶる | 同上。MAE / MFE 用に区間を指定して細かい足を返す |

読み取りトークンは端末の `localStorage` に入る。**取引はできず、履歴が読めるだけ**のトークンにしてある。
端末を無くしたら `wrangler secret put READ_TOKEN` で入れ直せば、その場で無効になる。

---

### 1分足が取れるか確かめる（MAE / MFE の前に）

ぼぶるは MAE / MFE を **1分足で計算し、取れなければ 15分足に落として「15分足ベース推定値」と明記**する。
どちらになるかは業者と契約で変わるので、デプロイ後に一度だけ確かめる。

```
curl -H "Authorization: Bearer <READ_TOKEN>" \
  "https://<中継>/api/bars?symbol=XAUUSD&interval=1min&start=2026-09-01T10:00:00Z&end=2026-09-01T11:00:00Z"
```

- `bars` が 60本前後返れば 1分足が使える
- `bars` が空で `notes` に業者のメッセージが入るなら、その契約では 1分足が無い（15分足に落ちる）
- 本数が保有時間の半分に満たないときも、ぼぶるは信用せず 15分足に落とす

Twelve Data の無料枠は 1分足を返すが、**さかのぼれる期間と 1分あたりの回数に上限**がある
（1回 5000本、8回/分）。ぼぶるは1トレードにつき 1〜2 回叩き、まとめて計算するときは 8秒ずつ間を空ける。

## 4. ぼぶる側の設定

設定タブで入れる。

- **朝分析の中継** — 取得URL `https://<中継>/api/ohlc`、読み取りトークン
- **MT5 取引同期** — 取得先「中継（VPS のエージェント）」、取得URL `https://<中継>/api/deals`、読み取りトークン

そのあと、環境タブの「データ取得先」で **中継（OHLC）** を選ぶ。

---

## 5. 中継を建てる前に試す

VPS も中継も無しで、取り込みの形だけ先に確かめられる。

```
python mt5_agent.py --print > deals.json
```

出た JSON を、ぼぶるの 環境タブ →「取引同期」→ 取得先「貼り付け（エージェントの JSON）」に貼って実行する。
同じものを何度貼っても、deal ticket が一意キーなので二重には入らない。

---

## 6. 取れるもの / 取れないもの

`mt5_agent.py` が送るのは MT5 が持っている事実だけ。

**取れる（約定）** — symbol / buy・sell / エントリー時刻・価格 / 決済時刻・価格 / lot /
profit / commission / swap / order ticket / deal ticket / position ID / SL / TP / 契約サイズ

**取れる（口座）** — 口座番号 / サーバ / 業者 / 口座通貨 / レバレッジ /
Balance / Equity / Floating P/L / Credit / Margin / Free Margin / 証拠金維持率

当日実現損益・前日比・ドローダウン・Fintokei の残り許容額は、
この口座情報と約定からぼぶる側で計算する（人間は入力しない）。

**取れない（作らない）** — エントリー根拠 / 感情 / 相場観 / パターン / ルール遵守度 /
エントリー時の口座残高

SL・TP には注意がある。約定（deal）は SL/TP を持たないので、

- 決済済みの建玉 … **発注時の値**（注文から引いている）。途中で動かしても、動かしたあとの値は履歴に残らない
- 保有中の建玉 … 建玉スナップショットの**いまの値**

ぼぶるは、スナップショットが取れた回だけ SL/TP を更新する。取れない回に発注時の値へ巻き戻ることはない。

ドテン（1つの約定で決済と新規建てが同時に起きるもの）は正確に割れないので、
**約定は保存するがトレード記録は作らない**。取り込み結果にその件数が出る。
