#!/usr/bin/env bash
# Prints each saved window entry as it is created or changed, once per second. Ctrl+C stops it.
STATE="${1:-$HOME/.config/window-memory/state.json}"
python3 - "$STATE" <<'PY'
import json, sys, time
path = sys.argv[1]
prev = {}
print(f"watching {path} (Ctrl+C to stop)")
while True:
    try:
        cur = {e['id']: e for e in json.load(open(path))['windows']}
        now = time.strftime('%H:%M:%S')
        for i, e in cur.items():
            if prev.get(i) != e:
                tag = 'CHANGED' if i in prev else 'NEW'
                mon = (e.get('monitor') or {}).get('index')
                print(now, tag, e.get('wmClass'), '| rel', e.get('rel'), '| max', e.get('maximized'), '| mon', mon, flush=True)
        for i in set(prev) - set(cur):
            print(now, 'REMOVED', prev[i].get('wmClass'), flush=True)
        prev = cur
    except FileNotFoundError:
        pass
    except Exception as ex:
        print(time.strftime('%H:%M:%S'), 'read error:', ex, flush=True)
    time.sleep(1)
PY
