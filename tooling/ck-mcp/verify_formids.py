"""verify_formids.py - checks every form desc literal in the server's code and data against the load order.

A desc is the server's form reference string, '<local id hex>:<Plugin.esm|esp|esl>', e.g. '39cf5:Skyrim.esm'
(what mp.getDescFromId returns and mp.getIdFromDesc takes). Each one found is resolved to its canonical record
'Skyrim.esm:039CF5' in the server load order (the dev Data folder read through server\\plugins.server.txt, the
same index ck-mcp\\dungeon_pools.py uses) and reported when:

  ERROR missing   no plugin defines or injects that record
  ERROR deleted   the winning override deletes it
  ERROR plugin    the plugin is not in the server load order (getIdFromDesc throws "not found in loaded files")
  ERROR case      the plugin name differs in case from the load order (the server compares names case-sensitively;
                  all-lowercase descs are taken as normalised comparison keys and not flagged)
  ERROR range     the local id does not fit the plugin's id space: 12 bits for an ESL-flagged plugin (the server
                  throws), 24 bits otherwise (the server silently truncates to another record)
  ERROR type      the surrounding code names what the id must be and the record is something else: the nearest
                  key, variable or list name (npc, weapon, armor, spell, world, cell, ref, item...) or a
                  [level, desc] entry of an "options" list (NPC_). Function bodies bound the search, so a name
                  outside the data literal never applies.
  warn  edid      an editor-id-looking string beside the desc in the same array, or a trailing // comment that is
                  one identifier, differs from the record's editor id (or its base's, for a placed reference)
  warn  format    uppercase hex, zero padding or 0x: getIdFromDesc accepts it, but getDescFromId never returns it,
                  so string comparisons against it fail
  warn  comment   any of the errors above in a comment (documentation, not code)

Default scope: server\\*.js, server\\*.json up to 400 KB (the big generated data - dungeons.json, wildlife.json,
NPC-Spawns.json, loot.json, admin-items.json - only with --all or when named), fork\\skymp5-server\\ts\\**\\*.ts.
A JS/TS line containing "verify-formids: ignore" is skipped.

    py ck-mcp\\verify_formids.py                      default scope
    py ck-mcp\\verify_formids.py --all                also the big generated JSON
    py ck-mcp\\verify_formids.py server\\dungeons.js   given files, directories or globs
    py ck-mcp\\verify_formids.py --staged             the staged .js/.json/.ts of the server repo (pre-commit)
    -q only problems, -v every desc with its record

Exit 1 on any error, 2 when the load order cannot be read, else 0."""
import sys, os, re, json, glob, bisect, argparse, subprocess, struct, time, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ck-mcp"))
import core, esplib

DATA = os.path.join(ROOT, "Skyrim Special Edition - dev", "Data")
SERVER = os.path.join(ROOT, "server")
PLUGINS_TXT = os.path.join(SERVER, "plugins.server.txt")
LARGE_JSON = 400 * 1024
IGNORE_MARK = "verify-formids: ignore"

# ---------------------------------------------------------------- expected types from names
PLACED = {"REFR", "ACHR", "PGRE", "PMIS", "PARW", "PBAR", "PBEA", "PCON", "PFLA", "PHZD"}
INVENTORY = {"WEAP", "ARMO", "AMMO", "MISC", "ALCH", "INGR", "BOOK", "SCRL", "SLGM", "KEYM", "LIGH"}
# one word of a key, variable or list name (camelCase / snake_case split, lowercased, plural 's' dropped)
WORD_TYPES = {
    "npc": {"NPC_"}, "archetype": {"NPC_"},
    "weapon": {"WEAP"}, "weap": {"WEAP"},
    "armor": {"ARMO"}, "armour": {"ARMO"}, "armo": {"ARMO"},
    "spell": {"SPEL"}, "shout": {"SHOU"}, "perk": {"PERK"}, "faction": {"FACT"}, "race": {"RACE"},
    "potion": {"ALCH"}, "ingredient": {"INGR"}, "book": {"BOOK"}, "scroll": {"SCRL"}, "soulgem": {"SLGM"},
    "ammo": {"AMMO"}, "arrow": {"AMMO"}, "bolt": {"AMMO"},
    "keyword": {"KYWD"}, "quest": {"QUST"}, "global": {"GLOB"},
    # a location desc may be a worldspace or an interior cell wherever the server takes worldOrCell
    "world": {"WRLD", "CELL"}, "worldspace": {"WRLD", "CELL"}, "cell": {"CELL"},
    "ref": PLACED, "refr": PLACED, "reference": PLACED, "anchor": PLACED, "treasury": PLACED,
    "door": PLACED | {"DOOR"},
    "item": INVENTORY,
}

def words(name):
    out = []
    for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+", name or ""):
        w = w.lower()
        if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.append(w)
    return out

def types_of_name(name):
    got = set()
    for w in words(name):
        got |= WORD_TYPES.get(w, set())
    return got

# Container names that say nothing about their contents; any other untyped container name ('words', 'shrines',
# 'placements') ends the search, so shouts[].words[] is not read as shouts
GENERIC = {"id", "desc", "form", "formid", "base", "value", "list", "entry", "pool", "option", "default", "data",
           "all", "extra", "custom", "known", "of", "or", "and", "by", "to", "for"}

def expected(occ):
    """(allowed record types, the name that decided it) or (None, None)"""
    fr = occ.frame
    # [level, desc, ...] inside a list named options: a leveled resolution, always a concrete NPC_
    if fr is not None and fr.kind == "[" and fr.first_is_number and occ.elem == 1:
        parent = fr.parent
        for lab in fr.labels + (parent.labels if parent is not None and parent.kind == "[" else []):
            if words(lab)[-1:] == ["option"]:
                return {"NPC_"}, lab
    # the desc's own key names the type ({ weapon: ... }) or is just an entry name ({ iron: ... }), never a stop
    if occ.key and types_of_name(occ.key):
        return types_of_name(occ.key), occ.key
    while fr is not None and not fr.barrier:
        for n in fr.labels:
            t = types_of_name(n)
            if t:
                return t, n
            if not set(words(n)) <= GENERIC:
                return None, None
        fr = fr.parent
    return None, None

# ---------------------------------------------------------------- desc literals
# matched against string values (quotes already removed), so an apostrophe inside a plugin name is fine: JK's Skyrim.esp
DESC_RE = re.compile(r"(?<![\w$.])(0[xX])?([0-9a-fA-F]{1,8}):([^\s:\"'`<>|?*\\/][^:\"`<>|?*\\/\n]*?\.[eE][sS][mMpPlL])(?![\w])")
EDID_HINT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{2,}$")

def looks_like_edid(s):
    # an editor id, not a display name: no spaces and some inner capital, digit or underscore ('CamonnaMask', 'Axe01')
    return bool(EDID_HINT.match(s)) and bool(re.search(r"[A-Z0-9_]", s[1:]))

class Frame:
    __slots__ = ("kind", "labels", "barrier", "parent", "first_is_number", "elem_strings", "idx", "key")
    def __init__(self, kind, labels, barrier, parent):
        self.kind, self.labels, self.barrier, self.parent = kind, labels, barrier, parent
        self.first_is_number = False
        self.elem_strings = []   # direct string elements of an array: (element index, value)
        self.idx = 0             # current element index of an array
        self.key = None          # current key of an object

class Occ:
    __slots__ = ("path", "line", "text", "hexpart", "plugin", "prefix", "whole", "in_comment", "frame", "key",
                 "elem", "comment_hint")
    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

def find_descs(s):
    return list(DESC_RE.finditer(s)) if ":" in s and ".es" in s.lower() else []

# ---------------------------------------------------------------- JSON scanner
JTOK = re.compile(r'"((?:[^"\\]|\\.)*)"|([{}\[\]:,])|(-?\d[\d.eE+\-]*|true|false|null)|(\s+)', re.S)

def scan_json(path, text):
    occs, lines = [], LineMap(text)
    top = Frame("top", [], True, None)
    stack = [top]
    expect_key = False
    pending_label = None        # key whose value is the next token
    pos, n = 0, len(text)
    while pos < n:
        m = JTOK.match(text, pos)
        if not m:
            pos += 1
            continue
        pos = m.end()
        s, p, lit, ws = m.groups()
        if ws is not None:
            continue
        fr = stack[-1]
        if p is not None:
            if p in "{[":
                labels = [pending_label] if pending_label else []
                stack.append(Frame(p, labels, False, fr))
                expect_key = p == "{"
                pending_label = None
                continue
            if p in "}]":
                if len(stack) > 1:
                    stack.pop()
                expect_key = False
                continue
            if p == ":":
                continue
            if p == ",":
                if fr.kind == "[":
                    fr.idx += 1
                else:
                    expect_key = fr.kind == "{"
                continue
        if lit is not None:
            if fr.kind == "[" and fr.idx == 0 and lit[0] in "-0123456789":
                fr.first_is_number = True
            pending_label = None
            continue
        # string token
        raw = s
        val = raw.replace('\\"', '"').replace("\\\\", "\\") if "\\" in raw else raw
        if fr.kind == "{" and expect_key:
            expect_key = False
            pending_label = val
            fr.key = val
            for m2 in find_descs(val):
                occs.append(make_occ(path, lines, m.start(1) + m2.start(), m2, val, None, fr, None, None, False))
            continue
        key = pending_label if fr.kind == "{" else None
        pending_label = None
        if fr.kind == "[":
            fr.elem_strings.append((fr.idx, val))
        for m2 in find_descs(val):
            occs.append(make_occ(path, lines, m.start(1) + m2.start(), m2, val, key, fr,
                                 fr.idx if fr.kind == "[" else None, None, False))
    return occs

# ---------------------------------------------------------------- JS / TS scanner
KEYWORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof",
            "yield", "await", "if", "for", "while", "switch", "catch", "function", "try", "finally", "const", "let",
            "var", "export", "default", "import", "from", "as", "extends", "class"}
BLOCK_KW = {"else", "try", "finally", "do"}
PAREN_KW = {"if", "for", "while", "switch", "catch", "function"}
JS_TOKEN = re.compile(r"""
 (?P<ws>\s+)
|(?P<lc>//[^\n]*)
|(?P<bc>/\*.*?\*/)
|(?P<num>0[xX][0-9a-fA-F_]+n?|0[bBoO][01234567_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)
|(?P<id>[A-Za-z_$][\w$]*)
|(?P<str>'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")
|(?P<punct>=>|\?\.|\?\?=?|\.\.\.|&&=?|\|\|=?|[{}()\[\];,:?.]|[=!<>]=*|[+\-*/%&|^~]=?)
""", re.S | re.X)

class Tok:
    __slots__ = ("kind", "text", "start", "val")
    def __init__(self, kind, text, start, val=None):
        self.kind, self.text, self.start, self.val = kind, text, start, val

def unescape_js(body):
    return re.sub(r"\\(.)", lambda m: m.group(1) if m.group(1) in "'\"`\\" else "\\" + m.group(1), body, flags=re.S)

def lex_js(src):
    """tokens (strings, template text, punctuation, ids, numbers) plus comments separately"""
    toks, comments = [], []
    pos, n = 0, len(src)
    brace_depth = []   # per open template substitution: brace depth at its start

    def regex_ok():
        prev = toks[-1] if toks else None
        if prev is None:
            return True
        if prev.kind in ("num", "str", "tmpl"):
            return False
        if prev.kind == "id":
            return prev.text in KEYWORDS
        return prev.text not in (")", "]", "}")

    def template(pos):
        """lex a template literal starting at the backtick; returns the position after it"""
        i, start, text = pos + 1, pos, []
        while i < n:
            c = src[i]
            if c == "\\":
                text.append(src[i:i + 2]); i += 2; continue
            if c == "`":
                toks.append(Tok("tmpl", src[start:i + 1], start + 1, unescape_js("".join(text))))
                return i + 1
            if c == "$" and src.startswith("${", i):
                toks.append(Tok("tmpl", "", start + 1, unescape_js("".join(text))))
                text = ["\0"]
                toks.append(Tok("punct", "(", i))
                i = lex(i + 2, True)
                toks.append(Tok("punct", ")", i - 1))
                start = i - 1
                continue
            text.append(c); i += 1
        return n

    def lex(pos, in_subst):
        depth = 0
        while pos < n:
            c = src[pos]
            if c == "`":
                pos = template(pos); continue
            if in_subst:
                if c == "{":
                    depth += 1
                elif c == "}":
                    if depth == 0:
                        return pos + 1
                    depth -= 1
            if c == "/" and src[pos + 1:pos + 2] not in ("/", "*") and regex_ok():
                i, cls = pos + 1, False
                while i < n and src[i] != "\n":
                    ch = src[i]
                    if ch == "\\":
                        i += 2; continue
                    if cls:
                        cls = ch != "]"
                    elif ch == "[":
                        cls = True
                    elif ch == "/":
                        break
                    i += 1
                if i < n and src[i] == "/":
                    i += 1
                    while i < n and src[i].isalpha():
                        i += 1
                    toks.append(Tok("regex", src[pos:i], pos))
                    pos = i
                    continue
            m = JS_TOKEN.match(src, pos)
            if not m:
                pos += 1; continue
            k = m.lastgroup
            t = m.group()
            if k == "lc" or k == "bc":
                comments.append(Tok("comment", t, pos))
            elif k == "str":
                toks.append(Tok("str", t, pos + 1, unescape_js(t[1:-1])))
            elif k != "ws":
                toks.append(Tok(k, t, pos))
            pos = m.end()
        return pos

    lex(0, False)
    return toks, comments

def js_frame_info(toks, i):
    """(labels, barrier) for the bracket token toks[i]"""
    b = toks[i].text
    j = i - 1
    prev = toks[j] if j >= 0 else None
    if prev is None:
        return [], True
    if b == "{":
        if prev.text in (")", "=>", ";", "{", "}") or (prev.kind == "id" and (prev.text in BLOCK_KW or prev.text not in KEYWORDS)):
            return [], True
    if b == "(":
        if prev.text == "=>" or (prev.kind == "id" and prev.text in PAREN_KW):
            return [], True
        if prev.kind == "id" and prev.text not in KEYWORDS or prev.text in (")", "]"):
            # a call: step back over the callee (a.b?.c, new X) and label with what the call is assigned to
            k = j
            while k >= 0 and toks[k].kind == "id" and k >= 2 and toks[k - 1].text in (".", "?.") and toks[k - 2].kind == "id":
                k -= 2
            if k >= 1 and toks[k - 1].text == "new":
                k -= 1
            j = k - 1
            prev = toks[j] if j >= 0 else None
            if prev is None:
                return [], True
    if b == "[" and (prev.kind in ("id", "str", "tmpl") and prev.text not in KEYWORDS or prev.text in (")", "]")):
        return [], False   # member access a[...]
    if prev.text == ":" and j >= 2 and toks[j - 1].kind in ("id", "str") and toks[j - 2].text in ("{", ","):
        return [toks[j - 1].val if toks[j - 1].kind == "str" else toks[j - 1].text], False
    if prev.text in ("=", "||=", "??=", "&&=") and j >= 1 and toks[j - 1].kind == "id":
        return [toks[j - 1].text], False
    return [], False

def scan_js(path, text):
    occs, lines = [], LineMap(text)
    ignored = {i + 1 for i, l in enumerate(text.split("\n")) if IGNORE_MARK in l}
    toks, comments = lex_js(text)
    # a trailing // comment that is one identifier names the record on its line ("6:DragonBreak.esp",  // Noticeboard)
    line_comment_hint = {}
    for c in comments:
        if c.text.startswith("//"):
            body = c.text[2:].strip()
            if looks_like_edid(body):
                line_comment_hint[lines.line(c.start)] = body
    top = Frame("top", [], True, None)
    stack = [top]
    for i, t in enumerate(toks):
        fr = stack[-1]
        if t.kind == "punct" and t.text in ("(", "[", "{"):
            labels, barrier = js_frame_info(toks, i)
            nf = Frame(t.text, labels, barrier, fr)
            if t.text == "[" and i + 1 < len(toks) and toks[i + 1].kind == "num":
                nf.first_is_number = True
            stack.append(nf)
            continue
        if t.kind == "punct" and t.text in (")", "]", "}"):
            want = {")": "(", "]": "[", "}": "{"}[t.text]
            for d in range(len(stack) - 1, 0, -1):
                if stack[d].kind == want:
                    del stack[d:]
                    break
            continue
        if t.kind == "punct" and t.text == "," and fr.kind == "[":
            fr.idx += 1
            continue
        if t.kind not in ("str", "tmpl"):
            continue
        prev = toks[i - 1] if i else None
        direct = prev is not None and prev.text in ("[", ",") and fr.kind == "["
        key = None
        if prev is not None and prev.text == ":" and i >= 3 and toks[i - 2].kind in ("id", "str") and toks[i - 3].text in ("{", ","):
            key = toks[i - 2].val if toks[i - 2].kind == "str" else toks[i - 2].text
        if direct:
            fr.elem_strings.append((fr.idx, t.val))
        for m2 in find_descs(t.val):
            ln = lines.line(t.start + m2.start())
            if ln in ignored:
                continue
            occs.append(make_occ(path, lines, t.start + m2.start(), m2, t.val, key, fr,
                                 fr.idx if direct else None, line_comment_hint.get(ln), False))
    for c in comments:
        for m2 in find_descs(c.text):
            ln = lines.line(c.start + m2.start())
            if ln not in ignored:
                occs.append(make_occ(path, lines, c.start + m2.start(), m2, c.text, None, None, None, None, True))
    return occs

# ---------------------------------------------------------------- shared helpers
class LineMap:
    def __init__(self, text):
        self.starts = [0] + [m.end() for m in re.finditer("\n", text)]
    def line(self, off):
        return bisect.bisect_right(self.starts, off)

def make_occ(path, lines, off, m, whole, key, frame, elem, comment_hint, in_comment):
    return Occ(path=path, line=lines.line(off), text=m.group(0), prefix=m.group(1) or "", hexpart=m.group(2),
               plugin=m.group(3), whole=whole.strip() == m.group(0), in_comment=in_comment, frame=frame, key=key,
               elem=elem, comment_hint=comment_hint)

# ---------------------------------------------------------------- record index
class Index:
    def __init__(self):
        self.lo = core.LoadOrder(DATA, PLUGINS_TXT)
        self.by_key = {p.key: p for p in self.lo.plugins}
        self.byfid = {p.load_index: {r[1]: r for r in p.index} for p in self.lo.plugins}
        self.master_of = {p.load_index: {m.lower(): i for i, m in enumerate(p.masters)} for p in self.lo.plugins}
        self.installed = {f.lower(): f for f in os.listdir(DATA) if f.lower().endswith((".esm", ".esp", ".esl"))}
        self._cache = {}

    def versions(self, origin, local):
        out = []
        for p in self.lo.plugins:
            if p is origin:
                raw = (len(p.masters) << 24) | local
            else:
                mi = self.master_of[p.load_index].get(origin.key)
                if mi is None:
                    continue
                raw = (mi << 24) | local
            r = self.byfid[p.load_index].get(raw)
            if r is not None:
                out.append((p, r))
        return out

    def record(self, origin, local):
        """{type, edid, deleted_by, injected_by, base: {type, edid, canon}} or None when no plugin has it"""
        key = (origin.key, local)
        if key in self._cache:
            return self._cache[key]
        vs = self.versions(origin, local)
        res = None
        if vs:
            first_p, first = vs[0]
            win_p, win = vs[-1]
            t, fid, fl, off, sz, ctx = win
            deleted = bool(fl & esplib.DEL)
            src_p, src = (win_p, win) if not deleted else (first_p, first)
            body = self.lo.body(src_p, src[3], src[4], src[2])
            res = {"type": first[0], "edid": esplib.edid_of(body) or "",
                   "deleted_by": win_p.name if deleted else None,
                   "injected_by": first_p.name if first_p is not origin else None, "base": None}
            if first[0] in PLACED:
                for sig, val in esplib.subrecords(body):
                    if sig == b"NAME" and len(val) >= 4:
                        bc = self.lo.canon(src_p, struct.unpack("<I", bytes(val[:4]))[0])
                        bsrc, bloc = bc.rsplit(":", 1)
                        bp = self.by_key.get(bsrc.lower())
                        b = self.record(bp, int(bloc, 16)) if bp else None
                        res["base"] = {"canon": bc, "type": b["type"] if b else "?", "edid": b["edid"] if b else ""}
                        break
        self._cache[key] = res
        return res

# ---------------------------------------------------------------- checking
def check(ix, occ):
    """(record or None, [(severity, kind, message)]); (None, None) when the match is prose, not a desc.
    In a comment every error becomes a 'comment' warning."""
    rec, probs = check_desc(ix, occ)
    if occ.in_comment and probs:
        probs = [("W", "comment", f"{k}: {msg}") if sev == "E" else (sev, k, msg) for sev, k, msg in probs]
    return rec, probs

def check_desc(ix, occ):
    probs = []
    loc = int(occ.hexpart, 16)
    fname = occ.plugin
    p = ix.by_key.get(fname.lower())
    if p is None:
        if not occ.whole and " " in fname and fname.lower() not in ix.installed:
            return None, None   # prose that happens to contain "12:... .esp", not a desc
        where = "installed in the dev Data folder but not in plugins.server.txt" if fname.lower() in ix.installed \
            else "not in plugins.server.txt and not in the dev Data folder"
        probs.append(("E", "plugin", f"{fname} is {where}"))
        return None, probs
    if fname != p.name and fname != fname.lower():
        probs.append(("E", "case", f"plugin written '{fname}', the server loads '{p.name}' (getIdFromDesc is case-sensitive)"))
    canonical_desc = "%x:%s" % (loc, p.name if fname != fname.lower() else fname)
    if not occ.in_comment and (occ.prefix or occ.hexpart != "%x" % loc):
        probs.append(("W", "format", f"getDescFromId returns '{canonical_desc}'; comparisons against this string fail"))
    if p.esl and loc > 0xFFF:
        probs.append(("E", "range", f"{p.name} is ESL-flagged: local id 0x{loc:X} does not fit 12 bits (the server throws)"))
        return None, probs
    if loc > 0xFFFFFF:
        probs.append(("E", "range", f"local id 0x{loc:X} is over 24 bits; the server truncates it to 0x{loc & 0xFFFFFF:X}"))
        return None, probs
    canon = "%s:%06X" % (p.name, loc)
    rec = ix.record(p, loc)
    if rec is None:
        probs.append(("E", "missing", f"{canon} does not exist in the load order"))
        return None, probs
    summary = describe(canon, rec)
    if rec["deleted_by"]:
        probs.append(("E", "deleted", f"{summary} is deleted by {rec['deleted_by']}"))
    if not occ.in_comment:
        want, why = expected(occ)
        if want and rec["type"] not in want:
            probs.append(("E", "type", f"{summary}, but '{why}' expects {type_names(want)}"))
    hints = []
    if occ.frame is not None and occ.elem is not None and occ.frame.kind == "[":
        hints += [v for i, v in occ.frame.elem_strings if i != occ.elem and looks_like_edid(v)]
    if occ.comment_hint:
        hints.append(occ.comment_hint)
    names = [rec["edid"].lower()] + ([rec["base"]["edid"].lower()] if rec["base"] else [])
    for h in hints:
        # a part of the editor id is a derived name (admin_catalog.py's 'RH04Letter' for DLC1RH04Letter), not a conflict
        if not any(h.lower() in n for n in names):
            probs.append(("W", "edid", f"{summary}; the line names '{h}'"))
    return rec, probs

def type_names(want):
    parts = []
    for group, name in ((PLACED, "a placed reference"), (INVENTORY, "an inventory item")):
        if group <= want:
            parts.append(name)
            want = want - group
    return " or ".join(parts + sorted(want))

def describe(canon, rec):
    s = f"{canon} is {rec['type']} {rec['edid'] or '(no editor id)'}"
    if rec["base"]:
        s += f" (base {rec['base']['type']} {rec['base']['edid'] or rec['base']['canon']})"
    if rec["injected_by"]:
        s += f" [injected by {rec['injected_by']}]"
    return s

# ---------------------------------------------------------------- files
def rel(path):
    try:
        r = os.path.relpath(path, ROOT)
        return path if r.startswith("..") else r
    except ValueError:
        return path

def default_files(include_large):
    out = sorted(glob.glob(os.path.join(SERVER, "*.js")))
    for f in sorted(glob.glob(os.path.join(SERVER, "*.json"))):
        if include_large or os.path.getsize(f) <= LARGE_JSON:
            out.append(f)
    ts = os.path.join(ROOT, "fork", "skymp5-server", "ts")
    out += sorted(f for f in glob.glob(os.path.join(ts, "**", "*.ts"), recursive=True) if "node_modules" not in f)
    return out

def expand(args):
    out = []
    for a in args:
        if os.path.isdir(a):
            for dp, dn, fn in os.walk(a):
                dn[:] = [d for d in dn if d not in ("node_modules", ".git")]
                out += [os.path.join(dp, f) for f in sorted(fn) if f.endswith((".js", ".json", ".ts"))]
        elif os.path.exists(a):
            out.append(a)
        else:
            hits = sorted(glob.glob(a, recursive=True))
            if not hits:
                print(f"verify_formids: no such file: {a}", file=sys.stderr)
            out += hits
    return [os.path.abspath(f) for f in out]

def staged(repo):
    """[(display path, text)] of the staged .js/.json/.ts files, read from the index, not the working tree"""
    names = subprocess.run(["git", "-C", repo, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
                           capture_output=True, check=True).stdout.decode("utf-8").split("\0")
    out = []
    for n in names:
        if n.endswith((".js", ".json", ".ts")):
            blob = subprocess.run(["git", "-C", repo, "show", ":" + n], capture_output=True, check=True).stdout
            out.append((rel(os.path.join(repo, n.replace("/", os.sep))), blob.decode("utf-8-sig", "replace")))
    return out

def scan(display, text):
    return scan_json(display, text) if display.endswith(".json") else scan_js(display, text)

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Check form desc literals ('39cf5:Skyrim.esm') against the server load order.")
    ap.add_argument("paths", nargs="*", help="files, directories or globs (default: server *.js/*.json, skymp5-server ts)")
    ap.add_argument("--all", action="store_true", help="include the big generated JSON in the default scope")
    ap.add_argument("--staged", action="store_true", help="check the staged .js/.json/.ts files of --repo")
    ap.add_argument("--repo", default=SERVER, help="git repo for --staged (default: server)")
    ap.add_argument("-q", "--quiet", action="store_true", help="print only problems")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every desc with its record")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
    t0 = time.time()

    if a.staged:
        sources = staged(os.path.abspath(a.repo))
        if not sources:
            return 0
    else:
        files = expand(a.paths) if a.paths else default_files(a.all)
        sources = []
        for f in files:
            with open(f, encoding="utf-8-sig", errors="replace") as fh:
                sources.append((rel(f), fh.read()))

    found = [(d, scan(d, t)) for d, t in sources]
    if not any(o for _, o in found):
        if not a.quiet:
            print(f"verify_formids: {len(sources)} files, no form descs")
        return 0

    try:
        ix = Index()
    except Exception as e:
        print(f"verify_formids: cannot read the load order ({e})", file=sys.stderr)
        return 2
    head = []
    if ix.lo.missing_plugins:
        head.append(("W", "loadorder", "plugins.server.txt lists plugins missing from the dev Data folder: " + ", ".join(ix.lo.missing_plugins)))
    # the running server reads server-settings.json loadOrder; this check reads plugins.server.txt
    try:
        with open(os.path.join(SERVER, "server-settings.json"), encoding="utf-8-sig") as fh:
            served = [os.path.basename(x) for x in json.load(fh).get("loadOrder") or []]
        with open(PLUGINS_TXT, encoding="utf-8-sig") as fh:
            listed = [l.strip().lstrip("*") for l in fh if l.strip() and not l.lstrip().startswith("#")]
        if served and served != listed:
            head.append(("W", "loadorder", "server-settings.json loadOrder differs from plugins.server.txt; the server uses loadOrder"))
    except Exception:
        pass

    errors = warnings = total = 0
    unique = set()
    out = []
    for sev, kind, msg in head:
        out.append(f"{'ERROR' if sev == 'E' else 'warn '} {kind:9} {msg}")
        warnings += sev == "W"
    for display, occs in found:
        if not occs:
            continue
        lines, types = [], collections.Counter()
        for o in sorted(occs, key=lambda o: o.line):
            rec, probs = check(ix, o)
            if probs is None:
                continue
            total += 1
            unique.add(o.text)
            if rec:
                types[rec["type"]] += 1
            for sev, kind, msg in probs:
                errors += sev == "E"
                warnings += sev == "W"
                lines.append(f"  L{o.line:<5} {'ERROR' if sev == 'E' else 'warn '} {kind:8} '{o.text}': {msg}")
            if a.verbose and not probs:
                want, why = expected(o)
                ctx = f"  [{why}: {type_names(want)}]" if want else ""
                lines.append(f"  L{o.line:<5} ok             '{o.text}': " +
                             (describe("%s:%06X" % (ix.by_key[o.plugin.lower()].name, int(o.hexpart, 16)), rec) if rec else "") + ctx)
        n = sum(types.values())
        if lines or not a.quiet:
            out.append(f"{display}  {n} desc{'s' if n != 1 else ''}: " + ", ".join(f"{t} {c}" for t, c in types.most_common()))
            out += lines
    if out:
        print("\n".join(out))
    if not a.quiet or errors or warnings:
        plural = lambda n, w: f"{n} {w}{'s' if n != 1 else ''}"
        print(f"\n{plural(len(sources), 'file')}, {plural(total, 'desc')} ({len(unique)} unique), {plural(errors, 'error')}, "
              f"{plural(warnings, 'warning')}, {time.time() - t0:.1f} s")
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main())
