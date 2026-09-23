{
  DOL - create the 80 inert marker spells for the DragonBreak skill system:
  16 skills x 5 tiers, EditorID DBO_Skill_<id>_T<n>, Ability type, no effects,
  in DragonBreak Online Edits.esp. Idempotent: existing records are reused.
  Result: Edit Scripts\DBO_SkillMarkers_result.txt  (EDID|FormID hex)
}
unit DBOSkillMarkers;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  RESULT_FILE   = 'DBO_SkillMarkers_result.txt';
  SKILLS = 'twohanded,archery,onehanded,defense,arcane,blacksmith,alchemist,woodcutter,miner,tailor,lockpicking,skinner,scholar,enchanter,priest,cook,harvesting';
  TIERS = 5;

var
  slLog: TStringList;
  TargetFile: IwbFile;
  cNew, cKept: integer;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

function FindByEditorID(grp: IInterface; edid: string): IInterface;
var i: integer; r: IInterface;
begin
  Result := nil;
  for i := 0 to Pred(ElementCount(grp)) do begin
    r := ElementByIndex(grp, i);
    if SameText(EditorID(r), edid) then begin Result := r; Exit; end;
  end;
end;

function Initialize: integer;
var
  sl: TStringList;
  i, t: integer;
  grp, rec: IInterface;
  edid, full: string;
begin
  Result := 0;
  slLog := TStringList.Create;
  cNew := 0; cKept := 0;
  TargetFile := FileByName(TARGET_PLUGIN);
  if not Assigned(TargetFile) then begin
    slLog.Add('FATAL  target plugin not loaded'); slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit;
  end;
  grp := GroupBySignature(TargetFile, 'SPEL');
  if not Assigned(grp) then grp := Add(TargetFile, 'SPEL', True);
  sl := TStringList.Create;
  sl.CommaText := SKILLS;
  for i := 0 to Pred(sl.Count) do
    for t := 1 to TIERS do begin
      edid := 'DBO_Skill_' + sl[i] + '_T' + IntToStr(t);
      rec := FindByEditorID(grp, edid);
      if Assigned(rec) then Inc(cKept)
      else begin
        rec := Add(grp, 'SPEL', True);
        SetElementEditValues(rec, 'EDID', edid);
        full := 'Skill: ' + sl[i] + ' tier ' + IntToStr(t);
        SetElementEditValues(rec, 'FULL', full);
        Add(rec, 'SPIT', True);
        SetElementNativeValues(rec, 'SPIT\Type', 4);        // Ability
        SetElementNativeValues(rec, 'SPIT\Cast Type', 0);   // Constant Effect
        SetElementNativeValues(rec, 'SPIT\Target Type', 0); // Self
        SetElementNativeValues(rec, 'SPIT\Base Cost', 0);
        Inc(cNew);
      end;
      slLog.Add(edid + '|' + IntToHex(GetLoadOrderFormID(rec), 8) + '|' + IntToHex(FormID(rec) and $FFFFFF, 6));
    end;
  sl.Free;
  slLog.Add('SUMMARY new=' + IntToStr(cNew) + ' kept=' + IntToStr(cKept));
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
end;

function Process(e: IInterface): integer;
begin
  Result := 0;
end;

function Finalize: integer;
begin
  Result := 0;
  slLog.Free;
end;

end.
