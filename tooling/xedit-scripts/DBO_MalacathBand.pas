{
  DOL - Malacath's Band of Brutality

  Ports the ESO mythic ring into Skyrim. Creates three records in
  DragonBreak Online Edits.esp:

    EnchOrcishClanMalacathBand    ENCH  +25% One-Handed, +25% Two-Handed
    OrcishClanMalacathBandAA      ARMA  worn model
    ArmorOrcishClanMalacathBand   ARMO  the ring itself

  WHY THESE NUMBERS

  ESO's version reads "Increases your damage done by 16%, reduces your
  Critical Damage done by 50%." Neither half ports literally:

  - 16% is huge in ESO's tight endgame budget. In Skyrim the magnitude of
    Fortify One-Handed IS the percentage, and vanilla rings already run
    13% (EnchArmorFortifyOneHandedBase) to 40% (...OneHanded06). A literal
    16% artifact would be weaker than common loot. Set to 25%, mid vanilla
    tier, on both weapon skills so it serves any orc build.

  - The critical-damage penalty cannot be ported at all. Skyrim has no
    critical-damage actor value; crit is entirely perk-driven, and a scan
    of all 950 MGEF records in Skyrim.esm finds nothing targeting it. Per
    the user's decision the ring carries no downside.

  SOURCE RECORDS

  The worn model is vanilla Ring of Hircine - a carved beast-skull signet
  on a heavy band - retextured to ebony under
  textures\armor\Orcish clan\Artifacts\malacathband*.dds.

  The ARMO is copied from JewelryRingGold, NOT from DA05HircinesRing.
  Hircine's ring carries a VMAD - the Daedric quest's Papyrus script - and
  copying it would drag werewolf quest behaviour onto this ring.
  JewelryRingGold has no VMAD and no EITM, so it is a clean shell.

  MagicDisallowEnchanting matches how Bethesda treats unique gear (169
  vanilla records carry it, e.g. the Nightingale set). It is convention
  rather than protection here - both effects are stock vanilla, so
  disenchanting would teach the player nothing they cannot already learn.

  Idempotent: re-running skips records that already exist.

  Run: right-click DragonBreak Online Edits.esp -> Apply Script -> DBO_MalacathBand
}
unit DBOMalacathBand;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  SRC_PLUGIN    = 'Skyrim.esm';

  ENCH_SRC  = 'EnchArmorFortifyOneHanded03';   // one effect, magnitude 25
  ENCH_NEW  = 'EnchOrcishClanMalacathBand';
  ENCH_NAME = 'Brutality';

  ARMA_SRC  = 'RingofHircineAA';
  ARMA_NEW  = 'OrcishClanMalacathBandAA';

  ARMO_SRC  = 'JewelryRingGold';
  ARMO_NEW  = 'ArmorOrcishClanMalacathBand';
  ARMO_NAME = 'Malacath''s Band of Brutality';

  MGEF_ONEHANDED = $0007A0FF;   // EnchFortifyOneHandedConstantSelf
  MGEF_TWOHANDED = $0007A106;   // EnchFortifyTwoHandedConstantSelf
  MAGNITUDE      = 25;

  KW_NOENCHANT   = $000C27BD;   // MagicDisallowEnchanting

  RING_VALUE  = 400;            // parity with Hircine's Ring
  RING_WEIGHT = 0.25;

var
  slLog: TStringList;
  cMade, cFail, cSkip: integer;
  MESH_WORN, MESH_GROUND: string;

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

// Walk to leaves and replace any value that looks like a mesh path. Matching
// on the '.nif' text rather than on a subrecord signature is deliberate: an
// earlier script in this project matched the signature of the model STRUCT,
// whose own edit value is empty, and silently changed nothing.
procedure SetAllNifs(e: IwbElement; newPath: string);
var i: integer; v: string;
begin
  if ElementCount(e) = 0 then begin
    v := GetEditValue(e);
    if (v <> '') and (Pos('.nif', LowerCase(v)) > 0) then
      SetEditValue(e, newPath);
    Exit;
  end;
  for i := Pred(ElementCount(e)) downto 0 do
    SetAllNifs(ElementByIndex(e, i), newPath);
end;

// Repoint any FormID leaf whose rendered value contains `match`. Edit values
// render as 'RingGoldAA [ARMA:0008E83B]', so `match` can be an EditorID or,
// more safely, a signature fragment like '[ARMA:'.
procedure Repoint(e: IwbElement; srcEDID: string; newFormID: cardinal);
var i: integer; v: string;
begin
  if ElementCount(e) = 0 then begin
    v := GetEditValue(e);
    if (v <> '') and (Pos(srcEDID, v) > 0) then
      SetEditValue(e, IntToHex(newFormID, 8));
    Exit;
  end;
  for i := Pred(ElementCount(e)) downto 0 do
    Repoint(ElementByIndex(e, i), srcEDID, newFormID);
end;

function CopyAsNew(src: IwbMainRecord; tgt: IwbFile; newEDID: string): IwbMainRecord;
begin
  Result := wbCopyElementToFile(src, tgt, True, True);
  if Assigned(Result) then
    SetElementEditValues(Result, 'EDID', newEDID);
end;

function Initialize: integer;
var
  fT, fS: IwbFile;
  src, ench, arma, armo: IwbMainRecord;
  effs, eff, kws, kw: IwbElement;
  k: integer;
  bs: string;
begin
  Result := 0; cMade := 0; cFail := 0; cSkip := 0;
  slLog := TStringList.Create;

  bs := Chr(92);   // literal backslash, kept out of string literals
  MESH_WORN   := 'OrcishClan' + bs + 'Armor' + bs + 'AmuletsandRings' + bs +
                 'ringofhircine.nif';
  MESH_GROUND := 'OrcishClan' + bs + 'Armor' + bs + 'AmuletsandRings' + bs +
                 'ringofhircineGO.nif';

  fT := FileByName(TARGET_PLUGIN);
  fS := FileByName(SRC_PLUGIN);
  if not Assigned(fT) then begin
    AddMessage('ERROR: ' + TARGET_PLUGIN + ' is not loaded.'); Result := 1; Exit;
  end;
  if not Assigned(fS) then begin
    AddMessage('ERROR: ' + SRC_PLUGIN + ' is not loaded.'); Result := 1; Exit;
  end;

  // ---------- ENCH ----------
  ench := RecByEDID(fT, 'ENCH', ENCH_NEW);
  if Assigned(ench) then begin
    slLog.Add('SKIP   ENCH already exists'); Inc(cSkip);
  end else begin
    src := RecByEDID(fS, 'ENCH', ENCH_SRC);
    if not Assigned(src) then begin
      slLog.Add('FAIL   source ENCH ' + ENCH_SRC + ' not found'); Inc(cFail);
    end else begin
      ench := CopyAsNew(src, fT, ENCH_NEW);
      if not Assigned(ench) then begin
        slLog.Add('FAIL   could not copy ENCH'); Inc(cFail);
      end else begin
        SetElementEditValues(ench, 'FULL', ENCH_NAME);

        effs := ElementByName(ench, 'Effects');
        if not Assigned(effs) then
          effs := ElementByPath(ench, 'Effects');

        if not Assigned(effs) then begin
          slLog.Add('FAIL   ENCH has no Effects array'); Inc(cFail);
        end else begin
          // first effect is already Fortify One-Handed at 25; set it
          // explicitly rather than trusting the source
          eff := ElementByIndex(effs, 0);
          SetElementNativeValues(eff, 'EFID', MGEF_ONEHANDED);
          SetElementNativeValues(eff, 'EFIT' + bs + 'Magnitude', MAGNITUDE);

          // append the two-handed effect
          eff := ElementAssign(effs, HighInteger, nil, False);
          if not Assigned(eff) then begin
            slLog.Add('FAIL   could not append 2nd effect'); Inc(cFail);
          end else begin
            SetElementNativeValues(eff, 'EFID', MGEF_TWOHANDED);
            SetElementNativeValues(eff, 'EFIT' + bs + 'Magnitude', MAGNITUDE);
            SetElementNativeValues(eff, 'EFIT' + bs + 'Area', 0);
            SetElementNativeValues(eff, 'EFIT' + bs + 'Duration', 0);
          end;

          if ElementCount(effs) = 2 then begin
            slLog.Add('OK     ENCH ' + ENCH_NEW + '  2 effects @ ' +
                      IntToStr(MAGNITUDE) + '%');
            Inc(cMade);
          end else begin
            slLog.Add('FAIL   ENCH has ' + IntToStr(ElementCount(effs)) +
                      ' effects, expected 2');
            Inc(cFail);
          end;
        end;
      end;
    end;
  end;

  // ---------- ARMA ----------
  arma := RecByEDID(fT, 'ARMA', ARMA_NEW);
  if Assigned(arma) then begin
    slLog.Add('SKIP   ARMA already exists'); Inc(cSkip);
  end else begin
    src := RecByEDID(fS, 'ARMA', ARMA_SRC);
    if not Assigned(src) then begin
      slLog.Add('FAIL   source ARMA ' + ARMA_SRC + ' not found'); Inc(cFail);
    end else begin
      arma := CopyAsNew(src, fT, ARMA_NEW);
      if not Assigned(arma) then begin
        slLog.Add('FAIL   could not copy ARMA'); Inc(cFail);
      end else begin
        SetAllNifs(arma, MESH_WORN);
        slLog.Add('OK     ARMA ' + ARMA_NEW);
        Inc(cMade);
      end;
    end;
  end;

  // ---------- ARMO ----------
  armo := RecByEDID(fT, 'ARMO', ARMO_NEW);
  if Assigned(armo) then begin
    slLog.Add('SKIP   ARMO already exists'); Inc(cSkip);
  end else begin
    src := RecByEDID(fS, 'ARMO', ARMO_SRC);
    if not Assigned(src) then begin
      slLog.Add('FAIL   source ARMO ' + ARMO_SRC + ' not found'); Inc(cFail);
    end else begin
      armo := CopyAsNew(src, fT, ARMO_NEW);
      if not Assigned(armo) then begin
        slLog.Add('FAIL   could not copy ARMO'); Inc(cFail);
      end else begin
        SetElementEditValues(armo, 'FULL', ARMO_NAME);
        SetAllNifs(armo, MESH_GROUND);
        SetElementNativeValues(armo, 'DATA' + bs + 'Value', RING_VALUE);
        SetElementNativeValues(armo, 'DATA' + bs + 'Weight', RING_WEIGHT);

        // Point the armature at our ARMA. Match on the ARMA SIGNATURE,
        // not on an EditorID - the first version of this guessed 'RingAA'
        // but JewelryRingGold actually uses 'RingGoldAA', so it silently
        // matched nothing and the ring kept the vanilla gold-band addon.
        if Assigned(arma) then
          Repoint(armo, '[ARMA:', GetLoadOrderFormID(arma));

        // attach the enchantment - EITM is absent on JewelryRingGold, and
        // setting a missing path is a silent no-op
        if Assigned(ench) then begin
          if not Assigned(ElementByPath(armo, 'EITM')) then
            Add(armo, 'EITM', True);
  // Reference fields go through the EDIT value, never the native value.
  // SetElementNativeValues writes raw bytes and skips xEdit's reference
  // mapping, which on a freshly Add()ed subrecord produces the wrong
  // plugin-index byte - it saved as 3A (another master) instead of 3F
  // (this plugin). The local part looks right, so the log looks fine.
          SetElementEditValues(armo, 'EITM',
                               IntToHex(GetLoadOrderFormID(ench), 8));
        end;

        // MagicDisallowEnchanting - the vanilla convention for unique gear.
        // JewelryRingGold already has a keyword array, so this appends.
        kws := ElementByPath(armo, 'KWDA');
        if Assigned(kws) then begin
          kw := ElementAssign(kws, HighInteger, nil, False);
          if Assigned(kw) then SetNativeValue(kw, KW_NOENCHANT);
        end;
        if Assigned(kws) then
          slLog.Add('       keywords now ' + IntToStr(ElementCount(kws)))
        else
          slLog.Add('       NOTE no KWDA array, disenchant not blocked');

        slLog.Add('OK     ARMO ' + ARMO_NEW);
        Inc(cMade);
      end;
    end;
  end;

  // ---------- verification ----------
  slLog.Add('');
  armo := RecByEDID(fT, 'ARMO', ARMO_NEW);
  if Assigned(armo) then begin
    slLog.Add('name       ' + GetElementEditValues(armo, 'FULL'));
    slLog.Add('ench       ' + GetElementEditValues(armo, 'EITM'));
    slLog.Add('value      ' + GetElementEditValues(armo, 'DATA' + bs + 'Value'));
    slLog.Add('armature   ' + GetElementEditValues(armo, 'Armature'));
  end;
  ench := RecByEDID(fT, 'ENCH', ENCH_NEW);
  if Assigned(ench) then begin
    effs := ElementByPath(ench, 'Effects');
    if Assigned(effs) then
      for k := 0 to Pred(ElementCount(effs)) do
        slLog.Add('effect ' + IntToStr(k) + '   ' +
                  GetElementEditValues(ElementByIndex(effs, k), 'EFID') + '  mag ' +
                  GetElementEditValues(ElementByIndex(effs, k), 'EFIT' + bs + 'Magnitude'));
  end;

  AddMessage('');
  AddMessage('=====================================');
  AddMessage('  records created : ' + IntToStr(cMade));
  AddMessage('  already present : ' + IntToStr(cSkip));
  AddMessage('  failures        : ' + IntToStr(cFail));
  AddMessage('=====================================');
  for k := 0 to Pred(slLog.Count) do AddMessage('  ' + slLog[k]);
  AddMessage('Review, then Ctrl+S to save.');
  slLog.Free;
end;

end.
