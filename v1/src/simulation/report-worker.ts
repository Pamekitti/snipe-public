import { buildSimulationReport } from './reporting.js'
// This child only reads. The indicator worker remains the sole durable writer.
process.on('message',(message:any)=>{
  if(message.type!=='build')return
  try {process.send?.({type:'report',at:message.at,value:buildSimulationReport(process.argv[2],message.at-31*86400000,message.at)})}
  catch(e){process.send?.({type:'report-error',error:String(e).replace(/(?:https?|wss?):\/\/\S+/gi,'[source]').slice(0,200)})}
})
process.on('disconnect',()=>process.exit(0))
