{
  DOL - audit every reference DragonBreak Online Edits.esp makes into the
  magic plugins that are being dropped. Read-only. Writes
  Edit Scripts\DBO_MagicRefs_result.txt as
      KIND|DLE FormID|Sig|EditorID|element path|target FormID|target Sig|target EditorID
  KIND = OVERRIDE (the DLE record itself belongs to a target master)
       = REF      (a field inside a DLE record points at a target record)
}
unit DBOMagicRefs;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  RESULT_FILE   = 'DBO_MagicRefs_result.txt';

var
  slLog: TStringList;
  TargetFile: IwbFile;
  cRef, cOvr, cRec: integer;

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
    if Assigned(lnk) then begin
      if IsDropMaster(GetFile(lnk)) then begin
        slLog.Add('REF|' + IntToHex(GetLoadOrderFormID(rec), 8) + '|' + Signature(rec) + '|' + EditorID(rec)
          + '|' + Path(child) + '|' + IntToHex(GetLoadOrderFormID(lnk), 8) + '|' + Signature(lnk) + '|' + EditorID(lnk));
        Inc(cRef);
      end;
    end;
    if ElementCount(child) > 0 then Walk(rec, child);
  end;
end;

function Initialize: integer;
var
  i: integer;
  rec, m: IwbMainRecord;
begin
  Result := 0;
  slLog := TStringList.Create;
  cRef := 0; cOvr := 0; cRec := 0;
  TargetFile := FileByName(TARGET_PLUGIN);
  if not Assigned(TargetFile) then begin
    slLog.Add('FATAL  target plugin not loaded');
    slLog.SaveToFile(ScriptsPath + RESULT_FILE);
    Result := 1; Exit;
  end;
  slLog.Add('masters on DLE: ' + IntToStr(MasterCount(TargetFile)));
  for i := 0 to Pred(RecordCount(TargetFile)) do begin
    rec := RecordByIndex(TargetFile, i);
    Inc(cRec);
    m := MasterOrSelf(rec);
    if IsDropMaster(GetFile(m)) then begin
      slLog.Add('OVERRIDE|' + IntToHex(GetLoadOrderFormID(rec), 8) + '|' + Signature(rec) + '|' + EditorID(rec) + '|||' + Signature(m) + '|' + EditorID(m));
      Inc(cOvr);
    end;
    Walk(rec, rec);
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
  slLog.Add('SUMMARY records=' + IntToStr(cRec) + ' overrides=' + IntToStr(cOvr) + ' refs=' + IntToStr(cRef));
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
  slLog.Free;
end;

end.
