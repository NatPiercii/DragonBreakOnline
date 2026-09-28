"""ruin-buttons.json for ruinbuttons.js: the buttons and levers of the expedition ruins and what each one opens.

Nate, 2026-09-28: "THE BUTTON IN TELEPE DOESNT WORK ... MAKE SURE THESE BUTTONS AND LEVERS WORK". For every cell of every
ruin in expeditions.json this reads BSHeartland.esm (the ruins are Beyond Skyrim's) and lists each reference that is an
activate parent (XAPR on its children) of a two-state activator: a child whose script, on the reference or its base, is
default2StateActivator. The animations are the script's openAnim / closeAnim properties, or the script's own defaults
("open" / "close") where the reference sets none. A child the winning plugin marks initially disabled is left out, since
the server never loads a disabled reference. Children driven by other scripts (TrapLinker's combat waves, ambush
triggers) are reported and left to the engine.

Run on the game server, from the repo root:  python3 tooling/ruin_buttons.py [--data /opt/skyrim-data]"""
import json, os, struct, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'ck-mcp'))
from esplib import Plugin, subrecords  # noqa: E402

DATA = sys.argv[sys.argv.index('--data') + 1] if '--data' in sys.argv else '/opt/skyrim-data'
ROOT = os.path.join(HERE, '..')
TWO_STATE = 'default2stateactivator'
DEFAULTS = {'openAnim': 'open', 'closeAnim': 'close'}     # default2StateActivator.pex variable defaults
# What the presser is told, by what the button opens (the targets are often out of sight from the button)
SAY = {'stairs': 'Somewhere below, stone grinds open.', 'gate': 'With a grinding of stone, the way ahead opens.'}
AGAIN = 'The button gives, but nothing more stirs.'
# Meshes that animate by a NIF controller sequence, not a behaviour graph, so PlayAnimation cannot move them. Read from
# the NIF itself: bskarpitstairs01.nif (Beyond Skyrim, sent from the PC 2026-09-28) has no BSBehaviorGraphExtraData and
# one NiControllerManager with two NiControllerSequence blocks named "Open" and "Close".
GAMEBRYO = {'CYRAylPitStairsRetractable01': {'call': 'gamebryo', 'open': 'Open', 'close': 'Close'}}
# Plugins after BSHeartland.esm that may override these references (checked for the initially-disabled flag)
LATER = ['DragonBreak Online Edits.esp', 'DragonBreak Nexus Patches.esp']


def wstr(d, o):
    n = struct.unpack_from('<H', d, o)[0]; return d[o + 2:o + 2 + n].decode('cp1252', 'replace'), o + 2 + n


def scripts_of(d):
    """{script name lowercase: {property: value}} for strings only (the animation names); no fragments on ACTI/REFR."""
    if not d: return {}
    ver, objfmt, n = struct.unpack_from('<hhH', d, 0); o = 6; out = {}
    for _ in range(n):
        name, o = wstr(d, o); o += 1
        props = {}
        pc = struct.unpack_from('<H', d, o)[0]; o += 2
        for _ in range(pc):
            pn, o = wstr(d, o); t = d[o]; o += 1
            if ver >= 4: o += 1
            if t == 1: o += 8
            elif t == 2: v, o = wstr(d, o); props[pn] = v
            elif t in (3, 4): o += 4
            elif t == 5: o += 1
            elif t in (11, 12, 13, 14, 15):
                c = struct.unpack_from('<I', d, o)[0]; o += 4
                for _ in range(c):
                    if t == 11: o += 8
                    elif t == 12: _, o = wstr(d, o)
                    elif t in (13, 14): o += 4
                    else: o += 1
            else: raise ValueError('VMAD property type %d' % t)
        out[name.lower()] = props
    return out


def main():
    ruins = json.load(open(os.path.join(ROOT, 'expeditions.json')))['expeditions']
    hl = Plugin(os.path.join(DATA, 'BSHeartland.esm')); fh = open(hl.path, 'rb')
    SELF = len(hl.masters)                                    # BSHeartland's own index in its form ids
    rec = {fid: r for r in hl.index for fid in [r[1]]}
    edid = {}; vmad = {}
    for sig, fid, flags, off, size, ctx in hl.index:
        if sig in ('ACTI', 'DOOR'):
            s = dict(subrecords(hl.data_at(fh, off, size, flags)))
            edid[fid] = (s.get(b'EDID') or b'').rstrip(b'\0').decode('cp1252', 'replace'); vmad[fid] = s.get(b'VMAD')
    # BSAssets / Skyrim bases the ruins use
    for name in ('BSAssets.esm', 'Skyrim.esm'):
        pl = Plugin(os.path.join(DATA, name)); f = open(pl.path, 'rb'); own = hl.masters.index(name)
        for sig, fid, flags, off, size, ctx in pl.index:
            if sig in ('ACTI', 'DOOR') and (fid >> 24) == len(pl.masters):
                s = dict(subrecords(pl.data_at(f, off, size, flags)))
                g = (own << 24) | (fid & 0xFFFFFF)
                edid[g] = (s.get(b'EDID') or b'').rstrip(b'\0').decode('cp1252', 'replace'); vmad[g] = s.get(b'VMAD')
    # References a later plugin marks initially disabled (they never load on the server)
    disabled_later = set()
    for name in LATER:
        p = os.path.join(DATA, name)
        if not os.path.exists(p): continue
        pl = Plugin(p); hi = [i for i, m in enumerate(pl.masters) if m.lower() == 'bsheartland.esm']
        if not hi: continue
        for sig, fid, flags, off, size, ctx in pl.index:
            if sig == 'REFR' and (fid >> 24) == hi[0] and flags & 0x800: disabled_later.add((SELF << 24) | (fid & 0xFFFFFF))
    desc = lambda fid: '%x:BSHeartland.esm' % (fid & 0xFFFFFF)
    out = []; notes = []
    for ruin in ruins:
        cells = {(SELF << 24) | int(c['desc'].split(':')[0], 16): c for c in ruin.get('cells', [])}
        children = {}                                         # parent ref -> [child ref]
        refs = {}
        for sig, fid, flags, off, size, ctx in hl.index:
            if sig != 'REFR' or ctx[1] not in cells: continue
            d = hl.data_at(fh, off, size, flags); r = {'fid': fid, 'cell': ctx[1], 'flags': flags, 'parents': []}
            for s, v in subrecords(d):
                if s == b'NAME': r['base'] = struct.unpack('<I', v[:4])[0]
                elif s == b'XAPR': r['parents'].append(struct.unpack_from('<I', v)[0])
                elif s == b'VMAD': r['vmad'] = v
            refs[fid] = r
            for p in r['parents']: children.setdefault(p, []).append(fid)
        buttons = []
        for parent, kids in sorted(children.items()):
            if parent not in refs: notes.append('%s: parent %08x is outside the ruin cells' % (ruin['name'], parent)); continue
            targets = []
            for k in sorted(kids):
                r = refs[k]; sc = scripts_of(r.get('vmad')); base_sc = scripts_of(vmad.get(r.get('base')))
                props = dict(DEFAULTS); found = TWO_STATE in sc or TWO_STATE in base_sc
                props.update(base_sc.get(TWO_STATE, {})); props.update(sc.get(TWO_STATE, {}))
                name = edid.get(r.get('base'), '?')
                if not found: notes.append('%s: %08x %s -> %08x %s is not a two-state activator; left to the engine' % (ruin['name'], parent, edid.get(refs[parent].get('base'), '?'), k, name)); continue
                if r['flags'] & 0x800 or k in disabled_later: notes.append('%s: %08x %s is initially disabled; skipped' % (ruin['name'], k, name)); continue
                kind = 'stairs' if 'stair' in name.lower() else 'gate'
                t = {'ref': desc(k), 'base': name, 'kind': kind, 'open': props['openAnim'], 'close': props['closeAnim']}
                if name in GAMEBRYO: t.update(GAMEBRYO[name])
                targets.append(t)
            if not targets: continue
            kinds = {t['kind'] for t in targets}
            buttons.append({'ref': desc(parent), 'base': edid.get(refs[parent].get('base'), '?'), 'cell': cells[refs[parent]['cell']]['desc'],
                            'say': SAY['stairs'] if kinds == {'stairs'} else SAY['gate'], 'again': AGAIN, 'targets': targets})
        if buttons: out.append({'id': ruin['id'], 'name': ruin['name'], 'buttons': buttons})
    doc = {'_comment': 'Generated by tooling/ruin_buttons.py from expeditions.json and BSHeartland.esm (%s); read by ruinbuttons.js. '
                       'Each button opens its targets for everyone in the cell; the ruin\'s lease ending closes them.' % DATA,
           'ruins': out}
    with open(os.path.join(ROOT, 'ruin-buttons.json'), 'w') as f: json.dump(doc, f, indent=1); f.write('\n')
    print('%d ruin(s), %d button(s), %d target(s)' % (len(out), sum(len(r['buttons']) for r in out), sum(len(b['targets']) for r in out for b in r['buttons'])))
    for r in out:
        for b in r['buttons']: print('  %s %s %s -> %s' % (r['name'], b['ref'], b['base'], ', '.join('%s %s (%s/%s)' % (t['ref'], t['base'], t['open'], t['close']) for t in b['targets'])))
    for n in notes: print('  note:', n)


main()
