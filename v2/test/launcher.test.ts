import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

let fixture: string | undefined
let child: ChildProcess | undefined
afterEach(() => {
  if (child?.exitCode === null) child.kill('SIGKILL')
  if (fixture) rmSync(fixture, {recursive:true,force:true})
})

it('the supervised launcher delivers shutdown directly to the bot', async () => {
  fixture = mkdtempSync(join(tmpdir(), 'snipe-launcher-'))
  symlinkSync(resolve('node_modules'), join(fixture, 'node_modules'))
  writeFileSync(join(fixture,'run-live.sh'),readFileSync('run-live.sh'))
  writeFileSync(join(fixture,'.env'),'MODE=shadow\nTRADE_SIZE_ETH=0.001\n')
  writeFileSync(join(fixture,'main.ts'), `import {writeFileSync} from 'node:fs';
process.on('SIGINT',()=>{writeFileSync('shutdown.saved','complete');process.exit(0)});
console.log('ready');setInterval(()=>{},1000);`)
  child = spawn('bash', ['./run-live.sh'], {cwd:fixture,env:{...process.env,MONITOR_HOST:'127.0.0.1',SWITCHES_FILE:join(fixture,'.env')},stdio:['ignore','pipe','pipe']})
  const exited = new Promise<{code:number|null;signal:string|null}>((ok,fail)=>{child!.once('error',fail);child!.once('exit',(code,signal)=>ok({code,signal}))})
  await new Promise<void>((ok,fail)=>{
    const timer=setTimeout(()=>fail(new Error('launcher did not become ready')),5000)
    child!.stdout!.on('data',data=>{if(String(data).includes('ready')){clearTimeout(timer);ok()}})
    child!.once('error',error=>{clearTimeout(timer);fail(error)})
  })
  child.kill('SIGINT')
  expect(await exited).toEqual({code:0,signal:null})
  expect(existsSync(join(fixture,'shutdown.saved'))).toBe(true)
},10000)
