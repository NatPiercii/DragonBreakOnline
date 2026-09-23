{
  DBO - Bruma playtest interiors (2026-09-16, user-directed)

  The server spawns every living actor itself and cannot run dungeon gates, levers or scripted seals, so for
  the interiors reachable from the Bruma worldspaces (and a few key-only doors on the Bruma exteriors):
    disable      plugin-placed actor: Initially Disabled, Enable Parent removed. Dungeon enemies come back
                 from the server's dungeon leases (ck-mcp\actors_server_replaced.json keeps them in the survey).
    sink         gate / portcullis / barrier: Initially Disabled, Z -30000, Enable Parent removed (same technique
                 as DBO_RemovePuzzleGates.pas).
    unlock       key-only door: lock (XLOC) removed.
    unseal       script-held door: lock (XLOC) and scripts (VMAD) removed.
  Jails and cages stay locked (user choice), so they are not in the list.

  List: DBO_BrumaInteriorsList.txt, one per line   op|owningplugin|localObjectID|expectedBaseEditorID
  The expected base EditorID is checked first; "*" skips the check. Overrides go into DragonBreak Online
  Edits.esp. Idempotent.
  Result: Edit Scripts\DBO_BrumaInteriors_result.txt
}
unit DBOBrumaInteriors;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  LIST_FILE     = 'DBO_BrumaInteriorsList.txt';
  RESULT_FILE   = 'DBO_BrumaInteriors_result.txt';
  SINK_Z        = -30000.0;
  FLAG_DISABLED = $800;

var
  slLog, slList, slParts: TStringList;
  TargetFile: IwbFile;
  cDone, cSkip, cFail: integer;

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
  i, flags: integer;
  op, plug, hex, want, got, tag: string;
  f: IwbFile;
  rec, win, ovr, base: IwbMainRecord;
  fid: cardinal;
  ok: boolean;
begin
  Result := 0;
  slLog := TStringList.Create;
  slList := TStringList.Create;
  slParts := TStringList.Create;
  slParts.Delimiter := '|';
  slParts.StrictDelimiter := True;
  cDone := 0; cSkip := 0; cFail := 0;

  TargetFile := FileByName(TARGET_PLUGIN);
  if not Assigned(TargetFile) then begin
    slLog.Add('FATAL  target plugin not loaded: ' + TARGET_PLUGIN);
    slLog.SaveToFile(ScriptsPath + RESULT_FILE);
    Result := 1; Exit;
  end;

  slList.LoadFromFile(ScriptsPath + LIST_FILE);
  slLog.Add('targets in list: ' + IntToStr(slList.Count));

  for i := 0 to Pred(slList.Count) do begin
    if Trim(slList[i]) = '' then Continue;
    slParts.DelimitedText := Trim(slList[i]);
    if slParts.Count < 4 then begin slLog.Add('FAIL   bad line ' + slList[i]); Inc(cFail); Continue; end;
    op := slParts[0]; plug := slParts[1]; hex := slParts[2]; want := slParts[3];
    tag := op + ' ' + plug + ':' + hex + ' ' + want;

    f := FileByName(plug);
    if not Assigned(f) then begin slLog.Add('FAIL   plugin not loaded  ' + tag); Inc(cFail); Continue; end;
    fid := (MasterCount(f) shl 24) or StrToInt('$' + hex);
    rec := RecordByFormID(f, fid, True);
    if not Assigned(rec) then begin slLog.Add('FAIL   not found          ' + tag); Inc(cFail); Continue; end;

    base := LinksTo(ElementByPath(rec, 'NAME'));
    got := '';
    if Assigned(base) then got := EditorID(base);
    if (want <> '*') and (not SameText(got, want)) then begin
      slLog.Add('SKIP   base mismatch      ' + tag + ' got ' + got); Inc(cSkip); Continue;
    end;

    win := WinningOverride(rec);
    if SameText(GetFileName(GetFile(win)), TARGET_PLUGIN) then
      ovr := win
    else begin
      AddRequiredElementMasters(win, TargetFile, False);
      ovr := wbCopyElementToFile(win, TargetFile, False, True);
    end;
    if not Assigned(ovr) then begin slLog.Add('FAIL   override not made  ' + tag); Inc(cFail); Continue; end;

    if (op = 'disable') or (op = 'sink') then begin
      flags := GetElementNativeValues(ovr, 'Record Header\Record Flags');
      SetElementNativeValues(ovr, 'Record Header\Record Flags', flags or FLAG_DISABLED);
      if Assigned(ElementByPath(ovr, 'XESP')) then RemoveElement(ovr, 'XESP');
      if op = 'sink' then SetElementNativeValues(ovr, 'DATA\Position\Z', SINK_Z);
    end
    else if (op = 'unlock') or (op = 'unseal') then begin
      if Assigned(ElementByPath(ovr, 'XLOC')) then RemoveElement(ovr, 'XLOC');
      if (op = 'unseal') and Assigned(ElementByPath(ovr, 'VMAD')) then RemoveElement(ovr, 'VMAD');
    end
    else begin
      slLog.Add('FAIL   unknown op         ' + tag); Inc(cFail); Continue;
    end;

    // read back
    flags := GetElementNativeValues(ovr, 'Record Header\Record Flags');
    ok := True;
    if (op = 'disable') or (op = 'sink') then
      ok := ((flags and FLAG_DISABLED) <> 0) and (not Assigned(ElementByPath(ovr, 'XESP')));
    if ok and (op = 'sink') then
      ok := GetElementNativeValues(ovr, 'DATA\Position\Z') <= -29999.0;
    if ok and ((op = 'unlock') or (op = 'unseal')) then
      ok := not Assigned(ElementByPath(ovr, 'XLOC'));
    if ok and (op = 'unseal') then
      ok := not Assigned(ElementByPath(ovr, 'VMAD'));
    if not ok then begin slLog.Add('FAIL   readback           ' + tag); Inc(cFail); Continue; end;

    slLog.Add('DONE   ' + IntToHex(GetLoadOrderFormID(ovr), 8) + '  ' + tag);
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
  slLog.Add('SUMMARY done=' + IntToStr(cDone) + ' skipped=' + IntToStr(cSkip) + ' failed=' + IntToStr(cFail));
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
  slLog.Free;
  slList.Free;
  slParts.Free;
end;

end.
