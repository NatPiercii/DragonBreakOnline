# Economy audit of the live world (read only): who holds what, and what looks duplicated.
# sudo python3 tools/economy/econ_audit.py > report.txt   (read only; the world and the gameplay files as live)
import sys, os, json, re, struct, collections
sys.path.insert(0, os.environ.get('ESPLIB_DIR', os.path.expanduser('~nate/dragonbreak/ck-mcp')))
import esplib

DATA = '/opt/skyrim-data'
ORDER = [l.strip() for l in open(os.path.expanduser('~nate/dragonbreak/fork/deploy/skyrim-data/loadorder.txt')) if l.strip() and not l.startswith('#')]
CF = '/opt/skymp-state/world/changeForms'
SERVER = '/opt/alduinak/build/dist/server'

# global id -> (type, edid, value) for items, using the runtime numbering (full plugins 00.., light plugins FE xxx)
items = {}
full_i = light_i = 0
for name in ORDER:
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        continue
    p = esplib.Plugin(path)
    if p.esl:
        base, mask, light = 0xFE000000 | (light_i << 12), 0xFFF, True; light_i += 1
    else:
        base, mask, light = full_i << 24, 0xFFFFFF, False; full_i += 1
    order_names = [m.lower() for m in p.masters]
    with open(path, 'rb') as fh:
        for t, fid, fl, off, sz, ctx in p.index:
            if t not in ('WEAP', 'ARMO', 'MISC', 'INGR', 'ALCH', 'BOOK', 'AMMO', 'SLGM', 'SCRL', 'KEYM', 'LIGH'):
                continue
            src, loc = p.modindex_source(fid)
            # only the record's own plugin defines its global id; overrides are resolved to the source's slot below
            d = p.data_at(fh, off, sz, fl)
            subs = dict((s, v) for s, v in esplib.subrecords(d))
            edid = subs.get(b'EDID', b'').rstrip(b'\0').decode('cp1252', 'replace')
            data = subs.get(b'DATA') or b''
            value = struct.unpack_from('<I', data, 12 if t == 'AMMO' else 0)[0] if len(data) >= (16 if t == 'AMMO' else 4) else 0
            if t == 'ALCH':
                enit = subs.get(b'ENIT') or b''
                value = struct.unpack_from('<I', enit, 0)[0] if len(enit) >= 4 else 0
            items[(src, loc)] = (t, edid, value)
    # remember this plugin's slot for resolving
    items.setdefault('__slots__', {})[p.key] = (base, mask)
slots = items.pop('__slots__')
glob = {}
for (src, loc), v in items.items():
    if src in slots:
        base, mask = slots[src]
        glob[(base | (loc & mask)) & 0xFFFFFFFF] = v

def info(bid):
    return glob.get(bid & 0xFFFFFFFF, ('?', f'{bid:08x}', 0))

ART = re.compile('|'.join(f'(?:{p})' for p in json.load(open(os.path.join(SERVER, 'artifacts.json')))['patterns']), re.I)
BAN = re.compile(r'Ebony|Daedric', re.I)
PLAIN = {'baseId', 'count', 'worn', 'wornLeft'}

holders = []   # (label, kind, entries)
for n in os.listdir(CF):
    if not n.endswith('.json'):
        continue
    d = json.load(open(os.path.join(CF, n)))
    ents = (d.get('inv') or {}).get('entries') or []
    if not ents:
        continue
    df = d.get('dynamicFields') or {}
    if d.get('profileId', -1) >= 0:
        app = d.get('appearanceDump') or {}
        name = (app.get('name') if isinstance(app, dict) else None) or '?'
        label = f'{name} #{df.get("private.charTag", "?")} (profile {d["profileId"]}, {d["formDesc"]})'
        holders.append((label, 'character', ents, d))
    elif d.get('recType') != 1:
        holders.append((f'container {d["formDesc"]} base {d.get("baseDesc")}', 'container', ents, d))

gold_rows, flags = [], collections.defaultdict(list)
made = collections.defaultdict(list)   # extras signature -> holders
for label, kind, ents, d in holders:
    gold = sum(int(e.get('count') or 0) for e in ents if e.get('baseId') == 15)
    value = 0
    for e in ents:
        t, edid, v = info(int(e['baseId']))
        c = int(e.get('count') or 0)
        if e['baseId'] != 15:
            value += v * c
        extras = {k: v2 for k, v2 in e.items() if k not in PLAIN and v2 not in (None, 0, False, '')}
        if t in ('WEAP', 'ARMO') and c > 3:
            flags['stacked gear (more than 3 of one weapon/armor)'].append(f'{label}: {c} x {edid}')
        if ART.search(edid):
            flags['artifacts held'].append(f'{label}: {c} x {edid}')
        if BAN.search(edid) and t in ('WEAP', 'ARMO', 'MISC'):
            flags['Ebony/Daedric held'].append(f'{label}: {c} x {edid}')
        if extras and t in ('WEAP', 'ARMO'):
            sig = json.dumps({'b': e['baseId'], **extras}, sort_keys=True)
            made[sig].append((label, c))
    if kind == 'character' or gold >= 500 or value >= 5000:
        gold_rows.append((gold, value, label, kind))

for sig, hs in made.items():
    total = sum(c for _, c in hs)
    if total > 1:
        s = json.loads(sig)
        t, edid, _ = info(s['b'])
        ext = ', '.join(f'{k}={v}' for k, v in s.items() if k not in ('b',) and k != 'enchantmentEffects')[:120]
        eff = ' with a player enchantment' if 'enchantmentEffects' in s else ''
        flags['identical player-made items (tempered/enchanted) in more than one copy'].append(
            f'{edid}{eff} [{ext}] x{total}: ' + '; '.join(f'{h} ({c})' for h, c in hs))

print('== Gold and carried item value (characters, and containers holding 500+ gold or 5,000+ value)')
for gold, value, label, kind in sorted(gold_rows, reverse=True)[:40]:
    print(f'{gold:8d} gold  {value:9d} item value  {kind:9s} {label}')
chars = [r for r in gold_rows if r[3] == 'character']
print(f'-- {len(chars)} characters; total gold carried {sum(r[0] for r in chars)}; median {sorted(r[0] for r in chars)[len(chars)//2] if chars else 0}')
for f in ('bank.json', 'businesses.json', 'economy.json', 'guilds.json', 'faction-storage.json', 'commissions.json', 'tenancy.json'):
    p = os.path.join(SERVER, f)
    if os.path.exists(p):
        print(f'-- {f}: {os.path.getsize(p)} bytes')
try:
    bank = json.load(open(os.path.join(SERVER, 'bank.json')))
    print('== bank.json (top level keys and balances)')
    print(json.dumps(bank)[:1500])
except Exception as e:
    print('bank.json unreadable', e)
for k, v in flags.items():
    print(f'== {k}: {len(v)}')
    for line in v[:40]:
        print('  ' + line)
