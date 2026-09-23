{
  DOL - Scourge, two-handed rebuild  (2026-09-12)

  Rebuilds OrcishClanScourge from a one-handed Mace of Aevar copy into a
  two-handed warhammer carrying the lore-accurate Scourge model, and replaces
  its enchantment. Keeps the record's FormID and EditorID, so nothing that
  points at the relic (only its own 1st-person STAT link) changes.

  Edits three existing records, creates none:
    OrcishClanScourge            WEAP  rebuilt from EbonyWarhammer (Skyrim.esm)
    1stPersonOrcishClanScourge   STAT  MODL -> 1st-person Scourge mesh
    EnchOrcishClanScourge        ENCH  Banish+Absorb Health -> Absorb Health + Absorb Stamina

  ---------------------------------------------------------------------
  WHY A REBUILD, NOT AN EDIT

  A one-handed mace record and a two-handed warhammer differ in far more
  than ETYP: animation type, skill, equip slot, sheath node, attack/idle
  sounds, impact data set, keywords, stagger, critical data. Copying every
  subrecord of a vanilla warhammer onto the existing record gets all of
  that right at once; editing fields one by one is how the earlier scripts
  produced records that silently kept the wrong sound set.

  ---------------------------------------------------------------------
  ENCHANTMENT - no Banish, by request

  Banish only fires on Daedra and does nothing to players, so it is gone.
  What replaces it is chosen for PvP:

    Absorb Health   30   lifesteal on a slow heavy hit - the wielder heals
                         on every landed swing, the one thing that keeps a
                         warhammer user alive in a trade
    Absorb Stamina  30   strips the target's power attacks and block; also
                         the closest Skyrim gets to lore's "victims are
                         poisoned" - see DBO_Scourge.pas for that reasoning

  Mace of Molag Bal, the vanilla Daedric mace, runs 25/25 absorb; a
  two-hander swings less often, so 30/30. No auto-calc, fixed cost per hit
  so the charge is predictable: 5000 charge / 120 per hit = ~41 hits.

  ---------------------------------------------------------------------
  STATS

    DaedricWarhammer   dmg 27  value 4000  weight 31  speed 0.6  reach 1.3
    EbonyWarhammer     dmg 26  value 1500  weight 30  speed 0.6  reach 1.3
    DA06Volendrung     dmg 25  value  450  weight 26  speed 0.6  reach 1.3

  Scourge: dmg 28, value 450, weight 26, speed 0.6, reach 1.3.
  28 is one above Daedric - the user asked for legendary, and this sits
  above every vanilla base warhammer while staying inside Skyrim's own
  numbers (Dragonbone is 28). Value and weight are Volendrung parity, the
  other Malacath artifact. Speed is left at the warhammer standard because
  DNAM speed also drives the swing animation rate; a faster hammer looks
  wrong and desyncs the hit frame.

  MagicDisallowEnchanting is added, as on the Band and on 169 vanilla
  unique records.

  Reference fields are written through EDIT values (see DBO_Scourge.pas
  for why native writes produce the wrong plugin-index byte).

  Run: SSEEdit.exe -autoload -script:DBO_Scourge2H.pas -autoexit
   or: right-click DragonBreak Online Edits.esp -> Apply Script
}
unit DBOScourge2H;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  SRC_PLUGIN    = 'Skyrim.esm';

  WEAP_EDID    = 'OrcishClanScourge';
  STAT_EDID    = '1stPersonOrcishClanScourge';
  ENCH_EDID    = 'EnchOrcishClanScourge';
  DISPLAY_NAME = 'Scourge';
  ENCH_NAME    = 'Blessed of Malacath';

  WEAP_SRC     = 'EbonyWarhammer';
  ENCH_REF     = 'EnchWeaponAbsorbHealth06';   // EFIT template for a weapon absorb effect
  MGEF_HEALTH  = 'EnchAbsorbHealthFFContact';
  MGEF_STAMINA = 'EnchAbsorbStaminaFFContact';
  KYWD_NOENCH  = 'MagicDisallowEnchanting';

  MODEL_3P = 'OrcishClan\Weapons\Scourge\truescourge.nif';
  MODEL_1P = 'OrcishClan\Weapons\Scourge\1stpersontruescourge.nif';

  MAG_HEALTH  = 30;
  MAG_STAMINA = 30;
  ENCH_COST   = 120;     // charge drained per hit
  ENCH_CHARGE = 5000;

  DAMAGE = 28;
  VALUE  = 450;
  WEIGHT = 26.0;
  SPEED  = 0.7;    // battleaxe speed, by request (warhammer standard is 0.6) - 2026-09-12
  REACH  = 1.3;

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

procedure Ok(msg: string);   begin slLog.Add('OK    ' + msg); Inc(cSet);  end;
procedure Fail(msg: string); begin slLog.Add('FAIL  ' + msg); Inc(cFail); end;

procedure SetNum(r: IwbElement; path: string; val: real; caption: string);
var got: real;
begin
  SetElementNativeValues(r, path, val);
  got := GetElementNativeValues(r, path);
  if Abs(got - val) < 0.001 then Ok(caption + ' = ' + FloatToStr(got))
  else Fail(caption + ' (wanted ' + FloatToStr(val) + ', got ' + FloatToStr(got) + ')');
end;

procedure SetStr(r: IwbElement; path, val, caption: string);
begin
  SetElementEditValues(r, path, val);
  if GetElementEditValues(r, path) = val then Ok(caption + ' = ' + val)
  else Fail(caption + ' (got ' + GetElementEditValues(r, path) + ')');
end;

// Reference fields: write the load-order FormID as an EDIT value, then check
// that xEdit renders it with the expected EditorID.
procedure SetRef(r: IwbElement; path: string; target: IwbMainRecord; caption: string);
var s: string;
begin
  if not Assigned(ElementByPath(r, path)) then Add(r, path, True);
  SetElementEditValues(r, path, IntToHex(GetLoadOrderFormID(target), 8));
  s := GetElementEditValues(r, path);
  if (Pos('Error', s) = 0) and (Pos(EditorID(target), s) > 0) then Ok(caption + ' -> ' + EditorID(target))
  else Fail(caption + ' renders as ' + s);
end;

function Initialize: integer;
var
  fT, fS: IwbFile;
  weap, stat, ench, src, refEnch, mgefH, mgefS, kw: IwbMainRecord;
  el, effs, eff, kwda, model: IwbElement;
  i, n: integer;
  bs, sig, s: string;
  dur: real;
begin
  Result := 0; cSet := 0; cFail := 0;
  slLog := TStringList.Create;
  bs := Chr(92);

  fT := FileByName(TARGET_PLUGIN);
  fS := FileByName(SRC_PLUGIN);
  if not Assigned(fT) then begin AddMessage('ERROR: ' + TARGET_PLUGIN + ' not loaded'); Result := 1; Exit; end;
  if not Assigned(fS) then begin AddMessage('ERROR: ' + SRC_PLUGIN + ' not loaded'); Result := 1; Exit; end;

  weap    := RecByEDID(fT, 'WEAP', WEAP_EDID);
  stat    := RecByEDID(fT, 'STAT', STAT_EDID);
  ench    := RecByEDID(fT, 'ENCH', ENCH_EDID);
  src     := RecByEDID(fS, 'WEAP', WEAP_SRC);
  refEnch := RecByEDID(fS, 'ENCH', ENCH_REF);
  mgefH   := RecByEDID(fS, 'MGEF', MGEF_HEALTH);
  mgefS   := RecByEDID(fS, 'MGEF', MGEF_STAMINA);
  kw      := RecByEDID(fS, 'KYWD', KYWD_NOENCH);
  if not Assigned(weap)    then begin AddMessage('ERROR: ' + WEAP_EDID + ' not found');  Result := 1; Exit; end;
  if not Assigned(stat)    then begin AddMessage('ERROR: ' + STAT_EDID + ' not found');  Result := 1; Exit; end;
  if not Assigned(ench)    then begin AddMessage('ERROR: ' + ENCH_EDID + ' not found');  Result := 1; Exit; end;
  if not Assigned(src)     then begin AddMessage('ERROR: ' + WEAP_SRC + ' not found');   Result := 1; Exit; end;
  if not Assigned(refEnch) then begin AddMessage('ERROR: ' + ENCH_REF + ' not found');   Result := 1; Exit; end;
  if not Assigned(mgefH)   then begin AddMessage('ERROR: ' + MGEF_HEALTH + ' not found'); Result := 1; Exit; end;
  if not Assigned(mgefS)   then begin AddMessage('ERROR: ' + MGEF_STAMINA + ' not found'); Result := 1; Exit; end;
  if not Assigned(kw)      then begin AddMessage('ERROR: ' + KYWD_NOENCH + ' not found'); Result := 1; Exit; end;

  // ---------- WEAP: strip everything but the header and EDID, then copy the warhammer ----------
  n := 0;
  for i := Pred(ElementCount(weap)) downto 0 do begin
    el := ElementByIndex(weap, i);
    sig := Name(el);
    if (sig = 'Record Header') or (Signature(el) = 'EDID') then Continue;
    RemoveByIndex(weap, i, True);
    Inc(n);
  end;
  slLog.Add('      stripped ' + IntToStr(n) + ' subrecords from ' + WEAP_EDID);

  n := 0;
  for i := 0 to Pred(ElementCount(src)) do begin
    el := ElementByIndex(src, i);
    if (Name(el) = 'Record Header') or (Signature(el) = 'EDID') then Continue;
    if Assigned(wbCopyElementToRecord(el, weap, False, True)) then Inc(n)
    else Fail('could not copy ' + Name(el) + ' from ' + WEAP_SRC);
  end;
  slLog.Add('      copied ' + IntToStr(n) + ' subrecords from ' + WEAP_SRC);
  if GetElementEditValues(weap, 'ETYP') = '' then Fail('ETYP missing after copy')
  else Ok('equip type = ' + GetElementEditValues(weap, 'ETYP'));
  Ok('anim type = ' + GetElementEditValues(weap, 'DNAM' + bs + 'Animation Type'));

  SetStr(weap, 'FULL', DISPLAY_NAME, 'name');

  // model: fresh path, drop the stale MODT hash block the copy brought along
  model := ElementByPath(weap, 'Model');
  if Assigned(model) and Assigned(ElementByPath(model, 'MODT')) then RemoveElement(model, ElementByPath(model, 'MODT'));
  SetStr(weap, 'Model' + bs + 'MODL', MODEL_3P, 'model');

  SetNum(weap, 'DATA' + bs + 'Damage', DAMAGE, 'damage');
  SetNum(weap, 'DATA' + bs + 'Value',  VALUE,  'value');
  SetNum(weap, 'DATA' + bs + 'Weight', WEIGHT, 'weight');
  SetNum(weap, 'DNAM' + bs + 'Speed',  SPEED,  'speed');
  SetNum(weap, 'DNAM' + bs + 'Reach',  REACH,  'reach');

  // keywords: warhammer set from the copy, plus MagicDisallowEnchanting
  kwda := ElementByPath(weap, 'KWDA');
  if not Assigned(kwda) then Fail('no KWDA after copy')
  else begin
    el := ElementAssign(kwda, HighInteger, nil, False);
    SetEditValue(el, IntToHex(GetLoadOrderFormID(kw), 8));
    s := GetEditValue(el);
    if Pos(KYWD_NOENCH, s) > 0 then Ok('keyword +' + KYWD_NOENCH + ' (' + IntToStr(ElementCount(kwda)) + ' total)')
    else Fail('keyword renders as ' + s);
  end;

  SetRef(weap, 'WNAM', stat, '1st-person STAT');
  SetRef(weap, 'EITM', ench, 'enchantment');
  if not Assigned(ElementByPath(weap, 'EAMT')) then Add(weap, 'EAMT', True);
  SetNum(weap, 'EAMT', ENCH_CHARGE, 'charge');

  // ---------- STAT ----------
  model := ElementByPath(stat, 'Model');
  if Assigned(model) and Assigned(ElementByPath(model, 'MODT')) then RemoveElement(model, ElementByPath(model, 'MODT'));
  SetStr(stat, 'Model' + bs + 'MODL', MODEL_1P, '1st-person model');

  // ---------- ENCH ----------
  SetStr(ench, 'FULL', ENCH_NAME, 'ench name');
  effs := ElementByPath(ench, 'Effects');
  if not Assigned(effs) then Fail('ENCH has no Effects')
  else begin
    while ElementCount(effs) > 2 do RemoveByIndex(effs, Pred(ElementCount(effs)), True);
    while ElementCount(effs) < 2 do ElementAssign(effs, HighInteger, nil, False);
    // duration/area pattern from a vanilla weapon absorb enchantment
    dur := GetElementNativeValues(ElementByIndex(ElementByPath(refEnch, 'Effects'), 0), 'EFIT' + bs + 'Duration');

    eff := ElementByIndex(effs, 0);
    SetRef(eff, 'EFID', mgefH, 'effect 0');
    SetNum(eff, 'EFIT' + bs + 'Magnitude', MAG_HEALTH, 'absorb health');
    SetNum(eff, 'EFIT' + bs + 'Area', 0, 'effect 0 area');
    SetNum(eff, 'EFIT' + bs + 'Duration', dur, 'effect 0 duration');

    eff := ElementByIndex(effs, 1);
    SetRef(eff, 'EFID', mgefS, 'effect 1');
    SetNum(eff, 'EFIT' + bs + 'Magnitude', MAG_STAMINA, 'absorb stamina');
    SetNum(eff, 'EFIT' + bs + 'Area', 0, 'effect 1 area');
    SetNum(eff, 'EFIT' + bs + 'Duration', dur, 'effect 1 duration');
  end;
  SetNum(ench, 'ENIT' + bs + 'Enchantment Cost', ENCH_COST, 'ench cost');
  SetNum(ench, 'ENIT' + bs + 'Enchantment Amount', ENCH_CHARGE, 'ench amount');
  // flags take a native bitmask; the edit value is a per-bit character string
  SetElementNativeValues(ench, 'ENIT' + bs + 'Flags', 1);
  if (GetElementNativeValues(ench, 'ENIT' + bs + 'Flags') and 1) = 1 then Ok('ench no-auto-calc')
  else Fail('ench flags = ' + GetElementEditValues(ench, 'ENIT' + bs + 'Flags'));

  // ---------- report ----------
  AddMessage('');
  AddMessage('=====================================');
  AddMessage('  fields set : ' + IntToStr(cSet));
  AddMessage('  failures   : ' + IntToStr(cFail));
  AddMessage('=====================================');
  for i := 0 to Pred(slLog.Count) do AddMessage('  ' + slLog[i]);
  slLog.Insert(0, 'fields set ' + IntToStr(cSet) + '  failures ' + IntToStr(cFail));
  slLog.SaveToFile(ScriptsPath + 'DBO_Scourge2H_result.txt');
  slLog.Free;
end;

end.
