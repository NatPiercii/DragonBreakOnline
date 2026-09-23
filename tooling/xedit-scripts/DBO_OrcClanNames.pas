{
  DOL - Orc Clan display names

  Sets FULL - Name on every Clan item so the player can tell clan gear from
  the stock item it was copied from. EditorIDs already all contain "Clan";
  this brings the in-game names into line.

  Rule: if the name has no "Clan" in it already,
          "Orcish <rest>"  ->  "Orcish Clan <rest>"
          anything else    ->  "Clan <name>"
  Records already containing "Clan" are left exactly as they are, so the 11
  you named by hand keep their wording and running this twice is harmless.

  Only ARMO and WEAP are touched - those are the records with a player-facing
  name. ARMA, STAT and TXST have none.

  Run: right-click DragonBreak Online Edits.esp -> Apply Script -> DBO_OrcClanNames
}
unit DBOOrcClanNames;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';

var
  slLog: TStringList;
  cChanged, cAlready, cSkipped, cFailed: integer;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

function ClanName(aOld: string): string;
begin
  if Copy(aOld, 1, 7) = 'Orcish ' then
    Result := 'Orcish Clan ' + Copy(aOld, 8, Length(aOld) - 7)
  else
    Result := 'Clan ' + aOld;
end;

procedure DoGroup(f: IwbFile; sig: string);
var g: IwbGroupRecord; r: IwbElement; j: integer; edid, old, nw: string;
begin
  g := GroupBySignature(f, sig);
  if not Assigned(g) then Exit;
  for j := 0 to Pred(ElementCount(g)) do begin
    r := ElementByIndex(g, j);
    if not Assigned(r) then Continue;
    edid := EditorID(r);
    if Pos('Clan', edid) = 0 then Continue;

    old := GetElementEditValues(r, 'FULL');
    if old = '' then begin
      slLog.Add('NO FULL       ' + edid);
      Inc(cSkipped); Continue;
    end;
    if Pos('Clan', old) > 0 then begin
      Inc(cAlready); Continue;
    end;

    nw := ClanName(old);
    SetElementEditValues(r, 'FULL', nw);
    if GetElementEditValues(r, 'FULL') = nw then begin
      slLog.Add('OK  ' + edid + '   "' + old + '"  ->  "' + nw + '"');
      Inc(cChanged);
    end else begin
      slLog.Add('FULL NOT SET  ' + edid);
      Inc(cFailed);
    end;
  end;
end;

function Initialize: integer;
var f: IwbFile; k: integer;
begin
  Result := 0;
  cChanged := 0; cAlready := 0; cSkipped := 0; cFailed := 0;
  slLog := TStringList.Create;

  f := FileByName(TARGET_PLUGIN);
  if not Assigned(f) then begin
    AddMessage('ERROR: ' + TARGET_PLUGIN + ' is not loaded.');
    Result := 1; Exit;
  end;

  DoGroup(f, 'ARMO');
  DoGroup(f, 'WEAP');

  AddMessage('');
  AddMessage('=====================================');
  AddMessage('  names changed      : ' + IntToStr(cChanged));
  AddMessage('  already said Clan  : ' + IntToStr(cAlready));
  AddMessage('  no FULL to set     : ' + IntToStr(cSkipped));
  AddMessage('  failures           : ' + IntToStr(cFailed));
  AddMessage('=====================================');
  for k := 0 to Pred(slLog.Count) do AddMessage('  ' + slLog[k]);
  AddMessage('Review the names, then Ctrl+S to save.');

  slLog.Free;
end;

end.
