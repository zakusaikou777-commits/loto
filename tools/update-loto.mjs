#!/usr/bin/env node
/**
 * みずほ銀行が公開している当せん番号CSVを取得して data/loto6.json / data/loto7.json を更新する。
 *
 *   node tools/update-loto.mjs            … 両方を更新
 *   node tools/update-loto.mjs loto6      … ロト6だけ
 *   node tools/update-loto.mjs --dry-run  … ファイルを書かずに結果だけ表示
 *
 * 設計方針:
 *  - 既存 JSON は絶対に減らさない。取得結果は必ず「マージ」する。
 *  - 1件も正しく解釈できなかった場合は exit 1 で落とす（壊れたデータをコミットさせない）。
 *  - 列の並びを決め打ちしない。ファイル全体の列プロファイルから本数字ブロックを特定する。
 *  - 素の fetch が弾かれた場合のみ Playwright にフォールバックする。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

// みずほ銀行の配信構成:
//   目次CSV   .../loto6/csv/loto6.csv        … 回号と抽せん日の一覧だけ（本数字は入っていない）
//   回別CSV   .../loto6/csv/A1022124.CSV     … その回の「本数字,..,ボーナス数字,..」行を含む
// 目次で回号を把握し、手元に無い回だけ回別CSVを取りに行く。
const GAMES = {
  loto6: { key: 'loto6', name: 'ロト6', pick: 6, max: 43, bonus: 1,
           indexUrl: 'https://www.mizuhobank.co.jp/retail/takarakuji/loto/loto6/csv/loto6.csv',
           roundUrl: (r) => `https://www.mizuhobank.co.jp/retail/takarakuji/loto/loto6/csv/A102${String(r).padStart(4, '0')}.CSV` },
  loto7: { key: 'loto7', name: 'ロト7', pick: 7, max: 37, bonus: 2,
           indexUrl: 'https://www.mizuhobank.co.jp/retail/takarakuji/loto/loto7/csv/loto7.csv',
           roundUrl: (r) => `https://www.mizuhobank.co.jp/retail/takarakuji/loto/loto7/csv/A103${String(r).padStart(4, '0')}.CSV` },
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
           '(KHTML, like Gecko) Version/17.4 Safari/605.1.15';

/* ---------- 日付（西暦 + 和暦） ---------- */
const ERAS = [
  { re: '令和|令|R', base: 2018 },
  { re: '平成|平|H', base: 1988 },
  { re: '昭和|昭|S', base: 1925 },
];
const iso = (y, m, d) => `${y}-${String(+m).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;

export function normDate(s) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  const m = t.match(/(\d{4})\s*[/\-年.]\s*(\d{1,2})\s*[/\-月.]\s*(\d{1,2})/);
  if (m) { const y = +m[1]; if (y >= 1990 && y <= 2100) return iso(y, m[2], m[3]); }
  for (const e of ERAS) {
    const r = new RegExp(`(?:${e.re})\\s*(元|\\d{1,2})\\s*[/\\-年.]\\s*(\\d{1,2})\\s*[/\\-月.]\\s*(\\d{1,2})`);
    const em = t.match(r);
    if (em) {
      const yy = em[1] === '元' ? 1 : +em[1];
      const y = e.base + yy;
      if (y >= 1990 && y <= 2100) return iso(y, em[2], em[3]);
    }
  }
  return '';
}

/* ---------- CSV 解析（列プロファイル方式） ---------- */
const isInt = (c) => /^\d+$/.test(c);

function splitCells(line) {
  const raw=[]; let cur='',q=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(q){ if(ch==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else if(ch==='"') q=true;
    else if(ch===','||ch==='\t'||ch===';') { raw.push(cur); cur=''; }
    else cur+=ch;
  }
  raw.push(cur);
  const out=[];
  for(let c of raw){
    c=c.replace(/[０-９]/g,d=>String.fromCharCode(d.charCodeAt(0)-0xFEE0)).replace(/　/g,' ').trim();
    // 「03 11 19 25 31 40」のように1セルへ空白区切りで数字が入っている形式に対応する。
    // ここで空白ごと削るとひと続きの巨大な数値になり、1件も解釈できなくなる。
    if(/^\d+(?:[ \t]+\d+)+$/.test(c)) { for(const t of c.split(/[ \t]+/)) out.push(t); }
    else out.push(c.replace(/[ \t]+/g,''));
  }
  return out;
}

export function parseCsv(text, cfg) {
  const rows = text.split(/\r\n|\r|\n/).filter((l) => l.trim()).map(splitCells);
  if (!rows.length) return { draws: [], blockLen: 0 };
  const W = Math.max(...rows.map((r) => r.length));
  if (W < cfg.pick) return { draws: [], blockLen: 0 };

  // 見出し行や注記行に統計を汚されないよう、「データらしい行」だけで列を判定する。
  // 見出しに数字が使われていても（例: "1,2,3,4,5,6,7"）本データの方が範囲内整数を多く持つ。
  const cnt = (r) => r.filter((c) => isInt(c) && +c >= 1 && +c <= cfg.max).length;
  const maxCnt = Math.max(...rows.map(cnt));
  const dataRows = rows.filter((r) => cnt(r) >= Math.max(cfg.pick, maxCnt - 1));
  const base = dataRows.length >= 3 ? dataRows : rows;
  const n = base.length;

  const prof = [];
  for (let c = 0; c < W; c++) {
    let ints = 0, inRange = 0, dates = 0, mx = 0, inc = 0, step1 = 0, prev = null;
    for (const r of base) {
      const v = r[c] ?? '';
      if (isInt(v)) {
        ints++;
        const x = +v;
        if (x > mx) mx = x;
        if (x >= 1 && x <= cfg.max) inRange++;
        if (prev !== null && x > prev) inc++;
        if (prev !== null && x === prev + 1) step1++;   // 回号の決定的な特徴
        prev = x;
      }
      if (normDate(v)) dates++;
    }
    prof.push({ c, rInt: ints / n, rRange: inRange / n, rDate: dates / n, max: mx,
                mono: ints > 1 ? inc / (ints - 1) : 0,
                step1: ints > 1 ? step1 / (ints - 1) : 0 });
  }

  const runs = [];
  let cur = null;
  for (const p of prof) {
    if (p.rRange >= 0.85 && p.rInt >= 0.85) { if (!cur) cur = { s: p.c, e: p.c }; else cur.e = p.c; }
    else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);

  const want = [cfg.pick + cfg.bonus, cfg.pick];
  const cands = runs
    .map((r) => {
      // 回号のような「単調増加する整数列」がブロック先頭に食い込んでいたら外す。
      // これを怠ると回号が本数字に混ざる（旧版の既知バグ）。
      // 「1ずつ増える整数列」= 回号。抽せん番号の列がこうなる確率は実質ゼロなので安全に外せる。
      let s = r.s;
      while (r.e - s + 1 > cfg.pick && n >= 5 && prof[s].step1 >= 0.9) s++;
      return { s, e: r.e, len: r.e - s + 1 };
    })
    .filter((r) => r.len >= cfg.pick);
  if (!cands.length) return { draws: [], blockLen: 0 };
  cands.sort((a, b) => {
    const da = Math.min(...want.map((w) => Math.abs(a.len - w)));
    const db = Math.min(...want.map((w) => Math.abs(b.len - w)));
    return da - db || a.s - b.s;
  });
  const blk = cands[0];

  const mainCols = [];
  for (let c = blk.s; c < blk.s + cfg.pick; c++) mainCols.push(c);
  const bonusCols = [];
  for (let c = blk.s + cfg.pick; c < Math.min(blk.s + cfg.pick + cfg.bonus, blk.e + 1); c++) bonusCols.push(c);

  let dateCol = -1, bd = 0;
  for (const p of prof) if (p.rDate > bd && p.rDate >= 0.4 && p.c < blk.s) { bd = p.rDate; dateCol = p.c; }
  if (dateCol < 0) for (const p of prof) if (p.rDate > bd && p.rDate >= 0.4) { bd = p.rDate; dateCol = p.c; }

  let roundCol = -1, bs = 0;
  for (const p of prof) {
    if (p.c >= blk.s && p.c <= blk.e) continue;
    if (p.c === dateCol) continue;
    if (p.rInt < 0.85) continue;
    const s = (p.step1 >= 0.9 ? 2 : 0) + (p.mono > 0.9 ? 1 : 0) + (p.max > cfg.max ? 1 : 0) + (p.c < blk.s ? 0.5 : 0);
    if (s > bs) { bs = s; roundCol = p.c; }
  }
  if (bs < 1.5) roundCol = -1;

  let draws = [];
  for (const r of rows) {
    const nums = mainCols.map((c) => r[c]).filter(isInt).map(Number).filter((x) => x >= 1 && x <= cfg.max);
    if (nums.length !== cfg.pick) continue;
    if (new Set(nums).size !== cfg.pick) continue;
    const bo = bonusCols.map((c) => r[c]).filter(isInt).map(Number)
      .filter((x) => x >= 1 && x <= cfg.max && !nums.includes(x));
    draws.push({
      round: roundCol >= 0 && isInt(r[roundCol] ?? '') ? +r[roundCol] : null,
      date: dateCol >= 0 ? normDate(r[dateCol]) : '',
      numbers: [...nums].sort((a, b) => a - b),
      bonus: [...new Set(bo)].sort((a, b) => a - b),
    });
  }
  // 日付列があり大半の行で日付が読める場合、日付を読めない行はヘッダ等とみなして落とす
  // （"1,2,3,4,5,6" のような数字だけの見出し行が抽せん結果として紛れ込むのを防ぐ）
  let droppedHeader = 0;
  if (dateCol >= 0 && draws.length >= 3) {
    const withDate = draws.filter((d) => d.date).length;
    if (withDate >= draws.length * 0.8) { droppedHeader = draws.length - withDate; draws = draws.filter((d) => d.date); }
  }
  return { draws, blockLen: blk.len, dateCol, roundCol, mainCols, bonusCols, droppedHeader };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 目次CSV / 回別CSV ---------- */
const zen2han = (c) => c.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

/** 目次CSVから {round, date} の一覧を取り出す。
 *  例: 第2124回ロト６,数字選択式全国自治宝くじ,令和8年7月30日,東京 宝くじドリーム館 */
export function parseIndex(text) {
  const out = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = zen2han(line).match(/第\s*(\d+)\s*回/);
    if (!m) continue;
    const round = +m[1];
    if (!round) continue;
    out.push({ round, date: normDate(line) });
  }
  // 同じ回号が複数行に出ても最初の1件だけ採用する
  const seen = new Set();
  return out.filter((x) => (seen.has(x.round) ? false : (seen.add(x.round), true)));
}

/** 回別CSVから本数字とボーナス数字を取り出す。
 *  例: 本数字,06,20,29,36,37,41,ボーナス数字,19 */
export function parseRound(text, cfg) {
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!/本数字/.test(line)) continue;
    const cells = line.split(',').map((c) => zen2han(c).trim());
    const bIdx = cells.findIndex((c) => /ボーナス/.test(c));
    const nums = [], bon = [];
    cells.forEach((c, i) => {
      if (!/^\d+$/.test(c)) return;
      const v = +c;
      if (v < 1 || v > cfg.max) return;
      if (bIdx >= 0 && i > bIdx) bon.push(v); else nums.push(v);
    });
    if (nums.length !== cfg.pick) continue;
    if (new Set(nums).size !== cfg.pick) continue;
    const date = normDate(text.split(/\r\n|\r|\n/).find((l) => /第\s*\d+\s*回/.test(zen2han(l))) || '');
    return {
      numbers: [...nums].sort((a, b) => a - b),
      bonus: [...new Set(bon)].filter((b) => !nums.includes(b)).slice(0, cfg.bonus).sort((a, b) => a - b),
      date,
    };
  }
  return null;
}

/* ---------- 取得 ---------- */
function decode(buf) {
  const bytes = new Uint8Array(buf);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!/�/.test(utf8)) return utf8;
  try { return new TextDecoder('shift_jis').decode(bytes); }
  catch { return utf8; }
}

class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status}`); this.status = status; this.url = url; }
}

async function fetchPlain(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/csv,text/plain,*/*',
      'Accept-Language': 'ja,en;q=0.8',
      'Referer': 'https://www.mizuhobank.co.jp/takarakuji/check/loto/index.html',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return decode(await res.arrayBuffer());
}

/* Playwright は「1度だけ」起動して使い回す。
   回別CSVは百件単位で取りに行くため、失敗のたびにブラウザを立ち上げると破綻する。 */
let _browser = null, _ctx = null, _useBrowser = false;

async function getContext() {
  if (_ctx) return _ctx;
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('playwright が入っていません（npm i -D playwright && npx playwright install chromium）'); }
  _browser = await chromium.launch();
  _ctx = await _browser.newContext({ userAgent: UA, locale: 'ja-JP' });
  // 先にトップを踏んで Cookie を得ておく
  const page = await _ctx.newPage();
  await page.goto('https://www.mizuhobank.co.jp/takarakuji/check/loto/index.html',
    { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.close().catch(() => {});
  return _ctx;
}

export async function closeBrowser() {
  if (_browser) await _browser.close().catch(() => {});
  _browser = null; _ctx = null;
}

async function fetchViaBrowser(url) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!resp) throw new Error('レスポンスなし');
    if (!resp.ok()) throw new HttpError(resp.status(), url);
    return decode(await resp.body());
  } finally {
    await page.close().catch(() => {});
  }
}

/* 遮断されるとCSVではなくHTMLのエラーページが返ってくる。長さでは判定できない
   （回別CSVは200文字程度しかないため、長さで切ると正常な応答まで失敗扱いになる）。 */
function looksBlocked(t) {
  const head = t.slice(0, 600).toLowerCase();
  return /<html|<!doctype|access denied|forbidden|reference\s*#/.test(head);
}

/** 遮断が疑われるか（この場合だけブラウザ経由に切り替える） */
function isBlocked(e) {
  if (e instanceof HttpError) return [403, 429, 503].includes(e.status);
  return /遮断|HTMLが返り/.test(e.message || '');
}

async function fetchCsv(url, opts = {}) {
  const tries = opts.tries ?? 3;
  if (!_useBrowser) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const t = await fetchPlain(url);
        if (!t || !t.trim()) throw new Error('空のレスポンス');
        if (looksBlocked(t)) throw new Error('CSVではなくHTMLが返りました（遮断の可能性）');
        return { text: t, via: 'fetch' };
      } catch (e) {
        // 404 は「その回が存在しない」だけ。リトライもブラウザ切替も無意味
        if (e instanceof HttpError && e.status === 404) throw e;
        lastErr = e;
        if (isBlocked(e)) break;             // 遮断ならリトライしても同じ
        if (i < tries - 1) await sleep(400 * (i + 1));   // 一時的な不調は待って再試行
      }
    }
    // 一時的な失敗でブラウザに切り替えない（Playwright未導入の環境で全滅するため）
    if (!isBlocked(lastErr)) throw lastErr;
    console.log(`  ! 遮断された可能性があります (${lastErr.message}) → 以降はブラウザ経由に切り替えます`);
    _useBrowser = true;
  }
  const t = await fetchViaBrowser(url);
  if (!t || !t.trim()) throw new Error('空のレスポンス');
  return { text: t, via: 'playwright' };
}

/* ---------- マージ ---------- */
const keyOf = (d) => (d.round != null ? `r${d.round}` : `d${d.date}|${d.numbers.join('-')}`);

function mergeDraws(oldDraws, newDraws) {
  const map = new Map();
  for (const d of oldDraws) map.set(keyOf(d), d);
  let added = 0, updated = 0;
  for (const d of newDraws) {
    const k = keyOf(d);
    const prev = map.get(k);
    if (!prev) { map.set(k, d); added++; }
    else if (JSON.stringify(prev) !== JSON.stringify(d)) { map.set(k, d); updated++; }
  }
  const all = [...map.values()].sort((a, b) => {
    if (a.round != null && b.round != null) return a.round - b.round;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  return { draws: all, added, updated };
}

/* ---------- メイン ---------- */

/** 同時実行数を絞って順に処理する（相手サーバーに負担をかけないため） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
      await sleep(120);
    }
  }));
  return out;
}

async function updateGame(cfg, opts) {
  console.log(`\n== ${cfg.name} ==`);
  const out = path.join(DATA_DIR, `${cfg.key}.json`);

  let prev = { draws: [] };
  if (existsSync(out)) {
    try { prev = JSON.parse(await readFile(out, 'utf8')); } catch { prev = { draws: [] }; }
  }
  const prevDraws = Array.isArray(prev.draws) ? prev.draws : [];

  // 1) 目次で回号一覧を得る
  const { text: idxText, via } = await fetchCsv(cfg.indexUrl);
  const index = parseIndex(idxText);
  if (!index.length) {
    console.log('  取得した目次の先頭3行（診断用）:');
    idxText.split(/\r\n|\r|\n/).filter((l) => l.trim()).slice(0, 3).forEach((l, i) => console.log(`    [${i + 1}] ${l}`));
    throw new Error(`${cfg.name}: 目次CSVから回号を1件も読み取れませんでした`);
  }
  const latestRound = Math.max(...index.map((x) => x.round));
  const oldestInIndex = Math.min(...index.map((x) => x.round));
  console.log(`  目次: ${via} / ${index.length}回分 (第${oldestInIndex}回〜第${latestRound}回)`);

  // 2) 手元に無い回を洗い出す
  const have = new Set(prevDraws.map((d) => d.round).filter((r) => Number.isInteger(r)));
  const dateOf = new Map(index.map((x) => [x.round, x.date]));
  let wanted = index.map((x) => x.round);
  // --back N で目次より古い回もさかのぼる
  if (opts.back > 0) {
    for (let r = oldestInIndex - 1; r >= Math.max(1, oldestInIndex - opts.back); r--) wanted.push(r);
  }
  const targets = wanted.filter((r) => !have.has(r)).sort((a, b) => b - a).slice(0, opts.limit);

  if (!targets.length) {
    console.log(`  すでに最新です（手元 ${prevDraws.length}回 / 最新 第${latestRound}回）`);
    return { added: 0, updated: 0 };
  }
  console.log(`  未取得 ${targets.length}回 を取得します…`);

  // 3) 回別CSVを取りに行く
  let okCount = 0, ngCount = 0;
  const fetched = await mapLimit(targets, 4, async (r) => {
    try {
      const { text } = await fetchCsv(cfg.roundUrl(r));
      const d = parseRound(text, cfg);
      if (!d) { ngCount++; return null; }
      okCount++;
      return { round: r, date: d.date || dateOf.get(r) || '', numbers: d.numbers, bonus: d.bonus };
    } catch (e) {
      ngCount++;
      return null;
    }
  });
  const got = fetched.filter(Boolean);
  console.log(`  取得成功 ${okCount}回 / 失敗・欠番 ${ngCount}回`);

  if (!got.length) throw new Error(`${cfg.name}: 回別CSVを1件も取得できませんでした`);

  const withoutDate = got.filter((d) => !d.date).length;
  if (withoutDate > got.length * 0.5)
    throw new Error(`${cfg.name}: ${withoutDate}/${got.length} 件で抽せん日を読めませんでした。取り込みを中止します`);

  // 4) マージして書き出す
  const { draws, added, updated } = mergeDraws(prevDraws, got);
  if (draws.length < prevDraws.length)
    throw new Error(`${cfg.name}: 件数が減っています (${prevDraws.length} → ${draws.length})。取り込みを中止します`);

  const latest = draws.reduce((a, d) => (d.round != null && d.round > a ? d.round : a), 0);
  const payload = {
    game: cfg.key,
    name: cfg.name,
    updated: new Date().toISOString().slice(0, 10),
    latestRound: latest || null,
    latestDate: draws.length ? draws[draws.length - 1].date : '',
    count: draws.length,
    source: cfg.indexUrl,
    note: '当せん確認は必ずみずほ銀行公式で行ってください。',
    draws,
  };

  console.log(`  新規 ${added}件 / 更新 ${updated}件 / 合計 ${draws.length}件`
            + (latest ? ` / 最新 第${latest}回 (${payload.latestDate})` : ''));
  if (targets.length === opts.limit)
    console.log(`  ※ 1回の実行では最大${opts.limit}件までにしています。残りは次回の実行で取得します。`);

  if (opts.dryRun) { console.log('  (dry-run のため書き込みませんでした)'); return { added, updated }; }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(out, JSON.stringify(payload) + '\n', 'utf8');
  console.log(`  → ${path.relative(ROOT, out)} を更新`);
  return { added, updated };
}

export { GAMES, mergeDraws, updateGame };

// 直接実行されたときだけ動かす（テストから import しても走らないように）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const numArg = (name, def) => {
    const i = args.findIndex((a) => a === name || a.startsWith(name + '='));
    if (i < 0) return def;
    const v = args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
  };
  const opts = {
    dryRun: args.includes('--dry-run'),
    limit: numArg('--limit', 150),   // 1回の実行で取りに行く最大回数
    back: numArg('--back', 0),       // 目次より古い回をいくつさかのぼるか
  };
  const targets = args.filter((a) => GAMES[a]);
  const list = targets.length ? targets : Object.keys(GAMES);

  let failed = 0, changed = 0;
  for (const k of list) {
    try {
      const r = await updateGame(GAMES[k], opts);
      changed += r.added + r.updated;
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      failed++;
    }
  }
  await closeBrowser();
  console.log(`\n完了: 変更 ${changed} 件 / 失敗 ${failed} 件`);
  process.exit(failed ? 1 : 0);
}
