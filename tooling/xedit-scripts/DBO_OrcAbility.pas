{
  Give the Orc the racial ability it never had.

  Measured by ck-mcp\raceabilities.py: every hard trait in the Bloodlines codex already exists as a
  working vanilla ability except this one. OrcRace carries RaceOrcBerserk, a Power, and no Ability at
  all, so an Orc has nothing under Active Effects while every other race shows its bloodline.

  DBO_RaceOrc is a copy of RaceBreton, which is the same shape: an Ability whose single effect is
  AbResistMagic. The magnitude goes 25 to 15, the codex figure. AbResistMagic's own description reads
  "Increases Magic Resistance by <mag>%", which is race neutral, so no new magic effect is needed.

  usage: tools\run-sseedit-script.ps1 -Script DBO_OrcAbility
}
unit DBO_OrcAbility;

const
  TARGET_FILE = 'DragonBreak Online Edits.esp';
  SOURCE_SPELL = 'RaceBreton';
  NEW_EDID = 'DBO_RaceOrc';
  NEW_NAME = 'Orcish Blood';
  MAGNITUDE = '15.000000';

var
  target, srcSpell, orcRace: IInterface;
  outLines: TStringList;

function Initialize: integer;
var
  i: integer;
  f: IInterface;
begin
  outLines := TStringList.Create;
  target := nil;
  for i := 0 to FileCount - 1 do begin
    f := FileByIndex(i);
    if GetFileName(f) = TARGET_FILE then target := f;
  end;
  if not Assigned(target) then begin
    outLines.Add('FATAL: ' + TARGET_FILE + ' is not in the load order.');
    Result := 1;
    Exit;
  end;
  outLines.Add('=== DBO orc ability ===');
  Result := 0;
end;

function Process(e: IInterface): integer;
begin
  Result := 0;
  if not Assigned(target) then Exit;
  if not IsWinningOverride(e) then Exit;
  if (Signature(e) = 'SPEL') and (GetElementEditValues(e, 'EDID') = SOURCE_SPELL) then
    srcSpell := e;
  if (Signature(e) = 'RACE') and (GetElementEditValues(e, 'EDID') = 'OrcRace') then
    orcRace := e;
end;

function Finalize: integer;
var
  newSpell, ovrRace, effects, eff, spells, entry: IInterface;
  i: integer;
  already: boolean;
  newId: string;
begin
  if not Assigned(target) then begin
    outLines.SaveToFile(ScriptsPath + 'DBO_OrcAbility.txt');
    outLines.Free;
    Result := 0;
    Exit;
  end;

  if not Assigned(srcSpell) then outLines.Add('FATAL: ' + SOURCE_SPELL + ' not found');
  if not Assigned(orcRace) then outLines.Add('FATAL: OrcRace not found');

  if Assigned(srcSpell) and Assigned(orcRace) then begin
    newSpell := wbCopyElementToFile(srcSpell, target, True, True);
    if not Assigned(newSpell) then
      outLines.Add('FATAL: could not create the new spell')
    else begin
      SetElementEditValues(newSpell, 'EDID', NEW_EDID);
      SetElementEditValues(newSpell, 'FULL', NEW_NAME);
      newId := IntToHex(GetLoadOrderFormID(newSpell), 8);
      outLines.Add('created ' + NEW_EDID + ' [' + newId + '] from ' + SOURCE_SPELL);

      effects := ElementByPath(newSpell, 'Effects');
      if Assigned(effects) then begin
        for i := 0 to ElementCount(effects) - 1 do begin
          eff := ElementByIndex(effects, i);
          outLines.Add('  effect ' + IntToStr(i) + ': ' + GetElementEditValues(eff, 'EFID')
                       + ' magnitude ' + GetElementEditValues(eff, 'EFIT\Magnitude'));
          SetElementEditValues(eff, 'EFIT\Magnitude', MAGNITUDE);
          outLines.Add('    magnitude set to ' + GetElementEditValues(eff, 'EFIT\Magnitude'));
        end;
      end else
        outLines.Add('  WARNING: no Effects element on the new spell');

      { OrcRace already lives in the target from the race stat pass, but copy defensively }
      if GetFileName(GetFile(orcRace)) = TARGET_FILE then
        ovrRace := orcRace
      else
        ovrRace := wbCopyElementToFile(orcRace, target, False, True);

      if not Assigned(ovrRace) then
        outLines.Add('FATAL: could not override OrcRace')
      else begin
        spells := ElementByPath(ovrRace, 'Actor Effects');
        if not Assigned(spells) then
          spells := Add(ovrRace, 'Actor Effects', True);
        already := False;
        for i := 0 to ElementCount(spells) - 1 do
          if Pos(NEW_EDID, GetEditValue(ElementByIndex(spells, i))) > 0 then already := True;

        if already then
          outLines.Add('OrcRace already lists ' + NEW_EDID)
        else begin
          entry := ElementAssign(spells, HighInteger, nil, False);
          SetEditValue(entry, newId);
          outLines.Add('OrcRace now lists ' + NEW_EDID);
        end;

        outLines.Add('');
        outLines.Add('OrcRace spells after the change:');
        for i := 0 to ElementCount(spells) - 1 do
          outLines.Add('  ' + GetEditValue(ElementByIndex(spells, i)));
      end;
    end;
  end;

  outLines.SaveToFile(ScriptsPath + 'DBO_OrcAbility.txt');
  outLines.Free;
  Result := 0;
end;

end.
