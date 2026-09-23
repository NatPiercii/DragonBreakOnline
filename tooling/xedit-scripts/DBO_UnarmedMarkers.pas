{
  DBO_UnarmedMarkers - authors DBO_Skill_unarmed_T1..T5 into "DragonBreak Online Edits.esp".

  Unarmed became the eighteenth skill on 2026-09-20 but never got its marker spells, so every
  boot logs "5 marker spell(s) missing". masterySystem resolves them purely by editor id -
  `DBO_Skill_<id>_T<n>` (masterySystem.ts:904) - so the name is the whole contract.

  A marker is an EMPTY ABILITY: constant effect, self, cost 0, a null EFID and a zeroed EFIT.
  It carries no magic effect whatsoever and exists only to be a HasSpell condition target, so
  plugin-side conditions (crafting recipes and the like) can key on a tier. Dumped from the
  eighty-five that already exist, with ck-mcp\markerspells.py.

  Each of the five is therefore a copy of the matching onehanded marker with a new editor id
  and a new name. Nothing else changes, and no master is added.

  Re-running is safe: a marker whose editor id is already in the target is left alone.

  Result file: DBO_UnarmedMarkers.txt beside this script.
}
unit DBO_UnarmedMarkers;

const
  TARGET_FILE = 'DragonBreak Online Edits.esp';
  TIERS       = 5;

var
  outLines: TStringList;
  target: IInterface;
  made: integer;
  askedFor: integer;

function FindSpell(f: IInterface; edid: string): IInterface;
var
  g, rec: IInterface;
  j: integer;
begin
  Result := nil;
  g := GroupBySignature(f, 'SPEL');
  if not Assigned(g) then Exit;
  for j := 0 to ElementCount(g) - 1 do begin
    rec := ElementByIndex(g, j);
    if GetElementEditValues(rec, 'EDID') = edid then begin
      Result := rec;
      Exit;
    end;
  end;
end;

procedure MakeMarker(tier: integer);
var
  srcSpell, rec: IInterface;
  edid, srcEdid, fullName: string;
begin
  Inc(askedFor);
  edid := 'DBO_Skill_unarmed_T' + IntToStr(tier);
  srcEdid := 'DBO_Skill_onehanded_T' + IntToStr(tier);
  fullName := 'Skill: unarmed tier ' + IntToStr(tier);

  if Assigned(FindSpell(target, edid)) then begin
    outLines.Add(edid + ': already present, left alone');
    Exit;
  end;

  srcSpell := FindSpell(target, srcEdid);
  if not Assigned(srcSpell) then begin
    outLines.Add(edid + ': template ' + srcEdid + ' not found, skipped');
    Exit;
  end;

  { AsNew = True gives the copy its own FormID, even copying within one file }
  rec := wbCopyElementToFile(srcSpell, target, True, True);
  if not Assigned(rec) then begin
    outLines.Add(edid + ': COPY FAILED');
    Exit;
  end;

  SetElementEditValues(rec, 'EDID', edid);
  SetElementEditValues(rec, 'FULL', fullName);

  outLines.Add(edid + '   ' + IntToHex(GetLoadOrderFormID(rec), 8)
    + '   "' + GetElementEditValues(rec, 'FULL') + '"'
    + '   (from ' + srcEdid + ')');
  Inc(made);
end;

function Initialize: integer;
var
  i, t: integer;
  f: IInterface;
begin
  outLines := TStringList.Create;
  made := 0;
  askedFor := 0;

  target := nil;
  for i := 0 to FileCount - 1 do begin
    f := FileByIndex(i);
    if GetFileName(f) = TARGET_FILE then target := f;
  end;

  outLines.Add('=== DBO unarmed marker spells ===');
  outLines.Add('target: ' + TARGET_FILE);
  outLines.Add('');

  if not Assigned(target) then begin
    outLines.Add('FATAL: ' + TARGET_FILE + ' is not in the load order. Nothing written.');
    Result := 1;
    Exit;
  end;

  for t := 1 to TIERS do MakeMarker(t);

  Result := 0;
end;

{ Everything runs once in Initialize. Process must still return 0: a non-zero return is how an
  xEdit script reports failure. }
function Process(e: IInterface): integer;
begin
  Result := 0;
end;

function Finalize: integer;
begin
  outLines.Add('');
  outLines.Add('records created: ' + IntToStr(made) + ' of ' + IntToStr(askedFor));
  outLines.SaveToFile(ScriptsPath + 'DBO_UnarmedMarkers.txt');
  outLines.Free;
  Result := 0;
end;

end.
