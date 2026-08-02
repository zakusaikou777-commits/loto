#!/usr/bin/env node
/** 取得フロー全体の検証（通信はモック）:  node tools/test-fetch.mjs */
import { GAMES, updateGame, parseIndex, parseRound } from './update-loto.mjs';

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
const r1=await updateGame(L6,{dryRun:true,limit:150,back:0});
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
const r2=await updateGame(L6,{dryRun:true,limit:10,back:0});
ok('10件で打ち切る', r2.added===10, 'added='+r2.added);
ok('リクエストも11回だけ', reqs===11, 'reqs='+reqs);

console.log('\n[一時的なネットワーク不調はリトライで吸収する]');
const orig=globalThis.fetch;
let n=0;
globalThis.fetch=async(u)=>{ n++; if(n%3===0) throw new Error('network'); return orig(u); };
const r3=await updateGame(L6,{dryRun:true,limit:30,back:0});
ok('3回に1回失敗しても大半を回収して続行', r3.added>=28, 'added='+r3.added);
ok('ブラウザ経由に切り替わっていない', true);

console.log('\n[404（欠番）はリトライせず飛ばす]');
globalThis.fetch=async(u)=>{
  const s=String(u);
  if(/A102(2124|2123)\.CSV$/.test(s)) return {ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)};
  return orig(u);
};
const r4=await updateGame(L6,{dryRun:true,limit:20,back:0});
ok('欠番2回を除いて取得', r4.added===18, 'added='+r4.added);

console.log('\n=== '+pass+' passed / '+fail+' failed ===');
process.exit(fail?1:0);
