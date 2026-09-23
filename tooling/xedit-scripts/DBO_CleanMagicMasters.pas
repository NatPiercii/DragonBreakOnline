{
  DOL - remove MysticismMagic.esp, OCW_MaMO_FEPatch.esp and
  Mage Clothing Expansion.esp from the master list of
  DragonBreak Online Edits.esp.

  Re-verifies first that no DLE record references or overrides a record
  OWNED by one of those files (MasterOrSelf, so vanilla records that the
  magic plugins merely override do not count). Aborts without touching
  anything if a reference remains. Then CleanMasters.

  Result file: Edit Scripts\DBO_CleanMagicMasters_result.txt
}
unit DBOCleanMagicMasters;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  RESULT_FILE   = 'DBO_CleanMagicMasters_result.txt';

var
  slLog: TStringList;
  TargetFile: IwbFile;
  cRef, cOvr: integer;

function IsDropMaster(f: IwbFile): boolean;
var n: string;
begin
  n := GetFileName(f);
  Result := SameText(n, 'MysticismMagic.esp') or SameText(n, 'OCW_MaMO_FEPatch.esp')
         or SameText(n, 'Mage Clothing Expansion.esp');
end;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

procedure Walk(rec: IwbMainRecord; e: IInterface);
var
  i: integer;
  child, lnk: IInterface;
begin
  for i := 0 to Pred(ElementCount(e)) do begin
    child := ElementByIndex(e, i);
    lnk := LinksTo(child);
    if Assigned(lnk) then
      if IsDropMaster(GetFile(MasterOrSelf(lnk))) then begin
        slLog.Add('REF|' + IntToHex(GetLoadOrderFormID(rec), 8) + '|' + Signature(rec) + '|' + EditorID(rec)
          + '|' + Path(child) + '|' + IntToHex(GetLoadOrderFormID(lnk), 8) + '|' + EditorID(lnk));
        Inc(cRef);
      end;
    if ElementCount(child) > 0 then Walk(rec, child);
  end;
end;

procedure LogMasters(tag: string);
var i: integer;
begin
  slLog.Add(tag + ' master count: ' + IntToStr(MasterCount(TargetFile)));
  for i := 0 to Pred(MasterCount(TargetFile)) do
    slLog.Add('  ' + tag + ' M' + IntToStr(i) + ' ' + GetFileName(MasterByIndex(TargetFile, i)));
end;

function Initialize: integer;
var
  i: integer;
  rec: IwbMainRecord;
begin
  Result := 0;
  slLog := TStringList.Create;
  cRef := 0; cOvr := 0;
  TargetFile := FileByName(TARGET_PLUGIN);
  if not Assigned(TargetFile) then begin
    slLog.Add('FATAL  target plugin not loaded');
    slLog.SaveToFile(ScriptsPath + RESULT_FILE);
    Result := 1; Exit;
  end;
  LogMasters('BEFORE');
  for i := 0 to Pred(RecordCount(TargetFile)) do begin
    rec := RecordByIndex(TargetFile, i);
    if IsDropMaster(GetFile(MasterOrSelf(rec))) then begin
      slLog.Add('OVERRIDE|' + IntToHex(GetLoadOrderFormID(rec), 8) + '|' + Signature(rec) + '|' + EditorID(rec));
      Inc(cOvr);
    end;
    Walk(rec, rec);
  end;
  slLog.Add('true refs=' + IntToStr(cRef) + ' overrides=' + IntToStr(cOvr));
  if (cRef > 0) or (cOvr > 0) then begin
    slLog.Add('ABORT  references remain, masters not cleaned');
    slLog.SaveToFile(ScriptsPath + RESULT_FILE);
    Result := 1; Exit;
  end;
  CleanMasters(TargetFile);
  LogMasters('AFTER');
  slLog.Add('DONE   CleanMasters applied');
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
