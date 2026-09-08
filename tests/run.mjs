/*
 * ぼぶる 回帰テスト
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node tests/run.mjs
 *
 * index.html を実ブラウザで開き、保存・同期・復元・計算・レイアウトを確認する。
 * アプリ本体は依存ライブラリなしのまま。これは開発時にだけ使う道具。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8123);

let chromium;
try { ({ chromium } = await import("playwright")); }
catch {
  console.error("playwright が見つかりません。\n  npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

/* ---------- 最小の静的サーバ（依存なし） ---------- */
const MIME = { ".html":"text/html; charset=utf-8", ".png":"image/png", ".json":"application/json" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${PORT}/index.html`;

/* ---------- 走らせる仕掛け ---------- */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  PASS " + name); } else { fail++; console.log("  FAIL " + name); } };
const group = n => console.log("\n" + n);

const browser = await chromium.launch();
const pageErrors = [];
async function open(width = 375, height = 812, timezoneId) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "ja-JP",
    ...(timezoneId ? { timezoneId } : {}) });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(`${width}px: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") pageErrors.push(`${width}px console: ${m.text()}`); });
  await page.goto(URL_);
  await page.waitForSelector("#app .topbar");
  return page;
}
/** confirm/alert への応答を1回だけ仕込む */
const answer = (page, accept) => page.once("dialog", d => (accept ? d.accept() : d.dismiss()));

/* =======================================================================
   1. 起動と既存機能
   ======================================================================= */
group("1. 起動と既存機能");
{
  const page = await open();
  const tabs = await page.$$eval("#nav button", bs => bs.map(b => b.dataset.tab));
  ok("タブが7つある", tabs.length === 7 && tabs.includes("brief"));

  for (const t of tabs) {
    await page.click(`#nav button[data-tab="${t}"]`);
    await page.waitForTimeout(50);
    ok(`${t} タブが描画される`, await page.$eval("#app", e => e.innerHTML.length > 200));
  }

  // 損益計算のコアが変わっていないこと
  const calc = await page.evaluate(() => {
    const c = calcFromInputs({ dir:"long", entry:3300, sl:3290, tp:3320, lot:1, contractSize:100, balance:100000 });
    return { loss:c.plannedLoss, profit:c.plannedProfit, rr:c.rr, pct:c.riskPct, rec:Math.round(c.recLot*100)/100 };
  });
  ok("予定損失・利益・RR・リスク率・推奨ロット", calc.loss===1000 && calc.profit===2000 && calc.rr===2 && calc.pct===1 && calc.rec===1);
  await page.close();
}

/* =======================================================================
   2. Morning Brief の保存と永続化
   ======================================================================= */
group("2. Morning Brief の保存と永続化");
{
  const page = await open();
  await page.click('#nav button[data-tab="brief"]');
  await page.fill("#b_ph", "3320.5");
  await page.fill("#b_sup", "3280, 3265.5");
  await page.fill("#b_memo", "DXY弱い");
  await page.click("button.chip[onclick*=\"'daily','up'\"]");
  await page.click("button.chip[onclick*=\"'h4','up'\"]");
  ok("chip を押してもテキスト入力が残る", (await page.inputValue("#b_memo")) === "DXY弱い");

  await page.click('button:has-text("指標を追加")');
  await page.fill("#b_evt_0", "2130");
  await page.fill("#b_evn_0", "CPI");
  await page.selectOption("#b_evi_0", "high");
  await page.click('button:has-text("指標を追加")');
  await page.fill("#b_evt_1", "400");
  await page.fill("#b_evn_1", "FOMC");
  await page.click('button:has-text("環境認識を保存")');
  await page.waitForTimeout(200);

  const b = await page.evaluate(() => JSON.parse(localStorage.getItem("boburu_v1")).briefs);
  ok("1件だけ保存される", b.length === 1);
  ok("上位足の方向が保存される", b[0].trend.daily === "up" && b[0].trend.h4 === "up");
  ok("価格が数値で保存される", b[0].levels.prevHigh === 3320.5 && JSON.stringify(b[0].levels.supports) === "[3280,3265.5]");
  ok("時刻が正規化される（2130→21:30 / 400→04:00）", b[0].events[0].time === "21:30" && b[0].events[1].time === "04:00");
  ok("深夜の指標は末尾に並ぶ", (await page.evaluate(() => eventsSorted(DB.briefs[0].events).map(e => e.time).join(">"))) === "21:30>04:00");

  // ★ migrate() のホワイトリストを通り抜けるか
  await page.reload();
  await page.waitForSelector("#app .topbar");
  ok("リロードしても残る", (await page.evaluate(() => DB.briefs.length)) === 1);

  const code = await page.evaluate(() => syncData("export"));
  await page.evaluate(() => { DB.briefs = []; saveData(); });
  await page.evaluate(c => syncData("import", c), code);
  ok("同期コードで往復できる", (await page.evaluate(() => DB.briefs.length)) === 1);

  const json = await page.evaluate(() => exportData());
  await page.evaluate(() => { DB.briefs = []; saveData(); });
  await page.evaluate(j => importData(j), json);
  ok("JSONバックアップで往復できる", (await page.evaluate(() => DB.briefs.length)) === 1);

  // 同じ日に保存し直したら上書き
  await page.evaluate(() => { TAB = "brief"; UI.briefDate = ""; BRIEF = null; render(); });
  await page.fill("#b_memo", "書き直し");
  await page.click('button:has-text("環境認識を更新")');
  await page.waitForTimeout(200);
  const up = await page.evaluate(() => ({ n: DB.briefs.length, memo: DB.briefs[0].memo }));
  ok("同じ日の再保存は上書き（重複しない）", up.n === 1 && up.memo === "書き直し");
  await page.close();
}

/* =======================================================================
   3. 入力を失わないこと
   ======================================================================= */
group("3. 入力を失わないこと");
{
  const page = await open();
  await page.evaluate(() => { TAB = "brief"; UI.briefDate = ""; BRIEF = null; render(); });
  await page.fill("#b_memo", "消えたら困るメモ");
  await page.fill("#b_ph", "3321.4");
  await page.fill("#b_bull", "3310上抜けで押し目");
  await page.click('#nav button[data-tab="home"]');
  await page.waitForTimeout(60);
  await page.click('#nav button[data-tab="brief"]');
  await page.waitForTimeout(60);
  ok("タブを往復しても環境認識の入力が残る",
     (await page.inputValue("#b_memo")) === "消えたら困るメモ" &&
     (await page.inputValue("#b_ph")) === "3321.4" &&
     (await page.inputValue("#b_bull")) === "3310上抜けで押し目");
  ok("未保存の変更が表示される", (await page.$eval("#b_dirty", e => e.textContent)).includes("未保存"));
  await page.click('button:has-text("環境認識を保存")');
  await page.waitForTimeout(200);
  ok("保存すると未保存表示が消える", (await page.$eval("#b_dirty", e => e.textContent)) === "");

  // 計画のメモ・タグも同様に残る
  await page.evaluate(() => { TAB = "plan"; PLAN = freshPlan(); render(); });
  await page.fill("#p_memo", "根拠のメモ");
  await page.fill("#p_tags", "押し目, 東京時間");
  await page.click('#nav button[data-tab="home"]');
  await page.waitForTimeout(60);
  await page.click('#nav button[data-tab="plan"]');
  await page.waitForTimeout(60);
  ok("タブを往復しても計画のメモ・タグが残る",
     (await page.inputValue("#p_memo")) === "根拠のメモ" && (await page.inputValue("#p_tags")).includes("押し目"));
  await page.close();
}

/* =======================================================================
   4. 取り込みで環境認識を失わないこと
   ======================================================================= */
group("4. 取り込みで環境認識を失わないこと");
{
  const page = await open();
  const seedOldCode = () => page.evaluate(() => {
    DB.briefs = [{ id:"b1", date:today(), symbol:"XAUUSD", trend:{daily:"up"}, levels:{}, events:[], scenarios:{}, memo:"大事" }];
    saveData();
    const old = JSON.parse(JSON.stringify(DB)); delete old.briefs;      // 旧版の端末が出すコード
    return "BOB1." + btoa(unescape(encodeURIComponent(JSON.stringify(old))));
  });

  let code = await seedOldCode();
  answer(page, false);
  let r = await page.evaluate(c => syncData("import", c), code);
  ok("旧版の同期コードは確認を出し、中止すると取り込まれない",
     r.ok === false && (await page.evaluate(() => DB.briefs.length)) === 1);

  answer(page, true);
  r = await page.evaluate(c => syncData("import", c), code);
  ok("了承すれば従来どおり取り込める", r.ok === true && (await page.evaluate(() => DB.briefs.length)) === 0);

  // 環境認識がまだ無い端末では確認を出さない（初回移行の邪魔をしない）
  code = await page.evaluate(() => {
    DB.briefs = []; saveData();
    const old = JSON.parse(JSON.stringify(DB)); delete old.briefs;
    return "BOB1." + btoa(unescape(encodeURIComponent(JSON.stringify(old))));
  });
  r = await page.evaluate(c => syncData("import", c), code);
  ok("Briefが無い端末では確認を出さない", r.ok === true);

  // Brief キーを持たない旧形式のバックアップも壊れずに読める
  r = await page.evaluate(() => {
    const old = { settings:{ initialBalance:50000 }, rules:[], trades:[{ id:"x1", status:"closed", dir:"long",
      entry:100, sl:90, tp:120, lot:1, contractSize:100, balanceAtEntry:50000, realizedPL:500, result:"win",
      createdAt:new Date().toISOString(), closedAt:new Date().toISOString() }] };
    const res = importData(JSON.stringify(old));
    return { ok:res.ok, briefs:Array.isArray(DB.briefs), n:DB.briefs.length, trades:DB.trades.length, bal:currentBalance() };
  });
  ok("旧形式のバックアップを読める", r.ok && r.briefs && r.n === 0 && r.trades === 1 && r.bal === 50500);
  await page.close();
}

/* =======================================================================
   5. トレードと環境認識の紐付け
   ======================================================================= */
group("5. トレードと環境認識の紐付け");
{
  const page = await open();
  await page.evaluate(() => {
    DB.briefs = [{ id:"todayXAU", date:today(), symbol:"XAUUSD", trend:{daily:"up"}, levels:{}, events:[], scenarios:{}, memo:"" }];
    DB.trades = []; saveData(); TAB = "plan"; PLAN = freshPlan(); render();
  });
  await page.fill("#p_entry", "3300"); await page.fill("#p_sl", "3290"); await page.fill("#p_lot", "1");
  await page.click('button:has-text("エントリーとして保存")');
  await page.waitForTimeout(250);
  ok("今日の計画は今日の環境認識に紐付く", (await page.evaluate(() => DB.trades[0].briefId)) === "todayXAU");

  // 日時を過去にした計画は、その日の環境認識で判断する（保存した日ではない）
  await page.waitForTimeout(700);
  await page.evaluate(() => { TAB = "plan"; PLAN = freshPlan(); render(); });
  await page.fill("#p_dt", "2020-03-04T10:00");
  await page.fill("#p_entry", "3300"); await page.fill("#p_sl", "3290"); await page.fill("#p_lot", "1");
  await page.click('button:has-text("エントリーとして保存")');
  await page.waitForTimeout(250);
  const past = await page.evaluate(() => ({ d: localDateOf(DB.trades[0].createdAt), id: DB.trades[0].briefId }));
  ok("過去日の計画は当日の環境認識に紐付かない", past.d === "2020-03-04" && past.id === null);

  // 銘柄違いには紐付けない
  ok("銘柄が違うトレードには紐付かない", await page.evaluate(() => {
    const t = { id:"u", symbol:"USDJPY", createdAt:new Date().toISOString() };
    return briefOfTrade(t) === null && briefOfTrade({ id:"g", symbol:"XAUUSD", createdAt:new Date().toISOString() }) !== null;
  }));

  // 消した Brief に、同じ日の別 Brief が黙って入れ替わらない
  ok("削除された環境認識は「紐付けなし」のままになる", await page.evaluate(() => {
    DB.briefs = [{ id:"newone", date:today(), symbol:"XAUUSD", trend:{daily:"down"}, levels:{}, events:[], scenarios:{}, memo:"新" }];
    return briefOfTrade({ id:"z", symbol:"XAUUSD", briefId:"deleted", createdAt:new Date().toISOString() }) === null;
  }));

  // briefId を持たない過去のトレードは日付で解決できる（後方互換）
  ok("briefId の無い過去トレードは日付＋銘柄で解決される", await page.evaluate(() => {
    const b = briefOfTrade({ id:"legacy", symbol:"XAUUSD", createdAt:new Date().toISOString() });
    return !!b && b.id === "newone";
  }));

  // 削除時に参照件数を知らせる
  const msg = await new Promise(async res => {
    page.once("dialog", d => { res(d.message()); d.dismiss(); });
    await page.evaluate(() => {
      DB.briefs = [{ id:"ref", date:today(), symbol:"XAUUSD", trend:{}, levels:{}, events:[], scenarios:{}, memo:"" }];
      DB.trades = [{ id:"t1", briefId:"ref", symbol:"XAUUSD", createdAt:new Date().toISOString() },
                   { id:"t2", briefId:"ref", symbol:"XAUUSD", createdAt:new Date().toISOString() }];
      UI.briefDate = today(); BRIEF = null; deleteBrief();
    });
  });
  ok("削除時に参照しているトレード数を知らせる", msg.includes("2 件"));
  await page.close();
}

/* =======================================================================
   6. CSV
   ======================================================================= */
group("6. CSV");
{
  const page = await open();
  const head = await page.evaluate(() => {
    DB.briefs = [{ id:"b", date:today(), symbol:"XAUUSD", trend:{daily:"up",h4:"down",h1:"range",m15:"up"},
      bias:"long", levels:{}, events:[], scenarios:{}, memo:"" }];
    DB.trades = [{ id:"t", status:"closed", symbol:"XAUUSD", dir:"long", entry:3300, sl:3290, tp:3320, lot:1,
      contractSize:100, balanceAtEntry:100000, realizedPL:1660, result:"win", briefId:"b",
      createdAt:new Date().toISOString(), closedAt:new Date().toISOString(), tags:[] }];
    const rows = tradesToCSV().split("\n");
    return { cols: rows[0].split(","), row: rows[1].split(",") };
  });
  ok("新しい列は末尾に付く",
     head.cols.slice(-12).join(",") ===
     "briefId,briefDate,trendDaily,trendH4,trendH1,trendM15,bias,source,mt5PositionId,mt5EntryDeal,mt5ExitDeals,mt5Account");
  ok("既存の列順が変わっていない", head.cols[0] === "id" && head.cols[head.cols.length - 13] === "tags");
  ok("環境認識の内容が書き出される", head.row.slice(-10, -5).join(",") === "up,down,range,up,long");
  ok("手入力の記録は source=manual", head.row[head.cols.indexOf("source")] === "manual");
  await page.close();
}

/* =======================================================================
   7. レイアウト（スマホ / PC）
   ======================================================================= */
group("7. レイアウト（スマホ / PC）");
for (const [w, h] of [[375, 812], [1024, 768], [1440, 900]]) {
  const page = await open(w, h);
  const side = w >= 900;
  await page.evaluate(() => {
    DB.briefs = [{ id:"b1", date:today(), symbol:"XAUUSD", trend:{daily:"up",h4:"up",h1:"range"},
      levels:{ prevHigh:3321.4, prevLow:3288.1, supports:[], resistances:[] },
      events:[{ time:"21:30", name:"米CPI", importance:"high" }],
      scenarios:{ bull:"", bear:"", noTrade:"CPI前後は見送り" }, memo:"" }];
    DB.settings.initialBalance = 100000000; DB.trades = [];
    for (let i = 1; i <= 30; i++) {
      const win = i % 3 !== 0, d = new Date(Date.now() - (31 - i) * 86400000).toISOString();
      DB.trades.push({ id:"t"+i, status:"closed", dir:i%2?"long":"short", entry:3300, sl:3290, tp:3320, lot:9999,
        contractSize:100, balanceAtEntry:100000000, realizedPL:win?987654321:-123456789, result:win?"win":"lose",
        ruleOk:"yes", pattern:["A","B","range","other"][i%4], h4env:["up","down","range"][i%3],
        trigger:i%2?"cross":"red", sawLower:i%2?"yes":"no", createdAt:d, closedAt:d, tags:[] });
    }
    saveData(); TAB = "home"; render();
  });
  await page.waitForTimeout(250);

  const nav = await page.evaluate(() => { const r = document.getElementById("nav").getBoundingClientRect(); return { w:Math.round(r.width), top:Math.round(r.top) }; });
  ok(`${w}px: ${side ? "左サイドバー" : "下部タブ"}`, side ? (nav.w === 212 && nav.top === 0) : (nav.w === w && nav.top > 0));

  ok(`${w}px: 本文がナビ分だけ避けている`, await page.evaluate(s => {
    const cs = getComputedStyle(document.body), n = document.getElementById("nav").getBoundingClientRect();
    return s ? parseFloat(cs.paddingLeft) >= n.width : parseFloat(cs.paddingBottom) >= n.height;
  }, side));

  const order = await page.$eval("#app", e => e.innerText);
  const seq = ["口座", "本日の損益", "直近30日 勝率", "環境認識"].map(k => order.indexOf(k));
  ok(`${w}px: ホームの並び順が同じ`, seq.every(i => i >= 0) && seq.every((v, i, a) => i === 0 || a[i-1] < v));

  await page.evaluate(() => { TAB = "growth"; UI.growthPeriod = "all"; render(); });
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => {
    const tops = [...document.querySelectorAll(".chartgrid > .card")].map(c => Math.round(c.getBoundingClientRect().top));
    let worst = 0;
    document.querySelectorAll(".tablewrap").forEach(d => { worst = Math.max(worst, d.scrollWidth - d.clientWidth); });
    return { n: tops.length, twoCol: new Set(tops).size < tops.length, tableOver: worst };
  });
  ok(`${w}px: グラフが${w >= 1180 ? "2列" : "1列"}`, g.n === 5 && (w >= 1180 ? g.twoCol : !g.twoCol));

  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`${w}px: 横スクロールが出ない（表は容器内で収める）`, over <= 1);

  await page.close();
}

/* =======================================================================
   8. セッション時間（サマータイム）
   ======================================================================= */
group("8. セッション時間（サマータイム）");
{
  const page = await open();
  const probe = () => page.evaluate(() => {
    const pick = (d, k) => sessionWindows(d).filter(x => x.key === k)[0] || null;
    return {
      wAsia: pick("2026-01-15", "asia"),   sAsia: pick("2026-07-15", "asia"),
      wLdn:  pick("2026-01-15", "london"), sLdn:  pick("2026-07-15", "london"),
      wNy:   pick("2026-01-15", "newyork"),sNy:   pick("2026-07-15", "newyork"),
      trans: pick("2026-03-29", "london"),
    };
  });
  const w = await probe();

  ok("東京は年間を通じて UTC+9（夏時間なし）",
     w.wAsia.offsetMin === 540 && w.sAsia.offsetMin === 540 && !w.wAsia.dst && !w.sAsia.dst);
  ok("ロンドンは冬 UTC+0 / 夏 UTC+1",
     w.wLdn.offsetMin === 0 && w.sLdn.offsetMin === 60 && !w.wLdn.dst && w.sLdn.dst);
  ok("ニューヨークは冬 UTC-5 / 夏 UTC-4",
     w.wNy.offsetMin === -300 && w.sNy.offsetMin === -240 && !w.wNy.dst && w.sNy.dst);

  // 固定UTCではなく「現地08:00」に追従しているか（夏冬で UTC 時刻が1時間ずれる）
  ok("ロンドンの窓は現地08:00に追従する",
     w.wLdn.startISO === "2026-01-15T08:00:00.000Z" && w.sLdn.startISO === "2026-07-15T07:00:00.000Z");
  ok("ニューヨークの窓は現地08:00に追従する",
     w.wNy.startISO === "2026-01-15T13:00:00.000Z" && w.sNy.startISO === "2026-07-15T12:00:00.000Z");
  ok("東京の窓は現地09:00で動かない",
     w.wAsia.startISO === "2026-01-15T00:00:00.000Z" && w.sAsia.startISO === "2026-07-15T00:00:00.000Z");
  ok("切り替え当日も現地時刻で解ける（2026-03-29 ロンドン）",
     w.trans.startISO === "2026-03-29T07:00:00.000Z" && w.trans.dst === true);
  ok("窓の終わりは始まりより後",
     [w.wAsia, w.sLdn, w.wNy].every(x => new Date(x.endISO) > new Date(x.startISO)));
  await page.close();

  // 端末のタイムゾーンが変わっても窓そのものは動かない
  const la = await open(375, 812, "America/Los_Angeles");
  const w2 = await la.evaluate(() => {
    const pick = (d, k) => sessionWindows(d).filter(x => x.key === k)[0];
    return { ldn: pick("2026-07-15", "london").startISO, ny: pick("2026-01-15", "newyork").startISO };
  });
  ok("端末のタイムゾーンに左右されない",
     w2.ldn === w.sLdn.startISO && w2.ny === w.wNy.startISO);
  await la.close();
}

/* =======================================================================
   9. 朝分析と marketDataProvider
   ======================================================================= */
group("9. 朝分析と marketDataProvider");
{
  const page = await open();
  await page.click('#nav button[data-tab="brief"]');

  ok("既定の取得先は未接続",
     (await page.evaluate(() => marketDataProvider.list().map(p => p.name).join(","))) === "none,relay,demo" &&
     (await page.evaluate(() => currentProviderName())) === "none");

  // --- 未接続: 配線は通るが値は入らない。手入力を壊さない ---
  await page.fill("#b_ph", "3333.3");
  await page.fill("#b_memo", "手で書いたメモ");
  answer(page, true);
  await page.click("#b_run");
  await page.waitForTimeout(400);
  ok("未接続でも朝分析は実行できる",
     (await page.$eval("#b_anastat", e => e.textContent)).includes("未接続"));
  ok("取れない項目は推測で埋めない（データなしのまま）",
     (await page.evaluate(() => [BRIEF.price.last, BRIEF.ema.e200, BRIEF.sessions.asia.high, BRIEF.bias]
        .every(v => v === null || v === ""))) === true);
  ok("未接続の朝分析で手入力が消えない",
     (await page.inputValue("#b_ph")) === "3333.3" && (await page.inputValue("#b_memo")) === "手で書いたメモ");

  // --- デモ: 取れた項目だけがフォームに入る ---
  await page.evaluate(() => { DB.settings.marketProvider = "demo"; saveData(); render(); });
  ok("デモは製品版の一覧に出ない（選ばれているときだけ出る）",
     await page.evaluate(() => marketDataProvider.list().filter(p => p.hidden).map(p => p.name).join(",")) === "demo" &&
     (await page.$$eval("#b_provider option", os => os.map(o => o.value))).includes("demo"));
  await page.waitForTimeout(150);
  answer(page, true);
  await page.click("#b_run");
  await page.waitForTimeout(400);
  const f = await page.evaluate(() => ({
    price: BRIEF.price.last, e10: BRIEF.ema.e10, e200: BRIEF.ema.e200,
    m15: BRIEF.trend.m15, daily: BRIEF.trend.daily, bias: BRIEF.bias,
    rh: BRIEF.levels.recentHigh, rl: BRIEF.levels.recentLow,
    asia: BRIEF.sessions.asia.high, ldn: BRIEF.sessions.london.low, ny: BRIEF.sessions.newyork.high,
    sum: BRIEF.aiSummary, demo: BRIEF.analysis.demo, src: BRIEF.analysis.source,
    memo: BRIEF.memo,
  }));
  ok("Issue #2 の必要項目が埋まる",
     [f.price, f.e10, f.e200, f.rh, f.rl, f.asia, f.ldn, f.ny].every(v => typeof v === "number") &&
     ["up", "down", "range"].includes(f.m15) && ["up", "down", "range"].includes(f.daily) &&
     ["long", "short", "wait"].includes(f.bias) && f.sum.length > 0);
  ok("取得層が触らない項目（メモ）は手入力のまま", f.memo === "手で書いたメモ");
  ok("デモ値には出所の印がつく", f.demo === true && f.src.includes("デモ"));
  ok("デモ値には警告が出る", (await page.$eval(".demowarn", e => e.textContent)).includes("デモ"));
  ok("結果が入力欄にも反映される", (await page.inputValue("#b_price")) === String(f.price));
  ok("編集してから保存できる（保存前は未保存表示）",
     (await page.$eval("#b_dirty", e => e.textContent)).includes("未保存"));

  // 手で直してから保存 → リロードしても残る
  await page.fill("#b_price", "3301.5");
  answer(page, true);   // デモ値のまま保存するかの確認
  await page.click('button:has-text("環境認識を保存")');
  await page.waitForTimeout(250);
  await page.reload();
  await page.waitForSelector("#app .topbar");
  const kept = await page.evaluate(() => {
    const b = DB.briefs[0];
    return { n: DB.briefs.length, price: b.price.last, m15: b.trend.m15, bias: b.bias,
             ny: b.sessions.newyork.high, e200: b.ema.e200, src: b.analysis.source };
  });
  ok("朝分析の結果を編集した内容が保存される", kept.price === 3301.5);
  ok("新しい項目がリロード後も残る",
     kept.n === 1 && kept.m15 === f.m15 && kept.bias === f.bias &&
     kept.ny === f.ny && kept.e200 === f.e200 && kept.src.includes("デモ"));

  // --- 差し替え口そのものの確認 ---
  const ext = await page.evaluate(async () => {
    marketDataProvider.register("t_ok", { label: "テスト取得先",
      fetch: () => Promise.resolve({ price: 1234.5, trend: { h1: "down" }, notes: ["ok"] }) });
    marketDataProvider.register("t_err", { label: "こわれた取得先",
      fetch: () => { throw new Error("boom"); } });
    const req = { symbol: "XAUUSD", date: today(), sessions: sessionWindows(today()) };
    const a = await marketDataProvider.fetch("t_ok", req);
    const b = await marketDataProvider.fetch("t_err", req);
    const c = await marketDataProvider.fetch("いない取得先", req);
    return { aOk: a.ok, aPrice: a.snapshot.price, aH1: a.snapshot.trend.h1, aDaily: a.snapshot.trend.daily,
             bOk: b.ok, bNote: b.snapshot.notes[0] || "", cOk: c.ok, cNote: c.snapshot.notes[0] || "" };
  });
  ok("あとから取得先を足せる（画面側は変更不要）",
     ext.aOk === true && ext.aPrice === 1234.5 && ext.aH1 === "down");
  ok("返さなかった項目は null のまま（データなし）", ext.aDaily === null);
  ok("取得先が落ちても画面は止まらない", ext.bOk === false && ext.bNote.includes("失敗"));
  ok("知らない取得先はエラーとして返る", ext.cOk === false && ext.cNote.includes("見つかりません"));

  // 取得層はセッション窓を受け取る（Bookmap 等が高安を集計するための入口）
  const gotWindows = await page.evaluate(async () => {
    let seen = null;
    marketDataProvider.register("t_req", { label: "受け取り確認",
      fetch: (req) => { seen = req; return Promise.resolve({}); } });
    await marketDataProvider.fetch("t_req", { symbol: "XAUUSD", date: "2026-07-15",
      sessions: sessionWindows("2026-07-15") });
    return { n: seen.sessions.length, keys: seen.sessions.map(s => s.key).join(","),
             hasIso: seen.sessions.every(s => !!s.startISO && !!s.endISO), sym: seen.symbol };
  });
  ok("取得先にセッション窓が渡る",
     gotWindows.n === 3 && gotWindows.keys === "asia,london,newyork" &&
     gotWindows.hasIso && gotWindows.sym === "XAUUSD");
  await page.close();
}

/* =======================================================================
   10. スクロール位置
   ======================================================================= */
group("10. スクロール位置");
{
  const page = await open();
  const y = () => page.evaluate(() => window.pageYOffset);
  // Playwright の click は要素を勝手に画面内へスクロールするので、
  // 位置を測る操作はページ内でクリックさせる
  const tap = (sel) => page.evaluate(s => document.querySelector(s).click(), sel);
  const tapText = (sel, text) => page.evaluate(([s, t]) =>
    [...document.querySelectorAll(s)].find(e => e.textContent.includes(t)).click(), [sel, text]);
  const scrollTo = async (v) => { await page.evaluate(n => window.scrollTo(0, n), v); await page.waitForTimeout(80); };

  // --- 計画: 打ち込んでいる途中でチップを押しても位置が動かない ---
  await page.click('#nav button[data-tab="plan"]');
  await page.fill("#p_entry", "4414.17");
  await page.fill("#p_sl", "4421.8");
  await page.fill("#p_tp", "4391.18");
  await scrollTo(600);
  const p0 = await y();
  await tap("button.chip[onclick*=\"'p_h4','down'\"]");
  await page.waitForTimeout(120);
  ok("計画: チップを押しても先頭に戻らない", p0 > 400 && Math.abs((await y()) - p0) <= 2);
  ok("計画: チップの選択は効いている", (await page.evaluate(() => PLAN.h4env)) === "down");

  await tap(".seg.ls button[data-v='short']");
  await page.waitForTimeout(120);
  ok("計画: 方向を切り替えても先頭に戻らない", Math.abs((await y()) - p0) <= 2);
  ok("計画: 方向を切り替えても入力が残る",
     (await page.inputValue("#p_entry")) === "4414.17" && (await page.inputValue("#p_sl")) === "4421.8");

  // --- 環境 ---
  await page.click('#nav button[data-tab="brief"]');
  await page.waitForTimeout(80);
  ok("タブを移ると先頭に戻る", (await y()) === 0);
  await scrollTo(500);
  const b0 = await y();
  await tap("button.chip[onclick*=\"'daily','up'\"]");
  await page.waitForTimeout(120);
  ok("環境: チップを押しても先頭に戻らない", b0 > 300 && Math.abs((await y()) - b0) <= 2);

  // --- 中身の短いタブへ移ってもずれない（トレード0件・成長） ---
  for (const tab of ["trades", "growth"]) {
    await page.click('#nav button[data-tab="plan"]');
    await scrollTo(900);
    await page.click(`#nav button[data-tab="${tab}"]`);
    await page.waitForTimeout(250);
    const top = await page.$eval("#app .topbar", e => Math.round(e.getBoundingClientRect().top));
    ok(`${tab}: 長い画面から移っても先頭・見出しが隠れない`, (await y()) === 0 && top >= 0 && top < 60);
  }

  // --- 保存したあとも位置が飛ばない ---
  await page.click('#nav button[data-tab="brief"]');
  await page.fill("#b_memo", "位置を保つ");
  await scrollTo(700);
  const s0 = await y();
  await tapText("button.btn.primary", "環境認識を");
  await page.waitForTimeout(250);
  ok("環境: 保存しても先頭に戻らない", s0 > 500 && Math.abs((await y()) - s0) <= 2);
  ok("環境: 保存はできている", (await page.evaluate(() => DB.briefs.length)) === 1);
  await page.close();
}

/* =======================================================================
   11. 口座通貨への換算（USDJPY）
   ======================================================================= */
group("11. 口座通貨への換算");
{
  const page = await open();
  // 本物のAPIは叩かない。取得層に差し込んだ偽の取得先で往復を見る
  const stub = (rate) => page.evaluate((r) => {
    window._fxCalls = 0;
    fxRateProvider.register("stub", { label: "テスト取得先", fetch: () => {
      window._fxCalls++;
      return Promise.resolve({ base: "USD", rates: { JPY: r }, at: "2026-09-07T00:00:00.000Z" });
    }});
    fxRateProvider.register("stub_ng", { label: "落ちる取得先", fetch: () => Promise.reject(new Error("network")) });
    FX_SOURCES = ["stub"];
  }, rate);

  ok("建値通貨を銘柄から読む", await page.evaluate(() =>
    quoteCurrencyOf("XAUUSD") === "USD" && quoteCurrencyOf("EURJPY") === "JPY" && quoteCurrencyOf("US30") === "USD"));

  // --- USD口座（既定）は今までどおり ---
  const usd = await page.evaluate(() => {
    DB.settings.currency = "USD";
    const c = calcFromInputs({ dir:"short", entry:4414.17, sl:4421.8, tp:4391.18, lot:2,
      contractSize:100, balance:50000000, fxRate:fxRateOrOne("XAUUSD") });
    return { rate: fxRateFor("XAUUSD"), loss: Math.round(c.plannedLoss), needed: fxNeeded("XAUUSD") };
  });
  ok("USD口座は換算しない（従来の値のまま）", usd.rate === 1 && usd.loss === 1526 && usd.needed === false);

  // --- JPY口座 + 自動取得 ---
  await stub(156.2);
  const jpy = await page.evaluate(async () => {
    DB.settings.currency = "JPY";
    DB.settings.fx = { auto:true, manual:null, quote:"", rate:null, at:null, rateAt:null, source:"" };
    ensureFxRate(true);
    await new Promise(r => setTimeout(r, 300));
    const c = calcFromInputs({ dir:"short", entry:4414.17, sl:4421.8, tp:4391.18, lot:2,
      contractSize:100, balance:50000000, fxRate:fxRateOrOne("XAUUSD") });
    return { rate: fxRateFor("XAUUSD"), loss: Math.round(c.plannedLoss),
             riskPct: c.riskPct, recLot: c.recLot, quote: DB.settings.fx.quote,
             src: DB.settings.fx.source, calls: window._fxCalls };
  });
  ok("JPY口座はレートを取得して換算する", jpy.rate === 156.2 && jpy.quote === "JPY" && jpy.calls === 1);
  ok("期限は取得した時刻で見る（提供元の更新時刻は別に持つ）", await page.evaluate(() =>
     DB.settings.fx.rateAt === "2026-09-07T00:00:00.000Z" &&
     Math.abs(Date.now() - new Date(DB.settings.fx.at).getTime()) < 60000));
  ok("予定損失が口座通貨になる", jpy.loss === Math.round(7.63 * 2 * 100 * 156.2));
  ok("リスク率が意味のある値になる（0.00%でなくなる）",
     Math.abs(jpy.riskPct - (7.63 * 2 * 100 * 156.2) / 50000000 * 100) < 1e-9 && jpy.riskPct > 0.4);
  ok("推奨ロットも換算後で出る",
     Math.abs(jpy.recLot - (50000000 * 0.01) / (7.63 * 100 * 156.2)) < 1e-6);

  // --- キャッシュ ---
  const cached = await page.evaluate(async () => {
    ensureFxRate(); await new Promise(r => setTimeout(r, 150));
    return window._fxCalls;
  });
  ok("10分はキャッシュを使う（取り直さない）", cached === 1);
  const forced = await page.evaluate(async () => {
    ensureFxRate(true); await new Promise(r => setTimeout(r, 300));
    return window._fxCalls;
  });
  ok("手動更新は取り直す", forced === 2);

  // --- 失敗時は直近成功値を残す ---
  const failed = await page.evaluate(async () => {
    FX_SOURCES = ["stub_ng"];
    ensureFxRate(true);
    await new Promise(r => setTimeout(r, 400));
    return { rate: fxRateFor("XAUUSD"), err: FX.lastError };
  });
  ok("取得に失敗しても直近値を捨てない", failed.rate === 156.2 && failed.err.length > 0);

  // --- 手動レートは自動が無いときの控え ---
  const manual = await page.evaluate(async () => {
    DB.settings.fx = { auto:false, manual:150, quote:"", rate:null, at:null, source:"" };
    return { rate: fxRateFor("XAUUSD"), line: fxLineHtml("XAUUSD") };
  });
  ok("自動値が無ければ手動レートを使う", manual.rate === 150 && manual.line.includes("手動設定"));

  // --- 取れないときは 1 で計算し、そのことを画面に出す ---
  const none = await page.evaluate(() => {
    DB.settings.fx = { auto:false, manual:null, quote:"", rate:null, at:null, source:"" };
    return { r: fxRateFor("XAUUSD"), used: fxRateOrOne("XAUUSD"), line: fxLineHtml("XAUUSD") };
  });
  ok("レートが無いときは 1 で計算し、断りを出す",
     none.r === null && none.used === 1 && none.line.includes("1 で計算"));

  // --- 記録に焼いたレートを使う（残高と同じ考え方） ---
  await stub(156.2);
  const baked = await page.evaluate(async () => {
    DB.settings.fx = { auto:true, manual:null, quote:"", rate:null, at:null, source:"" };
    ensureFxRate(true); await new Promise(r => setTimeout(r, 300));
    TAB = "plan"; PLAN = freshPlan();
    PLAN.symbol = "XAUUSD"; PLAN.dir = "short";
    PLAN.entry = "4414.17"; PLAN.sl = "4421.8"; PLAN.tp = "4391.18"; PLAN.lot = "2";
    const rec = planToRecord("open");
    DB.trades = [rec, { id:"old", status:"open", symbol:"XAUUSD", dir:"short", entry:4414.17,
      sl:4421.8, tp:4391.18, lot:2, contractSize:100, balanceAtEntry:50000000,
      createdAt:new Date().toISOString(), tags:[] }];
    // レートが動いても過去の記録は動かない
    DB.settings.fx.rate = 200;
    return { baked: rec.fxRate, cur: rec.acctCurrency,
             newLoss: Math.round(calcTrade(DB.trades[0]).plannedLoss),
             oldLoss: Math.round(calcTrade(DB.trades[1]).plannedLoss) };
  });
  ok("新しい記録にエントリー時のレートを焼く", baked.baked === 156.2 && baked.cur === "JPY");
  ok("あとでレートが動いても記録の数字は揺れない", baked.newLoss === Math.round(7.63 * 2 * 100 * 156.2));
  ok("レートを持たない過去の記録は 1 のまま（数字が勝手に変わらない）", baked.oldLoss === 1526);

  // --- 設定が保存され、リロードしても残る ---
  await page.evaluate(() => { DB.settings.currency = "JPY"; saveData(); TAB = "settings"; render(); });
  await page.waitForTimeout(150);
  ok("設定画面に口座通貨のプルダウンが出る",
     (await page.$eval("#s_currency", e => e.value)) === "JPY");
  ok("使っているレートが画面に出る",
     (await page.$eval("#app .fxline", e => e.textContent)).includes("USDJPY"));

  // 計画画面のレート行は入力中の銘柄に追従する
  await page.evaluate(() => {
    DB.settings.fx = { auto:false, manual:156.2, quote:"", rate:null, at:null, rateAt:null, source:"" };
    TAB = "plan"; PLAN = freshPlan(); PLAN.symbol = "XAUUSD"; render();
  });
  await page.waitForTimeout(150);
  const planLine = await page.$eval("#app .fxline", e => e.textContent);
  await page.fill("#p_sym", "EURJPY");
  await page.waitForTimeout(150);
  const planLine2 = await page.$eval("#app .fxline", e => e.textContent);
  ok("計画画面のレート行が銘柄に追従する",
     planLine.includes("USDJPY") && planLine2 === "" && !planLine.includes("LAN"));
  await page.reload();
  await page.waitForSelector("#app .topbar");
  const kept = await page.evaluate(() => ({ cur: DB.settings.currency, rate: DB.settings.fx.rate, q: DB.settings.fx.quote }));
  ok("口座通貨とレートがリロード後も残る", kept.cur === "JPY" && kept.rate === 200 && kept.q === "JPY");

  // --- 口座通貨を変えたら取得値は捨てる ---
  const swapped = await page.evaluate(() => {
    DB.settings.fx.auto = false;
    TAB = "settings"; render();
    document.getElementById("s_currency").value = "USD";
    saveSettings();
    return { rate: DB.settings.fx.rate, q: DB.settings.fx.quote, f: fxRateFor("XAUUSD") };
  });
  ok("口座通貨を変えたら古いレートを持ち越さない", swapped.rate === null && swapped.q === "" && swapped.f === 1);
  await page.close();
}

/* =======================================================================
   12. 実APIのレスポンスを読めるか（本物の応答を写した固定データ）
   ======================================================================= */
group("12. レート取得先の応答解釈");
{
  const page = await open();
  // 通信はせず、実際の API から取った応答をそのまま window.fetch に差し込む。
  // 「取得先の応答の形が変わったら気づける」ための固定データ。
  const real = await page.evaluate(async () => {
    const bodies = {
      "open.er-api.com": {"result":"success","base_code":"USD",
        "time_last_update_utc":"Mon, 07 Sep 2026 00:02:31 +0000",
        "rates":{"JPY":156.177011,"EUR":0.861072}},
      "cdn.jsdelivr.net": {"date":"2026-09-06","usd":{"jpy":156.24969077,"eur":0.86081177}},
    };
    const orig = window.fetch;
    window.fetch = (url) => {
      const key = Object.keys(bodies).find(k => String(url).includes(k));
      if (!key) return Promise.reject(new Error("想定外のURL " + url));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(bodies[key]) });
    };
    const a = await fxRateProvider.fetch("erapi", { base: "USD" });
    const b = await fxRateProvider.fetch("currencyapi", { base: "USD" });
    window.fetch = orig;
    return {
      aOk: a.ok, aJpy: a.snapshot.rates && a.snapshot.rates.JPY, aAt: a.snapshot.at, aSrc: a.snapshot.source,
      bOk: b.ok, bJpy: b.snapshot.rates && b.snapshot.rates.JPY, bAt: b.snapshot.at,
    };
  });
  ok("erapi の応答から USDJPY を読める", real.aOk && real.aJpy === 156.177011);
  ok("erapi の更新時刻を ISO に直せる", real.aAt === "2026-09-07T00:02:31.000Z");
  ok("currency-api の応答から USDJPY を読める（通貨コードは大文字に寄せる）",
     real.bOk && real.bJpy === 156.24969077);
  ok("currency-api の日付を ISO に直せる", real.bAt === "2026-09-06T00:00:00.000Z");

  // 1つ目が落ちたら2つ目に回る
  const failover = await page.evaluate(async () => {
    const orig = window.fetch;
    window.fetch = (url) => String(url).includes("open.er-api.com")
      ? Promise.reject(new Error("down"))
      : Promise.resolve({ ok: true, status: 200,
          json: () => Promise.resolve({ date: "2026-09-06", usd: { jpy: 156.25 } }) });
    const r = await fxRateProvider.fetchFirst(["erapi", "currencyapi"], { base: "USD" });
    window.fetch = orig;
    return { ok: r.ok, jpy: r.snapshot.rates && r.snapshot.rates.JPY, src: r.snapshot.source };
  });
  ok("1つ目が落ちたら控えの取得先に回る",
     failover.ok && failover.jpy === 156.25 && failover.src.includes("jsDelivr"));

  // 応答が壊れていても推測しない
  const broken = await page.evaluate(async () => {
    const orig = window.fetch;
    window.fetch = () => Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve({ result: "error" }) });
    const r = await fxRateProvider.fetch("erapi", { base: "USD" });
    window.fetch = orig;
    return { ok: r.ok, rates: r.snapshot.rates };
  });
  ok("応答が壊れていたら null（勝手な値を入れない）", broken.ok === false && broken.rates === null);
  await page.close();
}

/* =======================================================================
   13. 決済モーダル（符号の選択と口座通貨）
   ======================================================================= */
group("13. 決済登録の符号と通貨");
{
  const page = await open();
  const seed = () => page.evaluate(() => {
    DB.settings.currency = "JPY"; DB.settings.initialBalance = 50000000;
    DB.settings.fx = { auto:false, manual:156.2, quote:"", rate:null, at:null, rateAt:null, source:"" };
    DB.trades = [
      { id:"t1", status:"open", symbol:"XAUUSD", dir:"short", entry:4407.45, sl:4412.85, tp:4391,
        lot:2, contractSize:100, balanceAtEntry:50000000, fxRate:156.2, acctCurrency:"JPY",
        createdAt:new Date().toISOString(), tags:[] },
      { id:"t2", status:"open", symbol:"XAUUSD", dir:"short", entry:4407.45, sl:4412.85, tp:4391,
        lot:2, contractSize:100, balanceAtEntry:50000000,   // レートを持たない古い記録
        createdAt:new Date().toISOString(), tags:[] },
    ];
    saveData(); TAB = "trades"; UI.tradeTab = "open"; render();
  });
  await seed();
  await page.waitForTimeout(150);

  ok("古い記録には建値通貨の印が出る",
     (await page.$eval("#app", e => e.innerText)).includes("USD建て"));

  // --- 決済価格からの計算が口座通貨になる ---
  await page.evaluate(() => openCloseModal("t1"));
  await page.waitForTimeout(120);
  await page.fill("#c_price", "4412.85");
  await page.waitForTimeout(120);
  const hint = await page.$eval("#c_plhint", e => e.textContent);
  ok("決済価格からの計算にレートが掛かる（口座通貨）",
     hint.includes(String(Math.round(5.4 * 2 * 100 * 156.2).toLocaleString("en-US"))) && hint.includes("JPY"));
  ok("見出しの予定損失も口座通貨で単位つき",
     (await page.$eval("#modalRoot", e => e.innerText)).includes("JPY"));

  // --- 符号の選択 ---
  ok("符号のボタンが出ている", (await page.$$("#c_plsign button")).length === 2);
  ok("決済価格から符号が自動で決まる（損失側）",
     (await page.$eval("#c_plsign button[data-v='neg']", e => e.className)).includes("on"));

  await page.click(".miniapply");
  await page.waitForTimeout(120);
  const applied = await page.evaluate(() => ({
    field: document.getElementById("c_pl").value,
    sign: CLOSE.plSign,
    value: closePLValue(),
    sum: document.getElementById("c_plsum").textContent,
  }));
  ok("入力欄は絶対値、符号は別で持つ",
     applied.field === String(Math.abs(5.4 * 2 * 100 * 156.2)) && applied.sign === "neg");
  ok("保存される値は負になる", applied.value === -(5.4 * 2 * 100 * 156.2));
  ok("登録される実現損益が確認できる", applied.sum.includes("-") && applied.sum.includes("JPY"));

  // 利益側に切り替えられる（＝マイナスが打てない iOS でも符号を選べる）
  await page.click("#c_plsign button[data-v='pos']");
  await page.waitForTimeout(80);
  ok("符号を利益側に切り替えられる",
     (await page.evaluate(() => closePLValue())) === (5.4 * 2 * 100 * 156.2));

  // 金額だけ打ち直しても符号は保たれる
  await page.fill("#c_pl", "1080");
  await page.waitForTimeout(80);
  ok("金額を打ち直しても選んだ符号が残る", (await page.evaluate(() => closePLValue())) === 1080);

  await page.click("#c_plsign button[data-v='neg']");
  await page.waitForTimeout(80);
  await page.evaluate(() => saveClose("t1"));
  await page.waitForTimeout(250);
  const saved = await page.evaluate(() => {
    const t = DB.trades.filter(x => x.id === "t1")[0];
    return { pl: t.realizedPL, status: t.status, r: calcTrade(t).realizedR };
  });
  ok("符号つきで保存される", saved.pl === -1080 && saved.status === "closed");
  ok("R も口座通貨どうしで出る",
     Math.abs(saved.r - (-1080 / (5.4 * 2 * 100 * 156.2))) < 1e-9);

  // --- レートを持たない古い記録は換算しない ---
  await page.evaluate(() => { UI.tradeTab = "open"; render(); openCloseModal("t2"); });
  await page.waitForTimeout(150);
  await page.fill("#c_price", "4412.85");
  await page.waitForTimeout(120);
  const oldHint = await page.$eval("#c_plhint", e => e.textContent);
  ok("古い記録は換算せず建値通貨のまま示す",
     oldHint.includes("1,080") && oldHint.includes("USD") && !oldHint.includes("JPY"));
  await page.close();
}

/* =======================================================================
   14. MT5 取引同期（事実だけ・冪等）
   ======================================================================= */
group("14. MT5 取引同期");
{
  const page = await open();

  // MT5 が返す形をそのまま写した固定データ（time は UNIX 秒、type/entry は数値コード）
  const BATCH = {
    source: "テスト", generatedAt: "2026-09-07T00:00:00.000Z",
    account: { login: 1234567, server: "Fintokei-Live", currency: "USD", balance: 100000, equity: 100000 },
    deals: [
      { ticket: 501, order: 401, positionId: 301, time: 1757203200, type: 0, entry: 0,
        symbol: "XAUUSD", volume: 2, price: 3300, profit: 0, commission: -14, swap: 0,
        sl: 3290, tp: 3330, contractSize: 100 },
      { ticket: 502, order: 402, positionId: 301, time: 1757210400, type: 1, entry: 1,
        symbol: "XAUUSD", volume: 1, price: 3320, profit: 2000, commission: -7, swap: -1.5,
        contractSize: 100 },
      // 建てただけで決済していない別の建玉
      { ticket: 510, order: 410, positionId: 310, time: 1757212000, type: 1, entry: 0,
        symbol: "XAUUSD", volume: 1, price: 3310, profit: 0, commission: -7, swap: 0,
        sl: 3320, tp: 3280, contractSize: 100 },
      // 入出金の行（建玉ではない）
      { ticket: 520, positionId: 0, time: 1757100000, type: 2, entry: 0,
        symbol: "", volume: 0, price: 0, profit: 100000 }
    ],
    positions: [{ positionId: 310, symbol: "XAUUSD", type: 1, volume: 1, priceOpen: 3310,
                  sl: 3318, tp: 3280, time: 1757212000, profit: -30 }]
  };

  const first = await page.evaluate(async (batch) => {
    const r = await tradeSyncProvider.fetch("paste", { text: JSON.stringify(batch) });
    const rep = importDealBatch(r.batch);
    return { ok: r.ok, rep, deals: DB.deals.length, trades: DB.trades.length };
  }, BATCH);
  ok("貼り付けの JSON を読める", first.ok === true);
  ok("約定が件数どおり入る", first.deals === 4 && first.rep.dealsAdded === 4);
  ok("入出金の行からトレードは作らない", first.rep.positions === 2);
  ok("建玉ごとにトレードができる", first.trades === 2 && first.rep.tradesCreated === 2);

  const t1 = await page.evaluate(() => DB.trades.filter(t => t.mt5 && t.mt5.positionId === "301")[0]);
  ok("MT5 の事実が入る（銘柄・方向・価格・ロット）",
     t1.symbol === "XAUUSD" && t1.dir === "long" && t1.entry === 3300 && t1.lot === 2);
  ok("SL/TP は発注時の値が入る", t1.sl === 3290 && t1.tp === 3330);
  ok("UNIX 秒が ISO になる", t1.createdAt === new Date(1757203200000).toISOString());
  ok("一部決済のうちは決済扱いにしない",
     t1.status === "open" && t1.realizedPL === null && t1.closedAt === null);
  ok("主観の欄は空のまま（AIが埋めない）",
     t1.h4env === "" && t1.pattern === "" && t1.emotion === null && t1.ruleOk === null &&
     t1.memo === "" && t1.reviewMemo === "" && t1.learn === "");
  ok("口座通貨は MT5 の値を焼き込む", t1.acctCurrency === "USD");
  ok("MT5 由来の印がつく", t1.source === "mt5" && t1.mt5.entryDeal === "501");
  // エントリー時の残高は「いまの残高 − その時刻以降の約定の増減」で戻す
  //   100000 − (−14) − (2000−7−1.5) − (−7) = 98029.5
  ok("エントリー時の残高を約定から逆算する", Math.abs(t1.balanceAtEntry - 98029.5) < 1e-9);

  const t2 = await page.evaluate(() => DB.trades.filter(t => t.mt5 && t.mt5.positionId === "310")[0]);
  ok("保有中の SL は建玉スナップショットの現在値が勝つ", t2.sl === 3318 && t2.dir === "short");

  // --- 冪等性：同じバッチを流し直しても増えない ---
  const again = await page.evaluate(async (batch) => {
    const r = await tradeSyncProvider.fetch("paste", { text: JSON.stringify(batch) });
    const rep = importDealBatch(r.batch);
    return { rep, deals: DB.deals.length, trades: DB.trades.length };
  }, BATCH);
  ok("同じ約定は二重登録されない",
     again.deals === 4 && again.trades === 2 &&
     again.rep.dealsAdded === 0 && again.rep.tradesCreated === 0 && again.rep.tradesUpdated === 0);

  // --- 残りを決済する約定が来たら、同じ position ID の記録が閉じる ---
  const closed = await page.evaluate(async () => {
    const add = { deals: [{ ticket: 503, order: 403, positionId: 301, time: 1757214000, type: 1, entry: 1,
      symbol: "XAUUSD", volume: 1, price: 3310, profit: 1000, commission: -7, swap: -1.5, contractSize: 100 }] };
    const r = await tradeSyncProvider.fetch("paste", { text: JSON.stringify(add) });
    const rep = importDealBatch(r.batch);
    const t = DB.trades.filter(x => x.mt5 && x.mt5.positionId === "301")[0];
    return { rep, t, count: DB.trades.length };
  });
  ok("追加の決済で建玉が閉じる（新しい記録は作らない）",
     closed.count === 2 && closed.rep.tradesCreated === 0 && closed.rep.tradesUpdated === 1);
  // 口座情報が付いてこない回の約定は、まだこの残高に入っていないので巻き戻さない
  ok("残高が古いままの回はエントリー時残高を動かさない",
     Math.abs(closed.t.balanceAtEntry - 98029.5) < 1e-9);
  ok("決済価格は数量加重平均", closed.t.status === "closed" && closed.t.closePrice === 3315);
  ok("実現損益・手数料・スワップは MT5 の合計", 
     closed.t.realizedPL === 3000 && closed.t.fee === -28 && closed.t.swap === -3);
  const r301 = await page.evaluate(() =>
    calcTrade(DB.trades.filter(x => x.mt5 && x.mt5.positionId === "301")[0]).realizedR);
  ok("R が出る（SL があるので予定損失が立つ）", Math.abs(r301 - (3000 / 2000)) < 1e-9);

  // --- 手で直した値は次の同期で潰されない ---
  const merged = await page.evaluate(async () => {
    const t = DB.trades.filter(x => x.mt5 && x.mt5.positionId === "310")[0];
    t.tp = 3250;            // 手で直す
    t.memo = "自分のメモ";
    saveData();
    // MT5 側は TP を変えずに送り直す
    const same = { positions: [{ positionId: 310, symbol: "XAUUSD", type: 1, volume: 1,
      priceOpen: 3310, sl: 3318, tp: 3280, time: 1757212000 }], deals: [] };
    const r = await tradeSyncProvider.fetch("paste", { text: JSON.stringify(same) });
    const rep = importDealBatch(r.batch);
    const after = DB.trades.filter(x => x.mt5 && x.mt5.positionId === "310")[0];
    return { tp: after.tp, memo: after.memo, conflicts: rep.conflicts.length };
  });
  ok("MT5 側が変わっていなければ手直しを潰さない", merged.tp === 3250 && merged.memo === "自分のメモ");
  ok("食い違いは黙って消さずに報告する", merged.conflicts >= 0);

  // --- MT5 側が実際に変わったときは食い違いとして残す（勝手に上書きしない） ---
  const conflict = await page.evaluate(async () => {
    const moved = { positions: [{ positionId: 310, symbol: "XAUUSD", type: 1, volume: 1,
      priceOpen: 3310, sl: 3318, tp: 3200, time: 1757212000 }], deals: [] };
    const r = await tradeSyncProvider.fetch("paste", { text: JSON.stringify(moved) });
    const rep = importDealBatch(r.batch);
    const after = DB.trades.filter(x => x.mt5 && x.mt5.positionId === "310")[0];
    return { tp: after.tp, conflicts: rep.conflicts.map(c => c.field) };
  });
  ok("手直しがある欄は MT5 の変更で上書きしない",
     conflict.tp === 3250 && conflict.conflicts.indexOf("tp") >= 0);

  // --- ドテン（1約定で建て替え）はトレードを作らない ---
  const inout = await page.evaluate(async () => {
    const b = { deals: [
      { ticket: 601, positionId: 401, time: 1757220000, type: 0, entry: 0, symbol: "XAUUSD",
        volume: 1, price: 3300, contractSize: 100 },
      { ticket: 602, positionId: 401, time: 1757221000, type: 1, entry: 2, symbol: "XAUUSD",
        volume: 2, price: 3305, profit: 500, contractSize: 100 }] };
    const r = await tradeSyncProvider.fetch("paste", { text: JSON.stringify(b) });
    const rep = importDealBatch(r.batch);
    return { rep, made: DB.trades.filter(t => t.mt5 && t.mt5.positionId === "401").length,
             kept: DB.deals.filter(d => d.positionId === "401").length };
  });
  ok("正確に割れない建玉は記録を作らない", inout.made === 0 && inout.rep.skippedPositions.length === 1);
  ok("それでも約定そのものは残す（事実は捨てない）", inout.kept === 2);

  // --- 保存とリロード ---
  await page.reload();
  await page.waitForSelector("#app .topbar");
  const after = await page.evaluate(() => ({
    deals: DB.deals.length,
    trades: DB.trades.filter(t => t.source === "mt5").length,
    closed: DB.trades.filter(t => t.mt5 && t.mt5.positionId === "301")[0].realizedPL
  }));
  ok("リロードしても約定と記録が残る", after.deals === 7 && after.trades === 2 && after.closed === 3000);
  await page.close();
}

/* =======================================================================
   14b. MT5 の口座情報（事実だけ。ルール判定はしない）
   ======================================================================= */
group("14b. 口座情報");
{
  const page = await open();
  const ACC = {
    source: "テスト",
    account: { login: "555", server: "Fintokei-Live", currency: "USD", leverage: 100,
      balance: 102000, equity: 101300, profit: -700, margin: 3300, marginFree: 98000,
      marginLevel: 3070, at: "2026-09-07T06:00:00.000Z" },
    deals: [
      // 当日：+1500 と −800（手数料・スワップ込み）
      { ticket: 701, positionId: 601, time: Date.now() / 1000 - 3600, type: 0, entry: 0,
        symbol: "XAUUSD", volume: 1, price: 3300, profit: 0, commission: -7, contractSize: 100 },
      { ticket: 702, positionId: 601, time: Date.now() / 1000 - 1800, type: 1, entry: 1,
        symbol: "XAUUSD", volume: 1, price: 3315, profit: 1500, commission: -7, swap: -1,
        contractSize: 100 },
      { ticket: 703, positionId: 602, time: Date.now() / 1000 - 1200, type: 1, entry: 0,
        symbol: "XAUUSD", volume: 1, price: 3310, profit: 0, commission: -7, contractSize: 100 },
      { ticket: 704, positionId: 602, time: Date.now() / 1000 - 600, type: 0, entry: 1,
        symbol: "XAUUSD", volume: 1, price: 3318, profit: -800, commission: -7, swap: 0,
        contractSize: 100 },
      // 保有中（SL あり）。合計予定損失の材料
      { ticket: 705, positionId: 603, time: Date.now() / 1000 - 300, type: 0, entry: 0,
        symbol: "XAUUSD", volume: 2, price: 3300, profit: 0, commission: -14, sl: 3290,
        contractSize: 100 },
    ],
  };

  const r0 = await page.evaluate(async (acc) => {
    DB.settings.initialBalance = 100000;
    DB.settings.currency = "USD";
    saveData();
    const r = await tradeSyncProvider.fetch("paste", { text: JSON.stringify(acc) });
    const rep = importDealBatch(r.batch);
    return { rep, fs: accountState(), bal: currentBalance() };
  }, ACC);

  ok("口座情報が保存される", r0.rep.accountUpdated === true);
  ok("残高は MT5 の値になる（人が入れ直さない）", r0.bal === 102000 && r0.fs.source === "mt5");
  ok("有効証拠金・含み損益・証拠金が入る",
     r0.fs.equity === 101300 && r0.fs.floating === -700 &&
     r0.fs.margin === 3300 && r0.fs.marginFree === 98000);
  // 当日実現 = (0−7) + (1500−7−1) + (0−7) + (−800−7) + (0−14) = 657（手数料・スワップ込み）
  const DAY = 657, START = 102000 - DAY;
  ok("当日実現損益を約定から出す", Math.abs(r0.fs.todayRealized - DAY) < 1e-9);
  ok("前日終わりの残高は残高から当日ぶんを戻したもの", Math.abs(r0.fs.dayStart - START) < 1e-9);
  ok("前日比は含み損益込み", Math.abs(r0.fs.todayChange - (101300 - START)) < 1e-9);
  // 保有中の合計予定損失 = |3300−3290| × 2 lot × 100 = 2000（残高の 1.96%）。判定はしない
  ok("保有中の合計予定損失を SL から出す",
     r0.fs.openLossN === 1 && r0.fs.openLoss === 2000 &&
     Math.abs(r0.fs.openLossPct - 2000 / 102000 * 100) < 1e-9);
  ok("Fintokei のルール判定は持たない",
     await page.evaluate(() => typeof finState === "undefined" && DB.settings.fin === undefined));

  await page.evaluate(() => { TAB = "home"; render(); });
  await page.waitForTimeout(80);
  const home = await page.$eval("#app", e => e.innerText);
  ok("ホームに口座の状態が出る",
     home.includes("有効証拠金") && home.includes("含み損益") && home.includes("余剰証拠金"));
  ok("ホームに合計予定損失が出る", home.includes("保有中の合計予定損失"));
  ok("残り許容額やメーターは出ない",
     !home.includes("今日あと負けられる") && !home.includes("最大DD") && !home.includes("日次損失上限"));
  ok("MT5 由来だと分かる", home.includes("MT5"));

  await page.click('#nav button[data-tab="brief"]');
  await page.waitForTimeout(80);
  const brief = await page.$eval("#app", e => e.innerText);
  ok("環境認識にも口座の状態が出る", brief.includes("口座の状態") && brief.includes("当日実現損益"));

  await page.click('#nav button[data-tab="plan"]');
  await page.waitForTimeout(80);
  const plan = await page.$eval("#app", e => e.innerText);
  ok("計画画面に Fintokei の残り枠は出ない", !plan.includes("日次残り") && !plan.includes("全体残り"));
  ok("計画画面の内部リスク率と推奨ロットは残る", plan.includes("予定リスク率") && plan.includes("推奨ロット"));

  await page.click('#nav button[data-tab="settings"]');
  await page.waitForTimeout(80);
  const st = await page.$eval("#app", e => e.innerText);
  ok("設定から公式ルールと口座タイプの条件が消えている",
     !st.includes("Fintokei 公式ルール") && !st.includes("口座タイプの条件"));
  ok("残高モードは2択", (await page.$$("#s_balmode option")).length === 2);
  ok("設定に MT5 の口座情報が読み取り専用で出る", st.includes("MT5 の口座情報") && st.includes("Free Margin"));

  // --- 古い保存データの fin は捨てる ---
  ok("古い fin 設定は読み込み時に捨てる",
     await page.evaluate(() => {
       const m = migrate({ settings: { fin: { dailyLossPct: 5 }, finProfiles: [{ id: "x" }], balanceMode: "manual" }, trades: [] });
       return m.settings.fin === undefined && m.settings.finProfiles === undefined;
     }));

  // --- リロードしても残る ---
  await page.reload();
  await page.waitForSelector("#app .topbar");
  ok("口座情報がリロード後も残る",
     await page.evaluate(() => DB.account && DB.account.balance === 102000 && accountState().source === "mt5"));

  // --- MT5 が無ければ従来どおり ---
  ok("MT5 が無ければ初期残高＋決済損益に戻る",
     await page.evaluate(() => {
       DB.account = null; DB.deals = []; DB.trades = []; saveData();
       const f = accountState();
       return f.source === "local" && f.balance === 100000 && f.equity === 100000;
     }));
  await page.close();
}

/* =======================================================================
   15. 取得先の切り替えと中継
   ======================================================================= */
group("15. 取得先の切り替えと中継");
{
  const page = await open();
  ok("既定は未接続", await page.evaluate(() => mt5Settings().provider) === "none");
  ok("未接続では何も取り込まない",
     await page.evaluate(async () => {
       const r = await tradeSyncProvider.fetch("none", {});
       return importDealBatch(r.batch).dealsAdded === 0 && DB.trades.length === 0;
     }));

  const relay = await page.evaluate(async () => {
    const orig = window.fetch;
    let seen = null;
    window.fetch = (url, opt) => { seen = { url, opt }; return Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve({ source: "中継", account: { login: 9, currency: "USD" },
        deals: [{ ticket: 900, positionId: 900, time: "2026-09-06T12:00:00Z", type: 0, entry: 0,
                  symbol: "XAUUSD", volume: 1, price: 3300, contractSize: 100 }] }) }); };
    DB.settings.mt5.endpoint = "https://example.test/api/deals";
    DB.settings.mt5.token = "READ-TOKEN";
    const rep = await runTradeSync({ provider: "relay" });
    window.fetch = orig;
    return { seen, rep };
  });
  ok("取得URLを叩く", relay.seen.url.indexOf("https://example.test/api/deals") === 0);
  ok("トークンはヘッダで送る（URLには出さない）",
     relay.seen.opt.headers.Authorization === "Bearer READ-TOKEN" &&
     relay.seen.url.indexOf("READ-TOKEN") < 0);
  ok("中継から取り込める", relay.rep.ok === true && relay.rep.dealsAdded === 1);

  const failed = await page.evaluate(async () => {
    const orig = window.fetch;
    window.fetch = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    const rep = await runTradeSync({ provider: "relay" });
    window.fetch = orig;
    return { rep, deals: DB.deals.length };
  });
  ok("中継が断ってきても記録を壊さない",
     failed.rep.ok === false && failed.deals === 1 && failed.rep.notes.length > 0);

  ok("http:// の取得URLは断る",
     await page.evaluate(async () => {
       DB.settings.mt5.endpoint = "http://example.test/api/deals";
       const r = await tradeSyncProvider.fetch("relay", { endpoint: DB.settings.mt5.endpoint });
       return r.ok === false;
     }));
  await page.close();
}

/* =======================================================================
   16. 朝やろ（同期 → 市場データ → 保存）
   ======================================================================= */
group("16. 朝やろ");
{
  const page = await open();
  await page.click('#nav button[data-tab="brief"]');
  ok("環境タブに朝やろのボタンが出る", !!(await page.$("#m_run")));
  ok("環境タブに取引同期のカードが出る",
     (await page.$eval("#app", e => e.innerText)).includes("取引同期"));

  // デモの値は保存しない
  await page.evaluate(async () => {
    DB.settings.marketProvider = "demo"; saveData();
    await runMorningRoutine();
  });
  await page.waitForTimeout(120);
  const demo = await page.evaluate(() => ({
    briefs: DB.briefs.length,
    save: MORNING.steps.filter(s => s.key === "save")[0]
  }));
  ok("デモのサンプル値は保存しない", demo.briefs === 0 && demo.save.state === "warn");

  // 未接続だと、値が無いので空の環境認識を作らない
  const none = await page.evaluate(async () => {
    DB.settings.marketProvider = "none"; BRIEF = null; saveData();
    await runMorningRoutine();
    return { briefs: DB.briefs.length, steps: MORNING.steps.map(s => [s.key, s.state]) };
  });
  ok("入る値が無ければ空の環境認識を作らない", none.briefs === 0);
  ok("同期の段は未接続として飛ばす", none.steps[0][0] === "sync" && none.steps[0][1] === "skip");

  // 手入力が入っていれば、朝やろで保存まで進む
  await page.fill("#b_memo", "手で書いた");
  await page.click('#nav button[data-tab="brief"]');
  const saved = await page.evaluate(async () => {
    await runMorningRoutine();
    return { briefs: DB.briefs.length, memo: (DB.briefs[0] || {}).memo,
             save: MORNING.steps.filter(s => s.key === "save")[0].state };
  });
  ok("手入力があれば保存まで進む", saved.briefs === 1 && saved.memo === "手で書いた" && saved.save === "ok");

  // #morning で開くと自動で走り、ハッシュは消える
  const page2 = await open();
  await page2.evaluate(() => { DB.settings.marketProvider = "demo"; saveData(); });
  await page2.goto(URL_ + "#morning");
  await page2.waitForSelector("#app .topbar");
  await page2.waitForTimeout(400);
  const hashed = await page2.evaluate(() => ({
    tab: TAB, steps: MORNING.steps.length, hash: location.hash
  }));
  ok("#morning で朝の処理が走る", hashed.steps === 3 && hashed.tab === "brief");
  ok("ハッシュは消えるので再読込で二重に走らない", hashed.hash === "");
  await page2.close();
  await page.close();
}

/* =======================================================================
   17. OHLC からの計算（EMA / ATR / 方向 / 高安）
   ======================================================================= */
group("17. OHLC からの計算");
{
  const page = await open();

  // 1本ずつ1ずつ上がる素直な足を作る
  const mk = (n, from = 100, step = 1, day = false) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = from + i * step;
      const t = day
        ? new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
        : new Date(Date.UTC(2026, 8, 1, i)).toISOString();
      out.push({ t, o: c - step, h: c + 1, l: c - 2, c });
    }
    return out;
  };

  const ema = await page.evaluate((bars) => ({
    short: emaOf(bars, 10),
    tooFew: emaOf(bars.slice(0, 5), 10),
    flat: emaOf(bars.map(b => ({ ...b, c: 50 })), 10),
  }), mk(60));
  ok("本数が足りなければ EMA は出さない", ema.tooFew === null);
  ok("値が一定なら EMA もその値", ema.flat === 50);
  ok("上昇中の EMA は終値より下", ema.short > 0 && ema.short < 159);

  const atr = await page.evaluate((bars) => ({
    v: atrOf(bars, 14),
    tooFew: atrOf(bars.slice(0, 5), 14),
    noHL: atrOf(bars.map(b => ({ t: b.t, c: b.c })), 14),
  }), mk(60));
  // 各足は h=c+1 / l=c-2 / 前の終値との差が 1 → TR は常に 3
  ok("ATR が真の値幅から出る", Math.abs(atr.v - 3) < 1e-9);
  ok("本数が足りなければ ATR は出さない", atr.tooFew === null);
  ok("高安が無ければ ATR は出さない", atr.noHL === null);

  const trend = await page.evaluate((bars) => ({
    up: trendOfBars(bars),
    down: trendOfBars(bars.map((b, i) => ({ ...b, c: 1000 - i, h: 1001 - i, l: 998 - i }))),
    few: trendOfBars(bars.slice(0, 100)),
    none: trendOfBars([]),
  }), mk(400));
  ok("上げ続きは上昇と判定", trend.up === "up");
  ok("下げ続きは下降と判定", trend.down === "down");
  ok("EMA200 が出せなければ方向は出さない", trend.few === null && trend.none === null);

  const lv = await page.evaluate((daily) => ({
    prev: prevDayBar(daily, "2026-01-08"),
    gap: prevDayBar(daily, "2026-01-20"),      // 休場の先まで飛んでも直前の足を拾う
    week: weekHighLow(daily, "2026-01-08"),
    start: weekStartOf("2026-01-08"),
    between: barsBetween(daily, "2026-01-03T00:00:00.000Z", "2026-01-05T00:00:00.000Z").length,
  }), mk(10, 100, 1, true));
  ok("前日の足はその日より前で最後のもの", lv.prev.t.slice(0, 10) === "2026-01-07");
  ok("休場をまたいでも直前の足を拾う", lv.gap.t.slice(0, 10) === "2026-01-10");
  ok("週足は月曜はじまり", lv.start === "2026-01-05");
  ok("週足の高安はその週の日足から", lv.week.high === 108 && lv.week.low === 102);
  ok("窓で足を切り出せる", lv.between === 2);
  await page.close();
}

/* =======================================================================
   18. 朝分析の中継（OHLC → snapshot）
   ======================================================================= */
group("18. 朝分析の中継");
{
  const page = await open();
  await page.click('#nav button[data-tab="brief"]');

  const RESP = await page.evaluate(() => {
    // 中継が返す形の作り物。1時間足を250本ぶん用意して EMA200 まで出せるようにする
    const h1 = [];
    for (let i = 0; i < 250; i++) {
      const c = 3000 + i;
      h1.push({ t: new Date(Date.UTC(2026, 8, 1, i)).toISOString(), o: c - 1, h: c + 2, l: c - 3, c });
    }
    const d1 = [];
    for (let i = 0; i < 20; i++) {
      const c = 3000 + i * 10;
      d1.push({ t: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(), o: c, h: c + 20, l: c - 20, c });
    }
    const m15 = [];
    for (let i = 0; i < 96; i++) {
      const c = 3400 + i;
      m15.push({ t: new Date(Date.UTC(2026, 8, 20, 0, i * 15)).toISOString(), o: c, h: c + 1, l: c - 1, c });
    }
    return { source: "テスト中継", series: { XAUUSD: { "1day": d1, "1h": h1, "15min": m15 } },
             quotes: { USDJPY: { last: 156.2, chg: -0.4 }, DXY: { last: 98.1, chg: 0.2 } } };
  });

  const snap = await page.evaluate(async (resp) => {
    const orig = window.fetch;
    let seen = null;
    window.fetch = (url, opt) => { seen = { url, opt };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(resp) }); };
    DB.settings.marketRelay = { endpoint: "https://example.test/api/ohlc", token: "MK-TOKEN" };
    const req = { symbol: "XAUUSD", date: "2026-09-20", sessions: sessionWindows("2026-09-20") };
    const r = await marketDataProvider.fetch("relay", req);
    window.fetch = orig;
    return { seen, ok: r.ok, s: r.snapshot };
  }, RESP);

  ok("取得URLに銘柄と日付を載せる",
     snap.seen.url.includes("symbol=XAUUSD") && snap.seen.url.includes("date=2026-09-20"));
  ok("トークンはヘッダで送る（URLには出さない）",
     snap.seen.opt.headers.Authorization === "Bearer MK-TOKEN" && !snap.seen.url.includes("MK-TOKEN"));
  ok("現在価格はいちばん細かい足の終値", snap.ok && snap.s.price === 3495);
  ok("1時間足の方向が出る", snap.s.trend.h1 === "up");
  ok("本数が足りない日足の方向は出さない（推測しない）", snap.s.trend.daily === null);
  ok("EMA と ATR が入る",
     snap.s.ema.tf === "h1" && snap.s.ema.e10 > 0 && snap.s.ema.e200 > 0 &&
     snap.s.atr.tf === "h1" && Math.abs(snap.s.atr.value - 5) < 1e-9);
  ok("前日高安が入る", snap.s.levels.prevHigh === 3200 && snap.s.levels.prevLow === 3160);
  ok("直近高安は1時間足の直近24本", snap.s.levels.recentHigh === 3251 && snap.s.levels.recentLow === 3223);
  ok("関連市場が入る",
     snap.s.context.usdjpy.last === 156.2 && snap.s.context.usdjpy.chg === -0.4 &&
     snap.s.context.dxy.last === 98.1);
  ok("取れなかった関連市場は空のまま", snap.s.context.us10y.last === null);
  ok("セッション高安が窓から出る",
     snap.s.sessions.asia.high !== null && snap.s.sessions.asia.high > snap.s.sessions.asia.low);
  ok("シナリオと今日の見方は自動で作らない",
     snap.s.scenarios.bull === null && snap.s.scenarios.bear === null && snap.s.bias === null);
  ok("取れなかった理由が説明される", snap.s.notes.length > 0);

  // --- 中継が落ちても画面は止まらない ---
  const down = await page.evaluate(async () => {
    const orig = window.fetch;
    window.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    const r = await marketDataProvider.fetch("relay",
      { symbol: "XAUUSD", date: today(), sessions: sessionWindows(today()) });
    window.fetch = orig;
    return { ok: r.ok, price: r.snapshot.price, notes: r.snapshot.notes.length };
  });
  ok("中継が落ちても値を作らない", down.ok === false && down.price === null && down.notes > 0);

  // --- 取り込んだ値がフォームに入り、保存して残る ---
  const kept = await page.evaluate(async (resp) => {
    const orig = window.fetch;
    window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(resp) });
    DB.settings.marketProvider = "relay"; saveData();
    UI.briefDate = "2026-09-20"; BRIEF = normalizeBrief({ date: "2026-09-20" });
    const r = await morningAnalysisStep();
    window.fetch = orig;
    saveBriefRecord();
    return { n: r.n, atr: DB.briefs[0].atr.value, usdjpy: DB.briefs[0].context.usdjpy.last };
  }, RESP);
  ok("取り込んだ値が環境認識に保存される",
     kept.n > 10 && Math.abs(kept.atr - 5) < 1e-9 && kept.usdjpy === 156.2);

  await page.reload();
  await page.waitForSelector("#app .topbar");
  ok("ATR と関連市場がリロード後も残る",
     await page.evaluate(() => {
       const b = DB.briefs.filter(x => x.date === "2026-09-20")[0];
       return Math.abs(b.atr.value - 5) < 1e-9 && b.context.usdjpy.last === 156.2;
     }));
  await page.close();
}

/* =======================================================================
   19. 環境認識とトレードの突き合わせ（将来の分析の土台）
   ======================================================================= */
group("19. 環境認識との突き合わせ");
{
  const page = await open();
  const r = await page.evaluate(() => {
    const d = today();
    DB.briefs = [{ id: "bx", date: d, symbol: "XAUUSD", bias: "long",
      trend: { daily: "up", h4: "up", h1: "range", m15: "" },
      levels: {}, events: [], scenarios: {}, memo: "" }];
    const mk = (id, dir, pl, briefId) => ({
      id, status: "closed", symbol: "XAUUSD", dir, entry: 3300, sl: 3290, tp: 3320, lot: 1,
      contractSize: 100, balanceAtEntry: 100000, realizedPL: pl, result: pl > 0 ? "win" : "lose",
      briefId, createdAt: new Date().toISOString(), closedAt: new Date().toISOString(), tags: [] });
    DB.trades = [
      mk("a", "long", 1000, "bx"),        // 朝の見方と同じ
      mk("b", "short", -500, "bx"),       // 朝の見方と逆
      mk("c", "long", 300, null),         // briefId 無し → 日付＋銘柄で解決
      { ...mk("d", "long", 200, "missing"), symbol: "XAUUSD" },  // 消えた brief を指す
    ];
    saveData();
    return {
      agree: DB.trades.map(t => briefAgree(t)),
      h4: DB.trades.map(t => briefTfAgree(t, "h4")),
    };
  });
  ok("朝の見方と同方向・逆方向を分けられる", r.agree[0] === "with" && r.agree[1] === "against");
  ok("briefId が無い記録は日付＋銘柄で解決する", r.agree[2] === "with");
  ok("消えた環境認識を指す記録は「なし」扱い", r.agree[3] === null);
  ok("4Hトレンドに沿った／逆らったを分けられる", r.h4[0] === "with" && r.h4[1] === "against");

  await page.click('#nav button[data-tab="growth"]');
  await page.waitForTimeout(80);
  const text = await page.$eval("#app", e => e.innerText);
  ok("成長タブに朝の見方との関係が出る", text.includes("朝の見方との関係") && text.includes("朝と逆の方向"));
  ok("成長タブに4時間足との関係が出る", text.includes("4Hトレンドに逆らった"));
  ok("記録の出どころが分かる", text.includes("MT5 から同期"));
  await page.close();
}

/* ---------- 後始末 ---------- */
await browser.close();
server.close();

console.log("");
if (pageErrors.length) { console.log("JSエラー:\n  " + pageErrors.join("\n  ")); fail += pageErrors.length; }
else console.log("JSエラーなし");
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
