{
  DOL - remove puzzle-controlled and lever-controlled dungeon gates

  The server cannot run dungeon puzzles or lever gates, so the blocking
  pieces are taken out of the world the same way RP_DungeonOpen.esp already
  does for 275 gates in these dungeons: Initially Disabled + moved to
  Z -30000, with any Enable Parent removed so a parent marker cannot switch
  the gate back on at runtime.

  Targets come from DBO_PuzzleGateList.txt, one per line:
      owningplugin|localObjectID|expectedBaseEditorID
  Records are resolved inside their owning plugin (MasterCount shl 24 or
  local id), so the list is independent of load order. The expected base
  EditorID is checked before anything is touched; a mismatch is skipped.

  Every change is written as an override in DragonBreak Online Edits.esp.
  Vanilla and DLC masters are never edited. Idempotent: re-running edits the
  existing overrides in place and re-verifies them.

  Result file: Edit Scripts\DBO_RemovePuzzleGates_result.txt
}
unit DBORemovePuzzleGates;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  LIST_FILE     = 'DBO_PuzzleGateList.txt';
  RESULT_FILE   = 'DBO_RemovePuzzleGates_result.txt';
  SINK_Z        = -30000.0;
  FLAG_DISABLED = $800;

var
  slLog, slList: TStringList;
  TargetFile: IwbFile;
  cDone, cSkip, cFail, cAlready: integer;

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
  i, p1, p2: integer;
  line, plug, hex, want, got: string;
  f: IwbFile;
  rec, win, ovr, base: IwbMainRecord;
  fid: cardinal;
  flags: integer;
  z: double;
begin
  Result := 0;
  slLog := TStringList.Create;
  slList := TStringList.Create;
  cDone := 0; cSkip := 0; cFail := 0; cAlready := 0;

  TargetFile := FileByName(TARGET_PLUGIN);
  if not Assigned(TargetFile) then begin
    slLog.Add('FATAL  target plugin not loaded: ' + TARGET_PLUGIN);
    slLog.SaveToFile(ScriptsPath + RESULT_FILE);
    Result := 1; Exit;
  end;

  slList.LoadFromFile(ScriptsPath + LIST_FILE);
  slLog.Add('targets in list: ' + IntToStr(slList.Count));

  for i := 0 to Pred(slList.Count) do begin
    line := Trim(slList[i]);
    if line = '' then Continue;
    p1 := Pos('|', line);
    plug := Copy(line, 1, p1 - 1);
    line := Copy(line, p1 + 1, Length(line));
    p2 := Pos('|', line);
    hex := Copy(line, 1, p2 - 1);
    want := Copy(line, p2 + 1, Length(line));

    f := FileByName(plug);
    if not Assigned(f) then begin
      slLog.Add('FAIL   plugin not loaded  ' + plug + ':' + hex); Inc(cFail); Continue;
    end;

    fid := (MasterCount(f) shl 24) or StrToInt('$' + hex);
    rec := RecordByFormID(f, fid, True);
    if not Assigned(rec) then begin
      slLog.Add('FAIL   not found          ' + plug + ':' + hex); Inc(cFail); Continue;
    end;

    base := LinksTo(ElementByPath(rec, 'NAME'));
    got := '';
    if Assigned(base) then got := EditorID(base);
    if not SameText(got, want) then begin
      slLog.Add('SKIP   base mismatch      ' + plug + ':' + hex + '  want ' + want + ' got ' + got);
      Inc(cSkip); Continue;
    end;

    win := WinningOverride(rec);
    if SameText(GetFileName(GetFile(win)), TARGET_PLUGIN) then
      ovr := win
    else begin
      AddRequiredElementMasters(win, TargetFile, False);
      ovr := wbCopyElementToFile(win, TargetFile, False, True);
    end;
    if not Assigned(ovr) then begin
      slLog.Add('FAIL   override not made  ' + plug + ':' + hex + ' ' + want); Inc(cFail); Continue;
    end;

    flags := GetElementNativeValues(ovr, 'Record Header\Record Flags');
    z := GetElementNativeValues(ovr, 'DATA\Position\Z');
    if ((flags and FLAG_DISABLED) <> 0) and (z <= -29999.0) and (not Assigned(ElementByPath(ovr, 'XESP'))) then begin
      slLog.Add('OK     already removed    ' + plug + ':' + hex + ' ' + want); Inc(cAlready); Continue;
    end;

    SetElementNativeValues(ovr, 'Record Header\Record Flags', flags or FLAG_DISABLED);
    SetElementNativeValues(ovr, 'DATA\Position\Z', SINK_Z);
    if Assigned(ElementByPath(ovr, 'XESP')) then
      RemoveElement(ovr, 'XESP');

    // read back
    flags := GetElementNativeValues(ovr, 'Record Header\Record Flags');
    z := GetElementNativeValues(ovr, 'DATA\Position\Z');
    if ((flags and FLAG_DISABLED) = 0) or (z > -29999.0) or Assigned(ElementByPath(ovr, 'XESP')) then begin
      slLog.Add('FAIL   readback           ' + plug + ':' + hex + ' ' + want
        + ' flags=' + IntToHex(flags, 8) + ' z=' + FloatToStr(z)); Inc(cFail); Continue;
    end;

    slLog.Add('DONE   ' + IntToHex(GetLoadOrderFormID(ovr), 8) + '  ' + plug + ':' + hex + '  ' + want);
    Inc(cDone);
  end;
end;

function Process(e: IInterface): integer;
begin
  Result := 0;
end;

function Finalize: integer;
begin
  Result := 0;
  slLog.Add('');
  slLog.Add('SUMMARY done=' + IntToStr(cDone) + ' already=' + IntToStr(cAlready)
    + ' skipped=' + IntToStr(cSkip) + ' failed=' + IntToStr(cFail));
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
  slLog.Free;
  slList.Free;
end;

end.
