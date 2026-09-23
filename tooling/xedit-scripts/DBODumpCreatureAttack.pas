unit DBODumpCreatureAttack;

var
  outList: TStringList;

function Initialize: integer;
begin
  outList := TStringList.Create;
  Result := 0;
end;

procedure DumpElem(e: IInterface; indent: string; depth: integer);
var
  i: integer;
  c: IInterface;
begin
  if depth > 6 then Exit;
  for i := 0 to ElementCount(e) - 1 do begin
    c := ElementByIndex(e, i);
    outList.Add(indent + Name(c) + ' = ' + GetEditValue(c));
    if ElementCount(c) > 0 then
      DumpElem(c, indent + '  ', depth + 1);
  end;
end;

procedure DumpByEdid(fileName, sig, edid: string);
var
  f, g, r: IInterface;
  i: integer;
  found: boolean;
begin
  f := FileByName(fileName);
  if not Assigned(f) then begin
    outList.Add('### FILE NOT FOUND: ' + fileName);
    Exit;
  end;
  g := GroupBySignature(f, sig);
  if not Assigned(g) then begin
    outList.Add('### GROUP NOT FOUND: ' + fileName + ' ' + sig);
    Exit;
  end;
  found := False;
  for i := 0 to ElementCount(g) - 1 do begin
    r := ElementByIndex(g, i);
    if EditorID(r) = edid then begin
      outList.Add('');
      outList.Add('########## ' + fileName + ' ' + sig + ' ' + edid +
        '  formid=' + IntToHex(GetLoadOrderFormID(r), 8) + ' ##########');
      DumpElem(r, '', 0);
      found := True;
      Break;
    end;
  end;
  if not found then
    outList.Add('### EDID NOT FOUND: ' + fileName + ' ' + sig + ' ' + edid);
end;

function Finalize: integer;
begin
  // Beyond Skyrim ogre
  DumpByEdid('BSHeartland.esm', 'NPC_', 'CYREncOgre01');
  DumpByEdid('BSAssets.esm',    'RACE', 'BSKOgreRace');
  DumpByEdid('BSAssets.esm',    'RACE', 'OgreRace');
  DumpByEdid('BSAssets.esm',    'WEAP', 'BSKOgreClub');
  DumpByEdid('BSAssets.esm',    'WEAP', 'BSKCrOgreClub');

  // Vanilla controls
  DumpByEdid('Skyrim.esm', 'NPC_', 'EncWolf');
  DumpByEdid('Skyrim.esm', 'RACE', 'WolfRace');
  DumpByEdid('Skyrim.esm', 'NPC_', 'EncGiant01');
  DumpByEdid('Skyrim.esm', 'RACE', 'GiantRace');
  DumpByEdid('Skyrim.esm', 'WEAP', 'CrGiantClub');
  DumpByEdid('Skyrim.esm', 'WEAP', 'IronSword');
  DumpByEdid('Skyrim.esm', 'RACE', 'AtronachFlameRace');

  outList.SaveToFile('E:\DragonBreak Online Dev files\SSEEdit 4.1.5f\Edit Scripts\DBODumpCreatureAttack.txt');
  outList.Free;
  Result := 0;
end;

end.
