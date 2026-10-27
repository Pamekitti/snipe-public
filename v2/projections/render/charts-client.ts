/**
 * uPlot lifecycle: build the total-wallet pane and the History panes, then setData
 * when a payload changes.
 *
 * THIS IS THE ONE PLACE THE BROWSER MAY FORMAT A NUMBER. Axes and the tooltip print values
 * the projection already chose, at the decimal count the projection already chose. It does
 * not colour a win rate, does not compare a reading to a cut, and does not decide a stroke:
 * stroke, rules and yDecimals arrive as fields on the payload. Halt bands arrive as
 * `{from,to,stroke}`; this file only paints them, via toneColor.
 *
 * SETDATA MUST NOT RE-FIT X. uPlot's default is to snap the time axis to the first and last
 * point, then we pin it back to the lookback. Those two ranges disagree by up to a minute, and
 * four panes sync that snap to each other, which is why the line bounced left and right on
 * every stream tick. `auto: false` and `setData(..., false)` keep the lookback where it is.
 *
 * THE BODY BELOW CONTAINS NO BACKTICKS AND NO `${`, so it can live in a template literal
 * and take its range padding from `levels.ts` without any escaping.
 */
import { LEVELS } from '../levels.js'

export const CHART_JS = `(function(){
"use strict";
var RANGE_PAD=__RANGE_PAD__;
var MIN_RANGE=__MIN_RANGE__;
var CONST_PAD=__CONST_PAD__;
var ZOOM_SLOP=__ZOOM_SLOP__;
var BAR_FRAC=__BAR_FRAC__;
var BAR_MIN=__BAR_MIN__;
var BAR_MAX=__BAR_MAX__;
var SEG_GAP=__SEG_GAP__;
var STRIP_OFF=__STRIP_OFF__;
var STRIP_H=__STRIP_H__;
var STRIP_LABEL=__STRIP_LABEL__;
var X_SIZE=__X_SIZE__;
var X_GAP=__X_GAP__;
var LABEL_SLOT=__LABEL_SLOT__;
var BAND_ALPHA=__BAND_ALPHA__;
var plots={};
var walletPayload=null;
var chartPayload=null;
var userZoomed={wallet:false,charts:false};
var syncing=false;
var mouse={x:0,y:0};
var CSSV=new Map();
var HATCH=null;
var hidden=new Set();
try{
  var saved=localStorage.getItem('snipe.chartHidden');
  if(saved!==null)saved.split(',').forEach(function(k){if(k)hidden.add(k);});
  else hidden.add('filtered');
}catch(_){hidden.add('filtered');}

function $(id){return document.getElementById(id);}
function css(v){
  var hit=CSSV.get(v);
  if(hit===undefined){
    hit=getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    CSSV.set(v,hit);
  }
  return hit;
}
function toneColor(tone){
  if(tone==='good')return css('--good');
  if(tone==='bad')return css('--bad');
  if(tone==='warn')return css('--warn');
  if(tone==='muted')return css('--dim');
  return css('--accent');
}
function pad2(n){n=String(n);return ('0'+n).slice(-2);}
function utcTime(sec){
  var d=new Date(sec*1000);
  return pad2(d.getUTCHours())+':'+pad2(d.getUTCMinutes())+':'+pad2(d.getUTCSeconds())+' UTC';
}
function readPayload(id){
  var el=$(id);
  if(!el)return null;
  var raw=el.textContent||'';
  if(!raw)return null;
  try{return JSON.parse(raw);}catch(_){return null;}
}
function paneEl(id){return $('pane-'+id);}
function emptyEl(id){return $('empty-'+id);}
function groupOf(id){return id==='wallet'?'wallet':'charts';}
function payloadOf(id){return id==='wallet'?walletPayload:chartPayload;}
function wrapId(id){return id==='wallet'?'wallet-panes':'panes';}
function tipId(id){return id==='wallet'?'wallet-tip':'tip';}
function plotId(u){
  var id=null;
  Object.keys(plots).forEach(function(k){if(plots[k]===u)id=k;});
  return id;
}
function destroyAll(){
  Object.keys(plots).forEach(function(id){
    try{if(plots[id])plots[id].destroy();}catch(_){}
  });
  plots={};
  HATCH=null;
}
function yRange(lo,hi,pane){
  var vals=[];
  if(pane&&pane.kind==='stack'){
    lo=0;hi=0;
    var st=pane.stack||[];
    for(var s=0;s<st.length;s++){
      var h=visHeight(st[s]);
      if(h>hi)hi=h;
    }
  }
  if(isFinite(lo))vals.push(lo);
  if(isFinite(hi))vals.push(hi);
  var rules=pane&&pane.rules?pane.rules:[];
  for(var i=0;i<rules.length;i++)vals.push(rules[i].value);
  if(pane&&(pane.kind==='bars'||pane.kind==='stack'))vals.push(0);
  if(vals.length===0)return [0,1];
  lo=Math.min.apply(null,vals);
  hi=Math.max.apply(null,vals);
  if(!(isFinite(lo)&&isFinite(hi)))return [0,1];
  if(hi-lo<MIN_RANGE)return [lo-CONST_PAD,hi+CONST_PAD];
  var p=(hi-lo)*RANGE_PAD;
  return [lo-p,hi+p];
}
function visHeight(b){
  var n=0;
  if(!hidden.has('win'))n+=b.win||0;
  if(!hidden.has('loss'))n+=b.loss||0;
  if(!hidden.has('pending'))n+=b.pending||0;
  if(!hidden.has('flat'))n+=b.flat||0;
  if(!hidden.has('notSimulated'))n+=b.notSimulated||0;
  if(!hidden.has('filtered'))n+=b.filtered||0;
  return n;
}
function ax(){
  return {stroke:css('--dim'),font:'12px '+css('--mono'),
    grid:{show:true,stroke:css('--line'),width:1},
    ticks:{show:true,stroke:css('--line'),width:1,size:4}};
}
function xMute(){
  var a=ax();
  a.scale='x';a.side=2;a.size=0;a.gap=0;
  a.ticks={show:false};
  a.values=function(u,sp){return sp.map(function(){return null;});};
  return a;
}
function findPane(id){
  var payloads=[walletPayload,chartPayload];
  for(var p=0;p<payloads.length;p++){
    var payload=payloads[p];
    if(!payload||!payload.panes)continue;
    for(var i=0;i<payload.panes.length;i++)if(payload.panes[i].id===id)return payload.panes[i];
  }
  return null;
}
function drawRules(u){
  var id=plotId(u);
  var pane=id?findPane(id):null;
  if(!pane||!pane.rules||pane.rules.length===0)return;
  var ctx=u.ctx;
  ctx.save();
  ctx.beginPath();
  ctx.rect(u.bbox.left,u.bbox.top,u.bbox.width,u.bbox.height);
  ctx.clip();
  ctx.lineWidth=1;
  ctx.setLineDash([4,4]);
  ctx.globalAlpha=0.75;
  for(var i=0;i<pane.rules.length;i++){
    var rule=pane.rules[i];
    var y=u.valToPos(rule.value,'y',true);
    ctx.strokeStyle=toneColor(rule.stroke||'warn');
    ctx.beginPath();
    ctx.moveTo(u.bbox.left,y);
    ctx.lineTo(u.bbox.left+u.bbox.width,y);
    ctx.stroke();
  }
  ctx.restore();
}
function pr(u){return u.width?u.ctx.canvas.width/u.width:1;}
function hatch(u){
  if(HATCH)return HATCH;
  var R=pr(u);
  var c=document.createElement('canvas');
  var size=Math.max(4,Math.round(6*R));
  c.width=c.height=size;
  var g=c.getContext('2d');
  g.fillStyle=css('--panel2');
  g.fillRect(0,0,c.width,c.height);
  g.strokeStyle=css('--dim');
  g.lineWidth=1.2*R;
  g.beginPath();
  g.moveTo(0,c.height);
  g.lineTo(c.width,0);
  g.stroke();
  HATCH=u.ctx.createPattern(c,'repeat');
  return HATCH;
}
function segFill(u,key){
  if(key==='win')return css('--good');
  if(key==='loss')return css('--bad');
  if(key==='pending')return hatch(u);
  if(key==='flat')return css('--accent');
  if(key==='filtered')return css('--rule2');
  return css('--dim');
}
function drawStack(u){
  var pane=findPane('coins');
  if(!pane||pane.kind!=='stack'||!pane.stack||!chartPayload)return;
  var bs=pane.stack;
  if(!bs.length)return;
  var ctx=u.ctx,R=pr(u);
  ctx.save();
  ctx.beginPath();
  ctx.rect(u.bbox.left,u.bbox.top,u.bbox.width,u.bbox.height);
  ctx.clip();
  var slot=u.valToPos(bs[0].t+chartPayload.bucketSec,'x',true)-u.valToPos(bs[0].t,'x',true);
  var bw=Math.min(Math.max(BAR_MIN*R,slot*BAR_FRAC),BAR_MAX*R);
  var half=slot/2;
    var keys=['win','loss','pending','flat','notSimulated','filtered'];
  for(var i=0;i<bs.length;i++){
    var b=bs[i];
    var cx=u.valToPos(b.t,'x',true)+half-bw/2;
    if(cx<u.bbox.left-bw||cx>u.bbox.left+u.bbox.width+bw)continue;
    var acc=0;
    for(var k=0;k<keys.length;k++){
      if(hidden.has(keys[k]))continue;
      var v=b[keys[k]]||0;
      if(v<=0)continue;
      var yt=u.valToPos(acc+v,'y',true),yb=u.valToPos(acc,'y',true);
      var h=yb-yt,gap=h>SEG_GAP*R?R:0;
      ctx.fillStyle=segFill(u,keys[k]);
      ctx.fillRect(cx,yt+gap,bw,Math.max(R,h-gap));
      acc+=v;
    }
  }
  ctx.restore();
  if(!hidden.has('net'))drawStrip(u,bs,slot,R);
}
function drawStrip(u,bs,slot,R){
  var ctx=u.ctx;
  var top=u.bbox.top+u.bbox.height+STRIP_OFF*R,hh=STRIP_H*R;
  ctx.save();
  ctx.beginPath();ctx.rect(u.bbox.left,top,u.bbox.width,hh);ctx.clip();
  for(var i=0;i<bs.length;i++){
    var b=bs[i];
    var x=u.valToPos(b.t,'x',true)+R,w=Math.max(R,slot-2*R);
    ctx.globalAlpha=b.stripAlpha;
    ctx.fillStyle=b.stripTone==='warn'?hatch(u):toneColor(b.stripTone);
    ctx.fillRect(x,top,w,hh);
  }
  ctx.globalAlpha=1;
  ctx.restore();
  ctx.save();
  ctx.fillStyle=css('--dim');
  ctx.font=(10*R)+'px '+css('--mono');
  ctx.textAlign='right';
  ctx.textBaseline='alphabetic';
  ctx.fillText('return',u.bbox.left-8*R,top+hh-R);
  ctx.textAlign='center';
  ctx.textBaseline='top';
  ctx.font=(9*R)+'px '+css('--mono');
  var every=Math.max(1,Math.ceil(LABEL_SLOT*R/slot));
  for(var j=0;j<bs.length;j++){
    var bar=bs[j];
    if(!bar.netText||j%every!==0)continue;
    var lx=u.valToPos(bar.t+chartPayload.bucketSec/2,'x',true);
    if(lx<u.bbox.left||lx>u.bbox.left+u.bbox.width)continue;
    ctx.fillStyle=toneColor(bar.stripTone==='warn'?'muted':bar.stripTone);
    ctx.fillText(bar.netText,lx,top+hh+STRIP_LABEL*R);
  }
  ctx.restore();
}
function stackAt(pane,sec){
  if(!pane||!pane.stack||!chartPayload)return null;
  var slot=chartPayload.bucketSec,bs=pane.stack;
  if(!bs.length)return null;
  var last=bs[bs.length-1];
  if(sec>=last.t)return last;
  for(var i=0;i<bs.length;i++){
    var b=bs[i];
    if(sec>=b.t&&sec<b.t+slot)return b;
  }
  return null;
}
function drawBands(u){
  if(!chartPayload||!chartPayload.bands||hidden.has('halts'))return;
  var ctx=u.ctx,R=pr(u);
  ctx.save();
  ctx.beginPath();
  ctx.rect(u.bbox.left,u.bbox.top,u.bbox.width,u.bbox.height);
  ctx.clip();
  ctx.globalAlpha=BAND_ALPHA;
  for(var i=0;i<chartPayload.bands.length;i++){
    var b=chartPayload.bands[i];
    var x0=u.valToPos(b.from,'x',true);
    var x1=u.valToPos(b.to,'x',true);
    if(x1<u.bbox.left||x0>u.bbox.left+u.bbox.width)continue;
    ctx.fillStyle=toneColor(b.stroke);
    ctx.fillRect(x0,u.bbox.top,Math.max(R,x1-x0),u.bbox.height);
  }
  ctx.restore();
}
function drawTrades(u,payload,paneId){
  if(!payload||!payload.trades||hidden.has('trades'))return;
  var pane=findPane(paneId);
  if(!pane)return;
  var ctx=u.ctx,R=pr(u);
  ctx.save();
  ctx.beginPath();
  ctx.rect(u.bbox.left,u.bbox.top,u.bbox.width,u.bbox.height);
  ctx.clip();
  for(var i=0;i<payload.trades.length;i++){
    var td=payload.trades[i];
    var x=u.valToPos(td.t,'x',true);
    if(x<u.bbox.left-20*R||x>u.bbox.left+u.bbox.width+20*R)continue;
    var yv=valueAt(pane,td.t);
    if(yv==null)continue;
    var y=u.valToPos(yv,'y',true);
    var r=td.r*R;
    var c=toneColor(td.tone);
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=c+'cc';ctx.fill();
    if(td.ring){
      ctx.beginPath();ctx.arc(x,y,r+2.5*R,0,Math.PI*2);ctx.strokeStyle=c;ctx.lineWidth=R;ctx.stroke();
    }
  }
  ctx.restore();
}
function drawVirtual(u){
  drawBands(u);
  drawTrades(u,chartPayload,'virtual');
}
function drawWallet(u){
  drawTrades(u,walletPayload,'wallet');
}
function lgdSync(){
  var el=$('lgd');
  if(!el)return;
  var pane=findPane('coins');
  var st=pane&&pane.stack?pane.stack:[];
  var hasFlat=false,hasDrop=false;
  for(var s=0;s<st.length;s++){
    if(st[s].flat)hasFlat=true;
    if(st[s].notSimulated)hasDrop=true;
  }
  var btns=el.querySelectorAll('button[data-seg]');
  for(var i=0;i<btns.length;i++){
    var k=btns[i].getAttribute('data-seg');
    btns[i].setAttribute('aria-pressed',hidden.has(k)?'false':'true');
    if(k==='flat')btns[i].hidden=!hasFlat;
    if(k==='notSimulated')btns[i].hidden=!hasDrop;
  }
}
function bindLgd(){
  var el=$('lgd');
  if(!el||el.dataset.bound==='1')return;
  el.dataset.bound='1';
  el.addEventListener('click',function(e){
    var t=e.target;
    if(!t||!t.closest)return;
    var b=t.closest('button[data-seg]');
    if(!b)return;
    var k=b.getAttribute('data-seg');
    if(!k)return;
    if(hidden.has(k))hidden.delete(k);else hidden.add(k);
    try{
      var keys=[];
      hidden.forEach(function(x){keys.push(x);});
      localStorage.setItem('snipe.chartHidden',keys.join(','));
    }catch(_){}
    lgdSync();
    paint();
    Object.keys(plots).forEach(function(id){if(plots[id])plots[id].redraw();});
  });
}
function fullRange(id){
  var payload=payloadOf(id);
  if(!payload)return [0,1];
  return [payload.from,payload.to];
}
function onXScale(u){
  if(syncing)return;
  var id=plotId(u);
  if(!id)return;
  var g=groupOf(id);
  syncing=true;
  var mn=u.scales.x.min,mx=u.scales.x.max;
  Object.keys(plots).forEach(function(k){
    if(groupOf(k)!==g)return;
    var p=plots[k];
    if(p&&p!==u)p.setScale('x',{min:mn,max:mx});
  });
  syncing=false;
  var fr=fullRange(id);
  userZoomed[g]=mn>fr[0]+ZOOM_SLOP||mx<fr[1]-ZOOM_SLOP;
  if(g==='charts'){
    var chip=$('zoomchip');
    if(chip)chip.hidden=!userZoomed.charts;
  }
}
function resetZoom(){
  if(!chartPayload)return;
  var fr=[chartPayload.from,chartPayload.to];
  syncing=true;
  Object.keys(plots).forEach(function(id){
    if(groupOf(id)!=='charts')return;
    var p=plots[id];
    if(p)p.setScale('x',{min:fr[0],max:fr[1]});
  });
  syncing=false;
  userZoomed.charts=false;
  var chip=$('zoomchip');
  if(chip)chip.hidden=true;
}
function valueAt(pane,sec){
  if(!pane||!pane.t||pane.t.length===0)return null;
  var lo=0,hi=pane.t.length-1,found=-1;
  while(lo<=hi){
    var mid=(lo+hi)>>1;
    if(pane.t[mid]<=sec){found=mid;lo=mid+1;}
    else hi=mid-1;
  }
  if(found<0)return null;
  var y=pane.y[found];
  return y===null||y===undefined?null:y;
}
function paintTip(sec,id){
  var tip=$(tipId(id));
  var payload=payloadOf(id);
  if(!tip||!payload)return;
  var h='<div class="t">'+utcTime(sec)+'</div>';
  for(var i=0;i<payload.panes.length;i++){
    var pane=payload.panes[i];
    if(pane.missing){
      h+='<div class="r"><span>'+pane.title+'</span><span class="muted">'+pane.missing+'</span></div>';
      continue;
    }
    if(pane.kind==='stack'){
      var b=stackAt(pane,sec);
      h+='<div class="r"><span>coins launched</span><span>'+(b?String(b.height):'–')+'</span></div>';
      h+='<div class="r"><span>paper win</span><span>'+(b?String(b.win):'–')+'</span></div>';
      h+='<div class="r"><span>paper loss</span><span>'+(b?String(b.loss):'–')+'</span></div>';
      h+='<div class="r"><span>pending</span><span>'+(b?String(b.pending):'–')+'</span></div>';
      h+='<div class="r"><span>break-even</span><span>'+(b?String(b.flat):'–')+'</span></div>';
      h+='<div class="r"><span>no estimate</span><span>'+(b?String(b.notSimulated):'–')+'</span></div>';
      h+='<div class="r"><span>filtered out</span><span>'+(b?String(b.filtered):'–')+'</span></div>';
      h+='<div class="r"><span>net</span><span>'+(b&&b.netText?b.netText:'–')+'</span></div>';
      continue;
    }
    var y=valueAt(pane,sec);
    var text=y===null?'–':Number(y).toFixed(pane.yDecimals)+' '+pane.unit;
    h+='<div class="r"><span>'+pane.title+'</span><span>'+text+'</span></div>';
    for(var r=0;r<pane.rules.length;r++){
      var rule=pane.rules[r];
      h+='<div class="r"><span>'+rule.label+'</span><span>'+Number(rule.value).toFixed(pane.yDecimals)+'</span></div>';
    }
  }
  var trades=payload.trades||[];
  var near=null,best=30;
  for(var n=0;n<trades.length;n++){
    var d=Math.abs(trades[n].t-sec);
    if(d<best){best=d;near=trades[n];}
  }
  if(near){
    h+='<div class="r"><span>'+near.token+(near.book?' · '+near.book:'')+'</span><span>'+near.reason+'</span></div>';
    h+='<div class="r"><span>P&L</span><span>'+near.pnlText+'</span></div>';
  }
  tip.innerHTML=h;
  tip.style.display='block';
  var panes=$(wrapId(id));
  if(!panes)return;
  var w=tip.offsetWidth,ph=panes.clientWidth;
  var left=mouse.x+14;
  if(left+w>ph-4)left=ph-w-4;
  if(left<4)left=4;
  tip.style.left=left+'px';
  tip.style.top=(mouse.y+14)+'px';
}
function onCursor(u){
  var L=u.cursor.left;
  var id=plotId(u);
  var tip=id?$(tipId(id)):null;
  if(L==null||L<0){if(tip)tip.style.display='none';return;}
  if(id)paintTip(u.posToVal(L,'x'),id);
}
function mkPane(el,pane){
  var height=Number(el.getAttribute('data-h'))||1;
  var wrap=$(wrapId(pane.id));
  var width=wrap&&wrap.clientWidth?wrap.clientWidth:1;
  var decimals=pane.yDecimals;
  var kind=pane.kind;
  var paths=typeof uPlot!=='undefined'&&uPlot.paths?uPlot.paths:null;
  var seriesPaths=undefined;
  if(kind==='step'&&paths&&paths.stepped)seriesPaths=paths.stepped({align:1});
  if(kind==='bars'&&paths&&paths.bars)seriesPaths=paths.bars({size:[0.6,100]});
  if(kind==='stack')seriesPaths=function(){return null;};
  var yAxis=ax();
  yAxis.scale='y';yAxis.side=3;yAxis.size=64;
  yAxis.values=function(u,vs){return vs.map(function(v){return v==null?null:Number(v).toFixed(decimals);});};
  var xAxis=(pane.id==='coins'||pane.id==='wallet')?ax():xMute();
  if(pane.id==='coins'){
    xAxis.scale='x';xAxis.side=2;
    xAxis.size=kind==='stack'?X_SIZE:28;
    if(kind==='stack')xAxis.gap=X_GAP;
  }
  if(pane.id==='wallet'){
    xAxis.scale='x';xAxis.side=2;xAxis.size=28;
  }
  var series={
    scale:'y',width:(kind==='bars'||kind==='stack')?0:1.75,points:{show:false},spanGaps:false,
    stroke:function(){var live=findPane(pane.id);return toneColor(live?live.stroke:pane.stroke);},
    fill:kind==='bars'?function(){var live=findPane(pane.id);return toneColor(live?live.stroke:pane.stroke);} : undefined
  };
  if(seriesPaths)series.paths=seriesPaths;
  var draw=kind==='stack'?drawStack:(pane.id==='virtual'?drawVirtual:(pane.id==='wallet'?drawWallet:drawRules));
  var syncKey=pane.id==='wallet'?'snipe-wallet':'snipe';
  return new uPlot({
    width:width,height:height,legend:{show:false},
    cursor:{sync:{key:syncKey,scales:['x',null]},drag:{x:true,y:false,setScale:true},points:{show:false}},
    padding:[8,46,0,0],
    tzDate:function(ts){return uPlot.tzDate(new Date(ts*1000),'UTC');},
    scales:{
      x:{time:true,auto:false},
      y:{range:function(u,lo,hi){return yRange(lo,hi,findPane(pane.id));}}
    },
    axes:[xAxis,yAxis],
    series:[{},series],
    hooks:{draw:[draw],setScale:[function(u,k){if(k==='x')onXScale(u);}],setCursor:[onCursor]}
  },[[],[]],el);
}
function mount(payload){
  if(!payload||!payload.panes)return;
  payload.panes.forEach(function(pane){
    var el=paneEl(pane.id);
    if(!el)return;
    el.innerHTML='';
    plots[pane.id]=mkPane(el,pane);
  });
}
function rebuild(){
  destroyAll();
  walletPayload=readPayload('r-walletpayload');
  chartPayload=readPayload('r-chartpayload');
  if(typeof uPlot==='undefined')return;
  mount(walletPayload);
  mount(chartPayload);
  bindWrap('wallet-panes','wallet-tip');
  bindWrap('panes','tip');
  bindLgd();
  lgdSync();
}
function paintOne(payload,zoomed){
  if(!payload||!payload.panes)return;
  var fr=[payload.from,payload.to];
  payload.panes.forEach(function(pane){
    var sub=$('sub-'+pane.id);
    if(sub)sub.textContent=pane.subtitle;
    var empty=emptyEl(pane.id);
    var el=paneEl(pane.id);
    var missing=pane.missing||(pane.kind!=='stack'&&pane.t.length===0);
    if(empty){
      empty.hidden=!missing;
      empty.textContent=pane.missing||'nothing in this window to draw';
    }
    if(el)el.hidden=!!missing;
    var plot=plots[pane.id];
    if(!plot)return;
    if(missing){
      plot.setData([[],[]],false);
      if(!zoomed)plot.setScale('x',{min:fr[0],max:fr[1]});
      return;
    }
    plot.setData([pane.t.slice(),pane.y.slice()],false);
    if(!zoomed)plot.setScale('x',{min:fr[0],max:fr[1]});
  });
}
function paint(){
  walletPayload=readPayload('r-walletpayload');
  chartPayload=readPayload('r-chartpayload');
  if(typeof uPlot==='undefined')return;
  var head=$('chart-bookhead');
  if(head&&chartPayload&&chartPayload.bookHeader!=null)head.textContent=chartPayload.bookHeader;
  paintOne(walletPayload,userZoomed.wallet);
  paintOne(chartPayload,userZoomed.charts);
  lgdSync();
}
function bindWrap(id,tip){
  var el=$(id);
  if(!el||el.dataset.bound==='1')return;
  el.dataset.bound='1';
  el.addEventListener('mousemove',function(e){
    var r=el.getBoundingClientRect();
    mouse.x=e.clientX-r.left;mouse.y=e.clientY-r.top;
  });
  el.addEventListener('mouseleave',function(){
    var t=$(tip);if(t)t.style.display='none';
  });
}
document.addEventListener('click',function(ev){
  var t=ev.target;
  if(!t||!t.closest)return;
  if(t.closest('#zoomchip')){ev.preventDefault();resetZoom();}
});
window.addEventListener('resize',function(){
  Object.keys(plots).forEach(function(id){
    var p=plots[id];
    var el=paneEl(id);
    var wrap=$(wrapId(id));
    if(!p||!el||!wrap)return;
    var h=Number(el.getAttribute('data-h'))||1;
    p.setSize({width:wrap.clientWidth||1,height:h});
  });
});

window.__snipeCharts={
  rebuild:function(){rebuild();paint();},
  paint:function(){
    if(!Object.keys(plots).length)rebuild();
    paint();
  }
};
window.__snipeCharts.rebuild();
})();`
  .replace('__RANGE_PAD__', String(LEVELS.chartRangePad))
  .replace('__MIN_RANGE__', String(LEVELS.chartMinRange))
  .replace('__CONST_PAD__', String(LEVELS.chartConstantPad))
  .replace('__ZOOM_SLOP__', String(LEVELS.chartZoomSlopSec))
  .replace('__BAR_FRAC__', String(LEVELS.chartBarSlotFraction))
  .replace('__BAR_MIN__', String(LEVELS.chartBarMinPx))
  .replace('__BAR_MAX__', String(LEVELS.chartBarMaxPx))
  .replace('__SEG_GAP__', String(LEVELS.chartSegGapMinPx))
  .replace('__STRIP_OFF__', String(LEVELS.chartStripOffsetPx))
  .replace('__STRIP_H__', String(LEVELS.chartStripHeightPx))
  .replace('__STRIP_LABEL__', String(LEVELS.chartStripLabelGapPx))
  .replace('__X_SIZE__', String(LEVELS.chartXAxisSizePx))
  .replace('__X_GAP__', String(LEVELS.chartXAxisGapPx))
  .replace('__LABEL_SLOT__', String(LEVELS.chartNetLabelMinSlotPx))
  .replace('__BAND_ALPHA__', String(LEVELS.chartBandAlpha))
