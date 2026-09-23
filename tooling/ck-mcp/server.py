"""
Creation Kit MCP - systematic repair tools for Skyrim SE plugin files.

Operates directly on .esp/.esm records. The Creation Kit is not required and is
not driven; use it to look at the result.

Config via environment:
    CKMCP_DATA      Data folder to operate on   (required)
    CKMCP_PLUGINS   path to plugins/loadorder txt   (optional, autodetected)
    CKMCP_BACKUPS   backup folder   (default: <data>/../ckmcp-backups)
"""
import os, sys, json, functools
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp.server.mcpserver import MCPServer
import core, audit, edits

DATA = os.environ.get("CKMCP_DATA", "")
PLUGINS_TXT = os.environ.get("CKMCP_PLUGINS") or None
# Plugins whose deletions are curation, not damage. undelete_and_disable refuses
# on these. Deleting a ref here is a decision; restoring it silently reverts work.
PROTECTED = {x.strip().lower() for x in os.environ.get(
    "CKMCP_PROTECT_DELETIONS", "DragonBreak.esp").split(";") if x.strip()}

BACKUPS = os.environ.get("CKMCP_BACKUPS") or (
    os.path.join(os.path.dirname(DATA.rstrip("\\/")), "ckmcp-backups") if DATA else "ckmcp-backups")

mcp = MCPServer(
    name="creation-kit",
    instructions=(
        "Systematic repair for Skyrim SE plugins. FormIDs are always the string "
        "'plugin.esp:XXXXXX' - never a bare hex number, because the numeric form "
        "means different things in different plugins. Run an audit tool first, "
        "then a write tool with dry_run=true, then dry_run=false. Every write is "
        "backed up and verified; a failed verification leaves the file untouched. "
        "Deletions in protected plugins are the user's curation - report them, "
        "never restore them."
    ),
)

_lo = None


def lo(refresh=False):
    global _lo
    if _lo is None or refresh:
        if not DATA:
            raise RuntimeError("CKMCP_DATA is not set")
        if _lo:
            _lo.close()
        _lo = core.LoadOrder(DATA, PLUGINS_TXT)
    return _lo


def tool(fn):
    """wrap a tool so errors come back as data rather than a transport failure"""
    @functools.wraps(fn)
    def inner(*a, **k):
        try:
            return fn(*a, **k)
        except Exception as e:
            return {"error": "%s: %s" % (type(e).__name__, e)}
    return inner


# ------------------------------------------------------------------ discovery

@mcp.tool(description="List the loaded plugins with their masters, flags and record counts.")
@tool
def load_order() -> dict:
    L = lo()
    return {"data_dir": L.data_dir,
            "plugin_count": len(L.plugins),
            "missing_from_data": L.missing_plugins,
            "plugins": [{"index": p.load_index, "name": p.name, "records": len(p.index),
                         "esm": p.esm, "esl": p.esl, "master_count": len(p.masters)}
                        for p in L.plugins]}


@mcp.tool(description="Search cells by EditorID, name or grid coordinates. "
                      "grid is [x, y] for exteriors.")
@tool
def find_cells(query: str = "", grid: list | None = None, limit: int = 40) -> dict:
    L = lo(); q = query.lower(); out = []
    seen = set()
    for p in L.plugins:
        for _, t, fid, fl, off, sz, ctx in L.records(p, ('CELL',)):
            cid = L.canon(p, fid)
            if cid in seen:
                continue
            info = L.cell_info(cid)
            if not info:
                continue
            if grid and info["grid"] != list(grid):
                continue
            hay = (info["editor_id"] + " " + info["name"]).lower()
            if q and q not in hay:
                continue
            seen.add(cid)
            out.append({"id": cid, **info, "touched_by": L.chain().get(cid, [])})
            if len(out) >= limit:
                return {"count": len(out), "cells": out}
    return {"count": len(out), "cells": out}


@mcp.tool(description="Search placeable base objects (STAT, ACTI, CONT, DOOR, FURN...) "
                      "by EditorID or name.")
@tool
def find_base_objects(query: str, type: str = "", limit: int = 40) -> dict:
    L = lo(); q = query.lower(); out = []; seen = set()
    SKIP = {'REFR', 'ACHR', 'NAVM', 'LAND', 'INFO', 'CELL', 'WRLD', 'DIAL', 'PHZD'}
    for p in reversed(L.plugins):
        for _, t, fid, fl, off, sz, ctx in L.records(p):
            if t in SKIP or (type and t != type.upper()):
                continue
            cid = L.canon(p, fid)
            if cid in seen:
                continue
            import esplib
            e = esplib.edid_of(L.body(p, off, sz, fl)) or ""
            if q not in e.lower():
                continue
            seen.add(cid)
            out.append({"id": cid, "type": t, "editor_id": e, "from": p.name})
            if len(out) >= limit:
                return {"count": len(out), "objects": out}
    return {"count": len(out), "objects": out}


@mcp.tool(description="Identify a record and show its full override chain, "
                      "e.g. 'Skyrim.esm:00009B41'.")
@tool
def resolve(id: str) -> dict:
    L = lo()
    ch = L.chain().get(id)
    if not ch:
        return {"id": id, "exists": False}
    res = {"id": id, "exists": True, "override_chain": ch, "winner": ch[-1]}
    b = L.base_info(id)
    if b:
        res["base_object"] = b
    c = L.cell_info(id)
    if c:
        res["cell"] = c
    for p in reversed(L.plugins):
        if p.name != ch[-1]:
            continue
        for _, t, fid, fl, off, sz, ctx in L.records(p):
            if L.canon(p, fid) != id:
                continue
            res["type"] = t
            res["flags"] = L.flag_names(fl)
            if t in ('REFR', 'ACHR'):
                res.update(L.ref_fields(p, off, sz, fl))
                res["parent_cell"] = L.canon(p, ctx[1]) if ctx[1] else None
            break
        break
    return res


@mcp.tool(description="List the references a plugin places in a cell.")
@tool
def cell_contents(plugin: str, cell: str, limit: int = 200) -> dict:
    L = lo(); p = L.plugin(plugin); out = []
    for _, t, fid, fl, off, sz, ctx in L.records(p, ('REFR', 'ACHR')):
        if not ctx[1] or L.canon(p, ctx[1]) != cell:
            continue
        f = L.ref_fields(p, off, sz, fl)
        b = L.base_info(f["base"]) if f["base"] else None
        out.append({"id": L.canon(p, fid), "type": t, "flags": L.flag_names(fl),
                    "base_editor_id": (b or {}).get("editor_id"),
                    "base_type": (b or {}).get("type"),
                    "pos": f["pos"], "scale": f["scale"]})
        if len(out) >= limit:
            break
    return {"cell": cell, "plugin": p.name, "count": len(out), "references": out}


@mcp.tool(description="Find visible references near a world position, across the whole "
                      "load order. Useful for spotting what overlaps what.")
@tool
def refs_near(x: float, y: float, z: float = 0.0, radius: float = 500.0,
              include_hidden: bool = False, limit: int = 60) -> dict:
    L = lo(); out = []
    import esplib
    for p in L.plugins:
        for _, t, fid, fl, off, sz, ctx in L.records(p, ('REFR', 'ACHR')):
            if not include_hidden and (fl & 0x800 or fl & esplib.DEL):
                continue
            f = L.ref_fields(p, off, sz, fl)
            if not f["pos"]:
                continue
            px, py, pz = f["pos"]
            if abs(px - x) > radius or abs(py - y) > radius:
                continue
            cid = L.canon(p, fid)
            if L.winner(cid) != p.name:
                continue
            b = L.base_info(f["base"]) if f["base"] else None
            out.append({"id": cid, "base_editor_id": (b or {}).get("editor_id"),
                        "base_type": (b or {}).get("type"), "pos": f["pos"],
                        "scale": f["scale"], "flags": L.flag_names(fl), "winner": p.name})
            if len(out) >= limit:
                return {"count": len(out), "references": out}
    return {"count": len(out), "references": out}


# --------------------------------------------------------------------- audits

@mcp.tool(description="Structural validation: group walk, HEDR counts, master resolution, "
                      "deleted-record count.")
@tool
def validate(plugin: str) -> dict:
    return audit.validate(lo(), plugin)


@mcp.tool(description="Find deleted references (UDR) - the top cause of save corruption "
                      "and CTDs. Fix with undelete_and_disable.")
@tool
def find_deleted(plugin: str) -> dict:
    r = audit.find_deleted(lo(), plugin)
    return {"plugin": plugin, "count": len(r), "records": r[:200]}


@mcp.tool(description="Find records identical to the version they override (ITM). "
                      "safe_to_remove=false means a parent record whose children carry "
                      "the change - do not remove those.")
@tool
def find_itm(plugin: str) -> dict:
    r = audit.find_itm(lo(), plugin)
    return {"plugin": plugin, "count": len(r),
            "safe": sum(1 for x in r if x["safe_to_remove"]),
            "review_only": sum(1 for x in r if x["review_only"]),
            "records": r[:200]}


@mcp.tool(description="Find stacked duplicate placements - same base object at the same "
                      "position in the same cell.")
@tool
def find_duplicates(plugin: str) -> dict:
    r = audit.find_duplicates(lo(), plugin)
    return {"plugin": plugin, "count": len(r), "records": r[:200]}


@mcp.tool(description="Find FormID references pointing at records that do not exist.")
@tool
def find_dangling(plugin: str) -> dict:
    r = audit.find_dangling(lo(), plugin)
    return {"plugin": plugin, "count": len(r), "records": r[:200]}


@mcp.tool(description="Find load doors whose teleport destination no longer exists.")
@tool
def find_broken_doors(plugin: str) -> dict:
    r = audit.find_broken_doors(lo(), plugin)
    return {"plugin": plugin, "count": len(r), "doors": r[:200]}


# --------------------------------------------------------------------- writes

@mcp.tool(description="Undelete deleted references and mark them Initially Disabled, "
                      "restoring position from the record they override. Visually "
                      "identical to deleted, without the crash risk. Omit ids to fix all.")
@tool
def undelete_and_disable(plugin: str, ids: list | None = None, dry_run: bool = True,
                         override_protection: bool = False) -> dict:
    if plugin.lower() in PROTECTED and not override_protection:
        return {"plugin": plugin, "written": False,
                "reason": "protected plugin - deletions here are intentional curation",
                "detail": ("Deletions in %s are the user's decisions, not damage. "
                           "Report what is missing; do not restore it. Only pass "
                           "override_protection=true if the user explicitly asks "
                           "for these specific records to be restored." % plugin),
                "protected_plugins": sorted(PROTECTED)}
    r = edits.undelete_and_disable(lo(), plugin, ids, BACKUPS, dry_run)
    if r.get("written"):
        lo(refresh=True)
    return r


@mcp.tool(description="Set or clear record flags. Valid: deleted, persistent, "
                      "initially_disabled, visible_when_distant, ignored.")
@tool
def set_flags(plugin: str, ids: list, set: list = [], clear: list = [],
              dry_run: bool = True) -> dict:
    r = edits.set_flags(lo(), plugin, ids, tuple(set), tuple(clear), BACKUPS, dry_run)
    if r.get("written"):
        lo(refresh=True)
    return r


@mcp.tool(description="Move, rotate or rescale a reference. Position is [x,y,z], "
                      "rotation is radians [x,y,z].")
@tool
def move_ref(plugin: str, ref_id: str, pos: list | None = None, rot: list | None = None,
             scale: float | None = None, dry_run: bool = True) -> dict:
    r = edits.move_ref(lo(), plugin, ref_id, pos, rot, scale, BACKUPS, dry_run)
    if r.get("written"):
        lo(refresh=True)
    return r


@mcp.tool(description="Repoint FormID references, e.g. collapsing duplicate base objects. "
                      "mapping is {'old.esp:XXXXXX': 'new.esp:YYYYYY'}. Covers alternate "
                      "textures as well as ordinary reference fields.")
@tool
def repoint(plugin: str, mapping: dict, dry_run: bool = True) -> dict:
    r = edits.repoint(lo(), plugin, mapping, BACKUPS, dry_run)
    if r.get("written"):
        lo(refresh=True)
    return r


@mcp.tool(description="Remove records and prune emptied groups. Refuses if anything still "
                      "references them.")
@tool
def remove_records(plugin: str, ids: list, dry_run: bool = True) -> dict:
    r = edits.remove_records(lo(), plugin, ids, BACKUPS, dry_run)
    if r.get("written"):
        lo(refresh=True)
    return r


@mcp.tool(description="Reload the load order from disk. Use after editing files elsewhere, "
                      "for example in the Creation Kit.")
@tool
def reload() -> dict:
    L = lo(refresh=True)
    return {"reloaded": True, "plugins": len(L.plugins)}


if __name__ == "__main__":
    mcp.run()
