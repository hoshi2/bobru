---
name: asa
description: 朝の環境認識（XAUUSD）。「朝」「/asa」「環境認識を作って」で実行。TradingView から値動きと指標を取り、BOB EDGE の値を計算し、AI の見立て（シナリオ2本＋見送り条件）を書いて briefs/latest.json を GitHub へ送る。ぼぶる が自動で取り込む。
---

# 朝の環境認識（asa）

対象は XAUUSD（TradingView の `OANDA:XAUUSD`）。所要は数分。途中で本人に質問しない。
作業フォルダはこのリポジトリ（`bobru`）のルート。一時ファイルは `/tmp/asa/` に置く（リポジトリには入れない）。

## 1. 取得
足（値動き）はスクリプトが自分で取る（鍵なし。COMEX 金先物 GC=F を、スポットの現在値に合わせてずらして使う）：
```
python3 tools/asa/fetch_bars.py /tmp/asa
```
TradingView MCP からは**数字を数個だけ**写す（symbol は `OANDA:XAUUSD`、summary は付けない）：
- `mcp-tv-get-ohlcv` interval `15m` count 2 → 最後の足の c を `/tmp/asa/spot.json` に `{"price": <c>, "asOf": "<今の時刻 ISO>"}`
- `mcp-tv-get-ohlcv` interval `1D` count 3 → **最後から2番目**の足（＝前日。日足は NY 17:00＝日本時間 6:00 区切り）の h/l を prevHigh/prevLow
- `mcp-tv-get-ohlcv` interval `1W` count 2 → **最後**の足（今週）の h/l を weekHigh/weekLow
  → `/tmp/asa/levels.json` に `{"prevHigh":…,"prevLow":…,"weekHigh":…,"weekLow":…}`
- `mcp-tv-get-economic-calendar`（currencies `USD`、min_importance `0`、date_from・date_to は今日の日本時間 0:00〜翌 0:00 を UTC に直したもの）→ `/tmp/asa/events.json`（返事の JSON をそのまま。`result` 配列の各要素は date・importance・title があればよい）
数字は写し間違いに注意（桁・小数点）。写したら一度読み返す。

## 2. 計算
```
python3 tools/asa/build_brief.py /tmp/asa
```
`/tmp/asa/brief.json` ができる（text.json が無い段階では文章は空）。中身を読む：向き（trend）、EMA、前日・今週・直近の高安、セッション、BOB EDGE（`bobEdge.m15` `.h4`：a 白・b 水色・c 赤・purple 紫5本・spread 広がり・trend 紫の向き・cross 帯の中のクロス）、events。

## 3. 文章を書く（AI の見立て。日本語、短く、数字を根拠に）
`/tmp/asa/text.json` を書く：
```json
{"bias":"long|short|wait",
 "summary":"今日の相場をひとこと（1〜2文）。上位足の向きと、いちばん意識される価格を入れる",
 "scenarios":{
   "bull":"ロング案：どの価格でどう動いたら入るか。SL の目安と、根拠（BOB EDGE の状態を含む）",
   "bear":"ショート案：同上",
   "noTrade":"見送る条件：指標の前後、紫の広がりが小さい（収束中）、上位足と逆、など"},
 "notes":["取れなかったデータや注意があれば"]}
```
書き方の決まり：
- 中長期の目線（日足・4H）→ 意識される価格（前日高安・週足高安・EMA75/200）→ 入りたい場所、の順で考える。
- BOB EDGE の読み方：紫の広がり（spread）が小さい＝収束中＝動く前、広がり始め＝拡散開始＝入る候補。紫の向き（trend）が上なら買い目線、下なら売り目線。水色（b）が 20〜35 の帯で白が上抜け＝順張り買いの形、65〜80 の帯で下抜け＝順張り売りの形。
- 重要度 high の指標があれば、その時刻の前後は新規を避ける旨を noTrade に入れる（時刻は日本時間）。
- 断定しない。「〜なら」「〜を待つ」の形。金額は書かない。

もう一度 `python3 tools/asa/build_brief.py /tmp/asa` を実行して文章入りの `brief.json` にする。

## 4. 保存して送る
```
cp /tmp/asa/brief.json briefs/$(date +%F).json
cp /tmp/asa/brief.json briefs/latest.json
git add briefs && git commit -m "Morning brief $(date +%F)" && git push origin main
```
push できたら、本人には1〜3行で「作成した／見方／指標」だけ伝える（数字の羅列はしない）。

## 5. スクショが添付されていたら
チャートのスクショ（TradingView）が添付されていれば、ライン・意識されるゾーンを読み取り、text.json の scenarios と summary に反映する。数字（前日高安など）はスクショより計算値を優先する。

## 注意
- `briefs/` の中身は公開ページから誰でも読める。口座・残高・取引の記録は絶対に入れない。
- 取得に失敗した項目は null のまま（推測で埋めない）。ぼぶる 側は null を「データなし」として扱い、手入力を消さない。
- 日付は日本時間。ぼぶる は `latest.json` の `date` が今日のときだけ取り込む。
