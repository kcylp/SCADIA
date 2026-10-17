"""Measure one continuous deployed run; no credentials or raw business data are saved."""
import argparse
import datetime
import hashlib
import json
import pathlib
import statistics
import subprocess
import time
import urllib.error
import urllib.request


def get(route):
    started = time.monotonic()
    try:
        with urllib.request.urlopen('http://127.0.0.1:1881' + route, timeout=8) as response:
            body = response.read()
            return {'status': response.status, 'ms': round((time.monotonic() - started) * 1000), 'bytes': len(body)}, body
    except urllib.error.HTTPError as error:
        return {'status': error.code}, b''
    except Exception as error:
        return {'status': 0, 'errorType': type(error).__name__}, b''


def resources():
    command = "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','python.exe') } | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress"
    result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', command], capture_output=True, timeout=20)
    processes = json.loads(result.stdout.decode('utf-8-sig')) if result.returncode == 0 else []
    gpu = subprocess.run(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], capture_output=True, timeout=10)
    return {'processes': processes, 'gpu': gpu.stdout.decode().strip() if gpu.returncode == 0 else None}


def digest(root):
    hashes = {}
    for folder in ['source/server/runtime', 'source/server/api', 'source/server/dist', 'source/client/dist', 'source/tools']:
        for file in sorted((root / folder).rglob('*')):
            if file.is_file() and file.suffix in {'.js', '.ts', '.py', '.mjs', '.cjs', '.html', '.css'}:
                hashes[str(file.relative_to(root))] = hashlib.sha256(file.read_bytes()).hexdigest()
    return hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--duration', type=int, default=7200)
    parser.add_argument('--interval', type=int, default=60)
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit('Refusing to overwrite existing samples')
    initial_digest = digest(root)
    started = time.monotonic()
    start_at = datetime.datetime.now().astimezone().isoformat()
    rows = []
    deadline = started
    while True:
        row = {'at': datetime.datetime.now().astimezone().isoformat(), 'elapsedSeconds': round(time.monotonic() - started, 3)}
        row['version'], _ = get('/api/version')
        row['scenesHttp'], body = get('/api/ai/scenes')
        if row['scenesHttp']['status'] == 200:
            data = json.loads(body)
            row['sources'] = {}
            for source in ['visible', 'thermal']:
                state = data.get(source, {})
                row['sources'][source] = {key: state.get(key) for key in ['updatedAt', 'frameId', 'sessionId', 'imageWidth', 'imageHeight', 'inferenceMs', 'appliedRulesVersion', 'calibrationError', 'rulesError']}
                row['sources'][source]['ageMs'] = data.get('now', time.time() * 1000) - state.get('updatedAt', 0)
            row['reviewCounts'] = {key: len(data.get('reviews', {}).get(key, [])) if isinstance(data.get('reviews', {}).get(key), list) else None for key in ['pending', 'running', 'completed', 'failed']}
        row['ledgerHttp'], body = get('/api/ai/scene-events?scene=all&limit=1')
        if row['ledgerHttp']['status'] == 200:
            data = json.loads(body)
            row['ledgerCount'] = data.get('count')
            latest = (data.get('rows') or [{}])[0]
            row['lastEventAt'] = latest.get('at')
        for source in ['visible', 'thermal']:
            row['frame' + source.title()], _ = get('/api/ai/scenes/frame/' + source)
        row['alarms'], _ = get('/api/alarms?enabled=true')
        row['thermometryHttp'], body = get('/api/ai/scenes/thermometry')
        if row['thermometryHttp']['status'] == 200:
            t = json.loads(body)
            q = t.get('quality') or {}
            row['thermometry'] = {
                'status': t.get('status'), 'unit': t.get('unit'), 'unitSource': t.get('unitSource'),
                'deviceTemperature': t.get('deviceTemperature'), 'timeStatus': t.get('timeStatus'),
                'capturedAt': t.get('capturedAt'), 'receivedAt': t.get('receivedAt'), 'deviceTime': t.get('deviceTime'),
                'valid': q.get('valid'), 'ageMs': q.get('ageMs'), 'samples': t.get('samples'),
            }
        try:
            row['resources'] = resources()
        except Exception as error:
            row['resourceError'] = type(error).__name__
        rows.append(row)
        with output.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(json.dumps({'sample': len(rows), 'elapsed': row['elapsedSeconds'], 'http': row['version']['status'], 'ageMs': {k: v['ageMs'] for k, v in row.get('sources', {}).items()}, 'thermo': (row.get('thermometry') or {}).get('status')}, ), flush=True)
        if time.monotonic() - started >= args.duration:
            break
        deadline = min(started + args.duration, deadline + args.interval)
        time.sleep(max(0, deadline - time.monotonic()))
    def distribution(values):
        if not values:
            return None
        ordered = sorted(values)
        return {'n': len(values), 'p50': statistics.median(values), 'p95': ordered[min(len(ordered) - 1, int(len(ordered) * .95))], 'max': max(values)}
    summary = {'start': start_at, 'end': datetime.datetime.now().astimezone().isoformat(), 'elapsedSeconds': time.monotonic() - started, 'intervalSeconds': args.interval, 'samples': len(rows), 'sourceDigestStart': initial_digest, 'sourceDigestEnd': digest(root)}
    summary['httpFailures'] = sum(r.get(key, {}).get('status') != 200 for r in rows for key in ['version', 'scenesHttp', 'ledgerHttp', 'frameVisible', 'frameThermal', 'alarms', 'thermometryHttp'])
    summary['sources'] = {}
    for source in ['visible', 'thermal']:
        states = [r.get('sources', {}).get(source, {}) for r in rows]
        summary['sources'][source] = {'ageMs': distribution([s['ageMs'] for s in states if 'ageMs' in s]), 'inferenceMs': distribution([s['inferenceMs'] for s in states if isinstance(s.get('inferenceMs'), (int, float))]), 'sessions': len(set(s.get('sessionId') for s in states)), 'staleSamples': sum(s.get('ageMs', 999999) > 15000 for s in states)}
    # R-长稳：测温专用指标（现有 sources.thermal.ageMs 只是热像视频/分析源新鲜度，不是测温数据新鲜度）。
    thermo = [r.get('thermometry') for r in rows if isinstance(r.get('thermometry'), dict)]
    ok_rows = [t for t in thermo if t.get('status') == 'ok' and t.get('valid') is True]
    advances = repeats = backwards = cur_gap = max_gap = 0
    prev = None
    for t in thermo:
        c = t.get('capturedAt')
        if prev is not None and isinstance(c, (int, float)):
            if c > prev: advances += 1
            elif c == prev: repeats += 1
            else: backwards += 1
        if isinstance(c, (int, float)): prev = c
        if t.get('status') != 'ok':
            cur_gap += 1; max_gap = max(max_gap, cur_gap)
        else:
            cur_gap = 0
    summary['thermometry'] = {
        'samples': len(thermo), 'businessOk': len(ok_rows), 'businessNotOk': len(thermo) - len(ok_rows),
        'maxConsecutiveNotOk': max_gap, 'capturedAtAdvances': advances, 'capturedAtRepeats': repeats,
        'capturedAtBackwards': backwards,
        'unitConsistent': len({t.get('unit') for t in thermo}) <= 1,
        'timeStatusSeen': sorted({t.get('timeStatus') for t in thermo if t.get('timeStatus')}),
        'firstSamples': (thermo[0].get('samples') if thermo else None),
        'lastSamples': (thermo[-1].get('samples') if thermo else None),
    }
    summary['ledgerFirstLast'] = [rows[0].get('ledgerCount'), rows[-1].get('ledgerCount')]
    tm = summary['thermometry']
    summary['measurementComplete'] = (summary['elapsedSeconds'] >= args.duration and summary['sourceDigestStart'] == summary['sourceDigestEnd']
        and tm['samples'] > 0 and tm['unitConsistent'] and tm['businessNotOk'] == 0
        and tm['capturedAtAdvances'] > 0 and tm['capturedAtBackwards'] == 0)
    output.with_suffix('.summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    thermo_ok = tm['samples'] > 0 and tm['unitConsistent'] and tm['businessNotOk'] == 0 and tm['capturedAtAdvances'] > 0 and tm['capturedAtBackwards'] == 0
    return 0 if summary['measurementComplete'] and summary['httpFailures'] == 0 and thermo_ok and all(s['staleSamples'] == 0 and s['sessions'] == 1 for s in summary['sources'].values()) else 1


if __name__ == '__main__':
    raise SystemExit(main())
