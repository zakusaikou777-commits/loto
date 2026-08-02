#!/usr/bin/env node
/** 取り込みパーサの回帰テスト:  node tools/test-parser.mjs */
import { parseCsv, normDate, GAMES, mergeDraws, parseIndex, parseRound } from './update-loto.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got  ${g}\n      want ${w}`); }
};
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const L6 = GAMES.loto6, L7 = GAMES.loto7;

console.log('\n[1] 日付の正規化');
eq('西暦ハイフン', normDate('2026-05-30'), '2026-05-30');
eq('西暦スラッシュ', normDate('2026/5/30'), '2026-05-30');
eq('西暦漢字', normDate('2026年5月30日'), '2026-05-30');
eq('令和（漢字）', normDate('令和8年5月30日'), '2026-05-30');
eq('令和（略記）', normDate('R8.5.30'), '2026-05-30');
eq('令和元年', normDate('令和元年5月1日'), '2019-05-01');
eq('平成', normDate('平成31年4月30日'), '2019-04-30');
eq('非日付は空', normDate('第2124回'), '');
eq('金額を誤認しない', normDate('1234567890'), '');

console.log('\n[2] 回号の混入を防げるか（旧版の既知バグ）');
{
  // 回号が本数字と地続きで、日付列が無い形式
  const csv = ['12,3,11,19,25,31,40,5', '13,2,8,14,22,29,37,9', '14,1,6,17,23,30,41,4',
               '15,4,9,15,21,28,39,7', '16,5,10,18,24,33,42,2'].join('\n');
  const r = parseCsv(csv, L6);
  eq('回号を本数字に混ぜない', r.draws[0].numbers, [3, 11, 19, 25, 31, 40]);
  eq('ボーナスも正しい', r.draws[0].bonus, [5]);
  eq('回号を回号として拾う', r.draws[0].round, 12);
}

console.log('\n[3] みずほ形式（回号・和暦・本数字・ボーナス・金額）');
{
  const lines = ['回別,抽せん日,第1数字,第2数字,第3数字,第4数字,第5数字,第6数字,ボーナス数字,販売実績額,キャリーオーバー'];
  const base = [[3,11,19,25,31,40,5],[2,8,14,22,29,37,9],[1,6,17,23,30,41,4],
                [4,9,15,21,28,39,7],[5,10,18,24,33,42,2],[7,13,20,26,34,43,1]];
  base.forEach((b, i) => lines.push(
    `${2119 + i},令和8年${5 + (i % 2)}月${10 + i}日,${b.slice(0,6).join(',')},${b[6]},1234567890,0`));
  const r = parseCsv(lines.join('\n'), L6);
  eq('全行を解釈', r.draws.length, 6);
  eq('本数字', r.draws[0].numbers, [3, 11, 19, 25, 31, 40]);
  eq('ボーナス', r.draws[0].bonus, [5]);
  eq('回号', r.draws[0].round, 2119);
  eq('和暦を西暦に', r.draws[0].date, '2026-05-10');
  ok('販売実績額を番号にしない', r.draws.every(d => d.numbers.every(n => n <= 43)));
}

console.log('\n[4] ロト7形式');
{
  const lines = ['回別,抽せん日,1,2,3,4,5,6,7,BONUS1,BONUS2'];  // 数字だけの見出し行（データと紛らわしい）
  const base = [[1,5,9,14,22,30,36,7,19],[2,6,11,17,23,31,37,4,20],[3,8,12,18,24,29,35,1,15],
                [4,10,13,19,25,28,34,2,16],[6,7,15,20,26,32,33,5,21]];
  base.forEach((b, i) => lines.push(`${640 + i},令和8年6月${5 + i}日,${b.join(',')},999,0`));
  const r = parseCsv(lines.join('\n'), L7);
  eq('7個の本数字', r.draws[0].numbers, [1, 5, 9, 14, 22, 30, 36]);
  eq('ボーナス2個', r.draws[0].bonus, [7, 19]);
  eq('件数', r.draws.length, 5);
}

console.log('\n[5] 不正データを弾く');
{
  const dup = '2119,2026-05-30,5,5,5,5,5,5,3\n2120,2026-06-02,1,2,3,4,5,6,7';
  const r = parseCsv(dup, L6);
  ok('重複番号の行を落とす', r.draws.length === 1 && r.draws[0].numbers.join() === '1,2,3,4,5,6',
     `→ ${JSON.stringify(r.draws)}`);
}
{
  const r = parseCsv('これはCSVではありません\nただの文章です', L6);
  eq('無意味な入力は0件', r.draws.length, 0);
}

console.log('\n[6] ゲーム取り違えの検出材料');
{
  const l7 = ['640,2026-06-05,3,5,9,14,22,30,36,7,19',
              '641,2026-06-12,1,6,11,17,23,31,37,4,20',
              '642,2026-06-19,8,12,16,18,24,29,35,1,15',
              '643,2026-06-26,2,10,13,19,25,28,34,3,16',
              '644,2026-07-03,5,11,14,20,26,32,33,6,21'].join('\n');
  const asL7 = parseCsv(l7, L7);
  const asL6 = parseCsv(l7, L6);
  const s = (r, c) => !r.draws.length ? 0 : r.draws.length * (r.blockLen === c.pick + c.bonus ? 1.5 : r.blockLen === c.pick ? 1.2 : 0.5);
  ok('ロト7データはロト7として高スコア', s(asL7, L7) > s(asL6, L6) * 1.2,
     `L7=${s(asL7, L7)} L6=${s(asL6, L6)}`);

  // 逆向き: ロト6データ(38-43を含む)をロト7として読ませる
  const l6 = ['2119,2026-05-30,3,11,19,25,31,40,5',
              '2120,2026-06-02,2,8,14,22,29,41,9',
              '2121,2026-06-05,1,6,17,23,30,42,4',
              '2122,2026-06-09,4,9,15,21,28,43,7',
              '2123,2026-06-12,7,13,20,26,34,38,2'].join('\n');
  ok('ロト6データはロト6として高スコア',
     s(parseCsv(l6, L6), L6) > s(parseCsv(l6, L7), L7) * 1.2);
}

console.log('\n[7] マージ（既存を減らさない・重複を増やさない）');
{
  const oldD = [{ round: 1, date: '2026-01-01', numbers: [1,2,3,4,5,6], bonus: [7] },
                { round: 2, date: '2026-01-08', numbers: [2,3,4,5,6,7], bonus: [8] }];
  const newD = [{ round: 2, date: '2026-01-08', numbers: [2,3,4,5,6,7], bonus: [8] },
                { round: 3, date: '2026-01-15', numbers: [3,4,5,6,7,8], bonus: [9] }];
  const m = mergeDraws(oldD, newD);
  eq('新規1件のみ追加', m.added, 1);
  eq('合計3件', m.draws.length, 3);
  eq('回号順に並ぶ', m.draws.map(d => d.round), [1, 2, 3]);
  eq('再マージで増えない', mergeDraws(m.draws, newD).added, 0);
}

console.log('\n[8] カイ二乗の自由度');
{
  // 公正な乱数を大量に生成し、p<0.05 の発生率が 5% に近いことを確認する
  function logGamma(x){const c=[0.99999999999980993,676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];const g=7;if(x<0.5)return Math.log(Math.PI/Math.sin(Math.PI*x))-logGamma(1-x);x-=1;let a=c[0];const t=x+g+0.5;for(let i=1;i<g+2;i++)a+=c[i]/(x+i);return 0.5*Math.log(2*Math.PI)+(x+0.5)*Math.log(t)-t+Math.log(a);}
  function gammp(a,x){const gln=logGamma(a),FPMIN=1e-300,EPS=1e-12;if(x<=0)return 0;if(x<a+1){let ap=a,sum=1/a,del=sum;for(let n=0;n<300;n++){ap++;del*=x/ap;sum+=del;if(Math.abs(del)<Math.abs(sum)*EPS)break;}return sum*Math.exp(-x+a*Math.log(x)-gln);}let b=x+1-a,c=1/FPMIN,d=1/b,h=d;for(let i=1;i<300;i++){const an=-i*(i-a);b+=2;d=an*d+b;if(Math.abs(d)<FPMIN)d=FPMIN;c=b+an/c;if(Math.abs(c)<FPMIN)c=FPMIN;d=1/d;const del=d*c;h*=del;if(Math.abs(del-1)<EPS)break;}return 1-Math.exp(-x+a*Math.log(x)-gln)*h;}
  const chiP=(chi,df)=>chi<=0?1:1-gammp(df/2,chi/2);
  const draw=(max,pick)=>{const p=[...Array(max)].map((_,i)=>i+1);for(let i=p.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[p[i],p[j]]=[p[j],p[i]];}return p.slice(0,pick);};
  for (const cfg of [L6, L7]) {
    const N = 4000, rounds = 300;
    let hitsNew = 0, hitsOld = 0, sum = 0;
    for (let k = 0; k < N; k++) {
      const f = new Array(cfg.max + 1).fill(0);
      for (let i = 0; i < rounds; i++) draw(cfg.max, cfg.pick).forEach(n => f[n]++);
      const e = rounds * cfg.pick / cfg.max;
      let chi = 0; for (let n = 1; n <= cfg.max; n++) chi += (f[n] - e) ** 2 / e;
      sum += chi;
      if (chiP(chi, cfg.max - cfg.pick) < 0.05) hitsNew++;   // 修正後
      if (chiP(chi, cfg.max - 1) < 0.05) hitsOld++;          // 旧版
    }
    const mean = sum / N, rNew = hitsNew / N, rOld = hitsOld / N;
    console.log(`  ${cfg.name}: 平均χ²=${mean.toFixed(2)} (理論値 ${cfg.max - cfg.pick})`
              + ` / 偽陽性率 修正後=${(rNew * 100).toFixed(2)}% 旧版=${(rOld * 100).toFixed(2)}% (目標5%)`);
    ok(`${cfg.name} 平均χ²が max-pick に一致`, Math.abs(mean - (cfg.max - cfg.pick)) < 1.0);
    ok(`${cfg.name} 修正後の偽陽性率が5%付近`, rNew > 0.03 && rNew < 0.075);
    ok(`${cfg.name} 旧版より改善している`, Math.abs(rNew - 0.05) < Math.abs(rOld - 0.05));
  }
}

console.log('\n[9] みずほ実配信形式（本数字が1セルに空白区切り）');
{
  // 実ログで判明した形式: A52,回号,和暦日付,本数字とボーナスが空白区切り
  const rows = [[3,11,19,25,31,40,5],[2,8,14,22,29,37,9],[1,6,17,23,30,41,4],
                [4,9,15,21,28,39,7],[5,10,18,24,33,42,2],[7,13,20,26,34,43,1]];
  const csv = rows.map((b,i)=>
    `A52,${2119+i},令和8年${5+(i%2)}月${10+i}日,${b.map(n=>String(n).padStart(2,'0')).join(' ')}`).join('\n');
  const r = parseCsv(csv, L6);
  eq('全行を解釈', r.draws.length, 6);
  eq('本数字', r.draws[0].numbers, [3,11,19,25,31,40]);
  eq('ボーナス', r.draws[0].bonus, [5]);
  eq('回号', r.draws[0].round, 2119);
  eq('和暦日付', r.draws[0].date, '2026-05-10');
}
{
  // ボーナスだけ別セルの派生形
  const rows = [[3,11,19,25,31,40,5],[2,8,14,22,29,37,9],[1,6,17,23,30,41,4],
                [4,9,15,21,28,39,7],[5,10,18,24,33,42,2]];
  const csv = rows.map((b,i)=>
    `A52,${2119+i},令和8年6月${10+i}日,${b.slice(0,6).join(' ')},${b[6]}`).join('\n');
  const r = parseCsv(csv, L6);
  eq('本数字とボーナスが別セルでも通る', r.draws[0].numbers, [3,11,19,25,31,40]);
  eq('ボーナスを拾う', r.draws[0].bonus, [5]);
}
{
  // 全角数字
  const z = n => String(n).padStart(2,'0').replace(/[0-9]/g,d=>String.fromCharCode(d.charCodeAt(0)+0xFEE0));
  const rows = [[3,11,19,25,31,40,5],[2,8,14,22,29,37,9],[1,6,17,23,30,41,4],
                [4,9,15,21,28,39,7],[5,10,18,24,33,42,2]];
  const csv = rows.map((b,i)=>`A52,${2119+i},令和8年6月${10+i}日,${b.map(z).join('　')}`).join('\n');
  const r = parseCsv(csv, L6);
  eq('全角数字・全角スペースでも通る', r.draws[0].numbers, [3,11,19,25,31,40]);
}
{
  // CR のみの改行（古い Mac 形式）
  const rows = [[3,11,19,25,31,40,5],[2,8,14,22,29,37,9],[1,6,17,23,30,41,4],
                [4,9,15,21,28,39,7],[5,10,18,24,33,42,2]];
  const csv = rows.map((b,i)=>`A52,${2119+i},令和8年6月${10+i}日,${b.join(' ')}`).join('\r');
  eq('CRのみの改行でも全行読める', parseCsv(csv, L6).draws.length, 5);
}
{
  // ロト7（本数字7 + ボーナス2 が空白区切り）
  const rows = [[1,5,9,14,22,30,36,7,19],[2,6,11,17,23,31,37,4,20],[3,8,12,18,24,29,35,1,15],
                [4,10,13,19,25,28,34,2,16],[6,7,15,20,26,32,33,5,21]];
  const csv = rows.map((b,i)=>`A52,${640+i},令和8年6月${5+i}日,${b.join(' ')}`).join('\n');
  const r = parseCsv(csv, L7);
  eq('ロト7 本数字7個', r.draws[0].numbers, [1,5,9,14,22,30,36]);
  eq('ロト7 ボーナス2個', r.draws[0].bonus, [7,19]);
}

console.log('\n[10] みずほ 目次CSV（実データそのまま）');
{
  // 実際のログから採取した行をそのまま使う
  const idx = [
    'A52',
    '第2124回ロト６,数字選択式全国自治宝くじ,令和8年7月30日,東京 宝くじドリーム館',
    'A52',
    '第2123回ロト６,数字選択式全国自治宝くじ,令和8年7月27日,東京 宝くじドリーム館',
    'A52',
    '第2122回ロト６,数字選択式全国自治宝くじ,令和8年7月23日,東京 宝くじドリーム館',
  ].join('\r\n');
  const r = parseIndex(idx);
  eq('3回分を抽出', r.length, 3);
  eq('回号', r.map(x => x.round), [2124, 2123, 2122]);
  eq('和暦日付を西暦に', r[0].date, '2026-07-30');
  eq('A52行を誤って拾わない', r.every(x => x.round > 1000), true);
}
{
  const idx7 = ['A53', '第0688回ロト７,数字選択式全国自治宝くじ,令和8年7月31日,東京 宝くじドリーム館'].join('\n');
  const r = parseIndex(idx7);
  eq('ロト7 ゼロ埋め回号', r[0].round, 688);
  eq('ロト7 日付', r[0].date, '2026-07-31');
}

console.log('\n[11] みずほ 回別CSV（実データそのまま）');
{
  // 第2124回ロト6 の実ファイル構成
  const csv = [
    'A52',
    '第2124回ロト６,数字選択式全国自治宝くじ,令和8年7月30日,東京 宝くじドリーム館',
    '支払期間,令和8年7月31日から令和9年7月30日まで',
    '本数字,06,20,29,36,37,41,ボーナス数字,19',
    '１等,該当なし,該当なし',
    '２等,8口,8247000円',
    '３等,165口,431800円',
    '４等,8005口,9400円',
    '５等,134914口,1000円',
    'キャリーオーバー,219914692円',
    '販売実績額,1260775000円',
  ].join('\r\n');
  const d = parseRound(csv, L6);
  ok('解釈できる', !!d);
  eq('本数字（先頭ゼロ付き）', d.numbers, [6, 20, 29, 36, 37, 41]);
  eq('ボーナス', d.bonus, [19]);
  eq('抽せん日（支払期間の日付を拾わない）', d.date, '2026-07-30');
  ok('賞金額を番号にしない', d.numbers.every(n => n <= 43));
}
{
  // 第688回ロト7 の実データ
  const csv = [
    'A53',
    '第0688回ロト７,数字選択式全国自治宝くじ,令和8年7月31日,東京 宝くじドリーム館',
    '支払期間,令和8年8月1日から令和9年7月31日まで',
    '本数字,04,21,25,28,30,35,37,ボーナス数字,12,16',
    '１等,1口,600000000円',
    '２等,3口,7000000円',
  ].join('\r\n');
  const d = parseRound(csv, L7);
  eq('ロト7 本数字7個', d.numbers, [4, 21, 25, 28, 30, 35, 37]);
  eq('ロト7 ボーナス2個', d.bonus, [12, 16]);
  eq('ロト7 抽せん日', d.date, '2026-07-31');
}
{
  const bad = ['A52', '第2124回ロト６,...,令和8年7月30日,...', '１等,該当なし'].join('\n');
  eq('本数字行が無ければ null', parseRound(bad, L6), null);
}

console.log(`\n=== ${pass} passed / ${fail} failed ===`);
process.exit(fail ? 1 : 0);
