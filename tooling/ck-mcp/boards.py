import sys, json, math
sys.path.insert(0, r"E:\DragonBreak Online Dev files\ck-mcp")
import core
lo = core.LoadOrder(r"E:\DragonBreak Online Dev files\Skyrim Special Edition - dev\Data", r"E:\DragonBreak Online Dev files\server\plugins.server.txt")
BASES = {"DragonBreak.esp:000006","notice board.esp:003E10","DragonBreak Harvest.esp:000900","DragonBreak Harvest.esp:000901","DragonBreak Harvest.esp:000902"}
zones = json.load(open(r"E:\DragonBreak Online Dev files\server\zones.json"))
def nearest(pos):
    for s in zones["strongholds"]:
        d=math.dist(pos[:2], s["center"][:2])
        if d<=s["radius"]: return [s["id"]+"(stronghold)", round(d)]
    best=None
    for h in zones["holds"]:
        d=math.dist(pos[:2], h["capital"][:2])
        if best is None or d<best[1]: best=[h["id"],round(d)]
    return best
seen={}
for p in lo.plugins:
    for ri,t,fid,fl,off,sz,ctx in lo.records(p,('REFR',)):
        f=lo.ref_fields(p,off,sz,fl)
        if f["base"] in BASES:
            w,c,g = ctx
            key=lo.canon(p,fid)
            seen[key]={"ref":key,"plugin":p.name,"base":f["base"],"pos":f["pos"],"world":lo.canon(p,w) if w else None,"cell":lo.canon(p,c) if c else None,"flags":lo.flag_names(fl)}
for k,v in seen.items():
    if v["world"]=="Skyrim.esm:00003C" and v["pos"]:
        v["hold"]=nearest(v["pos"])
    ci=lo.cell_info(v["cell"]) if v["cell"] else None
    v["cellName"]=(ci or {}).get("editor_id")
    print(json.dumps(v))
