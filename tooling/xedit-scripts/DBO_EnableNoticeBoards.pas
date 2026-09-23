{
  DBO - enable Manny's notice boards for the server.
  notice board.esp places its 14 boards Initially Disabled and lets a quest script enable them;
  quest scripts never run under SkyMP, so the boards never appear. This overrides each listed
  board REFR into DragonBreak Online Edits.esp with the Initially Disabled flag cleared.
  Riverwood (001D93) and Riften (0038A2) are skipped on purpose: DragonBreak Online Edits.esp
  already places its own boards there. Winterhold (001D9A) and Morthal (001D9C) are already
  enabled by their COTN/TGC patches. Idempotent: a ref already overridden by the target is
  re-flagged, not duplicated.
  Result: Edit Scripts\DBO_EnableNoticeBoards_result.txt
  Run: SSEEdit.exe -D:"<dev Data>" -P:"<server\plugins.server.txt>" -autoload -script:DBO_EnableNoticeBoards.pas -autoexit
}
unit DBOEnableNoticeBoards;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  SOURCE_PLUGIN = 'notice board.esp';
  RESULT_FILE   = 'DBO_EnableNoticeBoards_result.txt';

var
  slLog: TStringList;
  TargetFile, SourceFile: IwbFile;
  SourceLO: integer;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

procedure EnableBoard(where: string; refId: cardinal);
var srcRef, win, ov: IInterface;
begin
  srcRef := RecordByFormID(SourceFile, (SourceLO shl 24) or refId, True);
  if not Assigned(srcRef) then begin slLog.Add('ERROR|' + where + '|ref ' + IntToHex(refId, 6) + ' not found'); Exit; end;
  win := WinningOverride(srcRef);
  if Equals(GetFile(win), TargetFile) then ov := win
  else ov := wbCopyElementToFile(win, TargetFile, False, True);
  if not Assigned(ov) then begin slLog.Add('ERROR|' + where + '|override failed for ' + IntToHex(refId, 6)); Exit; end;
  SetIsInitiallyDisabled(ov, False);
  slLog.Add(where + '|' + IntToHex(GetLoadOrderFormID(ov), 8) + '|enabled|cell ' + Name(LinksTo(ElementByName(ov, 'Cell'))));
end;

function Initialize: integer;
var i: integer;
begin
  Result := 0;
  slLog := TStringList.Create;
  TargetFile := FileByName(TARGET_PLUGIN);
  SourceFile := FileByName(SOURCE_PLUGIN);
  if (not Assigned(TargetFile)) or (not Assigned(SourceFile)) then begin
    slLog.Add('FATAL  target or source plugin not loaded; ' + IntToStr(FileCount) + ' files loaded from ' + DataPath + ':');
    for i := 0 to Pred(FileCount) do slLog.Add('  ' + GetFileName(FileByIndex(i)));
    slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit;
  end;
  SourceLO := GetLoadOrder(SourceFile);
  AddMasterIfMissing(TargetFile, SOURCE_PLUGIN);
  SortMasters(TargetFile);
  slLog.Add('masters ok, source load order ' + IntToHex(SourceLO, 2));

  EnableBoard('Dawnstar',      $001D9B);
  EnableBoard('Ivarstead',     $001D98);
  EnableBoard('Dragon Bridge', $001D96);
  EnableBoard('Rorikstead',    $001D95);
  EnableBoard('Falkreath',     $001D9D);
  EnableBoard('Windhelm',      $0038AA);
  EnableBoard('Markarth',      $0038A1);
  EnableBoard('Whiterun',      $0038A3);
  EnableBoard('Solitude',      $00389F);
  EnableBoard('Raven Rock',    $0357B0);

  slLog.Add('SUMMARY done');
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
end;

function Finalize: integer;
begin
  Result := 0;
end;

end.
