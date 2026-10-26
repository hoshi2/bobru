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
     head.cols.slice(-7).join(",") === "briefId,briefDate,trendDaily,trendH4,trendH1,trendM15,bias");
  ok("既存の列順が変わっていない", head.cols[0] === "id" && head.cols[head.cols.length - 8] === "tags");
  ok("環境認識の内容が書き出される", head.row.slice(-5).join(",") === "up,down,range,up,long");
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
  const seq = ["本日の損益", "直近30日 勝率", "環境認識", "FINTOKEI 状況"].map(k => order.indexOf(k));
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
     (await page.evaluate(() => marketDataProvider.list().map(p => p.name).join(","))) === "none,demo" &&
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
  await page.selectOption("#b_provider", "demo");
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
   14. 受信箱（Dell の MT5 履歴の自動取り込み。hoshi2/bob-bridge#21）
   Firestore は偽物に差し替え、boburu/<code>__inbox の items を読んで記録に入れる流れを確かめる
   ======================================================================= */
group("14. 受信箱の自動取り込み");
{
  const page = await open();
  const r = await page.evaluate(async () => {
    window.__fake = { doc:null, sets:[] };
    loadCloudCfg = () => ({ config:{ projectId:"test" }, code:"TESTCODE" });
    CLOUD.db = { collection:() => ({ doc:id => ({
      get: () => { const d = id === "TESTCODE__inbox" ? window.__fake.doc : null; return Promise.resolve({ exists:!!d, data:() => d }); },
      set: (v, opt) => { window.__fake.sets.push({ id, merge:!!(opt && opt.merge) });
        if (id === "TESTCODE__inbox") { let d = window.__fake.doc || {}; if (opt && opt.merge) d.consumed = Object.assign(d.consumed || {}, v.consumed || {}); else d = v; window.__fake.doc = d; }
        return Promise.resolve(); },
      onSnapshot: () => () => {} }) }) };
    CLOUD.ready = true;
    DB.trades = [];
    let acc = DB.accounts.filter(a => a.name === "Funded7")[0];
    if (!acc) { acc = JSON.parse(JSON.stringify(DB.accounts[0])); acc.id = "accF7"; acc.name = "Funded7"; acc.brokerIds = []; acc.currency = "JPY"; delete acc.closedReason; DB.accounts.push(acc); }
    acc.brokerIds = [];
    const nowMs = Date.now(), openedA = new Date(nowMs - 60 * 60000).toISOString(), closedA = new Date(nowMs - 30 * 60000).toISOString();
    // 保有中の計画（受信箱の 1001 と同じ銘柄・方向・近い価格と時刻 → 紐付く）
    DB.trades.push({ id:"openA", status:"open", accountId:acc.id, createdAt:openedA, updatedAt:openedA, savedAt:openedA, symbol:"XAUUSD", dir:"long", entry:4200, sl:4190, tp:4220, lot:1, tags:[] });
    const mk = (posId, o) => { const b = { posId, symbol:"GOLD", dir:"long", entry:4200, close:4210, lot:1, sl:4190, tp:null, fee:-700, swap:0, gross:100000, net:99300, brokerId:"999", currency:"JPY", account:"Funded7", source:"mt5", ...o }; b.dealId = "mt5:" + posId + ":" + b.closedAt; return b; };
    const items = {};
    const i1 = mk("1001", { openedAt:openedA, closedAt:closedA }); items[i1.dealId] = i1;
    const i2 = mk("1002", { openedAt:"2026-10-01T01:00:00.000Z", closedAt:"2026-10-01T02:00:00.000Z", dir:"short", entry:4300, close:4290, net:50000, gross:50700 }); items[i2.dealId] = i2;
    const i3 = mk("1003", { openedAt:"2026-10-02T01:00:00.000Z", closedAt:"2026-10-02T02:00:00.000Z", brokerId:"111", account:"Nope", currency:"USD" }); items[i3.dealId] = i3;   // 知らない口座名 → 自動で作る
    items["bad"] = { posId:"1004", symbol:"GOLD", dir:"long", openedAt:"2026-10-03T01:00:00.000Z" };                                                          // 壊れた1件
    window.__fake.doc = { app:"boburu-inbox", v:1, items, consumed:{} };
    await inboxCheck(true);
    const tA = findTrade("openA");
    const nope = DB.accounts.filter(a => a.name === "Nope")[0];
    const res1 = { trades:DB.trades.length, closed:DB.trades.filter(t => t.status === "closed").length, openA_status:tA.status, openA_pl:tA.realizedPL, openA_fee:tA.fee,
                   openA_deals:(tA.brokerDealIds || []).join(","), newNoPlan:DB.trades.filter(t => t.noPlan).length, brokerIds:acc.brokerIds.slice(),
                   consumed:Object.keys(window.__fake.doc.consumed || {}).sort(), waiting:INBOX.waiting, lastImported:INBOX.lastImported,
                   nope:nope ? { brokerIds:nope.brokerIds.slice(), currency:nope.currency, closed:!!nope.closedReason, trades:DB.trades.filter(t => t.accountId === nope.id).length } : null,
                   created:INBOX.createdAccounts.slice() };
    // 2回目：何も増えない
    INBOX.checkedAt = 0; await inboxCheck(true);
    const res2 = { trades:DB.trades.length, lastImported:INBOX.lastImported };
    // 他の端末が取り込み済み（consumed）の分は入れない
    const i5 = mk("1005", { openedAt:"2026-10-04T01:00:00.000Z", closedAt:"2026-10-04T02:00:00.000Z" }); window.__fake.doc.items[i5.dealId] = i5; window.__fake.doc.consumed[i5.dealId] = 1;
    INBOX.checkedAt = 0; await inboxCheck(true);
    const res3 = { trades:DB.trades.length };
    // 設定でオフにすると読まない
    DB.settings.inboxAuto = false;
    const i6 = mk("1006", { openedAt:"2026-10-05T01:00:00.000Z", closedAt:"2026-10-05T02:00:00.000Z" }); window.__fake.doc.items[i6.dealId] = i6;
    INBOX.checkedAt = 0; await inboxCheck(true);
    const res4 = { trades:DB.trades.length, on:inboxOn() };
    DB.settings.inboxAuto = true;
    // 同じ名前（Funded7）で別の口座番号 ＝ 口座を買い直した → 別口座「Funded7 (222)」を作り、種別・初期残高・ルールを前の Funded7 から引き継ぐ
    acc.initialBalance = 1234567; acc.type = "step1"; acc.rules.dailyLossPct = 4.5; acc.closedReason = "fail";
    const i7 = mk("1007", { openedAt:"2026-10-06T01:00:00.000Z", closedAt:"2026-10-06T02:00:00.000Z", brokerId:"222" }); window.__fake.doc.items[i7.dealId] = i7;
    INBOX.checkedAt = 0; await inboxCheck(true);
    const f2 = DB.accounts.filter(a => a.name === "Funded7 (222)")[0];
    const res6 = { trades:DB.trades.length, made:!!f2, brokerIds:f2 ? f2.brokerIds.slice() : [], init:f2 ? f2.initialBalance : null, type:f2 ? f2.type : null,
                   daily:f2 ? f2.rules.dailyLossPct : null, open:f2 ? !f2.closedReason : null, oldUntouched:acc.brokerIds.join() === "999",
                   inNew:f2 ? DB.trades.filter(t => t.accountId === f2.id).length : 0, consumed1007:!!window.__fake.doc.consumed[i7.dealId],
                   // 設定オフの間に届いていた 1006（口座番号 999）は、終了にした元の Funded7 に入る（別口座「Funded7 (999)」は作らない）
                   extra:DB.accounts.filter(a => a.name === "Funded7 (999)").length, inOld:DB.trades.filter(t => t.accountId === acc.id).length };
    acc.closedReason = null;
    // 設定 → 端末間の同期 に、オン/オフと「受信箱を確認」が出る
    TAB = "settings"; UI.settingsOpen.sync = true; render();
    const st = document.getElementById("cloudstatus");
    const res7 = { status:!!st, toggle:!!(st && st.querySelector("input[type=checkbox]")), text:(st && st.textContent) || "",
                   button:Array.prototype.some.call(document.querySelectorAll("#st_sync button"), b => b.textContent === "受信箱を確認") };
    // 記録タブの先頭に「更新」（受信箱を手で取りに行く）。同期オフでは出ない（hoshi2/bob-bridge#22）
    TAB = "trades"; render();
    const bar = document.getElementById("inboxbar");
    const res8 = { bar:!!bar, text:(bar && bar.textContent) || "", button:!!(bar && Array.prototype.some.call(bar.querySelectorAll("button"), b => b.textContent === "更新")) };
    const before = INBOX.checkedAt; INBOX.checkedAt = 0; inboxCheckUI(); await new Promise(r => setTimeout(r, 50));
    res8.checked = INBOX.checkedAt > before;
    const keepCfg = loadCloudCfg; loadCloudCfg = () => null; render();
    res8.offHidden = !document.getElementById("inboxbar");
    loadCloudCfg = keepCfg;
    return { res1, res2, res3, res4, res6, res7, res8 };
  });
  // 記録は 保有中だった openA（紐付けで決済済みに）＋ 計画なしの新規 1 件 ＋ 自動で作った口座「Nope」に 1 件 ＝ 3 件。壊れた1件は入らない
  ok("3件入り、壊れた1件は入らない", r.res1.trades === 3 && r.res1.closed === 3 && r.res1.newNoPlan === 2);
  ok("近い保有中の計画に紐付き、確定損益は手数料込みの net", r.res1.openA_status === "closed" && r.res1.openA_pl === 99300 && r.res1.openA_fee === -700 && r.res1.openA_deals.startsWith("mt5:1001:"));
  ok("口座番号を記憶する", r.res1.brokerIds.join() === "999");
  ok("知らない口座名は口座を自動で作って入れる（通貨・口座番号つき）", !!r.res1.nope && r.res1.nope.brokerIds.join() === "111" && r.res1.nope.currency === "USD" && !r.res1.nope.closed && r.res1.nope.trades === 1 && r.res1.created.join() === "Nope");
  ok("取り込んだ分だけ consumed に印が付く", r.res1.consumed.length === 3 && r.res1.consumed.every(k => /^mt5:100[123]:/.test(k)) && r.res1.waiting === 0 && r.res1.lastImported === 3);
  ok("2回目は何も増えない", r.res2.trades === 3 && r.res2.lastImported === 0);
  ok("他の端末が取り込み済みの分は入れない", r.res3.trades === 3);
  ok("設定でオフにすると読まない", r.res4.trades === 3 && r.res4.on === false);
  // 1006（オフの間に届いた分）は元の Funded7 へ、1007（別の口座番号）は新しい口座へ → 記録は 3 + 2 = 5
  ok("同じ名前で別の口座番号は新しい口座「Funded7 (222)」になる", r.res6.made && r.res6.brokerIds.join() === "222" && r.res6.open && r.res6.oldUntouched && r.res6.inNew === 1 && r.res6.trades === 5 && r.res6.consumed1007);
  ok("記憶済みの口座番号は、口座を終了にしていてもその口座に入る（別口座を作らない）", r.res6.extra === 0 && r.res6.inOld === 3);
  ok("新しい口座は前の Funded7 から種別・初期残高・ルールを引き継ぐ", r.res6.init === 1234567 && r.res6.type === "step1" && r.res6.daily === 4.5);
  ok("記録タブの先頭に受信箱の状態と「更新」が出て、押すと受信箱を確認する。同期オフでは出ない", r.res8.bar && r.res8.text.includes("最終確認") && r.res8.button && r.res8.checked && r.res8.offHidden);
  ok("設定の同期欄に 受信箱のオン/オフ・状態・「受信箱を確認」が出る", r.res7.status && r.res7.toggle && r.res7.text.includes("受信箱") && r.res7.text.includes("最終確認") && r.res7.button);
  await page.close();
}

/* =======================================================================
   15. 口座の削除と、設定の並び（取り込み・版番号を外した）
   ======================================================================= */
group("15. 口座の削除と設定の並び");
{
  const page = await open(1200, 800);
  page.on("dialog", d => d.accept());
  const r = await page.evaluate(() => {
    TAB = "settings"; UI.settingsOpen = UI.settingsOpen || {}; UI.settingsOpen.accounts = true; render();
    const ids = Array.from(document.querySelectorAll("details.st")).map(d => d.id);
    const first = DB.accounts[0];
    const a2 = makeAccount({ name:"空の口座", type:"step1", initialBalance:1000, currency:"USD" }); DB.accounts.push(a2);
    const a3 = makeAccount({ name:"合格した口座", type:"live", initialBalance:1000, currency:"USD" }); a3.closedReason = "pass"; DB.accounts.push(a3);
    DB.trades.push({ id:"t3", status:"closed", accountId:a3.id, createdAt:"2026-10-01T01:00:00.000Z", closedAt:"2026-10-01T02:00:00.000Z", symbol:"XAUUSD", dir:"long", entry:4200, lot:1, realizedPL:100, tags:[] });
    DB.tradePlans.push({ id:"p3", status:"draft", accountId:a3.id, createdAt:"2026-10-01T01:00:00.000Z", symbol:"XAUUSD", dir:"long", tags:[] });
    IMG["t3_entry"] = "data:,x";
    saveData(); render();
    const body = document.querySelector("#st_accounts .body");
    const closedBox = document.getElementById("closedaccts");
    const rows = Array.from(body.querySelectorAll(".acc-row"));
    const res = { ids, closedBox:!!closedBox, closedText:closedBox ? closedBox.textContent : "",
                  activeNames:rows.filter(r => !closedBox || !closedBox.contains(r)).map(r => r.querySelector("b").textContent),
                  deleteButtons:rows.filter(r => Array.from(r.querySelectorAll("button")).some(b => b.textContent === "削除")).length };
    // 最後の1口座は消せない
    DB.accounts = [first]; deleteAccount(first.id); res.lastKept = DB.accounts.length === 1 && !!findAccount(first.id);
    DB.accounts = [first, a2, a3];
    // 記録の無い口座は確認1回で消える
    deleteAccount(a2.id); res.emptyGone = !findAccount(a2.id);
    // 終了した口座を消すと、その記録・下書き・画像も消え、墓標が残る（他の端末からも消える）
    deleteAccount(a3.id);
    const dead = (DB.syncMetadata && DB.syncMetadata.deleted) || {};
    res.closedGone = !findAccount(a3.id) && !findTrade("t3") && !DB.tradePlans.some(p => p.id === "p3") && !IMG["t3_entry"] && !!dead[a3.id] && !!dead["t3"] && !!dead["p3"];
    res.current = currentAccountId() === first.id;
    res.saved = JSON.parse(localStorage.getItem("boburu_v1")).accounts.length === 1;
    return res;
  });
  ok("設定に「取引履歴の取り込み」「版番号」が無い", !r.ids.includes("st_import") && !r.ids.includes("st_versions") && r.ids.includes("st_accounts") && r.ids.includes("st_sync"));
  ok("稼働中の口座だけが並び、終了した口座は折りたたみに移る", r.closedBox && r.closedText.includes("終了した口座（1）") && r.closedText.includes("合格した口座") && !r.activeNames.includes("合格した口座") && r.activeNames.includes("空の口座"));
  ok("どの口座にも「削除」がある", r.deleteButtons === 3);
  ok("最後の1口座は消せない", r.lastKept);
  ok("記録の無い口座は消える", r.emptyGone);
  ok("終了した口座を消すと記録・下書き・画像も消え、墓標が残る", r.closedGone);
  ok("いまの口座は残り、保存される", r.current && r.saved);
  await page.close();
}

/* =======================================================================
   16. 受信箱の open（Dell が送る建玉中 → 「保有中」に自動で出す。hoshi2/bob-bridge#28）
   ======================================================================= */
group("16. 受信箱の建玉中を保有中に出す");
{
  const page = await open();
  const r = await page.evaluate(async () => {
    window.__fake = { doc:null };
    loadCloudCfg = () => ({ config:{ projectId:"test" }, code:"TESTCODE" });
    CLOUD.db = { collection:() => ({ doc:id => ({
      get: () => { const d = id === "TESTCODE__inbox" ? window.__fake.doc : null; return Promise.resolve({ exists:!!d, data:() => d }); },
      set: (v, opt) => { if (id === "TESTCODE__inbox") { const d = window.__fake.doc || {}; d.consumed = Object.assign(d.consumed || {}, v.consumed || {}); window.__fake.doc = d; } return Promise.resolve(); },
      onSnapshot: () => () => {} }) }) };
    CLOUD.ready = true;
    DB.trades = [];
    DB.accounts.forEach(a => { a.brokerIds = []; });
    let f7 = DB.accounts.filter(a => a.name === "Funded7")[0];
    if (!f7) { f7 = makeAccount({ name:"Funded7", type:"step1", initialBalance:1000000, currency:"JPY" }); DB.accounts.push(f7); }
    let fk = DB.accounts.filter(a => a.name === "Fintokei")[0];
    if (!fk) { fk = makeAccount({ name:"Fintokei", type:"step1", initialBalance:2000000, currency:"JPY" }); DB.accounts.push(fk); }
    delete f7.closedReason; delete fk.closedReason;
    const nAcc = DB.accounts.length;
    const nowMs = Date.now(), t1 = new Date(nowMs - 90 * 60000).toISOString(), t2 = new Date(nowMs - 20 * 60000).toISOString();
    // 手で先に書いた保有中の計画（2002 と同じ銘柄・方向・近い価格と時刻 → 紐付く）
    DB.trades.push({ id:"planB", status:"open", accountId:f7.id, createdAt:t2, updatedAt:t2, savedAt:t2, symbol:"XAUUSD", dir:"short", entry:4301, sl:4320, tp:4250, lot:0.5, h4env:"down", tags:[] });
    const op = (posId, o) => ({ posId, symbol:"XAUUSD", dir:"long", openedAt:t1, openedAtServer:"x", entry:4200, lot:1, sl:4190, tp:null, swap:0,
                                comment:null, magic:null, brokerId:"999", currency:"JPY", account:"Funded7", seenAt:t2, source:"mt5", ...o });
    window.__fake.doc = { app:"boburu-inbox", v:1, items:{}, consumed:{}, open:{
      "2001": op("2001", {}),
      "2002": op("2002", { dir:"short", entry:4300, lot:0.5, openedAt:t2, sl:null, tp:4250 }),
      "3001": op("3001", { brokerId:"555", account:"Fintokei", entry:4100, lot:0.2 }),
      "bad":  { posId:"2009", symbol:"GOLD" } } };
    await inboxCheck(true);
    const a = findTrade("mt5o_999_2001"), b = findTrade("planB"), c = findTrade("mt5o_555_3001");
    const res1 = { n:DB.trades.length, open:DB.trades.filter(t => t.status === "open").length,
                   a:a && { st:a.status, noPlan:!!a.noPlan, pos:a.mt5PosId, sl:a.sl, acc:a.accountId === f7.id, created:a.createdAt, bal:a.balanceAtEntry },
                   b:b && { pos:b.mt5PosId, entry:b.entry, planned:b.plannedEntry, sl:b.sl, h4:b.h4env, src:b.source },
                   c:c && { acc:c.accountId === fk.id }, fkIds:(fk.brokerIds || []).join(), accs:DB.accounts.length - nAcc, lastOpen:INBOX.lastOpen };
    // 記録タブの保有中に出る
    TAB = "trades"; UI.tradeTab = "open"; render();
    const txt = document.body.textContent;
    res1.view = { hasMt5:txt.includes("MT5"), hasNoPlan:txt.includes("計画なし"), hasF7:txt.includes("XAUUSD") };
    // 2回目：増えない
    INBOX.checkedAt = 0; await inboxCheck(true);
    const res2 = { n:DB.trades.length };
    // MT5 で SL を建値へ動かした → 記録の sl は最初のまま、札で今の SL を見せる
    window.__fake.doc.open["2001"].sl = 4200;
    INBOX.checkedAt = 0; await inboxCheck(true);
    const res3 = { sl:a.sl, mt5Sl:a.mt5Sl, pill:tradePills(a).some(p => p === "MT5 の今の SL 4200") };
    // 消した記録は作り直さない
    deleteTradeQuiet = id => { DB.trades = DB.trades.filter(t => t.id !== id); saveData(); };
    deleteTradeQuiet("mt5o_555_3001");
    INBOX.checkedAt = 0; await inboxCheck(true);
    const res4 = { back:!!findTrade("mt5o_555_3001"), dead:!!cloudDead()["mt5o_555_3001"] };
    // 決済：2001 が items に届き、open から消える → 同じ記録が決済済みになる（手で「決済登録」していても二重にしない）
    a.status = "closed"; a.realizedPL = 1; a.result = "win";   // 手で決済登録した
    delete window.__fake.doc.open["2001"];
    const closedA = new Date(nowMs - 5 * 60000).toISOString();
    const it = { posId:"2001", symbol:"GOLD", dir:"long", openedAt:t1, closedAt:closedA, entry:4200, close:4210, lot:1, sl:4190, tp:null,
                 fee:-700, swap:0, gross:100000, net:99300, brokerId:"999", currency:"JPY", account:"Funded7", source:"mt5" };
    it.dealId = "mt5:2001:" + closedA; window.__fake.doc.items[it.dealId] = it;
    INBOX.checkedAt = 0; await inboxCheck(true);
    const res5 = { n:DB.trades.length, st:a.status, pl:a.realizedPL, deals:(a.brokerDealIds || []).join(), consumed:!!window.__fake.doc.consumed[it.dealId] };
    // 決済済みになったあとで古い open が届いても、保有中を作り直さない
    window.__fake.doc.open["2001"] = op("2001", {});
    INBOX.checkedAt = 0; await inboxCheck(true);
    const res6 = { n:DB.trades.length, st:a.status };
    return { res1, res2, res3, res4, res5, res6 };
  });
  ok("建玉中が「保有中」に入る（計画なし・決め打ち id・口座 Funded7・残高つき）", !!r.res1.a && r.res1.a.st === "open" && r.res1.a.noPlan && r.res1.a.pos === "2001" && r.res1.a.sl === 4190 && r.res1.a.acc && typeof r.res1.a.bal === "number");
  ok("手で書いた近い計画には紐付ける（根拠は残り、事実で上書き・計画の値は plannedEntry）", !!r.res1.b && r.res1.b.pos === "2002" && r.res1.b.entry === 4300 && r.res1.b.planned === 4301 && r.res1.b.sl === 4320 && r.res1.b.h4 === "down" && r.res1.b.src === "mt5");
  ok("Fintokei の建玉は既存の「Fintokei」口座に入り、口座番号を記憶（口座は増えない）", !!r.res1.c && r.res1.c.acc && r.res1.fkIds === "555" && r.res1.accs === 0);
  ok("壊れた1件は入らず、件数が合う", r.res1.n === 3 && r.res1.open === 3 && r.res1.lastOpen === 3);
  ok("2回目は増えない", r.res2.n === 3);
  ok("MT5 で SL を動かしても記録の SL（R の元）は最初のまま、札で今の SL を出す", r.res3.sl === 4190 && r.res3.mt5Sl === 4200 && r.res3.pill);
  ok("消した保有中は作り直さない（墓標）", !r.res4.back && r.res4.dead);
  ok("決済が届くと同じ記録が決済済みになり、手の決済登録より事実が勝つ（二重にならない）", r.res5.n === 2 && r.res5.st === "closed" && r.res5.pl === 99300 && r.res5.deals.startsWith("mt5:2001:") && r.res5.consumed);
  ok("決済済みのあとに古い建玉が届いても作り直さない", r.res6.n === 2 && r.res6.st === "closed");
  ok("記録タブの保有中に MT5・計画なしの札で出る", r.res1.view.hasMt5 && r.res1.view.hasNoPlan && r.res1.view.hasF7);
  await page.close();
}

/* =======================================================================
   17. SL / TP の動き（Dell の見張り。hoshi2/bob-bridge#29）
   ======================================================================= */
group("17. SL / TP の動き");
{
  const page = await open(1200, 800);
  const r = await page.evaluate(async () => {
    window.__fake = { doc:null };
    loadCloudCfg = () => ({ config:{ projectId:"test" }, code:"TESTCODE" });
    CLOUD.db = { collection:() => ({ doc:id => ({
      get: () => { const d = id === "TESTCODE__inbox" ? window.__fake.doc : null; return Promise.resolve({ exists:!!d, data:() => d }); },
      set: (v, opt) => { if (id === "TESTCODE__inbox") { const d = window.__fake.doc || {}; d.consumed = Object.assign(d.consumed || {}, v.consumed || {}); window.__fake.doc = d; } return Promise.resolve(); },
      onSnapshot: () => () => {} }) }) };
    CLOUD.ready = true;
    DB.trades = [];
    DB.accounts.forEach(a => { a.brokerIds = []; });
    let f7 = DB.accounts.filter(a => a.name === "Funded7")[0];
    if (!f7) { f7 = makeAccount({ name:"Funded7", type:"step1", initialBalance:1000000, currency:"JPY" }); DB.accounts.push(f7); }
    delete f7.closedReason; DB.settings.currentAccountId = f7.id;
    const t1 = "2026-10-15T01:00:00.000Z", mv = (at, sl, tp) => ({ at, sl, tp });
    const base = { symbol:"GOLD", dir:"long", openedAt:t1, entry:4200, close:4210, lot:1, fee:0, swap:0, gross:1000, net:1000, brokerId:"999", currency:"JPY", account:"Funded7", source:"mt5", closeReason:"client" };
    const item = (posId, closedAt, o) => { const b = { posId, closedAt, ...base, ...o }; b.dealId = "mt5:" + posId + ":" + closedAt; return b; };
    const items = {};
    // 4001: 手で途中決済。注文時は SL なし → 後から 4190、建値 4200 へ
    const a = item("4001", "2026-10-15T02:00:00.000Z", { sl:4190, tp:4250, slFirst:4190, tpFirst:4250, slLast:4200, tpLast:4250,
      sltpMoves:[mv("2026-10-15T01:00:10.000Z", null, null), mv("2026-10-15T01:01:00.000Z", 4190, 4250), mv("2026-10-15T01:30:00.000Z", 4200, 4250)] });
    // 4002: SL を広げた（4190 → 4180）
    const b = item("4002", "2026-10-15T03:00:00.000Z", { openedAt:"2026-10-15T02:30:00.000Z", sl:4190, tp:null, slFirst:4190, slLast:4180, tpFirst:null, tpLast:null,
      sltpMoves:[mv("2026-10-15T02:30:30.000Z", 4190, null), mv("2026-10-15T02:40:00.000Z", 4180, null)] });
    // 4003: 見張りの記録なし（今までどおり）
    const c = item("4003", "2026-10-15T04:00:00.000Z", { openedAt:"2026-10-15T03:30:00.000Z", sl:null, tp:null });
    [a, b, c].forEach(x => { items[x.dealId] = x; });
    window.__fake.doc = { app:"boburu-inbox", v:1, items, consumed:{}, open:{} };
    await inboxCheck(true);
    const tid = p => DB.trades.filter(t => (t.brokerDealIds || []).some(d => d.startsWith("mt5:" + p + ":")))[0];
    const A = tid("4001"), B = tid("4002"), C = tid("4003");
    const res1 = { n:DB.trades.length,
      A:A && { sl:A.sl, tp:A.tp, last:A.slLast, moves:(A.sltpMoves || []).length, kind:slMoveKind(A), pills:tradePills(A), r:calcTrade(A).realizedR,
           rFirst:calcTrade(Object.assign({}, A, { sl:4190 })).realizedR, rLast:calcTrade(Object.assign({}, A, { sl:4199.9 })).realizedR },
      B:B && { sl:B.sl, kind:slMoveKind(B), pills:tradePills(B) },
      C:C && { sl:C.sl, kind:slMoveKind(C), has:"sltpMoves" in C } };
    // 計画に紐付く場合：計画の SL は残し、空なら最初の値で埋める
    DB.trades.push({ id:"planP", status:"open", accountId:f7.id, createdAt:"2026-10-16T01:00:00.000Z", updatedAt:"x", savedAt:"x", symbol:"XAUUSD", dir:"short", entry:4300, sl:null, tp:4250, lot:1, tags:[] });
    const p = item("4004", "2026-10-16T02:00:00.000Z", { openedAt:"2026-10-16T01:01:00.000Z", dir:"short", entry:4300, close:4290, sl:4310, slFirst:4310, slLast:4300, tpFirst:4250, tpLast:4250,
      sltpMoves:[mv("2026-10-16T01:01:30.000Z", 4310, 4250), mv("2026-10-16T01:20:00.000Z", 4300, 4250)] });
    window.__fake.doc.items[p.dealId] = p;
    INBOX.checkedAt = 0; await inboxCheck(true);
    const P = findTrade("planP");
    const res2 = { st:P.status, sl:P.sl, tp:P.tp, kind:slMoveKind(P) };
    // 建玉中：MT5 で SL を外した（一度は入っていた）→「外した」。まだ入れていないだけなら札なし
    window.__fake.doc.open = {
      "5001": { posId:"5001", symbol:"XAUUSD", dir:"long", openedAt:"2026-10-17T01:00:00.000Z", entry:4200, lot:1, sl:null, tp:null, swap:0, brokerId:"999", currency:"JPY", account:"Funded7", source:"mt5",
                slFirst:4190, tpFirst:null, sltpMoves:[mv("2026-10-17T01:00:30.000Z", 4190, null), mv("2026-10-17T01:10:00.000Z", null, null)] },
      "5002": { posId:"5002", symbol:"XAUUSD", dir:"long", openedAt:"2026-10-17T02:00:00.000Z", entry:4220, lot:1, sl:null, tp:null, swap:0, brokerId:"999", currency:"JPY", account:"Funded7", source:"mt5",
                sltpMoves:[mv("2026-10-17T02:00:30.000Z", null, null)] } };
    INBOX.checkedAt = 0; await inboxCheck(true);
    const O1 = findTrade("mt5o_999_5001"), O2 = findTrade("mt5o_999_5002");
    const res3 = { o1:O1 && { sl:O1.sl, kind:slMoveKind(O1) }, o2:O2 && { kind:slMoveKind(O2) } };
    // 分析に「SL の動かし方」と、逸脱の中身に「SLを広げた・外した」
    TAB = "growth"; UI.growthPeriod = "all"; render();
    const txt = document.body.textContent;
    const res4 = { table:txt.includes("SL の動かし方"), dev:txt.includes("SLを広げた・外した"), be:txt.includes("を建値へ") };
    return { res1, res2, res3, res4 };
  });
  ok("途中決済でも SL/TP が入る（記録の SL は最初の 4190、最後 4200、動き 3）", !!r.res1.A && r.res1.A.sl === 4190 && r.res1.A.tp === 4250 && r.res1.A.last === 4200 && r.res1.A.moves === 3);
  ok("建値へ動かした取引に「SL を建値へ」の札、R は最初の SL（4190）で計算", r.res1.A.kind === "be" && r.res1.A.pills.includes("SL を建値へ") && typeof r.res1.A.r === "number" && Math.abs(r.res1.A.r - r.res1.A.rFirst) < 1e-9 && r.res1.A.r !== r.res1.A.rLast);
  ok("広げた取引に「SL を広げた」の札", !!r.res1.B && r.res1.B.sl === 4190 && r.res1.B.kind === "widen" && r.res1.B.pills.includes("SL を広げた"));
  ok("見張りの記録が無い取引は今までどおり（札なし）", !!r.res1.C && r.res1.C.sl === null && r.res1.C.kind === null && !r.res1.C.has && r.res1.n === 3);
  ok("計画に紐付く取引は、空の SL だけ最初の値で埋め、計画の TP は残す", r.res2.st === "closed" && r.res2.sl === 4310 && r.res2.tp === 4250 && r.res2.kind === "be");
  ok("建玉中に SL を外すと「外した」、まだ入れていないだけなら札なし", !!r.res3.o1 && r.res3.o1.sl === 4190 && r.res3.o1.kind === "removed" && !!r.res3.o2 && r.res3.o2.kind === null);
  ok("分析に「SL の動かし方」と「SLを広げた・外した」が出る", r.res4.table && r.res4.dev && r.res4.be);
  await page.close();
}

group("18. 端末ごとの既定口座が同期で増えない");
{
  const page = await open(1200, 800);
  const r = await page.evaluate(() => {
    const res = { firstId: DB.accounts[0].id, n0: DB.accounts.length };
    // 別の端末で使っている口座が入ったクラウド（acc_default は無い）
    const remoteOf = accs => { const d = JSON.parse(JSON.stringify(DB)); d.accounts = accs; d.trades = []; d.tradePlans = []; return d; };
    const X = makeAccount({ name:"Fintokei", type:"step1", initialBalance:1000, currency:"JPY" }); X._m = Date.now() - 1000;
    const Y = makeAccount({ name:"Funded7", type:"live", initialBalance:1000, currency:"JPY" }); Y._m = Date.now() - 1000;
    DB.settings.theme = DB.settings.theme === "dark" ? "light" : "dark"; saveData();   // 何か触った端末（初回の丸ごと置き換えにならない）
    cloudApplyRemote({ data: JSON.stringify(remoteOf([X, Y])) }, false);
    saveData();
    res.a = { ids: DB.accounts.map(a => a.id), cur: DB.settings.currentAccountId, tomb: !!cloudDead()["acc_default"], X: X.id, Y: Y.id };
    // 既定口座に取引がある端末：外さない
    DB = defaultDB(); cloudSeenReset();
    DB.trades.push({ id:"tq", status:"closed", accountId:"acc_default", createdAt:"2026-10-20T01:00:00.000Z", closedAt:"2026-10-20T02:00:00.000Z", symbol:"XAUUSD", dir:"long", entry:4200, lot:1, realizedPL:100, tags:[] });
    saveData();
    cloudApplyRemote({ data: JSON.stringify(remoteOf([X, Y])) }, false);
    res.b = { ids: DB.accounts.map(a => a.id) };
    // クラウドに acc_default がある（ほかの新しい端末が使っている）：1件にまとまる
    DB = defaultDB(); cloudSeenReset(); saveData();
    const D = makeAccount({ id:"acc_default", name:"Fintokei", type:"step1", initialBalance:2000, currency:"JPY" }); D._m = Date.now() + 1000;
    cloudApplyRemote({ data: JSON.stringify(remoteOf([D, Y])) }, false);
    res.c = { ids: DB.accounts.map(a => a.id), bal: findAccount("acc_default").initialBalance };
    return res;
  });
  ok("新しい端末の最初の口座は決め打ちの id（acc_default）", r.firstId === "acc_default" && r.n0 === 1);
  ok("クラウドに口座があり、最初の口座が空なら外す（墓標は残さない・いまの口座はクラウドの口座へ）", r.a.ids.length === 2 && !r.a.ids.includes("acc_default") && r.a.cur === r.a.X && !r.a.tomb);
  ok("最初の口座に取引があれば外さない", r.b.ids.length === 3 && r.b.ids.includes("acc_default"));
  ok("クラウドにも acc_default があれば1件にまとまる（新しい方が勝つ）", r.c.ids.length === 2 && r.c.ids.filter(i => i === "acc_default").length === 1 && r.c.bal === 2000);
  await page.close();
}

group("19. 初期化・復元・入り直しで全端末の記録が消えない");
{
  const page = await open(1200, 800);
  page.on("dialog", d => d.accept());
  const r = await page.evaluate(() => {
    const T = (id, acc, m) => ({ id, status:"closed", accountId:acc, createdAt:"2026-10-17T01:00:00.000Z", closedAt:"2026-10-17T02:00:00.000Z", symbol:"XAUUSD", dir:"long", entry:4200, lot:1, realizedPL:10, tags:[], _m:m });
    const acc = DB.accounts[0].id, old = Date.now() - 86400000;
    const fill = n => { DB.trades = []; for (let i = 0; i < n; i++) DB.trades.push(T("tr" + i, acc, old)); };
    const copy = () => JSON.parse(JSON.stringify(DB));
    const res = {};
    // #32 の再現：記録を見たあと（同期は解除中）全データ削除 → 入り直して合わせる
    fill(15); saveData(); cloudSeenReset();
    const cloud = copy();
    wipeAll();
    res.wipe = { dead: Object.keys(cloudDead()).length };
    cloudApplyRemote({ data: JSON.stringify(cloud) }, false);
    res.wipe.back = DB.trades.length; res.wipe.blocked = CLOUD.blocked;
    // 復元（JSON）も墓標を作らない
    fill(15); saveData(); cloudSeenReset();
    const r1 = importData(JSON.stringify({ trades: [], settings: DB.settings, accounts: DB.accounts }));
    res.imp = { ok: r1.ok, dead: Object.keys(cloudDead()).length };
    // 自分の墓標で相手の記録が 12 件消える → 止める（自分も相手もそのまま）
    fill(12); saveData(); cloudSeenReset(); const c2 = copy();
    DB.trades = []; saveData();
    const dead2 = Object.keys(cloudDead()).length;
    cloudApplyRemote({ data: JSON.stringify(c2) }, false);
    res.mine = { dead2, blocked: CLOUD.blocked, local: DB.trades.length, err: CLOUD.error.includes("止めました") };
    CLOUD.blocked = 0; CLOUD.error = ""; DB.syncMetadata.deleted = {};
    // 相手の墓標で自分の記録が 12 件消える → 止める
    fill(12); saveData(); cloudSeenReset();
    const c3 = copy(); c3.trades = []; c3.syncMetadata.deleted = {}; DB.trades.forEach(t => c3.syncMetadata.deleted[t.id] = Date.now());
    cloudApplyRemote({ data: JSON.stringify(c3) }, false);
    res.theirs = { blocked: CLOUD.blocked, local: DB.trades.length };
    CLOUD.blocked = 0; CLOUD.error = "";
    // 口座の削除（取引 15 件ごと）は止めずに伝わる
    DB.syncMetadata.deleted = {}; fill(0);
    const Z = makeAccount({ name:"消す口座", type:"step1", initialBalance:1000, currency:"USD" }); Z._m = old; DB.accounts.push(Z);
    for (let i = 0; i < 15; i++) DB.trades.push(T("tz" + i, Z.id, old));
    saveData(); cloudSeenReset(); const c4 = copy();
    const dz = {}; dz[Z.id] = Date.now(); DB.trades.forEach(t => dz[t.id] = Date.now());
    c4.accounts = c4.accounts.filter(a => a.id !== Z.id); c4.trades = []; c4.syncMetadata.deleted = dz;
    cloudApplyRemote({ data: JSON.stringify(c4) }, false);
    res.acc = { blocked: CLOUD.blocked, local: DB.trades.length, accGone: !findAccount(Z.id) };
    // 1件の削除は今までどおり伝わる
    fill(3); saveData(); cloudSeenReset(); const c5 = copy();
    DB.trades = DB.trades.slice(1); saveData();
    cloudApplyRemote({ data: JSON.stringify(c5) }, false);
    res.one = { blocked: CLOUD.blocked, local: DB.trades.length };
    return res;
  });
  ok("全データ削除は墓標を作らず、入り直すとクラウドの記録が全部戻る（#32 の再現）", r.wipe.dead === 0 && r.wipe.back === 15 && !r.wipe.blocked);
  ok("JSON から復元しても墓標を作らない", r.imp.ok && r.imp.dead === 0);
  ok("自分の墓標で相手の記録が 10 件以上消える同期は止め、どちらもそのまま", r.mine.dead2 === 12 && r.mine.blocked === 12 && r.mine.local === 0 && r.mine.err);
  ok("相手の墓標で自分の記録が 10 件以上消える同期は止め、自分の記録は残る", r.theirs.blocked === 12 && r.theirs.local === 12);
  ok("口座の削除（取引ごと）は止めずに伝わる", !r.acc.blocked && r.acc.local === 0 && r.acc.accGone);
  ok("1件の削除は今までどおり伝わる", !r.one.blocked && r.one.local === 2);
  await page.close();
}

/* =======================================================================
   16. 受信箱の取り込みで、口座の通貨に合ったレートが付く（R が 150 倍になった 2026-10-21 の直し）
   ======================================================================= */
group("16. 受信箱の記録に口座通貨のレートが付く");
{
  const page = await open(1200, 800);
  const r = await page.evaluate(() => {
    const usd = DB.accounts[0]; usd.currency = "USD"; DB.settings.currency = "USD";          // いまの口座は USD
    const jpy = makeAccount({ name:"Funded7", type:"live", initialBalance:60000000, currency:"JPY" }); DB.accounts.push(jpy);
    DB.settings.fx.rate = null; DB.settings.fx.quote = ""; DB.settings.fx.manual = null;        // レートはまだ無い
    const g = { symbol:"XAUUSD", dir:"short", openedAt:"2026-10-21T05:00:00.000Z", closedAt:"2026-10-21T05:56:00.000Z", entry:4127.014, closePrice:4112.7, lot:2, net:285684, gross:286384, fee:-700, swap:0, sl:4131.61, tp:null, dealIds:["mt5:1:x"], orderIds:[], balance:null, posId:"1" };
    ctiCommit({ accountId:jpy.id, groups:[g], choices:{ 0:"new" }, stmt:{ platform:"mt5", brokerId:"777" }, remember:false });
    const t1 = DB.trades.filter(t => t.accountId === jpy.id)[0];
    const s1 = { fx:t1.fxRate, pending:!!t1.fxPending, R:calcTrade(t1).realizedR };
    DB.settings.fx.rate = 158.22; DB.settings.fx.quote = "JPY"; DB.settings.fx.at = now();     // レートが取れた
    resolvePendingFx();
    const s2 = { fx:t1.fxRate, pending:!!t1.fxPending, R:+calcTrade(t1).realizedR.toFixed(2) };
    const g2 = Object.assign({}, g, { posId:"2", dealIds:["mt5:2:x"], closedAt:"2026-10-21T06:00:00.000Z" });
    ctiCommit({ accountId:jpy.id, groups:[g2], choices:{ 0:"new" }, stmt:{ platform:"mt5", brokerId:"777" }, remember:false });
    const t2 = DB.trades.filter(t => t.accountId === jpy.id && t !== t1)[0];
    const s3 = { fx:t2.fxRate, pending:!!t2.fxPending };
    // 既存データの直し：fx が null の JPY 記録は migrate で待ちになり、レートで埋まる。fx=1 の古い記録と USD建てでない銘柄は触らない
    DB.trades.push(
      { id:"bad1", status:"closed", accountId:jpy.id, createdAt:"2026-10-20T01:00:00.000Z", closedAt:"2026-10-20T02:00:00.000Z", symbol:"XAUUSD", dir:"short", entry:4120.27, sl:4127.92, lot:2, realizedPL:139584, fxRate:null, acctCurrency:"JPY", contractSize:100, tags:[] },
      { id:"old1", status:"closed", accountId:jpy.id, createdAt:"2026-09-01T01:00:00.000Z", closedAt:"2026-09-01T02:00:00.000Z", symbol:"XAUUSD", dir:"long", entry:3300, sl:3290, lot:1, realizedPL:1000, fxRate:1, acctCurrency:"JPY", contractSize:100, tags:[] },
      { id:"nk1", status:"closed", accountId:jpy.id, createdAt:"2026-10-21T01:00:00.000Z", closedAt:"2026-10-21T02:00:00.000Z", symbol:"JP225P", dir:"short", entry:64572, sl:null, lot:20, realizedPL:-216, fxRate:null, acctCurrency:"JPY", contractSize:100, tags:[] });
    const db2 = migrate(JSON.parse(JSON.stringify(DB)));
    const f = id => db2.trades.filter(t => t.id === id)[0];
    const s4 = { badPending:!!f("bad1").fxPending, oldUntouched:f("old1").fxRate === 1 && !f("old1").fxPending, nkUntouched:!f("nk1").fxPending };
    DB = db2; resolvePendingFx();
    const s5 = { fx:findTrade("bad1").fxRate, R:+calcTrade(findTrade("bad1")).realizedR.toFixed(2) };
    return { s1, s2, s3, s4, s5 };
  });
  ok("レートが無いときは待ちになり、R は出さない", r.s1.fx === null && r.s1.pending && r.s1.R === null);
  ok("レートが取れると待っていた記録に入り、R がまともになる（いまの口座が USD のままでも）", r.s2.fx === 158.22 && !r.s2.pending && r.s2.R === 1.96);
  ok("レートがあれば取り込み時に付く", r.s3.fx === 158.22 && !r.s3.pending);
  ok("既存の fx 無し記録は migrate で待ちになり、fx=1 の古い記録と USD建てでない銘柄は触らない", r.s4.badPending && r.s4.oldUntouched && r.s4.nkUntouched);
  ok("待ちになった既存記録もレートで埋まる", r.s5.fx === 158.22 && r.s5.R === 0.58);
  await page.close();
}

group("20. 分類別の平均R（横棒の一覧）");
{
  const page = await open(375, 812);
  const r = await page.evaluate(() => {
    DB.settings.initialBalance = 100000000; DB.trades = [];
    for (let i = 1; i <= 5; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString();
      DB.trades.push({ id:"r"+i, status:"closed", dir:"long", entry:3300, sl:3290, tp:3320, lot:1, contractSize:100,
        balanceAtEntry:100000000, realizedPL:-1000, result:"lose", pattern:"other", h4env:i <= 2 ? "up" : "", createdAt:d, closedAt:d, tags:[] });
    }
    saveData(); TAB = "growth"; UI.growthPeriod = "all"; render();
    const rows = id => [...document.querySelectorAll("#" + id + " .rbar")].map(e => ({
      lab:e.querySelector(".rb-lab").firstChild.textContent, n:e.querySelector(".rb-lab span").textContent,
      val:e.querySelector(".rb-val").textContent, cls:e.className, bar:!!e.querySelector(".rb-track i") }));
    return { pat:rows("c_patr"), h4:rows("c_h4r"), canvas:!!document.querySelector("canvas#c_patr, canvas#c_h4r") };
  });
  ok("パターン別は記録の無い項目も毎回出る（4行・空は「記録なし」）", r.pat.length === 4 && r.pat[0].val === "記録なし" && !r.pat[0].bar && r.pat[3].lab === "その他" && r.pat[3].n === "5件");
  ok("平均R を数値で書き、マイナスは赤の棒", /^-\d+\.\d\dR$/.test(r.pat[3].val) && r.pat[3].cls.includes("neg") && r.pat[3].bar);
  ok("4時間足環境別は 上昇・下降・レンジ・未記録 の件数が出る", r.h4.map(x => x.lab + x.n).join() === "上昇2件,下降0件,レンジ0件,未記録3件");
  ok("古い canvas の棒グラフは残っていない", !r.canvas);
  await page.close();
}

/* =======================================================================
   21. 手で SL を動かしたとき（最初の SL は守り、今の SL とリスクを出す）hoshi2/bob-bridge#37
   ======================================================================= */
group("21. 手で SL を動かしたとき");
{
  const page = await open(375, 812);
  const r = await page.evaluate(async () => {
    DB.trades = [];
    const acc = currentAccount();
    DB.trades.push({ id:"m1", status:"open", accountId:acc.id, createdAt:"2026-10-26T01:00:00.000Z", updatedAt:"x", savedAt:"x",
      symbol:"XAUUSD", dir:"long", entry:4200, sl:4190, tp:4230, lot:1, contractSize:100, balanceAtEntry:1000000, fxRate:1, tags:[] });
    saveData(); TAB = "trades"; UI.tradeTab = "open"; render();
    const before = { note:!!document.querySelector(".slnow"), c:calcTrade(findTrade("m1")) };
    // 編集モーダル：最初の SL 欄と今の SL 欄が分かれている
    editTrade("m1"); await new Promise(r => setTimeout(r, 30));
    const labels = [...document.querySelectorAll("#modalRoot .field label")].map(e => e.textContent);
    const hasNow = !!document.getElementById("e_slnow"), hasFirst = !!document.getElementById("e_sl");
    // 今の SL を 4195（詰めた）にして保存
    document.getElementById("e_slnow").value = "4195"; saveEdit(); await new Promise(r => setTimeout(r, 30));
    const t1 = findTrade("m1"), c1 = calcTrade(t1);
    const s1 = { sl:t1.sl, last:t1.slLast, moves:(t1.sltpMoves || []).map(m => [m.sl, m.by || ""]), kind:slMoveKind(t1),
      loss:c1.currentLoss, rr:c1.currentRR, planned:c1.plannedLoss, note:(document.querySelector(".slnow") || {}).textContent || "" };
    // もう一度、建値 4200 へ
    editTrade("m1"); await new Promise(r => setTimeout(r, 30));
    const prefill = document.getElementById("e_slnow").value;
    document.getElementById("e_slnow").value = "4200"; saveEdit(); await new Promise(r => setTimeout(r, 30));
    const t2 = findTrade("m1"), c2 = calcTrade(t2);
    const s2 = { sl:t2.sl, last:t2.slLast, moves:(t2.sltpMoves || []).length, kind:slMoveKind(t2), loss:c2.currentLoss, rr:c2.currentRR,
      note:(document.querySelector(".slnow") || {}).textContent || "", pills:tradePills(t2) };
    // 空で保存 → 変更なし。最初の SL を直すと R の元が変わる（入力ミスの修正）
    editTrade("m1"); await new Promise(r => setTimeout(r, 30));
    document.getElementById("e_slnow").value = ""; document.getElementById("e_sl").value = "4188"; saveEdit(); await new Promise(r => setTimeout(r, 30));
    const t3 = findTrade("m1");
    const s3 = { sl:t3.sl, last:t3.slLast, moves:(t3.sltpMoves || []).length };
    // MT5 連携の記録は「今の SL」を手で変えない（欄は disabled）
    DB.trades.push({ id:"m2", status:"open", accountId:acc.id, createdAt:"2026-10-26T02:00:00.000Z", updatedAt:"x", savedAt:"x", mt5PosId:"7001", source:"mt5",
      symbol:"XAUUSD", dir:"short", entry:4300, sl:4310, tp:4280, lot:1, contractSize:100, balanceAtEntry:1000000, fxRate:1, mt5Sl:4305, mt5Tp:4280, tags:[] });
    saveData(); render();
    editTrade("m2"); await new Promise(r => setTimeout(r, 30));
    const m2 = { disabled:document.getElementById("e_slnow").disabled, val:document.getElementById("e_slnow").value, c:calcTrade(findTrade("m2")), pills:tradePills(findTrade("m2")) };
    closeModal();
    // ホームの保有中カードにも同じ行
    TAB = "home"; render();
    const home = [...document.querySelectorAll(".slnow")].map(e => e.textContent);
    return { before, labels, hasNow, hasFirst, s1, prefill, s2, s3, m2, home };
  });
  ok("動かしていない記録には「今の SL」行は出ない", !r.before.note && r.before.c.currentKnown === false && r.before.c.slMoved === false);
  ok("編集に「最初の SL」と「今の SL」の欄が分かれている", r.hasFirst && r.hasNow && r.labels.some(l => l.startsWith("最初の SL")) && r.labels.some(l => l.startsWith("今の SL")));
  ok("今の SL を 4195 にしても記録の SL は 4190 のまま、履歴 2 件（最初＋手動）、分類は「詰めた」", r.s1.sl === 4190 && r.s1.last === 4195 && r.s1.moves.length === 2 && r.s1.moves[1][0] === 4195 && r.s1.moves[1][1] === "manual" && r.s1.kind === "tighten");
  ok("今のリスクは 500、予定損失は 1000 のまま、今の RR 1:6", r.s1.loss === 500 && r.s1.planned === 1000 && Math.abs(r.s1.rr - 6) < 1e-9 && /今の SL 4195/.test(r.s1.note) && /-500/.test(r.s1.note));
  ok("次に開くと今の SL が入っている。建値 4200 へ動かすとリスク 0・RR なし・「建値へ」", r.prefill === "4195" && r.s2.sl === 4190 && r.s2.last === 4200 && r.s2.moves === 3 && r.s2.kind === "be" && r.s2.loss === 0 && r.s2.rr === null && /建値・リスク 0/.test(r.s2.note) && r.s2.pills.includes("SL を建値へ"));
  ok("空で保存すると変更なし。最初の SL の修正は履歴に入らず R の元だけ変わる", r.s3.sl === 4188 && r.s3.last === 4200 && r.s3.moves === 3);
  ok("MT5 連携の記録は今の SL が自動（欄は入力不可）、リスク 500、札に「MT5 の今の SL」は無い", r.m2.disabled && r.m2.val === "4305" && r.m2.c.currentLoss === 500 && r.m2.c.slMoved && !r.m2.pills.some(p => p.startsWith("MT5 の今の SL")) && r.m2.pills.some(p => p.startsWith("MT5 の今の TP")) === false);
  ok("ホームの保有中カードにも「今の SL」行が出る", r.home.length === 2 && r.home.some(x => /建値・リスク 0/.test(x)) && r.home.some(x => /今の SL 4305/.test(x)));
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
