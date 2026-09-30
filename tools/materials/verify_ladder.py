# Prove an xEdit pass changed the ladder values and NOTHING else.
#
#   python3 tools/materials/material_census.py before.json --all      # before the pass
#   ... run DBO_BlacksmithTiers.pas on the PC, deploy the plugins back to /opt/skyrim-data ...
#   python3 tools/materials/material_census.py after.json --all
#   python3 tools/materials/verify_ladder.py before.json after.json tools/materials/ladder.tsv
#
# A full xEdit save has silently changed 93 unrelated records before (memory xedit-resave-mutates-unrelated-records),
# so this is the gate, not a formality. Exit code 0 only if every intended change landed and no other group moved.
import sys, json, collections

def load_ladder(path):
    want = {}                      # (kind, selector, slot) -> value
    for line in open(path):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) != 5:
            sys.exit(f'ladder.tsv: expected 5 tab-separated fields, got {len(parts)}: {line!r}')
        kind, sel, how, slot, val = (p.strip() for p in parts)
        want[(kind, sel, slot)] = float(val)
    return want

def flat(census):
    # {'armor'|'weapons': {key: {slot: {...}}}} -> {(kind, material, slot): value}
    out = {}
    for section, kind in (('armor', 'armor'), ('weapons', 'weapon')):
        for key, slots in census.get(section, {}).items():
            material = key.split('|')[0]
            for slot, info in slots.items():
                out[(kind, material, slot)] = info['value']
    return out

def ranges(census):
    # the same keys, but the low/high of each group: 'value' is only the most common one, so on its own it cannot
    # tell a rule that reached every record from one that reached most of them
    out = {}
    for section, kind in (('armor', 'armor'), ('weapons', 'weapon')):
        for key, slots in census.get(section, {}).items():
            material = key.split('|')[0]
            for slot, info in slots.items():
                out[(kind, material, slot)] = tuple(info.get('range') or (info['value'], info['value']))
    return out

def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__ or 'usage: verify_ladder.py before.json after.json ladder.tsv')
    before_raw = json.load(open(sys.argv[1]))
    after_raw = json.load(open(sys.argv[2]))
    before = flat(before_raw)
    after = flat(after_raw)
    after_range = ranges(after_raw)
    want = load_ladder(sys.argv[3])

    # Only keyword rules name a census group. An edid rule (Beyond Skyrim chainmail) rides inside another
    # material's group, so its group is allowed to move but is reported for a human to read.
    edid_kinds = {(k, s) for (k, sel, s) in want if '*' in sel}

    moved = {k: (before[k], after[k]) for k in set(before) & set(after) if before[k] != after[k]}
    gone = sorted(set(before) - set(after))
    new = sorted(set(after) - set(before))

    problems, expected, collateral = [], [], []
    for k, (b, a) in sorted(moved.items()):
        kind, material, slot = k
        if (kind, material, slot) in want:
            if abs(a - want[(kind, material, slot)]) > 1e-9:
                problems.append(f'WRONG VALUE  {kind} {material} {slot}: {b} -> {a}, ladder says {want[(kind, material, slot)]:g}')
            else:
                expected.append(f'ok  {kind} {material} {slot}: {b} -> {a:g}')
        else:
            collateral.append(f'UNEXPECTED   {kind} {material} {slot}: {b} -> {a}')

    # every keyword rule must have landed, on EVERY record of the group and not just the most common one
    for (kind, sel, slot), v in sorted(want.items()):
        if '*' in sel:
            continue
        k = (kind, sel, slot)
        if k not in after:
            problems.append(f'MISSING      {kind} {sel} {slot}: no such group in the after census')
            continue
        if abs(after[k] - v) > 1e-9:
            problems.append(f'NOT APPLIED  {kind} {sel} {slot}: still {after[k]}, ladder says {v:g}')
            continue
        lo, hi = after_range[k]
        if abs(lo - v) > 1e-9 or abs(hi - v) > 1e-9:
            problems.append(f'PARTIAL      {kind} {sel} {slot}: most records are {v:g} but the group spans '
                            f'{lo:g}..{hi:g} - some records were missed')

    print(f'{len(expected)} intended change(s) landed')
    for line in expected:
        print('  ' + line)
    if collateral:
        print(f'\n{len(collateral)} group(s) moved that the ladder does not name:')
        for line in collateral:
            print('  ' + line)
        print('  (an editor-id rule can move the group it lives inside: ' +
              ', '.join(f'{k}/{s}' for k, s in sorted(edid_kinds)) + ')')
    if gone or new:
        print(f'\ngroups only in before: {len(gone)}, only in after: {len(new)}')
        for k in gone[:20]:
            print('  gone ', k)
        for k in new[:20]:
            print('  new  ', k)
    if problems:
        print(f'\n{len(problems)} PROBLEM(S):')
        for line in problems:
            print('  ' + line)
        return 1
    if collateral:
        print('\nno problems, but read the unnamed movers above before shipping')
        return 2
    print('\nclean: every ladder value landed and nothing else moved')
    return 0

if __name__ == '__main__':
    sys.exit(main())
