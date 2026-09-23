{
  Strip the vanilla starting kit off the Player NPC_ record.

  Skyrim.esm:00000007 carries SPLO Flames, Healing, PCHealRateCombat and a CNTO list holding the
  iron weapons, shield, torches, potions, lockpicks, 140 gold and The Book of the Dragonborn. The
  engine applies both client side when it builds the player, which is why an Orc still held Flames
  and Healing after the client stripped every foreign race spell, and why the starting gear appeared
  and then vanished as the server overwrote the inventory with its own.

  Neither can be fixed anywhere else. Papyrus RemoveSpell refuses a spell inherited from the base
  record, and the server's PapyrusActor::RemoveSpell refuses it for the same reason.

  PCHealRateCombat is kept. It is the in-combat health regeneration modifier, not a starting spell.

  usage: tools\run-sseedit-script.ps1 with -script pointing at this file's full path
}
unit DBO_PlayerRecord;

const
  TARGET_FILE = 'DragonBreak Online Edits.esp';
  KEEP_SPELL = 'PCHealRateCombat';

var
  target: IInterface;
  outLines: TStringList;
  done: boolean;

function Initialize: integer;
var
  i: integer;
  f: IInterface;
begin
  outLines := TStringList.Create;
  done := False;

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

  outLines.Add('=== DBO player record ===');
  outLines.Add('target: ' + TARGET_FILE);
  outLines.Add('');
  Result := 0;
end;

function Process(e: IInterface): integer;
var
  ovr, spells, items, entry: IInterface;
  i, removedSpells, removedItems: integer;
  edid, nm: string;
begin
  Result := 0;
  if done then Exit;
  if not Assigned(target) then Exit;
  if Signature(e) <> 'NPC_' then Exit;
  if not IsWinningOverride(e) then Exit;
  if GetElementEditValues(e, 'EDID') <> 'Player' then Exit;

  done := True;

  if GetFileName(GetFile(e)) = TARGET_FILE then
    ovr := e
  else
    ovr := wbCopyElementToFile(e, target, False, True);

  if not Assigned(ovr) then begin
    outLines.Add('Player: COPY FAILED');
    Exit;
  end;

  { The element holding SPLO entries is not named the same in every record definition, so report
    what is actually there rather than assuming a path. }
  outLines.Add('  top level elements:');
  for i := 0 to ElementCount(ovr) - 1 do
    outLines.Add('    [' + IntToStr(i) + '] name="' + Name(ElementByIndex(ovr, i)) +
                 '" sig="' + Signature(ElementByIndex(ovr, i)) + '"');
  outLines.Add('');

  removedSpells := 0;
  spells := ElementByPath(ovr, 'Spells');
  if not Assigned(spells) then spells := ElementByPath(ovr, 'Actor Effects');
  if not Assigned(spells) then spells := ElementByPath(ovr, 'SPLO');

  if Assigned(spells) and (ElementCount(spells) > 0) then begin
    for i := ElementCount(spells) - 1 downto 0 do begin
      entry := ElementByIndex(spells, i);
      nm := GetEditValue(entry);
      if Pos(KEEP_SPELL, nm) > 0 then begin
        outLines.Add('  kept spell: ' + nm);
        Continue;
      end;
      outLines.Add('  removed spell: ' + nm);
      RemoveElement(spells, entry);
      Inc(removedSpells);
    end;
  end else begin
    { no container, so the SPLO entries sit as siblings on the record itself }
    for i := ElementCount(ovr) - 1 downto 0 do begin
      entry := ElementByIndex(ovr, i);
      if Signature(entry) <> 'SPLO' then Continue;
      nm := GetEditValue(entry);
      if Pos(KEEP_SPELL, nm) > 0 then begin
        outLines.Add('  kept spell: ' + nm);
        Continue;
      end;
      outLines.Add('  removed spell (flat): ' + nm);
      RemoveElement(ovr, entry);
      Inc(removedSpells);
    end;
  end;

  removedItems := 0;
  items := ElementByPath(ovr, 'Items');
  if Assigned(items) then begin
    for i := ElementCount(items) - 1 downto 0 do begin
      entry := ElementByIndex(items, i);
      outLines.Add('  removed item: ' + GetEditValue(entry));
      RemoveElement(items, entry);
      Inc(removedItems);
    end;
    { an empty Items list should not be left behind as a zero-count container }
    if ElementCount(items) = 0 then begin
      RemoveElement(ovr, items);
      outLines.Add('  removed the now empty Items list');
    end;
  end else
    outLines.Add('  no Items element found');

  outLines.Add('');
  outLines.Add('spells removed: ' + IntToStr(removedSpells));
  outLines.Add('items removed: ' + IntToStr(removedItems));
  Result := 0;
end;

function Finalize: integer;
begin
  if not done then
    outLines.Add('FATAL: the Player NPC_ record was never reached. Nothing written.');
  outLines.SaveToFile(ScriptsPath + 'DBO_PlayerRecord.txt');
  outLines.Free;
  Result := 0;
end;

end.
