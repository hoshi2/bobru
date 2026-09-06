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

/* ---------- 後始末 ---------- */
await browser.close();
server.close();

console.log("");
if (pageErrors.length) { console.log("JSエラー:\n  " + pageErrors.join("\n  ")); fail += pageErrors.length; }
else console.log("JSエラーなし");
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
