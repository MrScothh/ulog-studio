"""Regenerate the bundled PX4 metadata (offline fallback) from PX4 build artifacts.

Usage: python tools/gen_px4_meta.py <dir with parameters.xml airframes.xml all_events.json.xz>
Sources (public): https://px4-travis.s3.amazonaws.com/Firmware/master/_general/{parameters.xml,airframes.xml,all_events.json.xz}
"""
import json, lzma, os, sys
import xml.etree.ElementTree as ET

src = sys.argv[1]
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'assets', 'px4')

params = {}
root = ET.parse(os.path.join(src, 'parameters.xml')).getroot()
for group in root.iter('group'):
    gname = group.get('name')
    for p in group.iter('parameter'):
        d = {'t': p.get('type'), 'g': gname}
        if p.get('default') is not None:
            d['d'] = float(p.get('default'))
        for tag, key in (('short_desc', 's'), ('min', 'min'), ('max', 'max'), ('unit', 'u'), ('decimal', 'dec')):
            e = p.find(tag)
            if e is not None and e.text:
                d[key] = float(e.text) if key in ('min', 'max', 'dec') else e.text.strip()
        vals = p.find('values')
        if vals is not None:
            d['v'] = {v.get('code'): (v.text or '').strip() for v in vals.iter('value')}
        bits = p.find('bitmask')
        if bits is not None:
            d['b'] = {b.get('index'): (b.text or '').strip() for b in bits.iter('bit')}
        params[p.get('name')] = d

frames = {}
root = ET.parse(os.path.join(src, 'airframes.xml')).getroot()
for group in root.iter('airframe_group'):
    for a in group.iter('airframe'):
        frames[a.get('id')] = {'name': a.get('name'), 'type': group.get('name')}

events = json.loads(lzma.decompress(open(os.path.join(src, 'all_events.json.xz'), 'rb').read()))

json.dump(params, open(os.path.join(out, 'parameters.json'), 'w'), separators=(',', ':'))
json.dump(frames, open(os.path.join(out, 'airframes.json'), 'w'), separators=(',', ':'))
json.dump(events, open(os.path.join(out, 'all_events.json'), 'w'), separators=(',', ':'))
print(len(params), 'params', len(frames), 'airframes', 'events components', list(events.get('components', {}).keys()))
