# Phase 0 — 既存「ぼぶる」監査レポート

対象コミット: `5062472`（`index.html` 1886行 / 112KB・単一ファイル）
本ドキュメントはコード変更を伴わない現状把握。行番号は上記コミット時点のもの。

---

## 1. 現在のアプリ構造

### ファイル構成
```
index.html          単一HTML（CSS + JS 全部入り・依存ライブラリなし・ビルドなし）
icon-192/512.png    ホーム画面追加用アイコン
apple-touch-icon.png / favicon-32.png
tools/make-icons.py  アイコン生成スクリプト
.nojekyll           GitHub Pages でファイルツリーをそのまま配信
README.md
```

### index.html の内訳
| 行 | 内容 |
|---|---|
| 1–12 | `<head>` メタ（viewport / apple-mobile-web-app / theme-color / icons） |
| 13–269 | `<style>` — CSS変数によるテーマ定義、全コンポーネントのスタイル |
| 271–285 | `<body>` — `#app`（描画先）／`#nav`（下部タブ・静的HTML）／`#toast`／`#modalRoot` |
| 286–1884 | `<script>` — アプリ本体 |

### JS の層構造（286–1884）
| 行 | 役割 |
|---|---|
| 295–304 | `storageAdapter`（保存責務の集約点）、`KEY_DATA` / `KEY_IMG` / `SYNC_PREFIX` |
| 307–419 | 既定データ `defaultSettings` / `defaultRules` / `defaultResearch` / `defaultDB` |
| 421–440 | 汎用ヘルパ（`uid` `now` `today` `isoDate` `toNum` `esc` `fmtMoney` `fmtR` …） |
| 443–447 | グローバル状態 `DB` / `IMG` / `TAB` / `UI` / `_saving` |
| 450–497 | `loadData` / `migrate` / `mergeSettings` / `saveData` / `saveImg` |
| 500–549 | `exportData` / `importData` / `syncData` / `tradesToCSV` |
| 552–604 | コア計算 `currentBalance` / `calcFromInputs` / `calcTrade` |
| 606–696 | 統計 `inPeriod` / `computeStats` / `currentStreak` / `todayPL` |
| 698–723 | `render()`（タブルータ）と `topbar()` |
| 725–803 | ホーム画面 |
| 805–1029 | 計画画面（`PLAN` 状態・フォーム部品・ライブ計算・保存） |
| 1031–1148 | トレード一覧（`tradeCard` / ラベル関数群 / 状態変更アクション） |
| 1150–1216 | 編集モーダル（`EDIT` 状態） |
| 1218–1320 | 決済モーダル（`CLOSE` 状態） |
| 1322–1426 | 成長画面（統計・グラフ・`classTable`） |
| 1428–1561 | ルールブック + 研究 |
| 1563–1685 | 設定・同期・バックアップ・CSV・全削除 |
| 1687–1729 | モーダル / toast / 画像圧縮 |
| 1731–1856 | Canvas 描画（折れ線・棒・スパークライン） |
| 1858–1883 | `applyTheme` / `boot` |

### 描画モデル
- **文字列HTML + 全置換**：`render()` が `TAB` を見て `viewHome/viewPlan/viewTrades/viewGrowth/viewRules/viewSettings` のいずれかを呼び、返ってきた文字列を `app.innerHTML` に一括代入（698–718）。
- **イベントは `onclick` 属性 + `window.*` グローバル関数**。仮想DOMもイベント委譲もない。新機能も同じ流儀に合わせるのが安全。
- 例外的に `render()` の直後だけ命令的初期化が走る：`initPlan()`（入力の live 計算）／`drawGrowthCharts()`／`drawEquitySpark()`（Canvas）。
- モーダルは `#modalRoot` に別途 `innerHTML`。モーダル内の chip 選択状態は再描画せず `refreshModalSegs()` で class をトグルするだけ（入力値を失わないため）。
- 記法は ES5 相当（`var` / `function` / `Array.prototype.forEach.call`）。`const`/アロー/テンプレートリテラルは未使用。

### ナビゲーション
`#nav` は**静的HTML**（274–280）で6ボタン（ホーム/計画/トレード/成長/ルール/設定）。各ボタンは `flex:1`、`boot()`（1874–1876）で `data-tab` を読んで `TAB` を差し替え `render()`。

---

## 2. データ構造

`defaultDB()`（405–419）が唯一の正。

```js
{
  version: 1,
  settings: { … },              // 後述
  accounts: [{id,name,type,initialBalance,created}],   // 現状UIなし・実質未使用
  tradePlans: [ tradeRecord ],  // 下書き（status:"draft"）
  trades:     [ tradeRecord ],  // status: open / closed / cancelled
  rules:      [ ruleFolder ],
  ruleHistory:[ {type,folder,before,after,reason,at} ],
  researchItems: [ research ],
  tags: ["押し目", …],           // 全トレード/研究で使った自由タグの辞書
  syncMetadata: { lastSync, lastExport, deviceCreated }
}
```

`settings`（307–330）:
```
appName, currency, accountName, accountType,
initialBalance(100000), balanceMode("auto"|"manual"), manualBalance,
contractSize(100), internalRiskPct(1), baseLot(1.00), lossStreakWarn(4),
fin:{ dailyLossPct:5, maxLossPct:10, openRiskPct:3,
      step1TargetPct:8, step2TargetPct:6, minTradingDays:3 },
theme("dark"|"light"|"system")
```

### 計算の要点
- `currentBalance()`（552–560）＝ `initialBalance + 決済済みトレードの realizedPL 合計`（manual モード時は手入力値）。
- `calcFromInputs()`（561–592）＝ SL幅・TP幅・予定損失・予定利益・リスク率・RR・推奨ロット。**損益＝価格差 × lot × contractSize** の一本槍（XAUUSD 前提、通貨換算なし）。
- `calcTrade()`（594–604）＝ 上記に加え **実現R = realizedPL / plannedLoss**。予定損失が未確定なら R は出ない。
- `computeStats()`（627–669）＝ n / wins / losses / be / winRate / netPL / netR / avgR / avgWin / avgLoss / pf / maxDD / maxWinStreak / maxLossStreak / ruleRate。`result` 未設定なら損益の符号で補助判定。

---

## 3. localStorage / Sync 構造

| 項目 | 内容 |
|---|---|
| 本体キー | `boburu_v1` — `JSON.stringify(DB)` 丸ごと |
| 画像キー | `boburu_v1_img` — `{ "<tradeId>_entry": dataURL, "<tradeId>_exit": dataURL }` |
| アクセス | `storageAdapter`（299–304）に集約。全 try/catch、失敗しても落ちない |
| 破損時 | `boburu_v1_broken_<timestamp>` に退避 → 新規状態で起動（457–463） |
| 保存契機 | `saveData()` の明示呼び出しのみ。自動保存タイマーなし |
| 同期 | `BOB1.` + base64(UTF-8 JSON) の**丸ごと置換**（515–532）。手動コピペ、サーバーなし |
| バックアップ | `{app:"boburu",version:1,exportedAt,data:DB}` の JSON ファイル |
| CSV | `tradesToCSV()`（533–548）— 30列固定。`DB.trades` のみ（下書きは対象外） |
| 画像 | **同期・バックアップ・CSV いずれの対象外**。端末内のみ。`compressImage()` で長辺1600px / JPEG 0.78 に圧縮 |
| PWA | **service worker も manifest も存在しない**。iOS の `apple-mobile-web-app-capable` メタのみ。オフラインキャッシュ層がないので、HTML を更新すれば再読込でそのまま反映される |

### ⚠ `migrate()` はホワイトリスト方式（468–483）
```js
db.version=1;
db.settings=…; db.accounts=…; db.tradePlans=…; db.trades=…;
db.rules=…; db.ruleHistory=…; db.researchItems=…; db.tags=…; db.syncMetadata=…;
return db;   // ← 知らないキーは "捨てられる"
```
`migrate()` は保存済みJSONを**既知キーだけで組み直す**。`loadData` / `importData` / `syncData("import")` の3経路すべてがここを通る。

**したがって `DB.briefs` を足すだけでは、リロード・復元・同期のたびに Morning Brief が消える。**
Phase 1 の最初の1行は `migrate()` への `db.briefs=Array.isArray(p.briefs)?p.briefs:[];` 追加でなければならない。

一方、**トレード個々のオブジェクトは素通し**（`db.trades=p.trades` をそのまま代入）なので、`trade.briefId` などフィールド追加は migrate 変更なしで永続化される。

---

## 4. Trade 構造

`planToRecord()`（987–1003）で生成され、`saveClose()`（1301–1320）で決済系が埋まる。`tradePlans`（下書き）と `trades` は**同じ形**で、`status` だけが違う（`promoteDraft` が配列間を移すだけ）。

```js
{
  id, status:"draft"|"open"|"closed"|"cancelled",
  createdAt, updatedAt, savedAt,          // createdAt = エントリー日時（ユーザー編集可）

  symbol:"XAUUSD", dir:"long"|"short",

  // 環境・根拠（すべて単一選択の文字列。未選択は ""）
  h4env:    "up"|"down"|"range"|"na",
  m15purple:"conv"|"start"|"expand"|"end"|"na",
  trigger:  "cross"|"red"|"other",
  pattern:  "A"|"B"|"range"|"other",
  sawLower: "yes"|"no",

  // 価格・数量
  entry, sl, tp, lot, balanceAtEntry, contractSize,   // number|null

  memo, tags:[String],

  // 決済系（未決済は null / ""）
  closedAt, closePrice, realizedPL, fee, swap,
  result:"win"|"lose"|"be"|null,
  ruleOk:"yes"|"no"|"partial"|null,
  closeSawLower, emotion:"calm"|"rush"|"anger"|"fear"|"greed"|"tired"|"other"|null,
  reviewMemo, learn
}
```

- 画像は record に入らず `IMG[id+"_entry"] / IMG[id+"_exit"]` に別置き。
- `balanceAtEntry` をトレードに焼き込むので、後から残高が変わっても当時のリスク率・Rが揺れない（重要な設計）。
- **設計書との対応**：`emotion`（感情）と `ruleOk`（実行品質＝ルール通り/一部逸脱/逸脱）は**すでに存在する**。設計書 §7「追加候補」は実質実装済み。ただし `emotion` は単一選択・FOMO/取り返したい/自信過剰の選択肢はない。

---

## 5. Rule / Research 構造

### rules（331–390）
```js
[ { id, name:"基本方針", open:true,
    items:[ {id, text, created} ] },
  …,
  { id, name:"変更履歴", open:false, items:[], isHistory:true }   // 特殊フォルダ
]
```
`isHistory:true` のフォルダだけは `items` を使わず `DB.ruleHistory` を逆順表示する（1433–1447）。

### ruleHistory
`logRuleChange()`（1503）が押す生ログ：
```js
{ type:"add"|"edit"|"delete", folder:<フォルダ名>, before, after, reason, at }
```
編集時は理由の入力欄あり（1487–1502）。設計書 §11 の変更履歴要件は**すでに満たしている**。

### researchItems（392–404, 1506–1561）
```js
{ id, title, hypothesis, target, start,
  status:"研究中"|"正式採用"|"保留"|"却下",
  tags:[String], memo, conclusion, created, updated }
```
`researchCard()` は **`research.tags` と `trade.tags` の交差**で対象トレードを拾い、`computeStats` に流して 対象数/勝率/平均R/PF/純R を出す（1509–1510）。
つまり「仮説 → サンプル数 → 勝率・PF・平均R → 結論」という設計書 §10 のループは**動く形で存在している**。足りないのは Morning Brief 由来の環境条件で絞る手段だけ。

---

## 6. Morning Brief を追加する最小変更案

### 6-1. データ（後方互換・加算のみ）
```js
// defaultDB() に1行
briefs: []

// migrate() に1行（★これが無いと消える）
db.briefs = Array.isArray(p.briefs) ? p.briefs : [];
```

brief 1件の形（設計書 §13 をほぼ踏襲、Phase 1 は手入力のみ）:
```js
{
  id, date:"YYYY-MM-DD",      // today() と同じローカル日付
  symbol:"XAUUSD",
  createdAt, updatedAt,
  trend:{ daily:"", h4:"", h1:"" },        // "up"|"down"|"range"|"na"|""
  levels:{ prevHigh:null, prevLow:null,
           weekHigh:null, weekLow:null,
           supports:[], resistances:[], zone:"" },
  events:[ {time:"21:30", name:"CPI", importance:"high"|"mid"|"low"} ],
  scenarios:{ bull:"", bear:"", noTrade:"" },
  memo:"",
  aiSummary:""                 // Phase 4 用に器だけ確保（Phase 1 では未使用）
}
```
`date + symbol` を一意キーとして扱う（同日同銘柄は上書き編集）。

### 6-2. UI（最小）
1. **タブを1つ増やす**（`#nav` に7個目のボタン、`render()` に1分岐、`viewBrief()` 追加）。
   - `nav button` は `flex:1` なので7個でも崩れないが、iPhone SE 幅（375px）では1枠 ≒ 53px。ラベルは **2文字**（例：「環境」）に収めるのが安全。
2. **ホームに要約カード1枚**：今日の brief があれば「日足↑ / 4H↑ / 1H→」＋重要イベント時刻、無ければ「今日の環境認識はまだ」＋作成ボタン。`viewHome()` の残高カード直下に `h+=` 1行を挿すだけ。
3. 入力部品は**全部既存流用**でよい：`field()` / `chipField()` / `segBtn()` / `card` / `sect-title` / `row2` / `row3`。新規CSSはほぼ不要。

### 6-3. Trade との紐付け（Phase 2 の下準備を Phase 1 で1本だけ入れておく）
`planToRecord()` に `briefId: (todayBrief()||{}).id || null` を足すだけで、以後のトレードは自動で当日 brief に繋がる。**画面もチップも増やさなくてよい**のが利点。

過去トレードは `briefId` が無いままでよい。分析側は
```js
function briefOfTrade(t){
  if(t.briefId) return DB.briefs.filter(b=>b.id===t.briefId)[0] || null;
  var d = localDateOf(t.createdAt);
  return DB.briefs.filter(b=>b.date===d && b.symbol===t.symbol)[0] || null;   // 日付フォールバック
}
```
と**日付フォールバック**で解決すれば、既存データを一切書き換えずに環境別分析に載る。

---

## 7. 既存データとの互換性リスク

| # | リスク | 深刻度 | 対策 |
|---|---|---|---|
| 1 | **`migrate()` のホワイトリストが `briefs` を毎回捨てる** | 致命 | `migrate()` に1行追加。Phase 1 の最優先項目。追加を忘れると「入力できるのに翌日消える」という最悪の壊れ方をする |
| 2 | **同期は丸ごと上書き**。片方の端末が旧HTMLのままだと、そこから出した同期コードで briefs が消える | 高 | GitHub Pages 配信なので両端末とも再読込すれば新版になる（SWキャッシュ無し）。Phase 1 リリース直後は**両端末で1回リロードしてから同期**する運用を README に明記 |
| 3 | `importData()` の妥当性判定（509–512）は `trades`/`rules`/`settings` のいずれかを見る。briefs だけのJSONは弾かれる | 低 | 仕様通りで問題なし。変更不要 |
| 4 | `tradesToCSV()` は30列固定。列を足すと既存の取り込み先とズレる可能性 | 低 | 新列（`briefId` 等）は**必ず末尾に追加**する |
| 5 | `refreshModalSegs()`（1182–1195）が `onclick` 属性を正規表現 `/'([^']+)'\)$/` で解析している | 中 | 編集モーダルに chip を足すときは**引数が2個・末尾が `'値')`** の形を厳守。形を変えると選択状態のトグルが静かに壊れる |
| 6 | `localStorage` 容量。画像は別キーだが同一オリジンの合計枠を共有 | 中 | briefs はテキストのみで軽い。ただし `saveData()` の失敗は toast のみなので、Brief 保存後は保存成否を確認する（`saveData()` の戻り値を見る）とより安全 |
| 7 | **日付の境界**：`today()` はローカル日付。NY時間の深夜トレードは「翌日の brief」に紐付く | 中（要判断） | Phase 1 の既定は「ローカル日付一致」。ズレが問題になる運用なら、Brief に手動で紐付け先を選ぶUIを Phase 2 で足す。**先に決め打ちで作り込まないこと** |
| 8 | `accounts` 配列は実質未使用（UIなし） | 情報 | 触らない。将来の複数口座対応の余地として放置 |
| 9 | グローバル関数名の衝突 | 低 | 新規は `window.saveBrief` `window.briefChipPick` 等、既存に無い名前を使う（`saveEdit`/`saveClose`/`saveResearch` と紛れないこと） |

---

## 8. Phase 1 で変更するファイル・箇所

**変更ファイルは `index.html` の1つだけ**（＋README追記）。

| 箇所 | 行（現状） | 変更内容 | 種別 |
|---|---|---|---|
| `defaultDB()` | 405–419 | `briefs: []` を1行追加 | 加算 |
| `migrate()` | 468–483 | `db.briefs = Array.isArray(p.briefs)?p.briefs:[];` を1行追加 **（最重要）** | 加算 |
| `#nav` | 274–280 | ボタンを1つ追加（`data-tab="brief"`・SVGアイコン・2文字ラベル） | 加算 |
| `render()` | 698–718 | `else if(TAB==="brief") html=viewBrief();` の1分岐 | 加算 |
| 新規関数群 | 1030 付近（計画セクションの前）に新設 | `viewBrief()` / `todayBrief()` / `briefOfTrade()` / `saveBrief()` / `deleteBrief()` / `briefChipPick()` / イベント行の追加削除 | 新規 |
| `viewHome()` | 745 付近（残高カードの直後） | 今日の Brief 要約カード（無ければ作成導線）を `h+=` 1行 | 加算 |
| `planToRecord()` | 987–1003 | `briefId: (todayBrief()||{}).id || null` を1行追加 | 加算 |
| `tradesToCSV()` | 533–548 | 列の**末尾**に `briefId` を追加（任意。Phase 2 でも可） | 加算 |
| CSS | 13–269 | 原則追加なし。必要なら経済指標行用に十数行だけ | ほぼ無 |
| README | — | Brief の説明と、同期時の注意（両端末を先に更新）を追記 | 加算 |

**Phase 1 のスコープ（手入力のみ・外部APIなし）**
日付／銘柄／日足・4H・1H方向／前日高安・週足高安・主要S/R／経済指標（時刻・指標名・重要度）／Bull・Bear・NoTrade シナリオ／メモ。

**Phase 1 完了時の動作確認項目**
1. ブラウザ再読込後も brief が残る（＝migrate の穴が塞がっている）
2. 同期コードを export → import して brief が残る
3. JSONバックアップ → 復元して brief が残る
4. **既存トレード・ルール・研究・グラフ・Fintokeiメーターが全て従来通り**
5. iPhone 幅（375px）で7タブが崩れない・下部ナビに被らない
6. brief 未作成の日でも計画保存・エントリー保存が通る（`briefId:null`）

---

## 9. Phase 1 で触らない箇所

以下は Phase 1 では**一切変更しない**。壊れたときの切り分けを容易にするため。

- `calcFromInputs()` / `calcTrade()` / `currentBalance()` — 損益・R・推奨ロットの計算コア（552–604）
- `computeStats()` / `currentStreak()` / `todayPL()` / `inPeriod()` — 統計（606–696）
- `saveClose()` と決済モーダル一式（1218–1320）
- 編集モーダル `editForm` / `refreshModalSegs`（1150–1216）※ chip を足さない
- ルールブック・研究の一切（1428–1561）
- 設定画面・同期・バックアップの**ロジック**（`syncData` / `exportData` / `importData` 本体）（500–532, 1563–1685）
- Canvas 描画一式（1731–1856）
- テーマ定義とアクセント `#c9a227`、`.card` / `.chip` / `.seg` 等の既存CSS
- 画像まわり（`IMG` / `compressImage` / `pickShot`）
- 成長画面（`viewGrowth` / `classTable`）— 環境別集計の追加は **Phase 3**

### 補足：Phase 3 の一部は Brief を待たずに実装できる
「時間帯別」「曜日別」「Long/Short別」は `createdAt` と `dir` だけで出せるため、既存データのみで `classTable()` に足せる。Morning Brief が必要なのは「環境別（日足↑/4H↑ 等）」だけ。Phase 2 の紐付けが済むまで待つ必要はない。
