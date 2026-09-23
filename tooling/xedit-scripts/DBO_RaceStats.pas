{
  DBO_RaceStats - writes the DragonBreak racial stat spread onto the ten playable RACE records
  as overrides in "DragonBreak Online Edits.esp" (the conflict layer, which loads last).

  Numbers are RACES_DESIGN.md section 2 (the Imperious spread) MINUS 50, because the player's
  total is raceData.startingX + the Player NPC_ offset, and that offset is 50 for health,
  magicka and stamina (verified with DBO_PlayerOffsets.pas). Carry weight and the three regen
  rates are absolute and are written as designed.

  DLE already lists "unofficial skyrim special edition patch.esp" as a master, so copying the
  USSEP override in adds no new master and cannot shift DLE's self-index.
}
unit DBO_RaceStats;

const
  TARGET_FILE = 'DragonBreak Online Edits.esp';
  OFFSET = 50;

var
  outLines: TStringList;
  names: TStringList;
  vals: TStringList;
  target: IInterface;
  touched: integer;

procedure Want(edid: string; h, m, s, carry: integer; hr, mr, sr: string; unarmed: integer);
begin
  names.Add(edid);
  vals.Add(IntToStr(h) + '|' + IntToStr(m) + '|' + IntToStr(s) + '|' +
           IntToStr(carry) + '|' + hr + '|' + mr + '|' + sr + '|' + IntToStr(unarmed));
end;

function Initialize: integer;
var
  i: integer;
  f: IInterface;
begin
  outLines := TStringList.Create;
  names := TStringList.Create;
  vals := TStringList.Create;
  touched := 0;

  { Unarmed damage is vanilla 4 for everyone and 10 for the two clawed races. Khajiit go to 14 so their
    claws are not identical to an Argonian's: Rawlith Khaj is the iconic one, Unarmed is a real skill as
    of 2026-09-20, and the field sits outside the 300 stat budget so it costs the race nothing elsewhere. }
  {        edid            H    M    S   carry  hRegen  mRegen   sRegen  unarmed }
  Want('HighElfRace',      90, 120,  90,  250, '0.5',   '3.75',  '4.5',    4);
  Want('ArgonianRace',    100,  95, 105,  325, '0.5',   '3.0',   '5.0',   10);
  Want('WoodElfRace',      95, 100, 105,  275, '1.0',   '3.0',   '5.0',    4);
  Want('BretonRace',       95, 105, 100,  300, '0.75',  '3.125', '4.75',   4);
  Want('DarkElfRace',      95, 110,  95,  275, '0.75',  '3.125', '4.75',   4);
  Want('ImperialRace',    100, 100, 100,  300, '1.0',   '3.0',   '5.0',    4);
  Want('KhajiitRace',      90, 105, 105,  300, '0.5',   '3.125', '5.25',  14);
  Want('NordRace',        110,  85, 105,  325, '0.75',  '2.875', '5.25',   4);
  Want('OrcRace',         110,  80, 110,  350, '1.0',   '2.75',  '5.5',    4);
  Want('RedguardRace',    100,  80, 120,  325, '0.75',  '2.875', '5.25',   4);

  target := nil;
  for i := 0 to FileCount - 1 do begin
    f := FileByIndex(i);
    if GetFileName(f) = TARGET_FILE then target := f;
  end;

  if not Assigned(target) then begin
    outLines.Add('FATAL: ' + TARGET_FILE + ' is not in the load order. Nothing written.');
    Result := 1;
    Exit;
  end;

  outLines.Add('=== DBO race stats ===');
  outLines.Add('target: ' + TARGET_FILE);
  outLines.Add('offset subtracted from H/M/S: ' + IntToStr(OFFSET));
  outLines.Add('');
  Result := 0;
end;

function Process(e: IInterface): integer;
var
  edid, spec: string;
  idx: integer;
  parts: TStringList;
  ovr, data: IInterface;
begin
  Result := 0;
  if not Assigned(target) then Exit;
  if Signature(e) <> 'RACE' then Exit;
  if not IsWinningOverride(e) then Exit;

  edid := GetElementEditValues(e, 'EDID');
  idx := names.IndexOf(edid);
  if idx < 0 then Exit;

  { never copy a record that already lives in the target onto itself }
  if GetFileName(GetFile(e)) = TARGET_FILE then
    ovr := e
  else
    ovr := wbCopyElementToFile(e, target, False, True);

  if not Assigned(ovr) then begin
    outLines.Add(edid + ': COPY FAILED');
    Exit;
  end;

  data := ElementByPath(ovr, 'DATA');
  if not Assigned(data) then begin
    outLines.Add(edid + ': no DATA element, skipped');
    Exit;
  end;

  spec := vals[idx];
  parts := TStringList.Create;
  parts.Delimiter := '|';
  parts.StrictDelimiter := True;
  parts.DelimitedText := spec;

  SetElementEditValues(ovr, 'DATA\Starting Health',   IntToStr(StrToInt(parts[0]) - OFFSET));
  SetElementEditValues(ovr, 'DATA\Starting Magicka',  IntToStr(StrToInt(parts[1]) - OFFSET));
  SetElementEditValues(ovr, 'DATA\Starting Stamina',  IntToStr(StrToInt(parts[2]) - OFFSET));
  SetElementEditValues(ovr, 'DATA\Base Carry Weight', parts[3]);
  SetElementEditValues(ovr, 'DATA\Health Regen',      parts[4]);
  SetElementEditValues(ovr, 'DATA\Magicka Regen',     parts[5]);
  SetElementEditValues(ovr, 'DATA\Stamina Regen',     parts[6]);
  SetElementEditValues(ovr, 'DATA\Unarmed Damage',    parts[7]);

  outLines.Add(edid + ': H=' + GetElementEditValues(ovr, 'DATA\Starting Health') +
    ' M=' + GetElementEditValues(ovr, 'DATA\Starting Magicka') +
    ' S=' + GetElementEditValues(ovr, 'DATA\Starting Stamina') +
    ' carry=' + GetElementEditValues(ovr, 'DATA\Base Carry Weight') +
    ' regen=' + GetElementEditValues(ovr, 'DATA\Health Regen') +
    '/' + GetElementEditValues(ovr, 'DATA\Magicka Regen') +
    '/' + GetElementEditValues(ovr, 'DATA\Stamina Regen') +
    '  unarmed=' + GetElementEditValues(ovr, 'DATA\Unarmed Damage'));

  parts.Free;
  Inc(touched);
end;

function Finalize: integer;
begin
  outLines.Add('');
  outLines.Add('records written: ' + IntToStr(touched) + ' of ' + IntToStr(names.Count));
  outLines.SaveToFile(ScriptsPath + 'DBO_RaceStats.txt');
  outLines.Free;
  names.Free;
  vals.Free;
  Result := 0;
end;

end.
