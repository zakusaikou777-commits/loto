#!/usr/bin/env node
/**
 * index.html のロジックを Node 上で検証する:  node tools/test-app.mjs
 *
 * 1) 必要な関数が全て定義されているか（置換ミスで関数が消える事故を検出する）
 * 2) 取り込みパーサが tools/update-loto.mjs と同じ結果を返すか
 * 3) 確率まわりの計算が理論値と一致するか
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseCsv, GAMES as UGAMES } from './update-loto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `\n      got  ${JSON.stringify(g)}\n      want ${JSON.stringify(w)}`);

console.log('\n[1] 必要な関数が全て存在するか');
const NEEDED = ['analyze', 'analyzeCached', 'deepAnalyze', 'backtest', 'makeTicket', 'generate',
  'renderAnalysis', 'renderGenerate', 'renderTickets', 'renderData', 'renderDeep', 'renderBacktest',
  'editBoxHTML', 'cmpRow', 'cmpRowSE', 'cmpLegend', 'verdict', 'parseTable', 'parseJson', 'parseImport',
  'normDate', 'mergeDraws', 'syncRemote', 'parseMizuhoRounds', 'diagnose', 'renderDiagnosis', 'similarSearch', 'shapeOf', 'simFilterSort', 'renderSimilar', 'exportCsv', 'exportJson', 'comb', 'hyperP', 'chiP', 'uniformityTest', 'render'];
const missing = NEEDED.filter((n) => !new RegExp(`function ${n}\\b`).test(script));
ok(`${NEEDED.length}個の関数が定義済み`, missing.length === 0, `未定義: ${missing.join(', ')}`);

console.log('\n[2] 参照される data-action にハンドラがあるか');
const used = [...script.matchAll(/data-action="([a-zA-Z]+)"/g)].map((m) => m[1]);
const handled = [...script.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]);
const orphan = [...new Set(used)].filter((a) => !handled.includes(a));
ok(`${new Set(used).size}種のアクションが全て処理される`, orphan.length === 0, `未処理: ${orphan.join(', ')}`);

console.log('\n[3] 修正が入っているか（退行の検出）');
ok('カイ二乗を非復元抽出で補正（自由度 max-1）', /const df=cfg\.max-1, adj=chi\*\(cfg\.max-1\)\/\(cfg\.max-cfg\.pick\)/.test(script));
ok('分析キャッシュがリビジョンで無効化される', /_rev/.test(script) && /_anCache/.test(script));
ok('デモデータ生成に確認がある', /seedDemo[\s\S]{0,400}?confirm\(/.test(script));
ok('貼り付けテキストを state に保持', /state\.pasteText=e\.target\.value/.test(script));
ok('マイ番号は登録日以降のみ照合', /tk\.since && d\.date && d\.date < tk\.since/.test(script));
ok('不人気ねらいが連番を加点', /consec\*0\.4/.test(script));
ok('バックテストのしきい値が2.6σ', /b\.maxZ<2\.6/.test(script));
ok('ヒートマップが単一色相ランプ', /lerp\('#2a2008','#eec052'/.test(script));
ok('viewport に maximum-scale がない', !/maximum-scale/.test(html));

console.log('\n[4] アプリのパーサを実行して検証');
const require = createRequire(import.meta.url);
const core = script.slice(0, script.indexOf('/* ===== HTML パーツ ===== */')).replace("'use strict';", '');
const tmp = path.join(ROOT, 'tools', '.app-core.cjs');
writeFileSync(tmp, core + '\nmodule.exports={GAMES,parseImport,parseJson,normDate,score,comb,hyperP,chiP,deepAnalyze,backtest,analyze,makeTicket,diagnose,similarSearch,shapeOf,simFilterSort,uniformityTest,pickRandom,mergeDraws,state};');
const A = require(tmp);
const L6 = A.GAMES.loto6, L7 = A.GAMES.loto7;

const csv = ['12,3,11,19,25,31,40,5', '13,2,8,14,22,29,37,9', '14,1,6,17,23,30,41,4',
             '15,4,9,15,21,28,39,7', '16,5,10,18,24,33,42,2'].join('\n');
eq('回号を本数字に混ぜない', A.parseImport(csv, L6).draws[0].numbers, [3, 11, 19, 25, 31, 40]);
eq('更新スクリプトと同じ結果', A.parseImport(csv, L6).draws.map((d) => d.numbers),
   parseCsv(csv, UGAMES.loto6).draws.map((d) => d.numbers));
eq('和暦を読める', A.normDate('令和8年5月30日'), '2026-05-30');
eq('JSONの重複番号を弾く', A.parseJson('[{"date":"2026-05-30","numbers":[5,5,5,5,5,5]}]', L6).draws.length, 0);
{
  // みずほの回別CSVをそのまま読ませても通るか
  const mz = ['A52','第2124回ロト６,数字選択式全国自治宝くじ,令和8年7月30日,東京 宝くじドリーム館',
    '支払期間,令和8年7月31日から令和9年7月30日まで',
    '本数字,06,20,29,36,37,41,ボーナス数字,19','１等,該当なし,該当なし','販売実績額,1260775000円'].join('\r\n');
  const r = A.parseImport(mz, L6);
  eq('回別CSVの本数字', r.draws[0].numbers, [6,20,29,36,37,41]);
  eq('回別CSVのボーナス', r.draws[0].bonus, [19]);
  eq('回別CSVの回号', r.draws[0].round, 2124);
  eq('回別CSVの日付', r.draws[0].date, '2026-07-30');
}

console.log('\n[5] 確率計算');
eq('C(43,6)', Math.round(A.comb(43, 6)), 6096454);
for (const cfg of [L6, L7]) {
  let sum = 0, mean = 0;
  for (let j = 0; j <= cfg.pick; j++) { sum += A.hyperP(cfg, j); mean += j * A.hyperP(cfg, j); }
  ok(`${cfg.name} 超幾何分布の合計が1`, Math.abs(sum - 1) < 1e-9);
  ok(`${cfg.name} 平均が pick²/max`, Math.abs(mean - cfg.pick * cfg.pick / cfg.max) < 1e-9);
}

console.log('\n[5b] 均等性の検定（公正な乱数での偽陽性率が名目5%に近いか）');
{
  // 乱数を固定して毎回同じ結果にする（偽陽性率のような確率的な値でテストが揺れないように）
  let seed = 20261011;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const origRandom = Math.random; Math.random = rnd;
  for (const cfg of [L6, L7]) {
    const T = 4000, N = 200; let fp = 0, fpOld = 0;
    for (let t = 0; t < T; t++) {
      const f = new Array(cfg.max + 1).fill(0);
      for (let i = 0; i < N; i++) for (const n of A.pickRandom(cfg.max, cfg.pick)) f[n]++;
      const u = A.uniformityTest(f, N, cfg);
      if (u.p < 0.05) fp++;
      if (A.chiP(u.chi, cfg.max - cfg.pick) < 0.05) fpOld++;   // 旧版の近似（自由度 max−pick）
    }
    const rate = fp / T * 100, old = fpOld / T * 100;
    console.log(`   ${cfg.name}: 補正後 ${rate.toFixed(2)}% / 旧版 ${old.toFixed(2)}%`);
    ok(`${cfg.name} 偽陽性率が名目5%の近く（4.0〜6.0%）`, rate >= 4.0 && rate <= 6.0, `${rate.toFixed(2)}%`);
    ok(`${cfg.name} 旧版の近似より名目5%に近い`, Math.abs(rate - 5) < Math.abs(old - 5), `補正後${rate.toFixed(2)}% / 旧版${old.toFixed(2)}%`);
  }
  Math.random = origRandom;
}

console.log('\n[6] バックテスト（公正な乱数では全戦略が理論値に収まる）');
{
  const mk = (n) => { const d = [];
    for (let i = 0; i < n; i++) { const p = [...Array(43)].map((_, k) => k + 1);
      for (let k = p.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [p[k], p[j]] = [p[j], p[k]]; }
      d.push({ id: 'd' + i, round: 1000 + i, date: '2026-01-01', numbers: p.slice(0, 6).sort((a, b) => a - b), bonus: [p[6]] }); }
    return d; };
  const b = A.backtest(mk(400), L6, 300);
  ok('学習70%/検証30%に分割', b.train === 280 && b.test === 120, `${b.train}/${b.test}`);
  ok('理論値 = 36/43', Math.abs(b.expAvg - 36 / 43) < 1e-9);
  b.rows.forEach((r) => console.log(`   ${r.name.padEnd(7, '　')} 平均${r.avg.toFixed(4)} ±${(2 * r.se).toFixed(4)}  ${r.z.toFixed(2)}σ`));
  // 誤警報は5戦略同時比較で約6%なので、まれに超える。3回試して1回でも収まればよしとする
  let inside = 0;
  for (let t = 0; t < 3; t++) if (A.backtest(mk(400), L6, 300).maxZ < 2.6) inside++;
  ok('公正な乱数では概ね誤差の範囲に収まる', inside >= 1, `3回中${inside}回`);
  ok('データ不足時はエラー', !!A.backtest(mk(10), L6, 50).error);
}

console.log('\n[7] 組み合わせの診断');
{
  // 既知の履歴を作り、診断結果が算術的に正しいか確かめる
  const draws = [
    { id:'a', round:101, date:'2026-01-06', numbers:[1,2,3,4,5,6],    bonus:[7] },
    { id:'b', round:102, date:'2026-01-13', numbers:[1,2,3,10,11,12], bonus:[8] },
    { id:'c', round:103, date:'2026-01-20', numbers:[1,20,21,22,23,24],bonus:[9] },
    { id:'d', round:104, date:'2026-01-27', numbers:[30,31,32,33,34,35],bonus:[1] },
    { id:'e', round:105, date:'2026-02-03', numbers:[1,2,3,4,5,6],    bonus:[7] },
  ];
  const g = A.diagnose([1,2,3,4,5,6], draws, L6);
  eq('履歴件数', g.N, 5);
  eq('番号1の出現回数', g.per.find(x=>x.n===1).count, 4);
  eq('番号1は前回も出た(0回前)', g.per.find(x=>x.n===1).gap, 0);
  eq('番号4の出現回数', g.per.find(x=>x.n===4).count, 2);
  eq('番号4は4回前が最後', g.per.find(x=>x.n===4).gap, 0);
  eq('番号6の最終出現は第105回', g.per.find(x=>x.n===6).last.round, 105);
  eq('一致数の分布', g.dist, [1,1,0,1,0,0,2]);   // 6個一致2回, 3個一致1回, 1個一致1回, 0個一致1回
  eq('最高一致は6個', g.bestM, 6);
  eq('完全一致は2回', g.exact.length, 2);
  eq('3個以上一致した回', g.hit3Obs, 3);
  eq('合計値', g.sum, 21);
  eq('奇数の個数', g.odd, 3);
  eq('連番の組数', g.consec, 5);
  const p12 = g.pairs.find(x=>x.a===1&&x.b===2);
  eq('ペア1-2の共起', p12.c, 3);               // 第101,102,105回
  const p56 = g.pairs.find(x=>x.a===5&&x.b===6);
  eq('ペア5-6の共起', p56.c, 2);               // 第101,105回
  ok('近かった回は一致数の多い順', g.matches[0].hit.length >= g.matches[g.matches.length-1].hit.length);
  eq('未出現の番号は gap=-1', A.diagnose([1,2,3,4,5,43], draws, L6).per.find(x=>x.n===43).gap, -1);
}

console.log('\n[8] 似た回の検索');
{
  // 1,600回ぶんの公正な乱数を用意して、実運用に近い規模で確かめる
  const mk = (n) => Array.from({ length: n }, (_, i) => {
    const p = [...Array(43)].map((_, k) => k + 1);
    for (let k = p.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [p[k], p[j]] = [p[j], p[k]]; }
    return { id: 's' + i, round: 500 + i, date: '2026-01-01', numbers: p.slice(0, 6).sort((a, b) => a - b), bonus: [p[6]] };
  });
  const draws = mk(1600);
  const target = [3, 11, 19, 25, 31, 40];
  const res = A.similarSearch(target, draws, L6, {});
  eq('全件が対象になる', res.N, 1600);

  // パーセンタイルの定義どおりか（上位5%で絞ると実際に約5%残る）
  for (const th of [1, 5, 10]) {
    const kept = res.rows.filter(r => r.pct <= th).length;
    const want = 1600 * th / 100;
    ok(`上位${th}%で絞ると実際に約${th}%が残る`, Math.abs(kept - want) <= 2, `${kept}件 / 期待${want}件`);
  }
  ok('パーセンタイルは0より大きく100以下', res.rows.every(r => r.pct > 0 && r.pct <= 100));

  // 形の近さ: 距離が小さいほどパーセンタイルが小さい
  const sortedByDist = [...res.rows].sort((a, b) => a.dist - b.dist);
  ok('距離順とパーセンタイル順が一致', sortedByDist.every((r, i) => i === 0 || r.pct >= sortedByDist[i - 1].pct));

  // 起点と同じ形の回は距離0になる
  const self = { id: 'self', round: 9999, date: '2026-09-01', numbers: target, bonus: [] };
  const res2 = A.similarSearch(target, [...draws, self], L6, {});
  const selfRow = res2.rows.find(r => r.d.id === 'self');
  ok('自分と同じ組み合わせは距離0', Math.abs(selfRow.dist) < 1e-12, `dist=${selfRow.dist}`);
  eq('自分と同じ組み合わせは6個一致', selfRow.m, 6);

  // excludeId で起点そのものを除外できる
  const res3 = A.similarSearch(target, [...draws, self], L6, { excludeId: 'self' });
  ok('起点の回を一覧から除外できる', !res3.rows.some(r => r.d.id === 'self'));
  eq('除外すると1件減る', res3.N, 1600);

  // 絞り込みと並び替え
  const all = A.simFilterSort(res, { match: 0, shape: 100, sort: 'match' });
  eq('絞り込みなしは全件', all.length, 1600);
  ok('一致数順に並ぶ', all.every((r, i) => i === 0 || all[i - 1].m >= r.m));
  const byShape = A.simFilterSort(res, { match: 0, shape: 100, sort: 'shape' });
  ok('形の近さ順に並ぶ', byShape.every((r, i) => i === 0 || byShape[i - 1].pct <= r.pct));
  const m3 = A.simFilterSort(res, { match: 3, shape: 100, sort: 'match' });
  ok('3個以上で絞ると全て3個以上', m3.every(r => r.m >= 3), `${m3.length}件`);
  const both = A.simFilterSort(res, { match: 3, shape: 5, sort: 'match' });
  ok('併用すると両方の条件を満たす', both.every(r => r.m >= 3 && r.pct <= 5), `${both.length}件`);
  ok('併用は単独より件数が少ない', both.length <= m3.length);
  const newest = A.simFilterSort(res, { match: 0, shape: 100, sort: 'new' });
  ok('新しい順は回号が降順', newest[0].d.round > newest[newest.length - 1].d.round);
  const oldest = A.simFilterSort(res, { match: 0, shape: 100, sort: 'old' });
  ok('古い順は回号が昇順', oldest[0].d.round < oldest[oldest.length - 1].d.round);

  // 形の指標そのもの
  eq('形: 合計値', A.shapeOf([1,2,3,4,5,6], L6).sum, 21);
  eq('形: 奇数の個数', A.shapeOf([1,2,3,4,5,6], L6).odd, 3);
  eq('形: 低い数の個数', A.shapeOf([1,2,3,4,5,40], L6).low, 5);
  eq('形: 連番の組数', A.shapeOf([1,2,3,10,20,30], L6).consec, 2);

  // 3個以上一致の件数が理論値に近いか（1600回 × 2.717%）
  let expHit3 = 0; for (let j = 3; j <= 6; j++) expHit3 += A.hyperP(L6, j);
  const obs3 = res.rows.filter(r => r.m >= 3).length;
  ok('3個以上一致の件数が理論値の近く', Math.abs(obs3 - 1600 * expHit3) < 4 * Math.sqrt(1600 * expHit3),
     `実測${obs3}件 / 理論${(1600 * expHit3).toFixed(1)}件`);
  console.log(`   1600回中: 3個以上一致 ${obs3}件（理論 ${(1600*expHit3).toFixed(1)}件）`);
}

console.log('\n[8b] 自動取得のマージ（公式データの訂正）');
{
  const S = A.state;
  const base = () => [
    { id: 'a', round: 10, date: '2026-01-05', numbers: [1,2,3,4,5,6], bonus: [7] },
    { id: 'b', round: 11, date: '2026-01-08', numbers: [8,9,10,11,12,13], bonus: [14], edited: true },
  ];
  const remote = [
    { round: 10, date: '2026-01-05', numbers: [1,2,3,4,5,40], bonus: [7] },   // 公式で訂正された
    { round: 11, date: '2026-01-08', numbers: [20,21,22,23,24,25], bonus: [26] },
    { round: 12, date: '2026-01-12', numbers: [30,31,32,33,34,35], bonus: [36] },
  ];
  S.store.loto6 = base();
  eq('自動取得では訂正を反映し新しい回を追加', A.mergeDraws('loto6', remote, { update: true }), { added: 1, updated: 1 });
  eq('訂正後の番号', S.store.loto6.find(d => d.round === 10).numbers, [1,2,3,4,5,40]);
  eq('訂正しても id は変わらない', S.store.loto6.find(d => d.round === 10).id, 'a');
  eq('手で直した回は上書きしない', S.store.loto6.find(d => d.round === 11).numbers, [8,9,10,11,12,13]);
  eq('同じ内容を再取得しても変更なし', A.mergeDraws('loto6', remote, { update: true }), { added: 0, updated: 0 });
  S.store.loto6 = base();
  eq('ファイル取り込み(追記)では既存の回を上書きしない', A.mergeDraws('loto6', remote), { added: 1, updated: 0 });
  eq('既存の回はそのまま', S.store.loto6.find(d => d.round === 10).numbers, [1,2,3,4,5,6]);
}

console.log('\n[8c] ご無沙汰番号は回号順で数える');
{
  // 日付が無くても回号があれば順序は決まる。旧版は日付で並べていたため順序が崩れていた
  const draws = [
    { id: 'p', round: 3, date: '', numbers: [1,2,3,4,5,6], bonus: [] },
    { id: 'q', round: 1, date: '', numbers: [7,8,9,10,11,12], bonus: [] },
    { id: 'r', round: 2, date: '', numbers: [13,14,15,16,17,18], bonus: [] },
  ];
  const a = A.analyze(draws, L6);
  eq('最新回(第3回)の番号は0回前', a.gap[1], 0);
  eq('第1回の番号は2回前', a.gap[7], 2);
  eq('全回に回号があれば日付欠落の警告を出さない', a.noDate, 0);
  eq('回号も日付もない回があれば警告する', A.analyze([...draws, { id: 's', round: null, date: '', numbers: [20,21,22,23,24,25], bonus: [] }], L6).noDate, 4);
}

console.log('\n[9] 詳細分析');
{
  const d = A.deepAnalyze(Array.from({ length: 120 }, (_, i) => {
    const p = [...Array(43)].map((_, k) => k + 1);
    for (let k = p.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [p[k], p[j]] = [p[j], p[k]]; }
    return { id: 'x' + i, round: 1000 + i, date: '2026-01-01', numbers: p.slice(0, 6).sort((a, b) => a - b), bonus: [] };
  }), L6);
  ok('ペア上位10組', d.topPairs.length === 10);
  eq('重複数の合計 = 比較回数', d.ov.reduce((a, b) => a + b, 0), 119);
  eq('下一桁の合計 = 全番号数', d.ld.reduce((a, b) => a + b, 0), 720);
  ok('連番率が理論値の近く', Math.abs(d.consecRate - d.consecExp) < 0.15, `${d.consecRate} vs ${d.consecExp}`);
}

require('node:fs').unlinkSync(tmp);
console.log(`\n=== ${pass} passed / ${fail} failed ===`);
process.exit(fail ? 1 : 0);
