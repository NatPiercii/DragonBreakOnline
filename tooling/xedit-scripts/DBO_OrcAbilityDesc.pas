{
  Fix the description on DBO_RaceOrc "Orcish Blood".

  DBO_OrcAbility.pas copied RaceBreton and set the effect magnitude to 15, but the SPEL's own DESC came
  along verbatim: "Your Breton blood gives you 25% resistance to magic." That field is what the Active
  Effects panel shows, so an Orc read Breton's text and Breton's number. This rewrites DESC only and
  reports the effect magnitude, so the text is checked against the real value.

  usage: tools\run-sseedit-script.ps1 -Script DBO_OrcAbilityDesc
}
unit DBO_OrcAbilityDesc;

const
  TARGET_FILE = 'DragonBreak Online Edits.esp';
  SPELL_EDID = 'DBO_RaceOrc';
  NEW_DESC = 'Your Orcish blood gives you 15% resistance to magic.';

var
  target, spell: IInterface;
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
  if not Assigned(target) then outLines.Add('FATAL: ' + TARGET_FILE + ' is not in the load order.');
  outLines.Add('=== DBO orc ability description ===');
  Result := 0;
end;

function Process(e: IInterface): integer;
begin
  Result := 0;
  if (Signature(e) = 'SPEL') and (GetElementEditValues(e, 'EDID') = SPELL_EDID)
     and (GetFileName(GetFile(e)) = TARGET_FILE) then
    spell := e;
end;

function Finalize: integer;
var
  effects: IInterface;
  i: integer;
  mag: string;
begin
  if not Assigned(spell) then
    outLines.Add('FATAL: ' + SPELL_EDID + ' not found in ' + TARGET_FILE)
  else begin
    outLines.Add('name: ' + GetElementEditValues(spell, 'FULL'));
    outLines.Add('old DESC: ' + GetElementEditValues(spell, 'DESC'));
    effects := ElementByPath(spell, 'Effects');
    mag := '';
    for i := 0 to ElementCount(effects) - 1 do begin
      mag := GetElementEditValues(ElementByIndex(effects, i), 'EFIT\Magnitude');
      outLines.Add('effect ' + IntToStr(i) + ': ' + GetElementEditValues(ElementByIndex(effects, i), 'EFID') + ' magnitude ' + mag);
    end;
    if (ElementCount(effects) = 1) and (StrToFloat(mag) = 15) then begin
      SetElementEditValues(spell, 'DESC', NEW_DESC);
      outLines.Add('new DESC: ' + GetElementEditValues(spell, 'DESC'));
    end else
      outLines.Add('NOT CHANGED: expected one effect at magnitude 15');
  end;
  outLines.SaveToFile(ScriptsPath + 'DBO_OrcAbilityDesc.txt');
  outLines.Free;
  Result := 0;
end;

end.
