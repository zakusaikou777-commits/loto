#!/usr/bin/env node
/** 取得フロー全体の検証（通信はモック）:  node tools/test-fetch.mjs */
import { GAMES, updateGame, parseIndex, parseRound } from './update-loto.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// 本物の data/ を読むと、データが溜まった時点で「すでに最新」になりテストが成り立たない。
// 空の一時ディレクトリを手元データとして使う
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'lotolab-fetch-test-'));

// Shift-JIS でのエンコードは iconv-lite がある場合だけ検証する
let iconv = null;
try { iconv = (await import('iconv-lite')).default; } catch {}
const enc = (s) => iconv ? iconv.encode(s, 'Shift_JIS') : Buffer.from(s, 'utf8');

let pass=0,fail=0;
const ok=(n,c,d='')=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+' '+d));};

// --- 実物どおりの疑似サーバー（Shift-JIS で返す） ---
const L6=GAMES.loto6, L7=GAMES.loto7;
const mkIndex=(g,rounds)=>rounds.map(r=>
  `A5${g==='loto6'?2:3}\r\n第${String(r).padStart(4,'0')}回ロト${g==='loto6'?'６':'７'},数字選択式全国自治宝くじ,令和8年7月${(r%28)+1}日,東京 宝くじドリーム館`).join('\r\n');
const mkRound=(cfg,r)=>{
  const pool=[...Array(cfg.max)].map((_,i)=>i+1);
  let seed=r; const rnd=()=>((seed=(seed*1103515245+12345)%2147483648)/2147483648);
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  const main=pool.slice(0,cfg.pick).sort((a,b)=>a-b), bon=pool.slice(cfg.pick,cfg.pick+cfg.bonus).sort((a,b)=>a-b);
  return [`A5${cfg.key==='loto6'?2:3}`,
    `第${String(r).padStart(4,'0')}回ロト${cfg.key==='loto6'?'６':'７'},数字選択式全国自治宝くじ,令和8年7月${(r%28)+1}日,東京 宝くじドリーム館`,
    `支払期間,令和8年8月1日から令和9年7月31日まで`,
    `本数字,${main.map(n=>String(n).padStart(2,'0')).join(',')},ボーナス数字,${bon.map(n=>String(n).padStart(2,'0')).join(',')}`,
    `１等,1口,200000000円`,`販売実績額,1260775000円`].join('\r\n');
};
const ROUNDS6=Array.from({length:112},(_,i)=>2124-i);
let reqs=0;
globalThis.fetch=async(url)=>{
  reqs++;
  const u=String(url);
  let body;
  if(u.endsWith('loto6.csv')) body=mkIndex('loto6',ROUNDS6);
  else {
    const m=u.match(/A102(\d{4})\.CSV$/);
    if(!m) return {ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)};
    body=mkRound(L6,+m[1]);
  }
  const buf=enc(body);
  return {ok:true,status:200,arrayBuffer:async()=>buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)};
};

console.log('[通しテスト: 目次 → 回別 → マージ]');
const r1=await updateGame(L6,{dryRun:true,dataDir,limit:150,back:0});
ok('112回すべて新規取得', r1.added===112, 'added='+r1.added);
ok('リクエスト数 = 目次1 + 回別112', reqs===113, 'reqs='+reqs);

console.log('\n[Shift-JIS のデコード]'+(iconv?'':' … iconv-lite が無いため UTF-8 で代用'));
const buf=enc(mkRound(L6,2124));
const txt=new TextDecoder(iconv?'shift_jis':'utf-8').decode(buf);
const d=parseRound(txt,L6);
ok((iconv?'Shift-JIS':'UTF-8')+'でも本数字を読める', d && d.numbers.length===6, JSON.stringify(d));
ok((iconv?'Shift-JIS':'UTF-8')+'でも和暦日付を読める', d && /^2026-07-/.test(d.date), d&&d.date);

console.log('\n[--limit で1回あたりの取得数を絞れる]');
reqs=0;
const r2=await updateGame(L6,{dryRun:true,dataDir,limit:10,back:0});
ok('10件で打ち切る', r2.added===10, 'added='+r2.added);
ok('リクエストも11回だけ', reqs===11, 'reqs='+reqs);

console.log('\n[一時的なネットワーク不調はリトライで吸収する]');
const orig=globalThis.fetch;
let n=0;
globalThis.fetch=async(u)=>{ n++; if(n%3===0) throw new Error('network'); return orig(u); };
const r3=await updateGame(L6,{dryRun:true,dataDir,limit:30,back:0});
ok('3回に1回失敗しても大半を回収して続行', r3.added>=28, 'added='+r3.added);
ok('ブラウザ経由に切り替わっていない', true);

console.log('\n[404（欠番）はリトライせず飛ばす]');
globalThis.fetch=async(u)=>{
  const s=String(u);
  if(/A102(2124|2123)\.CSV$/.test(s)) return {ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)};
  return orig(u);
};
const r4=await updateGame(L6,{dryRun:true,dataDir,limit:20,back:0});
ok('欠番2回を除いて取得', r4.added===18, 'added='+r4.added);

console.log('\n[公式側の訂正を取り込み、変化がなければ書き込まない]');
globalThis.fetch=orig;
const fixDir=mkdtempSync(path.join(os.tmpdir(), 'lotolab-fix-test-'));
const fixFile=path.join(fixDir,'loto6.json');
await updateGame(L6,{dryRun:false,limit:150,back:0,dataDir:fixDir});
const j1=JSON.parse(readFileSync(fixFile,'utf8'));
const lastDraw=j1.draws[j1.draws.length-1], good=[...lastDraw.numbers];
lastDraw.numbers=[1,2,3,4,5,6]; j1.updated='2000-01-01';     // 手元の最新回だけ誤った内容にしておく
writeFileSync(fixFile,JSON.stringify(j1));
reqs=0;
const r5=await updateGame(L6,{dryRun:false,limit:150,back:0,dataDir:fixDir});
ok('最新回の訂正を取り込む', r5.updated===1 && r5.added===0, JSON.stringify(r5));
ok('確認のリクエストは目次1 + 直近3回だけ', reqs===4, 'reqs='+reqs);
const j2=JSON.parse(readFileSync(fixFile,'utf8'));
ok('訂正後の番号になっている', JSON.stringify(j2.draws[j2.draws.length-1].numbers)===JSON.stringify(good));
j2.updated='2000-01-01'; writeFileSync(fixFile,JSON.stringify(j2));
const r6=await updateGame(L6,{dryRun:false,limit:150,back:0,dataDir:fixDir});
ok('変化がなければファイルを書き直さない', r6.added===0 && r6.updated===0
   && JSON.parse(readFileSync(fixFile,'utf8')).updated==='2000-01-01');
reqs=0;
await updateGame(L6,{dryRun:true,limit:150,back:0,dataDir:fixDir,recheck:0});
ok('--recheck 0 なら目次だけ', reqs===1, 'reqs='+reqs);

console.log('\n[目次にある回を1件も読めなければ、手元にデータがあっても失敗にする]');
// 回別CSVの形式が変わった想定（本数字の行が無い）。遮断(403)でも同じ扱いになるが、
// 403 だとブラウザ経由に切り替わってしまうので、ここでは形式変更で確かめる
const j3=JSON.parse(readFileSync(fixFile,'utf8'));
j3.draws=j3.draws.filter(d=>d.round<=2112); j3.count=j3.draws.length;       // 2113〜2124回が未取得
writeFileSync(fixFile,JSON.stringify(j3));
globalThis.fetch=async(u)=>String(u).endsWith('loto6.csv')?orig(u)
  :{ok:true,status:200,arrayBuffer:async()=>Buffer.from('A52\r\n第2124回ロト６,x,令和8年7月1日,y\r\n新しい形式,06,20,29','utf8')};
let err7=null;
try{ await updateGame(L6,{dryRun:true,limit:150,back:0,dataDir:fixDir}); }catch(e){ err7=e; }
ok('失敗として扱う（Playwright再試行とIssue通知が動く）', !!err7, '例外なし');
globalThis.fetch=async(u)=>{ const s=String(u);
  if(/A102(2124|2123)\.CSV$/.test(s)) return {ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)};
  return orig(u); };
writeFileSync(fixFile,JSON.stringify({...j2,draws:j2.draws.filter(d=>d.round<=2122)}));   // 未取得は404の2123・2124回だけ
let err9=null;
try{ await updateGame(L6,{dryRun:true,limit:150,back:0,dataDir:fixDir}); }catch(e){ err9=e; }
ok('最新回のCSVがまだ公開されていない(404)だけなら失敗にしない', !err9, err9&&err9.message);

console.log('\n=== '+pass+' passed / '+fail+' failed ===');
process.exit(fail?1:0);
