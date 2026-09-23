{
  DOL - balance Malacath's Cleaver and the Orsimer Chieftain Bow

  The last two relics still carrying Immersive Weapons' own numbers. Sets
  DAMAGE and VALUE only; weight, speed and reach are deliberately left alone.

  ---------------------------------------------------------------------
  THE RULE, and where it comes from

  The set's documented convention is "take the tier's damage, keep the base
  item's value and weight". Artifacts override the value half - Skyrim's own
  Daedric artifacts carry LOW gold because they are quest items, not loot:

    DA06Volendrung        dmg 25  value  450   (= EBONY warhammer damage)
    DA10MaceofMolagBal    dmg 16  value  210   (= ebony/daedric mace damage)
    DLC2BloodskalBlade    dmg 21  value  500   (unique two-hander)
    OrcishClanScourge     dmg 16  value  450   (set by DBO_Scourge)

  So: tier damage, artifact-band value, source weight/speed/reach.

  ---------------------------------------------------------------------
  MALACATH'S CLEAVER      25 / 3400  ->  24 / 500

  Greatsword tiers read from Skyrim.esm and the DLC:
    Orcish 18   Dwarven 19   Elven 20   Glass 21
    Ebony 22    Daedric 24   Dragonbone 25

  It sat at 25 - Dragonbone tier, above anything else in this mod, and at
  3400 gold, nearly eight times Scourge. Dropped to 24: Daedric tier, one
  clear step above the ordinary OrcishClanGreatsword at 22, and capped at a
  weapon the player could obtain anyway.

  Being below OrcishClanWarhammer (25) is correct, not an oversight -
  warhammers out-damage greatswords at every vanilla tier (ebony warhammer
  25 vs ebony greatsword 22).

  Value 500 matches Bloodskal Blade, the closest vanilla analogue: a unique,
  quest-placed two-hander.

  Weight 23 already equals the Daedric greatsword, so it is left as is.
  Speed 0.75 is kept because OrcishClanGreatsword also runs 0.75 - this set
  is deliberately a touch faster than vanilla's 0.70.

  ---------------------------------------------------------------------
  ORSIMER CHIEFTAIN BOW   14 / 400  ->  19 / 450

  Bow tiers:
    Orcish 10   Glass 15   Ebony 17   Daedric 19   Dragonbone 20

  OrcishClanBow is already 17 - ebony damage on orcish weight and speed.
  The relic goes to 19, Daedric tier, keeping the same one-step-above
  relationship the Cleaver has to the Clan greatsword.

  Value 450 for parity with Scourge and Volendrung.

  Weight 13 and speed 0.71 are the source mod's and are KEPT, matching how
  OrcishClanBow keeps orcish weight and speed under ebony damage. Note this
  makes the bow strong - 19 damage at 0.71 draw, where a Daedric bow draws
  at 0.50. That is the set's existing convention applied consistently, not
  an accident; if it plays too hot, speed is the dial to turn, not damage.

  ---------------------------------------------------------------------
  Idempotent - re-running reports ALREADY and changes nothing. Values are
  written natively and read back, because a silent no-op write is the
  failure this project has hit most.

  Run: right-click DragonBreak Online Edits.esp -> Apply Script -> DBO_BalanceRelics
}
unit DBOBalanceRelics;

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
  if not Assigned(f) then Exit;
  g := GroupBySignature(f, sig);
  if not Assigned(g) then Exit;
  for j := 0 to Pred(ElementCount(g)) do begin
    r := ElementByIndex(g, j);
    if not Assigned(r) then Continue;
    if SameText(EditorID(r), edid) then begin Result := r; Exit; end;
  end;
end;

procedure Apply(r: IwbMainRecord; path: string; want: integer;
                edid, caption: string);
var before, after: integer;
begin
  before := GetElementNativeValues(r, path);
  if before = want then begin
    slLog.Add('ALREADY  ' + edid + '  ' + caption + ' ' + IntToStr(want));
    Inc(cSame);
    Exit;
  end;
  SetElementNativeValues(r, path, want);
  after := GetElementNativeValues(r, path);
  if after = want then begin
    slLog.Add('OK       ' + edid + '  ' + caption + ' ' +
              IntToStr(before) + ' -> ' + IntToStr(after));
    Inc(cSet);
  end else begin
    slLog.Add('FAILED   ' + edid + '  ' + caption);
    Inc(cFailed);
  end;
end;

function Initialize: integer;
var
  f: IwbFile; r: IwbMainRecord; sl: TStringList;
  i, k: integer; bs: string;
begin
  Result := 0;
  cSet := 0; cSame := 0; cMissing := 0; cFailed := 0;
  slLog := TStringList.Create;
  slJobs := TStringList.Create;
  bs := Chr(92);

  f := FileByName(TARGET_PLUGIN);
  if not Assigned(f) then begin
    AddMessage('ERROR: ' + TARGET_PLUGIN + ' is not loaded.');
    Result := 1; Exit;
  end;

  // EditorID | damage | value
  slJobs.Add('OrcishClanMalacathsCleaver|24|500');
  slJobs.Add('OrcishClanOrsimerChieftanBow|19|450');

  AddMessage('Balancing the last two relics in ' + TARGET_PLUGIN + ' ...');
  AddMessage('');

  for i := 0 to Pred(slJobs.Count) do begin
    sl := TStringList.Create;
    sl.Delimiter := '|';
    sl.StrictDelimiter := True;
    sl.DelimitedText := slJobs[i];
    if sl.Count >= 3 then begin
      r := RecByEDID(f, 'WEAP', sl[0]);
      if not Assigned(r) then begin
        slLog.Add('NOT FOUND  ' + sl[0]);
        Inc(cMissing);
      end else begin
        Apply(r, 'DATA' + bs + 'Damage', StrToInt(sl[1]), sl[0], 'damage');
        Apply(r, 'DATA' + bs + 'Value',  StrToInt(sl[2]), sl[0], 'value');
      end;
    end;
    sl.Free;
  end;

  AddMessage('=====================================');
  AddMessage('  fields changed     : ' + IntToStr(cSet));
  AddMessage('  already correct    : ' + IntToStr(cSame));
  AddMessage('  records not found  : ' + IntToStr(cMissing));
  AddMessage('  failures           : ' + IntToStr(cFailed));
  AddMessage('=====================================');
  for k := 0 to Pred(slLog.Count) do AddMessage('  ' + slLog[k]);
  AddMessage('Weight, speed and reach were deliberately left unchanged.');
  AddMessage('Review, then Ctrl+S to save.');

  slLog.Free;
  slJobs.Free;
end;

end.
