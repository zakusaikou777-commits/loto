#!/usr/bin/env node
/** さかのぼり取得の検証（通信はモック）: node tools/test-backfill.mjs */
import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);
import { GAMES, updateGame } from './update-loto.mjs';
import path from 'node:path';
import os from 'node:os';
// 本物の data/ を汚さないよう、一時ディレクトリで検証する
const TMP = path.join(os.tmpdir(), 'lotolab-backfill-test');

import { writeFileSync, mkdirSync } from 'node:fs';
let pass=0,fail=0; const ok=(n,c,d='')=>{c?(pass++,console.log('  ✓ '+n)):(fail++,console.log('  ✗ '+n+' '+d));};
const L6=GAMES.loto6;
const OLDEST=1800;                       // これより古い回は公開されていない想定
const IDX=Array.from({length:112},(_,i)=>2124-i);
const mkRound=r=>{const p=[...Array(43)].map((_,i)=>i+1);let s=r;const rnd=()=>((s=(s*1103515245+12345)%2147483648)/2147483648);
 for(let i=p.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[p[i],p[j]]=[p[j],p[i]];}
 const m=p.slice(0,6).sort((a,b)=>a-b);
 return `A52\r\n第${String(r).padStart(4,'0')}回ロト６,x,令和8年7月${(r%28)+1}日,y\r\n本数字,${m.map(n=>String(n).padStart(2,'0')).join(',')},ボーナス数字,${p[6]}`;};
let reqs=0;
globalThis.fetch=async(u)=>{reqs++;const s=String(u);
 if(s.endsWith('loto6.csv')) return {ok:true,status:200,arrayBuffer:async()=>Buffer.from(IDX.map(r=>`A52\r\n第${String(r).padStart(4,'0')}回ロト６,x,令和8年7月${(r%28)+1}日,y`).join('\r\n'),'utf8')};
 if(s.endsWith('loto7.csv')) return {ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)};
 const m=s.match(/A102(\d{4})\.CSV$/); if(!m) return {ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)};
 const r=+m[1];
 if(r<OLDEST) return {ok:false,status:404,arrayBuffer:async()=>new ArrayBuffer(0)};
 return {ok:true,status:200,arrayBuffer:async()=>Buffer.from(mkRound(r),'utf8')};};

mkdirSync(TMP,{recursive:true});
const P=path.join(TMP,'loto6.json');

writeFileSync(P,JSON.stringify({game:'loto6',count:0,draws:[]}));

console.log('[1回目: 目次のぶん(112回)だけ取得]');
const r1=await updateGame(L6,{dryRun:false,limit:500,back:0,dataDir:TMP});
ok('112回', r1.added===112, 'added='+r1.added);

console.log('\n[2回目: --back 300 でさかのぼる]');
const r2=await updateGame(L6,{dryRun:false,limit:500,back:300,dataDir:TMP});
ok('さらに古い回を取得', r2.added>0, 'added='+r2.added);
let d=JSON.parse(require('node:fs').readFileSync(P,'utf8'));
const oldest2=Math.min(...d.draws.map(x=>x.round));
console.log('    最古 第'+oldest2+'回 / 合計 '+d.count+'件');

console.log('\n[3回目: 同じ --back 300 でさらに過去へ進むか]');
let threw=false;
try{ await updateGame(L6,{dryRun:false,limit:500,back:300,dataDir:TMP}); }catch(e){ threw=true; console.log('    例外: '+e.message); }
d=JSON.parse(require('node:fs').readFileSync(P,'utf8'));
const oldest3=Math.min(...d.draws.map(x=>x.round));
console.log('    最古 第'+oldest3+'回 / 合計 '+d.count+'件');
ok('さかのぼり切った後に再実行しても失敗しない', !threw);
ok('公開されていない回で打ち切られる', oldest3>=OLDEST, '最古='+oldest3+' 想定下限='+OLDEST);
ok('既存データは減らない', d.count>=325, 'count='+d.count);


console.log('\n=== '+pass+' passed / '+fail+' failed ===');
process.exit(fail?1:0);
