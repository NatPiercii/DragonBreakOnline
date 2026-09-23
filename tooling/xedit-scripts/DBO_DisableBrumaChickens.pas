{
  DBO - disable the two vanilla chickens at the farmstead northwest of Bruma cathedral.
  Their pathing yields a NaN heading at login and hangs the client (HANDOFF section 14).
  Server wildlife zones spawn replacements. Overrides each ACHR into DragonBreak Online Edits.esp
  with Initially Disabled set. Idempotent.
  Result: Edit Scripts\DBO_DisableBrumaChickens_result.txt
  Run: SSEEdit.exe -D:"<dev Data>" -P:"<server\plugins.server.txt>" -autoload -script:DBO_DisableBrumaChickens.pas -autoexit
}
unit DBODisableBrumaChickens;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  SOURCE_PLUGIN = 'BSHeartland.esm';
  RESULT_FILE   = 'DBO_DisableBrumaChickens_result.txt';

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

procedure DisableRef(refId: cardinal);
var srcRef, win, ov: IInterface;
begin
  srcRef := RecordByFormID(SourceFile, (SourceLO shl 24) or refId, True);
  if not Assigned(srcRef) then begin slLog.Add('ERROR|ref ' + IntToHex(refId, 6) + ' not found'); Exit; end;
  win := WinningOverride(srcRef);
  if Equals(GetFile(win), TargetFile) then ov := win
  else ov := wbCopyElementToFile(win, TargetFile, False, True);
  if not Assigned(ov) then begin slLog.Add('ERROR|override failed for ' + IntToHex(refId, 6)); Exit; end;
  SetIsInitiallyDisabled(ov, True);
  slLog.Add(IntToHex(GetLoadOrderFormID(ov), 8) + '|' + Signature(ov) + '|' + Name(LinksTo(ElementByName(ov, 'NAME - Base'))) + '|disabled=' + IntToStr(Ord(GetIsInitiallyDisabled(ov))));
end;

function Initialize: integer;
begin
  Result := 0;
  slLog := TStringList.Create;
  TargetFile := FileByName(TARGET_PLUGIN);
  SourceFile := FileByName(SOURCE_PLUGIN);
  if (not Assigned(TargetFile)) or (not Assigned(SourceFile)) then begin
    slLog.Add('FATAL  target or source plugin not loaded; ' + IntToStr(FileCount) + ' files');
    slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit;
  end;
  SourceLO := GetLoadOrder(SourceFile);
  slLog.Add('source load order ' + IntToHex(SourceLO, 2));
  DisableRef($06DF24);
  DisableRef($06DF25);
  slLog.Add('SUMMARY done');
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
end;

function Finalize: integer;
begin
  Result := 0;
end;

end.
