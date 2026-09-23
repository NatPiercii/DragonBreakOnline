{
  DBO_ShrineActivators2 - makes the Daedric shrines Nat placed at the Namira site prayable.

  He placed fifteen statues there on 2026-09-20 as a central test ground. Two of them are
  ACTIVATORS and already work (ShrineOfMalacath, and the vanilla DA09MeridiaStatue). The rest are
  STATICS, and the engine fires no activation on a static - prayer.js never hears about them, so
  they are scenery however good they look.

  This does two things:

  1. Creates a DBO_ShrineOf<Prince> ACTI for each Prince that has no activator yet, cloned from
     DBO_ShrineOfHircine (authored 2026-09-14) and given the SAME MODEL as the statue Nat chose,
     so nothing changes visually.
  2. Repoints his placed references at those activators, so the statue he put there IS the shrine
     rather than something standing next to one.

  Every model already ships with man_DaedricShrines.esp or Skyrim.esm, and DLE already masters
  both, so this adds no master and cannot shift DLE's self-index.

  Hircine, Sanguine and Sheogorath already have DBO activators using those exact meshes, so their
  references are repointed at the existing records rather than duplicating them.

  Re-running is safe: an activator that exists is left alone, and a reference already pointing at
  the right base is left alone.

  Result file: DBO_ShrineActivators2.txt beside this script.
}
unit DBO_ShrineActivators2;

const
  TARGET_FILE = 'DragonBreak Online Edits.esp';
  CLONE_FROM  = 'DBO_ShrineOfHircine';

var
  outLines: TStringList;
  target: IInterface;
  cloneSrc: IInterface;
  actiName: TStringList;    { editor id  -> load order FormID of the activator, as hex }
  refrMap: TStringList;     { local REFR id hex -> activator editor id }
  made, repointed, missed: integer;

function FindRec(f: IInterface; sig, edid: string): IInterface;
var
  g, rec: IInterface;
  j: integer;
begin
  Result := nil;
  g := GroupBySignature(f, sig);
  if not Assigned(g) then Exit;
  for j := 0 to ElementCount(g) - 1 do begin
    rec := ElementByIndex(g, j);
    if GetElementEditValues(rec, 'EDID') = edid then begin
      Result := rec;
      Exit;
    end;
  end;
end;

{ Make the activator if it is not already there, and remember its load order FormID either way. }
procedure Activator(edid, fullName, model: string);
var
  rec: IInterface;
begin
  rec := FindRec(target, 'ACTI', edid);
  if Assigned(rec) then begin
    outLines.Add(edid + ': already present, left alone   ' + IntToHex(GetLoadOrderFormID(rec), 8));
    actiName.Values[edid] := IntToHex(GetLoadOrderFormID(rec), 8);
    Exit;
  end;

  rec := wbCopyElementToFile(cloneSrc, target, True, True);
  if not Assigned(rec) then begin
    outLines.Add(edid + ': COPY FAILED');
    Exit;
  end;
  SetElementEditValues(rec, 'EDID', edid);
  SetElementEditValues(rec, 'FULL', fullName);
  SetElementEditValues(rec, 'Model\MODL', model);
  actiName.Values[edid] := IntToHex(GetLoadOrderFormID(rec), 8);
  outLines.Add(edid + '   ' + IntToHex(GetLoadOrderFormID(rec), 8) + '   "' + fullName + '"   ' + model);
  Inc(made);
end;

procedure Repoint(localHex, edid: string);
begin
  refrMap.Values[Uppercase(localHex)] := edid;
end;

function Initialize: integer;
var
  i: integer;
  f: IInterface;
begin
  outLines := TStringList.Create;
  actiName := TStringList.Create;
  refrMap := TStringList.Create;
  made := 0; repointed := 0; missed := 0;

  target := nil;
  cloneSrc := nil;
  for i := 0 to FileCount - 1 do begin
    f := FileByIndex(i);
    if GetFileName(f) = TARGET_FILE then target := f;
  end;

  outLines.Add('=== DBO Daedric shrine activators, pass 2 ===');
  outLines.Add('target: ' + TARGET_FILE);
  outLines.Add('');

  if not Assigned(target) then begin
    outLines.Add('FATAL: ' + TARGET_FILE + ' is not in the load order. Nothing written.');
    Result := 1;
    Exit;
  end;
  cloneSrc := FindRec(target, 'ACTI', CLONE_FROM);
  if not Assigned(cloneSrc) then begin
    outLines.Add('FATAL: ' + CLONE_FROM + ' not found to clone from. Nothing written.');
    Result := 1;
    Exit;
  end;

  outLines.Add('--- activators ---');
  { the three that already exist, so their FormIDs land in the map }
  Activator('DBO_ShrineOfHircine',       'Shrine of Hircine',        'man_Hircine\hircine.nif');
  Activator('DBO_ShrineOfSanguine',      'Shrine of Sanguine',       'man_sanguine\sanguine.nif');
  Activator('DBO_ShrineOfSheogorath',    'Shrine of Sheogorath',     'man_sheo\sheo.nif');
  { and the ten that do not }
  Activator('DBO_ShrineOfAzura',         'Shrine of Azura',          'man_azura\shrineofazura01.nif');
  Activator('DBO_ShrineOfBoethiah',      'Shrine of Boethiah',       'Clutter\Statues\ShrineOfBoethiah01.nif');
  Activator('DBO_ShrineOfHermaeusMora',  'Shrine of Hermaeus Mora',  'man_mora\mora.nif');
  Activator('DBO_ShrineOfMephala',       'Shrine of Mephala',        'man_mephala\mephala.nif');
  Activator('DBO_ShrineOfMehrunesDagon', 'Shrine of Mehrunes Dagon', 'Clutter\Mehrunes\ShrineMehrunes01.nif');
  Activator('DBO_ShrineOfMolagBal',      'Shrine of Molag Bal',      'man_molag\molag.nif');
  Activator('DBO_ShrineOfNamira',        'Shrine of Namira',         'man_namira\namira.nif');
  Activator('DBO_ShrineOfNocturnal',     'Shrine of Nocturnal',      'man_nocturnal\noct.nif');
  Activator('DBO_ShrineOfPeryite',       'Shrine of Peryite',        'man_peryite\peryite.nif');
  Activator('DBO_ShrineOfVaermina',      'Shrine of Vaermina',       'man_vaermina\vaermina.nif');
  { Clavicus Vile has no statue in the man_ set. The only one in the load order belongs to
    Gray Fox Cowl.esm, which is NOT a master here - but a model is only a path string, so using
    its mesh adds no dependency. That mesh sits in vanilla's Clutter\Statues\ beside the Boethiah
    shrine above, so it is almost certainly Bethesda's own and not the mod's. }
  Activator('DBO_ShrineOfClavicusVile',  'Shrine of Clavicus Vile',  'Clutter\Statues\ClavicusVileShrine01.nif');

  { the references Nat placed, by their local FormID in DLE }
  Repoint('125BCA', 'DBO_ShrineOfHircine');
  Repoint('125BD4', 'DBO_ShrineOfSanguine');
  Repoint('125BD5', 'DBO_ShrineOfSheogorath');
  Repoint('125BC9', 'DBO_ShrineOfAzura');
  Repoint('125BFB', 'DBO_ShrineOfBoethiah');
  Repoint('125BCD', 'DBO_ShrineOfHermaeusMora');
  Repoint('125BCB', 'DBO_ShrineOfMephala');
  Repoint('125BE2', 'DBO_ShrineOfMehrunesDagon');
  Repoint('125BCC', 'DBO_ShrineOfMolagBal');
  Repoint('125BCF', 'DBO_ShrineOfNamira');
  Repoint('125BD2', 'DBO_ShrineOfNocturnal');
  Repoint('125BD3', 'DBO_ShrineOfPeryite');
  Repoint('125BD6', 'DBO_ShrineOfVaermina');

  outLines.Add('');
  outLines.Add('--- references repointed ---');
  Result := 0;
end;

{ xEdit walks every record; the references to repoint are picked out here rather than looked up,
  which avoids depending on RecordByFormID's exact signature. }
function Process(e: IInterface): integer;
var
  localHex, edid, idHex: string;
  wanted: cardinal;
begin
  Result := 0;
  if not Assigned(target) then Exit;
  if Signature(e) <> 'REFR' then Exit;
  if GetFileName(GetFile(e)) <> TARGET_FILE then Exit;

  localHex := IntToHex(FixedFormID(e) and $00FFFFFF, 6);
  edid := refrMap.Values[localHex];
  if edid = '' then Exit;

  idHex := actiName.Values[edid];
  if idHex = '' then begin
    outLines.Add(localHex + ': ' + edid + ' has no activator, left alone');
    Inc(missed);
    Exit;
  end;

  wanted := StrToInt64('$' + idHex);
  if GetElementNativeValues(e, 'NAME') = wanted then begin
    outLines.Add(localHex + ': already points at ' + edid);
    Exit;
  end;

  outLines.Add(localHex + '  ' + GetElementEditValues(e, 'NAME') + '   ->   ' + edid);
  SetElementNativeValues(e, 'NAME', wanted);
  Inc(repointed);
end;

function Finalize: integer;
begin
  outLines.Add('');
  outLines.Add('activators created: ' + IntToStr(made));
  outLines.Add('references repointed: ' + IntToStr(repointed));
  if missed > 0 then outLines.Add('references left alone for want of an activator: ' + IntToStr(missed));
  outLines.SaveToFile(ScriptsPath + 'DBO_ShrineActivators2.txt');
  outLines.Free;
  actiName.Free;
  refrMap.Free;
  Result := 0;
end;

end.
