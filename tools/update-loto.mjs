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

const GAMES = {
  loto6: { key: 'loto6', name: 'ロト6', pick: 6, max: 43, bonus: 1,
           url: 'https://www.mizuhobank.co.jp/retail/takarakuji/loto/loto6/csv/loto6.csv' },
  loto7: { key: 'loto7', name: 'ロト7', pick: 7, max: 37, bonus: 2,
           url: 'https://www.mizuhobank.co.jp/retail/takarakuji/loto/loto7/csv/loto7.csv' },
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

/* ---------- 取得 ---------- */
function decode(buf) {
  const bytes = new Uint8Array(buf);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!/�/.test(utf8)) return utf8;
  try { return new TextDecoder('shift_jis').decode(bytes); }
  catch { return utf8; }
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decode(await res.arrayBuffer());
}

async function fetchViaBrowser(url) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('playwright が入っていません（npm i -D playwright && npx playwright install chromium）'); }
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'ja-JP' });
    const page = await ctx.newPage();
    // まずトップを踏んで Cookie を得てから CSV を取りに行く
    await page.goto('https://www.mizuhobank.co.jp/takarakuji/check/loto/index.html',
      { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!resp || !resp.ok()) throw new Error(`HTTP ${resp ? resp.status() : '?'}`);
    return decode(await resp.body());
  } finally {
    await browser.close();
  }
}

async function fetchCsv(url) {
  try {
    const t = await fetchPlain(url);
    if (t && t.length > 200) return { text: t, via: 'fetch' };
    throw new Error('レスポンスが短すぎます');
  } catch (e) {
    console.log(`  ! 直接取得に失敗 (${e.message}) → ブラウザ経由で再試行`);
    return { text: await fetchViaBrowser(url), via: 'playwright' };
  }
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
async function updateGame(cfg, dryRun) {
  console.log(`\n== ${cfg.name} ==`);
  const out = path.join(DATA_DIR, `${cfg.key}.json`);

  let prev = { draws: [] };
  if (existsSync(out)) {
    try { prev = JSON.parse(await readFile(out, 'utf8')); } catch { prev = { draws: [] }; }
  }
  const prevDraws = Array.isArray(prev.draws) ? prev.draws : [];

  const { text, via } = await fetchCsv(cfg.url);
  const parsed = parseCsv(text, cfg);
  console.log(`  取得: ${via} / ${text.length} 文字 → ${parsed.draws.length} 件を解釈`
            + ` (本数字ブロック長 ${parsed.blockLen}, 日付列 ${parsed.dateCol}, 回号列 ${parsed.roundCol})`);

  if (!parsed.draws.length) {
    const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
    console.log(`  取得したCSVの先頭3行（診断用）:`);
    lines.slice(0, 3).forEach((l, i) => console.log(`    [${i + 1}] ${l}`));
    console.log(`  1行目をセルに分解: ${JSON.stringify(splitCells(lines[0] || ''))}`);
    console.log(`  総行数: ${lines.length}`);
    throw new Error(`${cfg.name}: CSVから1件も解釈できませんでした。列の形式が変わった可能性があります`);
  }

  const withoutDate = parsed.draws.filter((d) => !d.date).length;
  if (withoutDate > parsed.draws.length * 0.5)
    throw new Error(`${cfg.name}: ${withoutDate}/${parsed.draws.length} 件で日付を読めませんでした。取り込みを中止します`);

  const { draws, added, updated } = mergeDraws(prevDraws, parsed.draws);
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
    source: cfg.url,
    note: '当せん確認は必ずみずほ銀行公式で行ってください。',
    draws,
  };

  console.log(`  新規 ${added} 件 / 更新 ${updated} 件 / 合計 ${draws.length} 件`
            + (latest ? ` / 最新 第${latest}回 (${payload.latestDate})` : ''));

  if (dryRun) { console.log('  (dry-run のため書き込みませんでした)'); return { added, updated }; }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(out, JSON.stringify(payload) + '\n', 'utf8');
  console.log(`  → ${path.relative(ROOT, out)} を更新`);
  return { added, updated };
}

export { GAMES, mergeDraws };

// 直接実行されたときだけ動かす（テストから import しても走らないように）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targets = args.filter((a) => GAMES[a]);
  const list = targets.length ? targets : Object.keys(GAMES);

  let failed = 0, changed = 0;
  for (const k of list) {
    try {
      const r = await updateGame(GAMES[k], dryRun);
      changed += r.added + r.updated;
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      failed++;
    }
  }
  console.log(`\n完了: 変更 ${changed} 件 / 失敗 ${failed} 件`);
  process.exit(failed ? 1 : 0);
}
