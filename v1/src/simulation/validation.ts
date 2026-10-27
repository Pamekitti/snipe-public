import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {MODEL_HASH} from './identity.js'
import {EXECUTION_VERSION} from '../strategy/execution-model.js'
import {loadScenarioRelease} from './scenario-controller.js'
export function modelValidation(path?:string){
  const result={modelVersion:EXECUTION_VERSION,modelHash:MODEL_HASH,sourceVerification:'unavailable',arithmeticVerification:'unvalidated',historicalAccuracy:'unvalidated',prospectiveValidation:'unvalidated',rankingFrozen:true}
  try{
    const receipt=JSON.parse(readFileSync(new URL('./validation.json',import.meta.url),'utf8'))
    const curveHash=createHash('sha256').update(readFileSync(new URL('../state/curve.ts',import.meta.url))).digest('hex')
    if(receipt.curveHash===curveHash&&receipt.arithmeticPassed)result.arithmeticVerification='passed'
    if(receipt.modelHash===MODEL_HASH){result.sourceVerification=receipt.sourceVerification;result.historicalAccuracy=receipt.historicalAccuracy}
  }catch{}
  if(path&&loadScenarioRelease(path+'.release.json').release){
    result.sourceVerification='passed';result.arithmeticVerification='passed';result.historicalAccuracy='passed';result.prospectiveValidation='passed';result.rankingFrozen=false
  }
  return result
}
