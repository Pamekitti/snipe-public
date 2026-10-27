/* Local display controls only. This file has no fetch, EventSource, wallet, or RPC code. */
(function(){
'use strict';
var state={view:'active',book:'untaxed',window:'24h'},openToken=null,exitFilter='all';
function metrics(){var t=document.getElementById('kpi');if(t)t.classList.toggle('show-extra');}
function paint(){
 var regions=window.SNIPE_DEMO_VIEWS[state.view+'|'+state.book+'|'+state.window];
 if(!regions)throw new Error('Unknown bundled demo view');
 var sx=window.scrollX,sy=window.scrollY;
 for(var k in regions){
  var el=document.getElementById('r-'+k);if(!el)continue;
  if(k==='chartpayload'||k==='walletpayload'){el.textContent=regions[k];continue;}
  if(k==='charts'||k==='walletchart')continue;
  el.innerHTML=regions[k];
 }
 document.querySelectorAll('[data-window]').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-window')===state.window);});
 document.querySelectorAll('[data-book]').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-book')===state.book);});
 var notice=document.querySelector('.demo-banner small');
 notice.textContent=state.view==='active'?'Source captured 25 Oct 2026. Trading view ends 19 Sep 2026 23:59:59 UTC. Position P&L excludes separately booked wallet gas. No wallet or trading connection.':state.view==='retired'?'Final captured time: 25 Oct 2026. No trades fall inside the final seven days. Historical observer data is unavailable.':'Missing-data interface fixture. Missing evidence is not a zero return.';
 window.__snipeCharts.paint();
 openToken=null;filterExits();window.scrollTo(sx,sy);
}
function filterExits(){
 document.querySelectorAll('[data-exits-book]').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-exits-book')===exitFilter);});
 document.querySelectorAll('#rec tr.hd').forEach(function(r){r.hidden=exitFilter!=='all'&&r.getAttribute('data-book')!==exitFilter;var next=r.nextElementSibling;if(next)next.hidden=true;});
}
function expand(row){
 var token=row.getAttribute('data-token');openToken=openToken===token?null:token;
 document.querySelectorAll('#rec tr[data-token]').forEach(function(r){var yes=r.getAttribute('data-token')===openToken;if(r.classList.contains('hd')){r.classList.toggle('open',yes);r.setAttribute('aria-expanded',String(yes));}else r.hidden=!yes;});
}
document.addEventListener('click',function(e){
 var el=e.target.closest('[data-book],[data-window],[data-exits-book],[data-metrics],#rec tr.hd');if(!el)return;
 if(el.hasAttribute('data-exits-book')){exitFilter=el.getAttribute('data-exits-book');filterExits();return;}
 if(el.hasAttribute('data-metrics')){metrics();return;}
 if(el.closest('#rec')){expand(el);return;}
 if(el.hasAttribute('data-book'))state.book=el.getAttribute('data-book');
 if(el.hasAttribute('data-window'))state.window=el.getAttribute('data-window');
 paint();
});
document.addEventListener('keydown',function(e){var row=e.target.closest('#rec tr.hd');if(row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();expand(row);}});
document.getElementById('demo-case').addEventListener('change',function(e){state.view=e.target.value;paint();});
})();
