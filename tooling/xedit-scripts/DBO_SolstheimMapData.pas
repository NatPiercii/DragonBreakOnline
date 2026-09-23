{
  DOL - fold "Morrowind Map Fix.esp" into DragonBreak Online Edits.esp.
  The map fix overrides the Solstheim worldspace (Dragonborn.esm:000800) to widen the map camera
  bounds (MNAM) for Journey to Baan Malur. Loading it last would clobber DragonBreak's own edits to
  that record, so the MNAM block is copied into DLE's existing override instead and the map fix
  plugin is dropped from the load order. FULL (the "Morrowind" rename) is deliberately not copied.
  Result: Edit Scripts\DBO_SolstheimMapData_result.txt
  Run: SSEEdit.exe -D:"<dev Data>" -P:"<server\plugins.server.txt>" -autoload -script:DBO_SolstheimMapData.pas -autoexit
}
unit DBOSolstheimMapData;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  SOURCE_PLUGIN = 'Morrowind Map Fix.esp';
  RESULT_FILE   = 'DBO_SolstheimMapData_result.txt';

var
  slLog: TStringList;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

function Initialize: integer;
var
  TargetFile, SourceFile, Dragonborn: IwbFile;
  baseRec, srcRec, dstRec, mnam: IInterface;
  before, after, src: string;
begin
  Result := 0;
  slLog := TStringList.Create;
  TargetFile := FileByName(TARGET_PLUGIN);
  SourceFile := FileByName(SOURCE_PLUGIN);
  Dragonborn := FileByName('Dragonborn.esm');
  if (not Assigned(TargetFile)) or (not Assigned(SourceFile)) or (not Assigned(Dragonborn)) then begin
    slLog.Add('FATAL  a plugin is not loaded'); slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit;
  end;
  baseRec := RecordByFormID(Dragonborn, (GetLoadOrder(Dragonborn) shl 24) or $000800, True);
  if not Assigned(baseRec) then begin slLog.Add('FATAL  Solstheim WRLD not found'); slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit; end;
  srcRec := nil; dstRec := nil;
  // the map fix's override and DLE's override of the same record
  srcRec := WinningOverride(baseRec);
  if not Equals(GetFile(srcRec), SourceFile) then begin slLog.Add('FATAL  map fix is not the winning override; check the plugin list order'); slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit; end;
  dstRec := OverrideByIndex(baseRec, Pred(OverrideCount(baseRec)) - 1); // the override just before the map fix
  if not Equals(GetFile(dstRec), TargetFile) then begin
    // DLE is not the previous override: create one from the current winner-before-mapfix
    dstRec := wbCopyElementToFile(dstRec, TargetFile, False, True);
  end;
  mnam := ElementBySignature(srcRec, 'MNAM');
  if not Assigned(mnam) then begin slLog.Add('FATAL  map fix has no MNAM'); slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit; end;
  before := GetElementEditValues(dstRec, 'MNAM\Cell Coordinates\NW Cell\X') + ',' + GetElementEditValues(dstRec, 'MNAM\Cell Coordinates\NW Cell\Y') + ' .. ' + GetElementEditValues(dstRec, 'MNAM\Cell Coordinates\SE Cell\X') + ',' + GetElementEditValues(dstRec, 'MNAM\Cell Coordinates\SE Cell\Y');
  src := GetElementEditValues(srcRec, 'MNAM\Cell Coordinates\NW Cell\X') + ',' + GetElementEditValues(srcRec, 'MNAM\Cell Coordinates\NW Cell\Y') + ' .. ' + GetElementEditValues(srcRec, 'MNAM\Cell Coordinates\SE Cell\X') + ',' + GetElementEditValues(srcRec, 'MNAM\Cell Coordinates\SE Cell\Y');
  RemoveElement(dstRec, 'MNAM');
  wbCopyElementToRecord(mnam, dstRec, False, True);
  after := GetElementEditValues(dstRec, 'MNAM\Cell Coordinates\NW Cell\X') + ',' + GetElementEditValues(dstRec, 'MNAM\Cell Coordinates\NW Cell\Y') + ' .. ' + GetElementEditValues(dstRec, 'MNAM\Cell Coordinates\SE Cell\X') + ',' + GetElementEditValues(dstRec, 'MNAM\Cell Coordinates\SE Cell\Y');
  slLog.Add('target record in ' + GetFileName(GetFile(dstRec)) + ' | MNAM before ' + before + ' | map fix ' + src + ' | after ' + after);
  slLog.Add('SUMMARY done');
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
end;

function Finalize: integer;
begin
  Result := 0;
end;

end.
