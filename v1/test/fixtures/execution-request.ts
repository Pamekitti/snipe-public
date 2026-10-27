import { freshCurve, simBuy } from '../../src/state/curve.js'
import { EXECUTION_VERSION, EVIDENCE_VERSION, type ExecutionRequest } from '../../src/strategy/execution-model.js'
const p={phantomQuote:10n**18n,reservedTokens:10n**24n,launchSupply:10n**27n,feeBps:100n,creatorTaxBps:100n,snipeTaxStartBps:0n,snipeTaxSeconds:0n,launchedAt:1000n}
export const request=():ExecutionRequest=>{
  const quote=simBuy(p,freshCurve(p),10n**16n,1003n).tokensOut
  return {modelVersion:EXECUTION_VERSION,evidenceVersion:EVIDENCE_VERSION,strategyVersion:'test',id:'a',token:'a',curve:'c',wallet:'',params:Object.fromEntries(Object.entries(p).map(([k,v])=>[k,String(v)])),sizeWei:String(10n**16n),entryQuoteTokens:String(quote),minTokens:String(quote/2n),maxEntryMultiple:4.5,takeProfit:2,
    rules:{maxHoldMs:1000,hardStopMultiple:0.5,deadCoinAfterMs:0,deadCoinBelowMult:1.03},entryAt:1003000,endAt:1010000,pollMs:50,
    seed:{state:freshCurve(p),order:{block:1,transaction:0,log:0},at:1000000,observedAt:1000001},logs:[],
    timing:{kind:'observed',label:'test',frozenAt:1002000,fitThrough:1000000,n:100,sendMs:50,confirmationMs:100,sellMs:75,observationMs:0,sameTimeOrder:'unavailable'},
    costs:{buyWei:'10',approvalWei:'20',sellWei:'30',failedSellWei:'40',approvalDelayMs:0,retryMs:100,maxSellAttempts:4,failedSellAttempts:0},
    coverage:{complete:true,from:1000000,through:1010000,independentlyChecked:true,gaps:[]},provenance:{kind:'prospective',source:'fixture',capturedAt:1003000}}
}
