{
  DBO_Blessings - authors the eleven missing shrine-blessing spells into
  "DragonBreak Online Edits.esp" (the conflict layer, which loads last).

  Every blessing is a copy of AltarNocturnalSpell with a new editor id, a new name and one
  swapped magic effect. That template was chosen after dumping both candidates byte for byte:
  a vanilla shrine blessing is a FIRE-AND-FORGET SELF spell whose effect carries an 8 hour
  duration (28800 s) plus CureDiseaseEffect - NOT a constant-effect ability. That is also why
  Meridia is not given a turn-undead: in this shape it would fire once, at the shrine.

  Every magic effect named below already exists in Skyrim.esm, so this script authors no MGEF
  and adds no master: DLE already lists Skyrim.esm. That matters, because a new master would
  shift DLE's self-index (see the memory note on merging into DLE).

  The proof that an alchemy-family effect works inside a shrine spell is vanilla's own
  AltarMaraSpellWHAnvil (WindhelmSSE.esp), which uses AlchFortifySmithing.

  Namira is the one exception to "swap one effect": she keeps FortifySneakFFSelf and her SECOND
  effect becomes NightEyeEffect in place of CureDiseaseEffect. She is the Prince of decay and
  pestilence; a blessing from her curing disease would have been the odd thing.

  Re-running is safe: a blessing whose editor id is already in the target is left alone.

  Result file: DBO_Blessings.txt beside this script.
}
unit DBO_Blessings;

const
  TARGET_FILE = 'DragonBreak Online Edits.esp';
  TEMPLATE    = 'AltarNocturnalSpell';
  DURATION    = 28800;

var
  outLines: TStringList;
  target: IInterface;
  srcSpell: IInterface;
  made: integer;
  askedFor: integer;

function FindSpell(f: IInterface; edid: string): IInterface;
var
  g, rec: IInterface;
  j: integer;
begin
  Result := nil;
  g := GroupBySignature(f, 'SPEL');
  if not Assigned(g) then Exit;
  for j := 0 to ElementCount(g) - 1 do begin
    rec := ElementByIndex(g, j);
    if GetElementEditValues(rec, 'EDID') = edid then begin
      Result := rec;
      Exit;
    end;
  end;
end;

function Describe(rec: IInterface): string;
var
  effs, e: IInterface;
  i: integer;
  s: string;
begin
  s := '';
  effs := ElementByPath(rec, 'Effects');
  if not Assigned(effs) then begin
    Result := '(no effects)';
    Exit;
  end;
  for i := 0 to ElementCount(effs) - 1 do begin
    e := ElementByIndex(effs, i);
    if s <> '' then s := s + '  +  ';
    s := s + GetElementEditValues(e, 'EFID')
         + '  mag ' + GetElementEditValues(e, 'EFIT\Magnitude')
         + '  dur ' + GetElementEditValues(e, 'EFIT\Duration');
  end;
  Result := s;
end;

{ second = 0 leaves the template's CureDiseaseEffect in place }
procedure Build(edid, fullName: string; mgef: cardinal; mag: integer; second: cardinal);
var
  rec, effs, e0, e1: IInterface;
begin
  Inc(askedFor);

  if Assigned(FindSpell(target, edid)) then begin
    outLines.Add(edid + ': already present, left alone');
    Exit;
  end;

  { AsNew = True gives the copy its own FormID in the target file }
  rec := wbCopyElementToFile(srcSpell, target, True, True);
  if not Assigned(rec) then begin
    outLines.Add(edid + ': COPY FAILED');
    Exit;
  end;

  SetElementEditValues(rec, 'EDID', edid);
  SetElementEditValues(rec, 'FULL', fullName);

  effs := ElementByPath(rec, 'Effects');
  if not Assigned(effs) or (ElementCount(effs) < 1) then begin
    outLines.Add(edid + ': the template has no effects, skipped');
    Exit;
  end;

  e0 := ElementByIndex(effs, 0);
  SetElementNativeValues(e0, 'EFID', mgef);
  SetElementNativeValues(e0, 'EFIT\Magnitude', mag);
  SetElementNativeValues(e0, 'EFIT\Duration', DURATION);

  if (second <> 0) and (ElementCount(effs) > 1) then begin
    e1 := ElementByIndex(effs, 1);
    SetElementNativeValues(e1, 'EFID', second);
    SetElementNativeValues(e1, 'EFIT\Magnitude', 0);
    SetElementNativeValues(e1, 'EFIT\Duration', DURATION);
  end;

  outLines.Add(edid + '   ' + IntToHex(GetLoadOrderFormID(rec), 8) + '   "' + fullName + '"');
  outLines.Add('      ' + Describe(rec));
  Inc(made);
end;

function Initialize: integer;
var
  i: integer;
  f: IInterface;
begin
  outLines := TStringList.Create;
  made := 0;
  askedFor := 0;

  target := nil;
  srcSpell := nil;
  for i := 0 to FileCount - 1 do begin
    f := FileByIndex(i);
    if GetFileName(f) = TARGET_FILE then target := f;
    if not Assigned(srcSpell) then srcSpell := FindSpell(f, TEMPLATE);
  end;

  outLines.Add('=== DBO shrine blessings ===');
  outLines.Add('target:   ' + TARGET_FILE);
  outLines.Add('template: ' + TEMPLATE);
  outLines.Add('');

  if not Assigned(target) then begin
    outLines.Add('FATAL: ' + TARGET_FILE + ' is not in the load order. Nothing written.');
    Result := 1;
    Exit;
  end;
  if not Assigned(srcSpell) then begin
    outLines.Add('FATAL: ' + TEMPLATE + ' was not found. Nothing written.');
    Result := 1;
    Exit;
  end;

  outLines.Add('template found in ' + GetFileName(GetFile(srcSpell))
    + ' as ' + IntToHex(GetLoadOrderFormID(srcSpell), 8));
  outLines.Add('  ' + Describe(srcSpell));
  outLines.Add('');

  {      editor id                       in-game name                  magic effect  mag  second }
  Build('DBO_BlessingOfDibella',        'Blessing of Dibella',        $0003EB27, 10, 0);  { AlchFortifyIllusion }
  Build('DBO_BlessingOfZenithar',       'Blessing of Zenithar',       $0003EB01, 50, 0);  { AlchFortifyCarryWeight }
  Build('DBO_BlessingOfTalos',          'Blessing of Talos',          $0003EB1A, 10, 0);  { AlchFortifyTwoHanded }
  Build('DBO_BlessingOfHircine',        'Blessing of Hircine',        $000FB98B, 10, 0);  { FortifyStaminaRateFFSelf }
  Build('DBO_BlessingOfMehrunesDagon',  'Blessing of Mehrunes Dagon', $0003EB26, 10, 0);  { AlchFortifyDestruction }
  Build('DBO_BlessingOfMephala',        'Blessing of Mephala',        $0003EB18, 10, 0);  { AlchFortifyAlchemy }
  Build('DBO_BlessingOfMolagBal',       'Blessing of Molag Bal',      $0003EB25, 10, 0);  { AlchFortifyConjuration }
  Build('DBO_BlessingOfPeryite',        'Blessing of Peryite',        $00090041, 50, 0);  { AlchResistPoison }
  Build('DBO_BlessingOfVaermina',       'Blessing of Vaermina',       $0006B10C,  0, 0);  { NightEyeEffect }
  Build('DBO_BlessingOfMeridia',        'Blessing of Meridia',        $0003EB06, 25, 0);  { AlchFortifyHealRate }
  Build('DBO_BlessingOfNamira',         'Blessing of Namira',         $0010E8AF, 10, $0006B10C);

  Result := 0;
end;

{ Everything runs once in Initialize, off the template. Process must still return 0: a non-zero
  return is how an xEdit script reports failure. }
function Process(e: IInterface): integer;
begin
  Result := 0;
end;

function Finalize: integer;
begin
  outLines.Add('');
  outLines.Add('records created: ' + IntToStr(made) + ' of ' + IntToStr(askedFor));
  outLines.SaveToFile(ScriptsPath + 'DBO_Blessings.txt');
  outLines.Free;
  Result := 0;
end;

end.
