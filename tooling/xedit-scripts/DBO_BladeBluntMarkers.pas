{
  DBO_BladeBluntMarkers - authors DBO_Skill_blade_T1..T5 and DBO_Skill_blunt_T1..T5 into "DragonBreak Online Edits.esp".

  Blade and Blunt replaced One-Handed and Two-Handed on 2026-09-24 (masterySystem.ts moves each character's progress).
  masterySystem resolves tier markers purely by editor id, DBO_Skill_<id>_T<n>, so until these exist the boot logs
  "10 marker spell(s) missing" and the two skills grant no marker. Nothing breaks without them: no plugin condition in
  the load order uses the onehanded or twohanded markers (checked with ck-mcp on 2026-09-24).

  A marker is an EMPTY ABILITY (see DBO_UnarmedMarkers.pas). Blade copies the onehanded markers and Blunt the twohanded
  ones, with a new editor id and a new name; the old records are kept, since DBO_UnarmedMarkers copies from them.

  Re-running is safe: a marker whose editor id is already in the target is left alone.

  Result file: DBO_BladeBluntMarkers.txt beside this script.
}
unit DBO_BladeBluntMarkers;

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

procedure MakeMarker(skill, from: string; tier: integer);
var
  srcSpell, rec: IInterface;
  edid, srcEdid, fullName: string;
begin
  Inc(askedFor);
  edid := 'DBO_Skill_' + skill + '_T' + IntToStr(tier);
  srcEdid := 'DBO_Skill_' + from + '_T' + IntToStr(tier);
  fullName := 'Skill: ' + skill + ' tier ' + IntToStr(tier);

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

  outLines.Add('=== DBO blade and blunt marker spells ===');
  outLines.Add('target: ' + TARGET_FILE);
  outLines.Add('');

  if not Assigned(target) then begin
    outLines.Add('FATAL: ' + TARGET_FILE + ' is not in the load order. Nothing written.');
    Result := 1;
    Exit;
  end;

  for t := 1 to TIERS do MakeMarker('blade', 'onehanded', t);
  for t := 1 to TIERS do MakeMarker('blunt', 'twohanded', t);

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
  outLines.SaveToFile(ScriptsPath + 'DBO_BladeBluntMarkers.txt');
  outLines.Free;
  Result := 0;
end;

end.
