{
  DOL - Scourge, Blessed of Malacath

  Sets stats and builds the enchantment for OrcishClanScourge, which
  DBO_OrcClanVariants creates by copying Immersive Weapons' Mace of Aevar.

  Creates one new record and edits one existing:
    EnchOrcishClanScourge   ENCH  Banish 36 + Absorb Health 15
    OrcishClanScourge       WEAP  stats, name, EITM, EAMT

  ---------------------------------------------------------------------
  LORE (Lore:Scourge, UESP)

  "Mackkan's Hammer, Bane of Daedra, the Daedric Scourge, Scourge Blessed
  of Malacath." Forged from sacred ebony in the Fires of Fickledire. Takes
  the form of a steel or ebony mace. Banishes Daedra to Oblivion with a
  single blow. Its victims are said to be poisoned, and it can summon the
  Daedra it has previously slain to serve the wielder.

  What that maps to:

    ebony mace       -> ebony retexture, ebony damage and weight    DONE
    banish daedra    -> EnchBanishFFContact at 36, the top vanilla   DONE
                        tier (EnchWeaponBanish06's own magnitude)
    victims poisoned -> EnchAbsorbHealthFFContact at 15             DONE
    summons the      -> NOT IMPLEMENTED, deliberately - see below
      daedra it slew

  The summoning is the one power that cannot be built honestly here. It
  needs a custom Summon Creature MGEF plus a bound actor, and Skyrim has
  no probability gate on a weapon enchantment - the effect fires on EVERY
  hit. A mace that spawns a Dremora per swing is not the artifact, it is a
  broken item. Left out rather than approximated badly.

  Absorb Health is an interpretation, not canon: lore says "poisoned", and
  Skyrim has no poison-over-time weapon effect (a scan of the 17
  Ench*FFContact MGEFs in Skyrim.esm finds fire, frost, shock, absorb,
  damage-stamina/magicka, banish, paralysis, soul trap, turn undead - no
  poison). Absorb Health is the nearest, and matches how Bethesda builds a
  Daedric artifact mace: DA10MaceofMolagBal absorbs rather than poisons.

  ---------------------------------------------------------------------
  STATS

  Morrowind and Daggerfall numbers do not transfer - Scourge is worth tens
  of thousands of gold there. Anchored instead to Skyrim's own artifact
  conventions, read from Skyrim.esm:

    DaedricMace          dmg 16  value 1750  weight 20
    EbonyMace            dmg 16  value 1000  weight 19
    DA10MaceofMolagBal   dmg 16  value  210  weight 18  charge 3000
    DA06Volendrung       dmg 25  value  450  weight 26  charge 3000

  Two patterns hold: Skyrim's Daedric artifacts match their tier's base
  damage rather than exceeding it, and they carry LOW gold values because
  they are quest items, not loot. So Scourge is an ebony-tier one-handed
  mace valued at parity with Volendrung, Malacath's other artifact.

  This REPLACES the Mace of Aevar values the record is copied with
  (dmg 17 / value 2500 / weight 18 / speed 0.85).

  ---------------------------------------------------------------------
  Numbers are written as NATIVE values. Edit values render floats as
  '0.800000', so comparing a read-back against FloatToStr(0.80) would
  report a false failure on a write that actually worked.

  EITM and EAMT are Added before being set - setting a subrecord that is
  absent on the record is a silent no-op, which is how an earlier script
  in this project produced 517 records with no model.

  Idempotent: re-running skips the ENCH if it already exists.

  Run: right-click DragonBreak Online Edits.esp -> Apply Script -> DBO_Scourge
}
unit DBOScourge;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  SRC_PLUGIN    = 'Skyrim.esm';

  WEAP_EDID    = 'OrcishClanScourge';
  DISPLAY_NAME = 'Scourge';

  ENCH_SRC  = 'EnchWeaponBanish06';        // one effect, Banish at 36
  ENCH_NEW  = 'EnchOrcishClanScourge';
  ENCH_NAME = 'Bane of Daedra';

  MGEF_BANISH  = $000ACBB5;   // EnchBanishFFContact
  MGEF_ABSORB  = $000AA155;   // EnchAbsorbHealthFFContact
  MAG_BANISH   = 36;          // top vanilla tier
  MAG_ABSORB   = 15;

  DAMAGE      = 16;      // ebony / daedric mace tier
  VALUE       = 450;     // parity with Volendrung
  WEIGHT      = 19.0;    // ebony mace
  SPEED       = 0.80;    // standard mace
  REACH       = 1.00;    // standard mace
  ENCH_CHARGE = 3000;    // matches both Malacath artifacts

var
  slLog: TStringList;
  cSet, cFail: integer;

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

// Set a number, then read it back. A write that silently does nothing is the
// failure mode this project has hit most often, so nothing is assumed.
// Floats are compared with a tolerance because of storage rounding.
procedure SetNum(r: IwbElement; path: string; val: real; caption: string);
var got: real;
begin
  SetElementNativeValues(r, path, val);
  got := GetElementNativeValues(r, path);
  if Abs(got - val) < 0.001 then begin
    slLog.Add('OK    ' + caption + ' = ' + FloatToStr(got));
    Inc(cSet);
  end else begin
    slLog.Add('FAIL  ' + caption + ' (wanted ' + FloatToStr(val) +
              ', got ' + FloatToStr(got) + ')');
    Inc(cFail);
  end;
end;

function Initialize: integer;
var
  fT, fS: IwbFile;
  src, ench, weap: IwbMainRecord;
  effs, eff: IwbElement;
  k: integer;
  bs: string;
begin
  Result := 0; cSet := 0; cFail := 0;
  slLog := TStringList.Create;
  bs := Chr(92);   // literal backslash, kept out of string literals

  fT := FileByName(TARGET_PLUGIN);
  fS := FileByName(SRC_PLUGIN);
  if not Assigned(fT) then begin
    AddMessage('ERROR: ' + TARGET_PLUGIN + ' is not loaded.'); Result := 1; Exit;
  end;
  if not Assigned(fS) then begin
    AddMessage('ERROR: ' + SRC_PLUGIN + ' is not loaded.'); Result := 1; Exit;
  end;

  weap := RecByEDID(fT, 'WEAP', WEAP_EDID);
  if not Assigned(weap) then begin
    AddMessage('ERROR: ' + WEAP_EDID + ' not found. Run DBO_OrcClanVariants first.');
    Result := 1; Exit;
  end;

  // ---------- enchantment ----------
  ench := RecByEDID(fT, 'ENCH', ENCH_NEW);
  if Assigned(ench) then
    slLog.Add('SKIP  ENCH already exists')
  else begin
    src := RecByEDID(fS, 'ENCH', ENCH_SRC);
    if not Assigned(src) then begin
      slLog.Add('FAIL  source ENCH ' + ENCH_SRC + ' not found'); Inc(cFail);
    end else begin
      ench := wbCopyElementToFile(src, fT, True, True);
      if not Assigned(ench) then begin
        slLog.Add('FAIL  could not copy ENCH'); Inc(cFail);
      end else begin
        SetElementEditValues(ench, 'EDID', ENCH_NEW);
        SetElementEditValues(ench, 'FULL', ENCH_NAME);

        effs := ElementByPath(ench, 'Effects');
        if not Assigned(effs) then begin
          slLog.Add('FAIL  ENCH has no Effects array'); Inc(cFail);
        end else begin
          // effect 0 is already Banish at 36; set it explicitly rather
          // than trusting the source record
          eff := ElementByIndex(effs, 0);
          SetElementNativeValues(eff, 'EFID', MGEF_BANISH);
          SetElementNativeValues(eff, 'EFIT' + bs + 'Magnitude', MAG_BANISH);

          eff := ElementAssign(effs, HighInteger, nil, False);
          if not Assigned(eff) then begin
            slLog.Add('FAIL  could not append absorb effect'); Inc(cFail);
          end else begin
            SetElementNativeValues(eff, 'EFID', MGEF_ABSORB);
            SetElementNativeValues(eff, 'EFIT' + bs + 'Magnitude', MAG_ABSORB);
            SetElementNativeValues(eff, 'EFIT' + bs + 'Area', 0);
            SetElementNativeValues(eff, 'EFIT' + bs + 'Duration', 0);
          end;

          if ElementCount(effs) = 2 then begin
            slLog.Add('OK    ENCH ' + ENCH_NEW + '  banish ' +
                      IntToStr(MAG_BANISH) + ' + absorb ' + IntToStr(MAG_ABSORB));
            Inc(cSet);
          end else begin
            slLog.Add('FAIL  ENCH has ' + IntToStr(ElementCount(effs)) +
                      ' effects, expected 2');
            Inc(cFail);
          end;
        end;
      end;
    end;
  end;

  // ---------- stats ----------
  SetElementEditValues(weap, 'FULL', DISPLAY_NAME);
  if GetElementEditValues(weap, 'FULL') = DISPLAY_NAME then begin
    slLog.Add('OK    name = ' + DISPLAY_NAME); Inc(cSet);
  end else begin
    slLog.Add('FAIL  name'); Inc(cFail);
  end;

  SetNum(weap, 'DATA' + bs + 'Damage', DAMAGE, 'damage');
  SetNum(weap, 'DATA' + bs + 'Value',  VALUE,  'value');
  SetNum(weap, 'DATA' + bs + 'Weight', WEIGHT, 'weight');
  SetNum(weap, 'DNAM' + bs + 'Speed',  SPEED,  'speed');
  SetNum(weap, 'DNAM' + bs + 'Reach',  REACH,  'reach');

  // ---------- wire the enchantment ----------
  // Re-look-up rather than reusing the handle from creation: a record made
  // moments ago is not always in xEdit's resolver yet, which shows up as
  // '<Error: Could not be resolved>' on the reference.
  ench := RecByEDID(fT, 'ENCH', ENCH_NEW);
  if not Assigned(ench) then begin
    slLog.Add('FAIL  ENCH missing at wiring stage'); Inc(cFail);
  end else begin
    if not Assigned(ElementByPath(weap, 'EITM')) then Add(weap, 'EITM', True);
    if not Assigned(ElementByPath(weap, 'EAMT')) then Add(weap, 'EAMT', True);
  // Reference fields go through the EDIT value, never the native value.
  // SetElementNativeValues writes raw bytes and skips xEdit's reference
  // mapping, which on a freshly Add()ed subrecord produces the wrong
  // plugin-index byte - it saved as 3A (another master) instead of 3F
  // (this plugin). The local part looks right, so the log looks fine.
    SetElementEditValues(weap, 'EITM', IntToHex(GetLoadOrderFormID(ench), 8));
    SetElementNativeValues(weap, 'EAMT', ENCH_CHARGE);

    if (Pos('Error', GetElementEditValues(weap, 'EITM')) = 0) and
       (Pos(ENCH_NEW, GetElementEditValues(weap, 'EITM')) > 0) then begin
      slLog.Add('OK    enchantment = ' + ENCH_NEW); Inc(cSet);
    end else begin
      slLog.Add('FAIL  enchantment not linked'); Inc(cFail);
    end;
    if GetElementNativeValues(weap, 'EAMT') = ENCH_CHARGE then begin
      slLog.Add('OK    charge = ' + IntToStr(ENCH_CHARGE)); Inc(cSet);
    end else begin
      slLog.Add('FAIL  charge not set'); Inc(cFail);
    end;
  end;

  // ---------- report ----------
  slLog.Add('');
  slLog.Add('EITM renders as  ' + GetElementEditValues(weap, 'EITM'));
  slLog.Add('(an unresolved reference here is usually the resolver lagging');
  slLog.Add(' a same-run record - confirm after saving, not before)');

  AddMessage('');
  AddMessage('=====================================');
  AddMessage('  fields set : ' + IntToStr(cSet));
  AddMessage('  failures   : ' + IntToStr(cFail));
  AddMessage('=====================================');
  for k := 0 to Pred(slLog.Count) do AddMessage('  ' + slLog[k]);
  AddMessage('Review, then Ctrl+S to save.');
  slLog.Free;
end;

end.
