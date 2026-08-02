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
  'normDate', 'mergeDraws', 'syncRemote', 'parseMizuhoRounds', 'exportCsv', 'exportJson', 'comb', 'hyperP', 'chiP', 'render'];
const missing = NEEDED.filter((n) => !new RegExp(`function ${n}\\b`).test(script));
ok(`${NEEDED.length}個の関数が定義済み`, missing.length === 0, `未定義: ${missing.join(', ')}`);

console.log('\n[2] 参照される data-action にハンドラがあるか');
const used = [...script.matchAll(/data-action="([a-zA-Z]+)"/g)].map((m) => m[1]);
const handled = [...script.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]);
const orphan = [...new Set(used)].filter((a) => !handled.includes(a));
ok(`${new Set(used).size}種のアクションが全て処理される`, orphan.length === 0, `未処理: ${orphan.join(', ')}`);

console.log('\n[3] 修正が入っているか（退行の検出）');
ok('カイ二乗の自由度が max-pick', /const df=cfg\.max-cfg\.pick/.test(script));
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
writeFileSync(tmp, core + '\nmodule.exports={GAMES,parseImport,parseJson,normDate,score,comb,hyperP,deepAnalyze,backtest,analyze,makeTicket};');
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
  ok('公正な乱数では概ね誤差の範囲に収まる', inside >= 2, `3回中${inside}回`);
  ok('データ不足時はエラー', !!A.backtest(mk(10), L6, 50).error);
}

console.log('\n[7] 詳細分析');
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
