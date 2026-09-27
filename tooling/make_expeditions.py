# Builds server/expeditions.json (dungeons.js /expedition): the Ayleid ruins BSHeartland finished inside but gave no
# door from the world, each with an expedition entrance from the Synod Conclave (Bruma) to its main door.
#
# Recipe (CT 115, 2026-09-27, ~10 min): copy ck-mcp core.py, esplib.py, dungeons_survey.py and dungeons_build.py to
# <SC>/ckmcp, point their paths at /opt/skyrim-data and server/plugins.server.txt, narrow their REFR/ACHR loops to
# BSHeartland.esm + DragonBreak Online Edits.esp (the full scan outlasts 25 min here), write dungeons_extra.json
# {"cells": ["CYRVarando01", "CYRNiryastare", "CYRSilorn", "CYRBawn01", "CYRTelepe01"]} and actors_server_replaced.json
# {"refs": []}, run the survey then the build, write <SC>/ruin-arrivals.json (per ruin: insideCell, insideDesc = its
# BSKARDoor01 with no XTEL, insidePos 200 units from the door toward the middle of the cell, insideRot facing in), then
#   python3 tooling/make_expeditions.py expeditions.json <SC>
import json, sys
SC = sys.argv[2] if len(sys.argv) > 2 else '.'
built = json.load(open(SC + '/ckmcp/out/dungeons.json'))['dungeons']
arr = json.load(open(SC + '/ruin-arrivals.json'))
SYNOD = {'cell': '20ff:BSHeartland.esm', 'pos': [-8.8, -578.4, -114.9], 'rot': [0.0, 0.0, 0.0]}
COUNTY = {'Niryastare': 'Kvatch County', 'Silorn': 'Skingrad County', 'Bawn': 'Bravil County', 'Telepe': 'Leyawiin County', 'Varando': ''}
out = []
for name, a in arr.items():
    cell = a['insideCell'].lower()
    d = next((x for x in built if any(c['desc'].lower() == cell for c in x['cells'])), None)
    if not d:
        print('NOT BUILT:', name); continue
    e = dict(SYNOD, expedition=True, doorPos=SYNOD['pos'], insideDesc=a['insideDesc'], insideCell=a['insideCell'], insidePos=a['insidePos'], insideRot=a['insideRot'])
    d = dict(d, name=name, type='ayleid', county=COUNTY.get(name, ''), entrances=[e])
    # the Cape Bawn lighthouse is a separate place with its own door; it stays out of Bawn's lease
    d['cells'] = [c for c in d['cells'] if 'Lighthouse' not in c.get('edid', '')]
    keep = {c['desc'].lower() for c in d['cells']}
    d['zones'] = [z for z in d['zones'] if str(z.get('cell', '')).lower() in keep]
    d['chests'] = [c for c in d['chests'] if str(c.get('cell', '')).lower() in keep]
    # Varando: one skeleton among 31 chests (its enemies start disabled in BSHeartland); a loot run, so left out
    if sum(len(z['npcs']) for z in d['zones']) < 8:
        print('LEFT OUT (almost no enemies):', name); continue
    out.append(d)
    print(name, d['id'], 'cells', len(d['cells']), 'zones', len(d['zones']), 'npcs', sum(len(z['npcs']) for z in d['zones']), 'chests', len(d['chests']))
json.dump({'_comment': 'Expeditions from the Synod Conclave (dungeons.js /expedition). Built on CT 115 from the load order by ck-mcp dungeons_survey.py + dungeons_build.py (scratch copy), then given an expedition entrance: cell/pos/rot = where the party sets out and comes back (the Synod), inside* = the arrival spot 200 units into the ruin from its main door, which has no destination of its own.', 'expeditions': out},
          open(sys.argv[1], 'w'), indent=0)
