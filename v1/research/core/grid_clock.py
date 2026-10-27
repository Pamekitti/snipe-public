"""Historical approximation of the serial shadow worker's publication clock."""
import hashlib,json

def recorded_publications(raw):
    config=raw.get("state",{}).get("risk",{}).get("venue",{}).get("configId")
    output={}
    if not config:return output
    for job in raw.get("bot_shadow_jobs",[]):
        if job.get("config")!=config or job.get("status")!="published" or not job.get("request"):continue
        if not all(job.get(k) is not None for k in ("pnl","close_at","available","published_at","gate_at")):continue
        request=json.loads(job["request"]) if isinstance(job["request"],str) else job["request"]
        output[job["token"].lower()]={**job,"request_sha256":hashlib.sha256(json.dumps(request,sort_keys=True).encode()).hexdigest()}
    return output


def publications(records, models, delay=0, recorded=None):
    completed = None
    output = []
    for record in sorted(records, key=lambda r: (r['entry'], r['token'])):
        model = models[record['token']]
        # 3s exit coverage, 10s header age, then a 1s worker tick.
        ready = model['entry'] + model.get('send_delay_ms', 0) + model.get('open_delay_ms', 0) + model.get('collection_hold_ms', 45000) + 13000
        tick = (ready // 1000 + 1) * 1000
        completed = max(tick, completed + 1000 if completed is not None else tick)
        available = max(record['available'] - 1, completed) + 1 + delay
        source='modeled_serial_worker'
        proof=(recorded or {}).get(record['token'])
        if proof and proof['request_sha256']==model.get('request_sha256') and int(proof['pnl'])==int(model.get('results',{}).get('adaptive',{}).get('pnlWei',0)) and proof['close_at']==model.get('results',{}).get('adaptive',{}).get('exitAt'):
            available=max(proof['available'],proof['published_at'],proof['gate_at'],proof['close_at'])+delay
            source='recorded_exact_request'
        output.append(dict(record, available=available, modeled_durable_at=completed,publication_source=source))
    return output
