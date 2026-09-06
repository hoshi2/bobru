# Phase 1 — 朝分析（Morning Brief のリアルタイム化・下ごしらえ）

対象 Issue: [#2 Morning Brief をリアルタイムAI分析化](https://github.com/hoshi2/bobru/issues/2)

このフェーズでは **外部APIには一切つながない**。
つなぐときに画面側を書き換えずに済むよう、取得層と項目・セッション時間の土台だけを先に置く。

---

## 1. やったこと

| | 内容 |
|---|---|
| 取得層 | `marketDataProvider` — 取得先を登録・差し替えできる抽象化層 |
| セッション時間 | 固定UTCではなく IANA タイムゾーンで計算（サマータイム自動追従） |
| 項目 | Issue #2 の必要項目を Morning Brief のデータ構造に追加 |
| UI | 「環境」タブに **朝分析** ボタンと取得先の選択を追加 |
| 方針 | 取得できない項目は推測で埋めず「データなし」（`null`）のまま残す |

手入力の Morning Brief はそのまま残っている。朝分析は**フォームを埋めるだけ**で、
保存はこれまで通り利用者が「環境認識を保存」を押したときにだけ起きる。
＝ 自動分析の結果を**編集してから保存できる**。

---

## 2. marketDataProvider（差し替え口）

`index.html` の Morning Brief セクションの直前。

```js
marketDataProvider.register(name, {
  label,          // 画面のプルダウンに出る名前
  note,           // 補足説明（任意）
  demo,           // true ならサンプル値として警告を出す
  fetch: function(req){ return Promise.resolve(snapshot); }
});
```

### req（アプリ → 取得先）

```js
{
  symbol : "XAUUSD",
  date   : "2026-09-06",
  sessions: [                      // アプリ側がタイムゾーンから算出して渡す
    { key:"asia", label:"アジア", tz:"Asia/Tokyo",
      startISO:"2026-09-06T00:00:00.000Z", endISO:"2026-09-06T06:00:00.000Z",
      offsetMin:540, dst:false },
    …london, newyork
  ]
}
```

**取得側はサマータイムを考えなくてよい。** `startISO`〜`endISO` の高安を集計すれば
それがアジア／ロンドン／ニューヨークのセッション高安になる。

### snapshot（取得先 → アプリ）

`emptyMarketSnapshot()` の形。**取得できなかった項目は必ず `null` のまま返すこと。**

```js
{
  symbol, date, source, asOf, demo,
  price,                                        // 現在価格
  trend:  { daily, h4, h1, m15 },               // "up"|"down"|"range"|"na"|null
  ema:    { tf, e10, e75, e200 },
  levels: { prevHigh, prevLow, weekHigh, weekLow,
            recentHigh, recentLow, supports[], resistances[], zone },
  sessions:{ asia:{high,low}, london:{high,low}, newyork:{high,low} },
  scenarios:{ bull, bear, noTrade },
  bias,                                         // "long"|"short"|"wait"|null
  summary,                                      // 環境認識の要約
  notes: []                                     // 取れなかった理由などの説明文
}
```

`null` は「データなし」として扱われ、**利用者の手入力を上書きしない**。
知らないキーは `mergeSnapshot()` が捨てるので、取得先が余計なものを返しても壊れない。

### 取得層が面倒を見ること

- 60秒のタイムアウト（返ってこない取得先で画面が固まらない）
- `throw` / reject を握って `{ok:false}` に変換（落ちても画面は止まらない）
- 実行中に日付やタブが変わったら、古い結果は破棄して書き込まない

### 同梱の取得先（どちらも通信しない）

| name | label | 中身 |
|---|---|---|
| `none` | 未接続（手入力） | 既定。全項目が「データなし」。セッション時間の計算だけ動く |
| `demo` | デモ（サンプル値・実データではありません） | 配線確認用のダミー。日付ごとに同じ値が出る。**画面に赤い警告が出て、保存時にも確認が入る** |

選んだ取得先は `DB.settings.marketProvider` に残る。

---

## 3. セッション時間（サマータイム対応）

`SESSION_DEFS` に**各市場の壁時計時刻**で持ち、`Intl.DateTimeFormat` から実オフセットを引く。

| key | 市場 | タイムゾーン | 現地時刻 |
|---|---|---|---|
| `asia` | アジア | `Asia/Tokyo` | 09:00–15:00 |
| `london` | ロンドン | `Europe/London` | 08:00–16:30 |
| `newyork` | ニューヨーク | `America/New_York` | 08:00–17:00 |

夏時間の切り替わりはブラウザの tz データが面倒を見るので、こちらは何もしない。
実際に UTC 上の窓がずれることは回帰テスト（グループ8）で固定している。

```
ロンドン 08:00 現地  →  2026-01-15 は 08:00Z / 2026-07-15 は 07:00Z
ニューヨーク 08:00 現地 → 2026-01-15 は 13:00Z / 2026-07-15 は 12:00Z
東京 09:00 現地      →  年間を通じて 00:00Z（夏時間なし）
```

主な関数：

- `tzOffsetMinutes(tz, date)` — その瞬間のオフセット（分・東が正）
- `zonedWallToUtc(tz,y,mo,d,hh,mi)` — 現地の壁時計時刻 → 実際の瞬間。DST境界では引き直す
- `isDstAt(tz, date)` — 1月と7月の小さい方を標準時とみなす（南半球でも動く）
- `sessionWindow(date, def)` / `sessionWindows(date)` — その日のセッション窓
- `sessionLocalRange(w, baseDate)` — 端末の時計に直した表示（日がずれる分は（翌）（前））

窓の終わりが始まり以下になる定義（日をまたぐセッション）は、翌日の現地時刻として解き直す。
`Date.UTC` が日付の桁あふれを正規化するので、DSTをまたいでも正しい。

セッション定義を変えたいときは `SESSION_DEFS` の `start` / `end` を直すだけでよい。

---

## 4. データ構造の変更（すべて加算・後方互換）

`freshBrief()` / `normalizeBrief()` に追加。既存の brief は `normalizeBrief()` が既定値で埋める。

```js
trend:    { daily, h4, h1, m15 }          // ← m15 を追加
price:    { last, asOf }                  // 追加
ema:      { tf, e10, e75, e200 }          // 追加
levels:   { …, recentHigh, recentLow }    // ← 直近高安を追加
sessions: { asia:{high,low}, london:{high,low}, newyork:{high,low} }   // 追加
bias:     ""                              // "long"|"short"|"wait" 追加
analysis: { source, at, demo, notes[] }   // 朝分析の出所。手入力だけなら空のまま
```

`aiSummary` は Phase 0 で器だけ確保してあったものを「環境認識の要約」として使い始めた。

`migrate()` は brief 個々のオブジェクトを素通しするので、**migrate の変更は不要**。
CSV は末尾に `trendM15` と `bias` を追加した（既存列の順は変えていない）。

---

## 5. 画面

「環境」タブの構成：

1. 日付・銘柄
2. **朝分析**（取得先の選択 → 実行 → 取得結果と、その日のセッション時間）
3. 各時間足の方向（日足 / 4H / 1H / **15M**）
4. **現在価格と EMA**（EMA の時間足も選べる）
5. 重要価格（前日・週足・**直近**・主要S/R・注目ゾーン）
6. **セッション別 高値・安値**（窓の時刻を端末時計で併記／夏時間の印）
7. 今日の経済指標・イベント
8. 今日のシナリオ（**今日の見方**＝ロング優勢／ショート優勢／様子見、Bull / Bear / No Trade）
9. **環境認識の要約**・メモ

ホームの要約カードにも「今日の見方」と現在価格が出る。

朝分析を押すと、入力済みの内容がある場合は上書き確認が入る。
取れた項目だけがフォームに入り、**未保存**のまま残る（保存は従来通り利用者が押す）。

---

## 6. 壊していないことの確認

`node tests/run.mjs` — 既存51件に加え、グループ8（サマータイム）・グループ9（朝分析と取得層）を追加して **77 PASS / 0 FAIL**。

追加した確認：

- 東京 / ロンドン / ニューヨークのオフセットが冬夏で正しく変わる
- 切り替え当日（2026-03-29 ロンドン）も現地時刻で解ける
- 端末のタイムゾーンを変えても窓そのものは動かない
- 未接続の朝分析で手入力が消えない・推測値で埋まらない
- 取得先が落ちても・いなくても画面が止まらない
- 取得先にセッション窓が渡る
- 朝分析の結果を編集して保存 → リロードしても残る

---

## 7. 次に必要な作業

### Phase 2 — OHLC の取得先をつなぐ
- 価格・日足/4H/1H/15M の方向・EMA 10/75/200・前日/週足/直近の高安・セッション高安を実データにする
- データ源の選定が先（Bookmap の Add-on API は板と約定が主で、OHLC は別途必要か要検証）
- ブラウザから直接叩けるか（CORS・APIキーの置き場所）が最大の論点。
  単一HTML・localStorage のままキーを持つのは避けたいので、**軽い中継**を挟むかを決める必要がある
- 実装は `marketDataProvider.register("ohlc", {...})` を1つ足すだけで、画面側は触らない

### Phase 3 — Bookmap 由来の項目
- 板の厚い価格帯・大口約定・吸収／流動性反応の候補・出来高／CVD
- snapshot に `depth` / `flow` を足す（`mergeSnapshot()` に数行）。画面はカードを1枚増やす

### Phase 4 — Claude API で分析
- 環境認識の要約・Bull/Bear/NoTrade シナリオ・今日の見方・警戒価格帯を生成
- 取得済みの snapshot を渡して文章を返す取得先として実装する
- APIキーをブラウザに置けないので、ここは中継が必須
- 「AIは売買執行を行わない」「取れない項目は推測で埋めない」をプロンプト側でも明示する

### Phase 5 — 仕上げ
- 目標レスポンス1分以内の計測（取得層のタイムアウトは60秒に置いてある）
- 当日の重要経済指標の自動取得
- 保存済み brief を成長タブの環境別集計に載せる（Phase 0 監査の §9 補足）

### 決めておきたいこと
- セッション定義（現状 東京 09–15 / ロンドン 08–16:30 / NY 08–17）が実運用と合っているか
- 日付の境界。`today()` はローカル日付なので、NY深夜のトレードは翌日の brief に紐付く
- デモ取得先を製品版に残すか（配線確認には便利だが、値は作り物）
