{
  DOL - activator shrines for Hircine, Sanguine and Sheogorath on the Daedric Shrines AIO statues.
  Adds man_DaedricShrines.esp as a master of DragonBreak Online Edits.esp, creates one ACTI per
  deity (DBO_ShrineOf<Deity>, model = the statue mesh, no script), overrides each statue REFR
  as Initially Disabled, and places a new REFR of the ACTI with the same transform in the same
  cell. Idempotent: an existing ACTI is reused; a statue ref already overridden by the target
  is skipped. Result: Edit Scripts\DBO_ShrineActivators_result.txt  (deity|ACTI|REFR lines)
  Meridia needs nothing here: her vanilla Kilkreath statue is already an activator (4e4d6).
  Run: SSEEdit.exe -D:"<dev Data>" -P:"<server\plugins.server.txt>" -autoload -script:DBO_ShrineActivators.pas -autoexit
}
unit DBOShrineActivators;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  SOURCE_PLUGIN = 'man_DaedricShrines.esp';
  RESULT_FILE   = 'DBO_ShrineActivators_result.txt';

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

function FindByEditorID(grp: IInterface; edid: string): IInterface;
var i: integer; r: IInterface;
begin
  Result := nil;
  if not Assigned(grp) then Exit;
  for i := 0 to Pred(ElementCount(grp)) do begin
    r := ElementByIndex(grp, i);
    if SameText(EditorID(r), edid) then begin Result := r; Exit; end;
  end;
end;

function SourceRecord(localId: cardinal): IInterface;
begin
  Result := RecordByFormID(SourceFile, (SourceLO shl 24) or localId, True);
end;

// Creates or reuses the activator for a deity; model and bounds taken from the statue base.
// Every field is (re)applied so a record left half-built by an aborted run gets completed.
function Shrine(deity, full: string; statId: cardinal): IInterface;
var grp, stat, acti: IInterface; modl, what: string;
begin
  Result := nil;
  grp := GroupBySignature(TargetFile, 'ACTI');
  if not Assigned(grp) then grp := Add(TargetFile, 'ACTI', True);
  stat := SourceRecord(statId);
  if not Assigned(stat) then begin slLog.Add('ERROR  ' + deity + ': statue base ' + IntToHex(statId, 6) + ' not found'); Exit; end;
  modl := GetElementEditValues(stat, 'Model\MODL');
  acti := FindByEditorID(grp, 'DBO_ShrineOf' + deity);
  if Assigned(acti) then what := 'ACTI kept' else begin
    acti := Add(grp, 'ACTI', True);
    SetElementEditValues(acti, 'EDID', 'DBO_ShrineOf' + deity);
    what := 'ACTI new';
  end;
  // OBND exists on a fresh record already; copy the six bounds one by one
  if not Assigned(ElementBySignature(acti, 'OBND')) then Add(acti, 'OBND', True);
  SetElementNativeValues(acti, 'OBND\X1', GetElementNativeValues(stat, 'OBND\X1'));
  SetElementNativeValues(acti, 'OBND\Y1', GetElementNativeValues(stat, 'OBND\Y1'));
  SetElementNativeValues(acti, 'OBND\Z1', GetElementNativeValues(stat, 'OBND\Z1'));
  SetElementNativeValues(acti, 'OBND\X2', GetElementNativeValues(stat, 'OBND\X2'));
  SetElementNativeValues(acti, 'OBND\Y2', GetElementNativeValues(stat, 'OBND\Y2'));
  SetElementNativeValues(acti, 'OBND\Z2', GetElementNativeValues(stat, 'OBND\Z2'));
  if not Assigned(ElementBySignature(acti, 'FULL')) then Add(acti, 'FULL', True);
  SetElementEditValues(acti, 'FULL', full);
  if not Assigned(ElementByName(acti, 'Model')) then Add(acti, 'Model', True);
  SetElementEditValues(acti, 'Model\MODL', modl);
  slLog.Add(deity + '|' + what + '|' + IntToHex(GetLoadOrderFormID(acti), 8) + '|' + modl);
  Result := acti;
end;

// Hides one statue ref and places the activator on its transform.
procedure Place(deity: string; acti: IInterface; refId: cardinal);
var srcRef, ov, nr: IInterface;
begin
  if not Assigned(acti) then Exit;
  srcRef := SourceRecord(refId);
  if not Assigned(srcRef) then begin slLog.Add('ERROR  ' + deity + ': statue ref ' + IntToHex(refId, 6) + ' not found'); Exit; end;
  if Equals(GetFile(WinningOverride(srcRef)), TargetFile) then begin
    slLog.Add(deity + '|REFR kept|statue ' + IntToHex(refId, 6) + ' already overridden');
    Exit;
  end;
  ov := wbCopyElementToFile(srcRef, TargetFile, False, True);
  SetIsInitiallyDisabled(ov, True);
  nr := wbCopyElementToFile(srcRef, TargetFile, True, True);
  SetElementNativeValues(nr, 'NAME', GetLoadOrderFormID(acti));
  SetIsInitiallyDisabled(nr, False);
  slLog.Add(deity + '|REFR new|' + IntToHex(GetLoadOrderFormID(nr), 8) + '|statue ' + IntToHex(refId, 6) + ' hidden|cell ' + Name(LinksTo(ElementByName(nr, 'Cell'))));
end;

function Initialize: integer;
var i: integer; acti: IInterface;
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

  acti := Shrine('Hircine', 'Shrine of Hircine', $000D61);
  Place('Hircine', acti, $000827);   // Tamriel, Falkreath forest
  Place('Hircine', acti, $000822);   // Solstheim

  acti := Shrine('Sanguine', 'Shrine of Sanguine', $000852);
  Place('Sanguine', acti, $000859);  // Tamriel, Rift
  Place('Sanguine', acti, $000853);  // interior 3d62b

  acti := Shrine('Sheogorath', 'Shrine of Sheogorath', $00089B);
  Place('Sheogorath', acti, $00089C); // Tamriel, Hjaalmarch marsh

  slLog.Add('SUMMARY done');
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
end;

function Finalize: integer;
begin
  Result := 0;
end;

end.
