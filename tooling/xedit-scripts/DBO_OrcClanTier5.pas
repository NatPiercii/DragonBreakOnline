{
  DOL - Orc Clan tier 5 armour ratings

  Raises the modded Clan armour to tier 5 protection, following the convention
  already used by the vanilla-derived Clan set: take the tier's ARMOUR RATING
  and leave value and weight at whatever the base item had.

  That convention is visible in the existing records, e.g.
    ArmorOrcishClanCuirass  AR 43 (ebony)  value 1000 / weight 35 (orcish)
  rather than ebony's own 1500 / 38.

  Targets, read from Skyrim.esm rather than from memory:
    Glass (tier 5 light) cuirass 38  helmet 16  gauntlets 11  boots 11
    Ebony (tier 5 heavy) cuirass 43  helmet 21  gauntlets 16  boots 16

  DNAM stores armour rating multiplied by 100, so AR 38 is written as 3800.
  This script sets the native value directly and reads it back to confirm.

  Only the seven modded pieces are touched. The vanilla-derived Clan records
  were already balanced by hand and are deliberately left alone.

  Run: right-click DragonBreak Online Edits.esp -> Apply Script -> DBO_OrcClanTier5
}
unit DBOOrcClanTier5;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';

var
  slJobs, slLog: TStringList;
  cSet, cSame, cMissing, cFailed: integer;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

function RecByEDID(f: IwbFile; sig, edid: string): IwbMainRecord;
var g: IwbGroupRecord; r: IwbElement; j: integer;
begin
  Result := nil;
  g := GroupBySignature(f, sig);
  if not Assigned(g) then Exit;
  for j := 0 to Pred(ElementCount(g)) do begin
    r := ElementByIndex(g, j);
    if not Assigned(r) then Continue;
    if SameText(EditorID(r), edid) then begin Result := r; Exit; end;
  end;
end;

function Initialize: integer;
var
  f: IwbFile; r: IwbMainRecord; sl: TStringList;
  i, k, target, before, after: integer;
begin
  Result := 0;
  cSet := 0; cSame := 0; cMissing := 0; cFailed := 0;
  slLog := TStringList.Create;
  slJobs := TStringList.Create;

  f := FileByName(TARGET_PLUGIN);
  if not Assigned(f) then begin
    AddMessage('ERROR: ' + TARGET_PLUGIN + ' is not loaded.');
    Result := 1; Exit;
  end;

  // EditorID | armour rating
  slJobs.Add('ArmorOrcishClanCuirassLight|38');    // glass cuirass
  // Studded sits 3 above the glass cuirass so it reads as the upgrade its
  // name implies, without leaving tier 5 or reaching ebony's 43.
  slJobs.Add('ArmorOrcishClanCuirassStudded|41');
  slJobs.Add('ArmorOrcishClanHelmetMedium|16');    // glass helmet
  slJobs.Add('ArmorOrcishClanBootsMedium|11');     // glass boots
  slJobs.Add('ArmorOrcishClanGauntletsHeavy|11');  // glass gauntlets
  slJobs.Add('ArmorOrcishClanCuirassMedium|43');   // ebony cuirass (Warchief)
  slJobs.Add('ArmorOrcishClanMaskHelmet|21');      // ebony helmet (masked)

  AddMessage('Setting tier 5 armour ratings in ' + TARGET_PLUGIN + ' ...');
  AddMessage('');

  for i := 0 to Pred(slJobs.Count) do begin
    sl := TStringList.Create;
    sl.Delimiter := '|';
    sl.StrictDelimiter := True;
    sl.DelimitedText := slJobs[i];
    if sl.Count >= 2 then begin
      target := StrToInt(sl[1]) * 100;
      r := RecByEDID(f, 'ARMO', sl[0]);
      if not Assigned(r) then begin
        slLog.Add('NOT FOUND   ' + sl[0]);
        Inc(cMissing);
      end else begin
        before := GetElementNativeValues(r, 'DNAM');
        if before = target then begin
          slLog.Add('ALREADY     ' + sl[0] + '  AR ' + IntToStr(target div 100));
          Inc(cSame);
        end else begin
          SetElementNativeValues(r, 'DNAM', target);
          after := GetElementNativeValues(r, 'DNAM');
          if after = target then begin
            slLog.Add('OK          ' + sl[0] + '  AR ' +
                      IntToStr(before div 100) + ' -> ' + IntToStr(after div 100));
            Inc(cSet);
          end else begin
            slLog.Add('SET FAILED  ' + sl[0]);
            Inc(cFailed);
          end;
        end;
      end;
    end;
    sl.Free;
  end;

  AddMessage('=====================================');
  AddMessage('  ratings changed    : ' + IntToStr(cSet));
  AddMessage('  already correct    : ' + IntToStr(cSame));
  AddMessage('  records not found  : ' + IntToStr(cMissing));
  AddMessage('  failures           : ' + IntToStr(cFailed));
  AddMessage('=====================================');
  for k := 0 to Pred(slLog.Count) do AddMessage('  ' + slLog[k]);
  AddMessage('Value and weight were deliberately left unchanged.');
  AddMessage('Review, then Ctrl+S to save.');

  slLog.Free;
  slJobs.Free;
end;

end.
