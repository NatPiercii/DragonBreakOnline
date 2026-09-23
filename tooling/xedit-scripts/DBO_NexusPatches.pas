{
  DBO - build DragonBreak Nexus Patches.esp from the server's edited copies of six Nexus plugins.
  The server used to run edited copies of Armors of the Velothi I/II, Immersive Armors, Immersive Weapons,
  TGCotN Winterhold and notice board while players ran the Nexus files. This copies each edited record
  listed in DBO_NexusPatches_list.txt (source|master|local id|signature) into a new plugin that loads last,
  so the Nexus originals can go back everywhere. Parent CELL and WRLD records are copied first from their
  current winning override, so the patch changes nothing but the listed records. Every copy is then
  compared element by element against its source.
  Load the EDITED copies (dev Data) with -P server\plugins.server.txt; the patch must not exist yet.
  Result: Edit Scripts\DBO_NexusPatches_result.txt
  Run: SSEEdit.exe -D:"<dev Data>" -P:"<server\plugins.server.txt>" -autoload -script:DBO_NexusPatches.pas -autoexit
}
unit DBONexusPatches;

const
  PATCH_NAME  = 'DragonBreak Nexus Patches.esp';
  LIST_FILE   = 'DBO_NexusPatches_list.txt';
  RESULT_FILE = 'DBO_NexusPatches_result.txt';

var
  slLog, slWant, slFound, slRecs, slParents: TStringList;
  Patch: IwbFile;
  Errors: integer;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

procedure Fail(msg: string);
begin
  slLog.Add('ERROR|' + msg); Inc(Errors);
end;

function RecKey(src: string; r: IInterface): string;
begin
  Result := LowerCase(src + '|' + GetFileName(GetFile(MasterOrSelf(r))) + '|' + IntToHex(FixedFormID(r) and $FFFFFF, 6));
end;

// Every leaf below a record as path=value, record header skipped (form id and version fields differ by design)
procedure Dump(e: IInterface; sl: TStringList);
var i: integer; c: IInterface;
begin
  if ElementCount(e) = 0 then begin sl.Add(Path(e) + '=' + GetEditValue(e)); Exit; end;
  for i := 0 to Pred(ElementCount(e)) do begin
    c := ElementByIndex(e, i);
    if Name(c) <> 'Record Header' then Dump(c, sl);
  end;
end;

procedure Compare(src, copy: IInterface; what: string);
var a, b: TStringList; i: integer;
begin
  a := TStringList.Create; b := TStringList.Create;
  Dump(src, a); Dump(copy, b);
  if a.Text <> b.Text then begin
    Fail('mismatch ' + what + ' ' + Name(src));
    for i := 0 to Pred(a.Count) do
      if (i >= b.Count) or (a[i] <> b[i]) then begin
        slLog.Add('   src : ' + a[i]);
        if i < b.Count then slLog.Add('   copy: ' + b[i]);
        Break;
      end;
  end;
  if GetElementNativeValues(src, 'Record Header\Record Flags') <> GetElementNativeValues(copy, 'Record Header\Record Flags') then
    Fail('flags differ ' + what + ' ' + Name(src));
  a.Free; b.Free;
end;

function WorldOf(cell: IInterface): IInterface;
var g: IInterface;
begin
  Result := nil;
  g := GetContainer(cell);
  while Assigned(g) and (ElementType(g) = etGroupRecord) do begin
    if GroupType(g) = 1 then begin Result := ChildrenOf(g); Exit; end;
    g := GetContainer(g);
  end;
end;

procedure AddParent(r: IInterface);
var cell, wrld: IInterface;
begin
  if Signature(r) <> 'REFR' then Exit;
  cell := WinningOverride(MasterOrSelf(LinksTo(ElementByName(r, 'Cell'))));
  if not Assigned(cell) then begin Fail('no cell for ' + Name(r)); Exit; end;
  wrld := WorldOf(cell);
  if Assigned(wrld) then begin
    wrld := WinningOverride(MasterOrSelf(wrld));
    if slParents.IndexOf(IntToHex(GetLoadOrderFormID(wrld), 8)) < 0 then
      slParents.AddObject(IntToHex(GetLoadOrderFormID(wrld), 8), wrld);
  end;
  if slParents.IndexOf(IntToHex(GetLoadOrderFormID(cell), 8)) < 0 then
    slParents.AddObject(IntToHex(GetLoadOrderFormID(cell), 8), cell);
end;

function Initialize: integer;
var i, j, n: integer; parts: TStringList; src: IwbFile; r, c: IInterface; k, srcName: string;
begin
  Result := 0; Errors := 0;
  slLog := TStringList.Create; slWant := TStringList.Create; slFound := TStringList.Create;
  slRecs := TStringList.Create; slParents := TStringList.Create;
  parts := TStringList.Create; parts.Delimiter := '|'; parts.StrictDelimiter := True;
  slWant.LoadFromFile(ScriptsPath + LIST_FILE);
  slLog.Add('list ' + IntToStr(slWant.Count) + ' records, ' + IntToStr(FileCount) + ' files loaded');

  if Assigned(FileByName(PATCH_NAME)) then begin
    slLog.Add('FATAL|' + PATCH_NAME + ' is already loaded; remove it from the order and Data first');
    slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit;
  end;

  // Find every listed record in its source file
  for i := 0 to Pred(slWant.Count) do begin
    parts.DelimitedText := slWant[i];
    slWant[i] := LowerCase(parts[0] + '|' + parts[1] + '|' + parts[2]);
  end;
  slWant.Sorted := True; slRecs.Sorted := True; slParents.Sorted := True;
  srcName := '';
  for i := 0 to Pred(slWant.Count) do begin
    parts.DelimitedText := slWant[i];
    if SameText(parts[0], srcName) then Continue;
    srcName := parts[0];
    src := FileByName(srcName);
    if not Assigned(src) then begin Fail('source not loaded: ' + srcName); Continue; end;
    n := 0;
    for j := 0 to Pred(RecordCount(src)) do begin
      r := RecordByIndex(src, j);
      k := RecKey(GetFileName(src), r);
      if slWant.IndexOf(k) >= 0 then begin slRecs.AddObject(k, r); Inc(n); end;
    end;
    slLog.Add('source ' + GetFileName(src) + ': ' + IntToStr(n) + ' records found');
  end;
  for i := 0 to Pred(slWant.Count) do
    if slRecs.IndexOf(slWant[i]) < 0 then Fail('not found: ' + slWant[i]);
  if Errors > 0 then begin slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit; end;

  // Parents from their current winners, before the patch exists
  for i := 0 to Pred(slRecs.Count) do AddParent(ObjectToElement(slRecs.Objects[i]));
  slLog.Add('parents: ' + IntToStr(slParents.Count) + ' CELL/WRLD records');

  Patch := AddNewFileName(PATCH_NAME);
  if not Assigned(Patch) then begin slLog.Add('FATAL|could not create ' + PATCH_NAME); slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit; end;
  for i := 0 to Pred(slParents.Count) do AddRequiredElementMasters(ObjectToElement(slParents.Objects[i]), Patch, False);
  for i := 0 to Pred(slRecs.Count) do AddRequiredElementMasters(ObjectToElement(slRecs.Objects[i]), Patch, False);
  SortMasters(Patch);
  SetElementEditValues(ElementByIndex(Patch, 0), 'CNAM - Author', 'DragonBreak');
  SetElementEditValues(ElementByIndex(Patch, 0), 'SNAM - Description',
    'DragonBreak changes to Armors of the Velothi I/II, Immersive Armors, Immersive Weapons, TGCotN Winterhold and notice board.');

  // Worlds first, then cells, then the edited records
  for i := 0 to Pred(slParents.Count) do begin
    r := ObjectToElement(slParents.Objects[i]);
    if Signature(r) = 'WRLD' then wbCopyElementToFile(r, Patch, False, True);
  end;
  for i := 0 to Pred(slParents.Count) do begin
    r := ObjectToElement(slParents.Objects[i]);
    if Signature(r) = 'CELL' then wbCopyElementToFile(r, Patch, False, True);
  end;
  for i := 0 to Pred(slRecs.Count) do wbCopyElementToFile(ObjectToElement(slRecs.Objects[i]), Patch, False, True);

  // Verify every copy against its source
  for i := 0 to Pred(slParents.Count) do begin
    r := ObjectToElement(slParents.Objects[i]);
    c := RecordByFormID(Patch, LoadOrderFormIDtoFileFormID(Patch, GetLoadOrderFormID(r)), False);
    if not Assigned(c) then Fail('parent missing in patch: ' + Name(r)) else Compare(r, c, 'parent');
  end;
  for i := 0 to Pred(slRecs.Count) do begin
    r := ObjectToElement(slRecs.Objects[i]);
    c := RecordByFormID(Patch, LoadOrderFormIDtoFileFormID(Patch, GetLoadOrderFormID(r)), False);
    if not Assigned(c) then Fail('record missing in patch: ' + Name(r)) else Compare(r, c, 'record');
  end;

  slLog.Add('patch records: ' + IntToStr(RecordCount(Patch)) + ', masters: ' + IntToStr(MasterCount(Patch)));
  for i := 0 to Pred(MasterCount(Patch)) do slLog.Add('  master ' + GetFileName(MasterByIndex(Patch, i)));
  slLog.Add('SUMMARY ' + IntToStr(slRecs.Count) + ' records, ' + IntToStr(slParents.Count) + ' parents, ' + IntToStr(Errors) + ' errors');
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
  if Errors > 0 then Result := 1;
end;

function Finalize: integer;
begin
  Result := 0;
end;

end.
