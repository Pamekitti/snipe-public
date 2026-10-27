/**
 * The browser's entire share of the work: swap in HTML, remember which tab is open.
 *
 * IT IS A STRING, NOT A BUILD ARTEFACT. v2 runs `.ts` under `tsx` with no bundler anywhere, and
 * `deploy.sh` ships source files. A client that needed compiling would put a build step between
 * "the tests passed" and "the page renders", which is a new way for the box to disagree with the
 * laptop. So this ships as a string, inlined into the document, and the only cost is that it is
 * plain ES5-era JavaScript rather than TypeScript.
 *
 * IT COMPUTES NOTHING AND IT MUST STAY THAT WAY. It assigns finished HTML to `innerHTML`, it
 * tracks which tab is selected, it keeps unfinished size input across a stream tick, and it
 * posts operator controls. There is no formatter, no threshold and no model here. Chart
 * drawing lives in `charts-client.ts`, which is the only script allowed to format a number.
 *
 * WHY TAB STATE LIVES HERE AND IN THE URL. The server renders only the selected book and
 * lookback, so it has to be told; and a selection that lived only in the DOM would not survive
 * a reload or a shared link. Holding it on `<html data-*>` and mirroring it into the query
 * string covers both.
 *
 * THE BODY BELOW CONTAINS NO BACKTICKS AND NO `${`, deliberately, so it can live in a template
 * literal and take its two timings from `levels.ts` without any escaping.
 */
import { LEVELS } from '../levels.js'

export const CLIENT_JS = `(function(){
"use strict";
var root=document.documentElement;
var es=null,poll=null,retry=null;
var streamGen=0;
var openToken=null;
var metricsOpen=false;
var sizeDrafts={};

function params(){
  var p=new URLSearchParams();
  if(root.dataset.book)p.set('book',root.dataset.book);
  if(root.dataset.window)p.set('h',root.dataset.window);
  p.set('exits',root.dataset.exits||'all');
  return p;
}

function restoreMetrics(){
  var table=document.getElementById('kpi');
  var btn=document.querySelector('[data-metrics]');
  if(!table||!btn)return;
  if(metricsOpen)table.classList.add('show-extra');
  else table.classList.remove('show-extra');
  btn.setAttribute('aria-expanded',metricsOpen?'true':'false');
  btn.textContent=metricsOpen?'Fewer metrics':'More metrics';
}

function setExitOpen(token,open){
  var rows=document.querySelectorAll('#rec tr[data-token]');
  for(var i=0;i<rows.length;i++){
    var row=rows[i];
    var match=row.getAttribute('data-token')===token;
    if(row.classList.contains('hd')){
      row.setAttribute('aria-expanded',open&&match?'true':'false');
      if(match){if(open)row.classList.add('open');else row.classList.remove('open');}
      else row.classList.remove('open');
      var chev=row.querySelector('td.sm');
      if(chev)chev.innerHTML=open&&match?'&#9662;':'&#9656;';
    }else{
      row.hidden=!(open&&match);
    }
  }
}

function restoreExit(){
  if(openToken)setExitOpen(openToken,true);
}

function restoreSizeDrafts(){
  var inputs=document.querySelectorAll('[data-size-input]');
  for(var i=0;i<inputs.length;i++){
    var book=inputs[i].getAttribute('data-size-input');
    if(book&&Object.prototype.hasOwnProperty.call(sizeDrafts,book))inputs[i].value=sizeDrafts[book];
  }
}

function bookId(row){
  var tab=row&&row.querySelector('[data-book]');
  return tab?tab.getAttribute('data-book'):null;
}

/* Keep the real input node connected while labels and STOP/AUTO state refresh around it.
   Replacing that node closes the phone keyboard even if its text is restored afterwards. */
function patchBooks(el,html){
  var holder=document.createElement('div');
  holder.innerHTML=html;
  var next=holder.querySelector('#books');
  var current=el.querySelector('#books');
  if(!next||!current){el.innerHTML=html;return;}

  var oldRows=current.querySelectorAll('.book-row');
  var nextRows=next.querySelectorAll('.book-row');
  var oldByBook={};
  var i;
  for(i=0;i<oldRows.length;i++){
    var oldId=bookId(oldRows[i]);
    if(oldId)oldByBook[oldId]=oldRows[i];
  }

  var seen={};
  for(i=0;i<nextRows.length;i++){
    var nextRow=nextRows[i];
    var id=bookId(nextRow);
    var oldRow=id?oldByBook[id]:null;
    if(!id||!oldRow){current.appendChild(nextRow.cloneNode(true));continue;}
    seen[id]=true;

    var oldTab=oldRow.querySelector('.tab.book');
    var nextTab=nextRow.querySelector('.tab.book');
    if(oldTab&&nextTab)oldTab.replaceWith(nextTab.cloneNode(true));

    var oldControls=oldRow.querySelector('.book-controls');
    var nextControls=nextRow.querySelector('.book-controls');
    if(!oldControls||!nextControls)continue;
    var oldSize=oldControls.querySelector('.book-size');
    var nextSize=nextControls.querySelector('.book-size');
    if(oldSize&&nextSize){
      var attrs=['data-size-old','data-size-source','data-drawdown-stakes'];
      for(var a=0;a<attrs.length;a++)oldSize.setAttribute(attrs[a],nextSize.getAttribute(attrs[a])||'');
      var oldInput=oldSize.querySelector('[data-size-input]');
      var nextInput=nextSize.querySelector('[data-size-input]');
      if(oldInput&&nextInput){
        oldInput.min=nextInput.min;oldInput.max=nextInput.max;oldInput.step=nextInput.step;
        if(document.activeElement!==oldInput&&!Object.prototype.hasOwnProperty.call(sizeDrafts,id))oldInput.value=nextInput.value;
      }
      var oldDefault=oldSize.querySelector('[data-size-default]');
      var nextDefault=nextSize.querySelector('[data-size-default]');
      if(oldDefault&&!nextDefault)oldDefault.remove();
      else if(!oldDefault&&nextDefault)oldSize.appendChild(nextDefault.cloneNode(true));
    }
    var children=oldControls.children;
    for(var c=children.length-1;c>=0;c--)if(!children[c].classList.contains('book-size'))children[c].remove();
    var nextChildren=nextControls.children;
    for(var n=0;n<nextChildren.length;n++)if(!nextChildren[n].classList.contains('book-size'))oldControls.appendChild(nextChildren[n].cloneNode(true));
  }
  for(i=0;i<oldRows.length;i++){
    var staleId=bookId(oldRows[i]);
    if(staleId&&!seen[staleId])oldRows[i].remove();
  }
}

function paintCharts(chartsDirty,payloadDirty){
  var api=window.__snipeCharts;
  if(!api)return;
  if(chartsDirty)api.rebuild();
  else if(payloadDirty)api.paint();
}

/* Regions arrive already rendered. Charts are the exception: replacing the shell destroys
   canvases, so the payload region is written as text and the drawer calls setData.

   The shell is built once. A later push that rewrites it (a live subtitle, a clock in a
   parent, a reconnect's first snapshot) would drop the canvases, the document would shrink,
   and the browser would clamp scroll to the top. Lookback and book clicks already paint the
   pressed tab; the new series arrives on the payload regions. The total wallet keeps
   #pane-wallet the same way, so a book click does not rebuild it. */
function apply(regions){
  var sx=window.scrollX,sy=window.scrollY;
  var chartsDirty=false,payloadDirty=false;
  var tableScrolls=[];
  for(var k in regions){
    if(!Object.prototype.hasOwnProperty.call(regions,k))continue;
    var el=document.getElementById('r-'+k);
    if(!el)continue;
    if(k==='chartpayload'||k==='walletpayload'){el.textContent=regions[k];payloadDirty=true;continue;}
    if(k==='charts'){
      if(document.getElementById('pane-virtual'))continue;
      el.innerHTML=regions[k];
      chartsDirty=true;
      continue;
    }
    if(k==='walletchart'){
      if(document.getElementById('pane-wallet'))continue;
      el.innerHTML=regions[k];
      chartsDirty=true;
      continue;
    }
    if(k==='books'){patchBooks(el,regions[k]);continue;}
    var scrollers=el.querySelectorAll('.scroll');
    for(var i=0;i<scrollers.length;i++)tableScrolls.push({region:k,index:i,left:scrollers[i].scrollLeft,top:scrollers[i].scrollTop});
    el.innerHTML=regions[k];
  }
  restoreMetrics();
  restoreExit();
  restoreSizeDrafts();
  paintCharts(chartsDirty,payloadDirty);
  // Table containers are replaced on refresh; their offsets belong to the reader.
  // Restore after expanded rows so the full scroll range exists.
  for(var j=0;j<tableScrolls.length;j++){
    var saved=tableScrolls[j];
    var container=document.getElementById('r-'+saved.region);
    var scroller=container&&container.querySelectorAll('.scroll')[saved.index];
    if(scroller){scroller.scrollLeft=saved.left;scroller.scrollTop=saved.top;}
  }
  if(window.scrollX!==sx||window.scrollY!==sy)window.scrollTo(sx,sy);
}

function syncUrl(){
  var q=params().toString();
  history.replaceState(null,'',q?('?'+q):location.pathname);
}

function stop(){
  streamGen++;
  if(es){es.close();es=null;}
  if(poll){clearInterval(poll);poll=null;}
  if(retry){clearTimeout(retry);retry=null;}
}

function connect(){
  stop();
  var gen=streamGen;
  if(!window.EventSource){polling();return;}
  es=new EventSource('/api/stream?'+params().toString());
  es.onmessage=function(e){
    /* A closed stream can still deliver one buffered snapshot. That snapshot is the unfiltered
       page, and applying it after a book click is why the exits filter looked like a no-op. */
    if(gen!==streamGen)return;
    try{apply(JSON.parse(e.data));}catch(_){}
  };
  /* EventSource reconnects by itself while the connection is merely interrupted. A CLOSED
     readyState means it has given up, and only then is polling the right answer. */
  es.onerror=function(){
    if(gen!==streamGen)return;
    if(es&&es.readyState===2){es=null;polling();}
  };
}

function polling(){
  if(poll)return;
  var gen=streamGen;
  var tick=function(){
    if(gen!==streamGen)return;
    fetch('/api/regions?'+params().toString(),{cache:'no-store'})
      .then(function(r){return r.json();})
      .then(function(regions){if(gen===streamGen)apply(regions);})
      .catch(function(){});
  };
  tick();
  poll=setInterval(tick,POLL_MS);
  /* Keep trying the stream: polling is the fallback, not the destination. */
  retry=setTimeout(function(){if(poll)connect();},RETRY_MS);
}

/* One listener for every tab and every button. Regions are replaced wholesale, so a listener
   bound to a button would be lost on the next update; delegation survives. */
document.addEventListener('click',function(ev){
  var t=ev.target;
  if(!t||!t.closest)return;

  var metrics=t.closest('[data-metrics]');
  if(metrics){
    metricsOpen=!metricsOpen;
    restoreMetrics();
    return;
  }

  var exitRow=t.closest('#rec tr.hd');
  if(exitRow){
    var token=exitRow.getAttribute('data-token');
    openToken=(openToken===token)?null:token;
    restoreExit();
    return;
  }

  var sizeSet=t.closest('[data-size-set]');
  if(sizeSet){
    ev.preventDefault();
    sizeControl(sizeSet.getAttribute('data-size-set'),false,sizeSet);
    return;
  }
  var sizeDefault=t.closest('[data-size-default]');
  if(sizeDefault){
    ev.preventDefault();
    sizeControl(sizeDefault.getAttribute('data-size-default'),true,sizeDefault);
    return;
  }

  var el=t.closest('[data-book],[data-window],[data-exits-book],[data-action]');
  if(!el)return;

  if(el.hasAttribute('data-action')){
    ev.preventDefault();
    control(el.getAttribute('data-action'),el);
    return;
  }
  if(el.hasAttribute('data-book'))root.dataset.book=el.getAttribute('data-book');
  else if(el.hasAttribute('data-window'))root.dataset.window=el.getAttribute('data-window');
  else if(el.hasAttribute('data-exits-book'))root.dataset.exits=el.getAttribute('data-exits-book');

  /* Move the highlight immediately. The server confirms it on the next push, but a tab that
     waits for a round trip before looking pressed feels broken on a phone. Book rows wrap
     the tab, so the pressed class is on the buttons, not the row. */
  var group=el.closest('.tabs,.seg')||el.parentNode;
  if(group){
    var tabs=group.querySelectorAll?group.querySelectorAll('.tab'):group.children;
    for(var i=0;i<tabs.length;i++)tabs[i].classList.remove('on');
  }
  el.classList.add('on');

  syncUrl();
  connect();
});

document.addEventListener('input',function(ev){
  var t=ev.target;
  if(!t||!t.getAttribute)return;
  var book=t.getAttribute('data-size-input');
  if(book)sizeDrafts[book]=t.value;
});

document.addEventListener('keydown',function(ev){
  if(ev.key!=='Enter'&&ev.key!==' ')return;
  var t=ev.target;
  if(!t||!t.closest)return;
  var row=t.closest('#rec tr.hd');
  if(!row)return;
  ev.preventDefault();
  row.click();
});

function control(action,btn){
  if(action==='set-api-mode'){
    /* Selecting a provider is explicit. Rescue spending is visible beside the selector. */
  }else if(action==='retry-exit'){
    if(!confirm('Retry the exit for '+btn.getAttribute('data-recovery-token')+'? This can sell all remaining tokens and spend gas. Wallet safety stops stay in force.'))return;
  }else if(action!=='start'){
    if(!confirm('Really '+action+'? This changes what the bot does with real money.'))return;
  }
  btn.disabled=true;
  var oldLabel=btn.textContent;
  if(action==='start'||action==='set-api-mode')btn.textContent='PREPARING...';
  var body={action:action};
  if(action==='set-api-mode')body.apiMode=btn.getAttribute('data-api-mode');
  var positionId=btn.getAttribute('data-position-id');
  if(positionId)body.positionId=positionId;
  var book=btn.getAttribute('data-control-book');
  if(book)body.book=book;
  fetch('/api/control',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  }).then(function(r){return r.json();}).then(function(r){
    /* A refusal from the listener (403 cross-origin, 413 oversize, 400 unparseable) carries an
       error field and never reached the fold, so it has to be said out loud: a silent no-op on
       a STOP button reads as a bot that stopped. */
    if(r&&r.error)alert(r.error);
    else if(r&&r.why&&r.do==='nothing')alert(r.why);
    connect();
  }).catch(function(){
    alert('the control request did not reach the bot. Nothing changed.');
  }).then(function(){btn.disabled=false;btn.textContent=oldLabel;});
}

function sizeControl(book,useDefault,btn){
  var box=btn.closest('[data-size-control]');
  var input=box&&box.querySelector('[data-size-input]');
  if(!box||!input)return;
  if(!useDefault&&!input.checkValidity()){
    alert(input.validationMessage||'Enter a valid ETH size.');
    return;
  }
  var preview={action:useDefault?'preview-default':'preview-size',book:book};
  if(!useDefault)preview.sizeEth=input.value;
  setSizeBusy(box,true);
  postControl(preview).then(function(r){
    if(r&&r.error){alert(r.error);return null;}
    if(!r||r.do==='nothing'){if(r&&r.why)alert(r.why);return null;}
    var old=box.getAttribute('data-size-old');
    var source=useDefault?'the global default':(r.sizeEth+' ETH');
    var range=r.adaptiveMinEth&&r.adaptiveMaxEth?'\\nAdaptive range becomes '+r.adaptiveMinEth+'–'+r.adaptiveMaxEth+' ETH.':'';
    var message=book+' base size: '+old+' ETH to '+source+'.'+range+'\\nDrawdown becomes '+r.drawdownEth+' ETH.\\nOpen positions keep their original size.\\n\\nApply this change?';
    if(!confirm(message))return null;
    var apply={action:useDefault?'clear-size':'set-size',book:book};
    if(!useDefault)apply.sizeEth=input.value;
    return postControl(apply);
  }).then(function(r){
    if(!r)return;
    if(r.error)alert(r.error);
    else if(r.why&&r.do==='nothing')alert(r.why);
    else delete sizeDrafts[book];
    connect();
  }).catch(function(){
    alert('the size request did not reach the bot. Nothing changed.');
  }).then(function(){setSizeBusy(box,false);});
}

function postControl(body){
  return fetch('/api/control',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  }).then(function(r){return r.json();});
}

function setSizeBusy(box,busy){
  var fields=box.querySelectorAll('input,button');
  for(var i=0;i<fields.length;i++)fields[i].disabled=busy;
}

/* A backgrounded tab on a phone should not hold a stream open; reconnect on return. */
document.addEventListener('visibilitychange',function(){
  if(document.hidden)stop();else connect();
});

/* The URL wins on load, so a shared link opens on the book it names. */
(function(){
  var q=new URLSearchParams(location.search);
  if(q.get('book'))root.dataset.book=q.get('book');
  if(q.get('h'))root.dataset.window=q.get('h');
  else if(q.get('wh'))root.dataset.window=q.get('wh');
  if(q.get('exits'))root.dataset.exits=q.get('exits');
})();

connect();
})();`
  .replace('POLL_MS', String(LEVELS.streamMinIntervalMs))
  .replace('RETRY_MS', String(LEVELS.streamKeepAliveMs))
