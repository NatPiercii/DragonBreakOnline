{
  DOL - Orc Clan variants (modded gear)

  Creates Clan variants of the Sentinel orc armour and the Immersive Weapons
  orcish weapons, inside TARGET_PLUGIN.

  For each source record it:
    - copies it as a NEW record (never an override of the source)
    - renames the EditorID so every one contains "OrcishClan"
    - repoints every model path at meshes\OrcishClan\..., the pre-built
      duplicates whose texture paths already point at the recoloured textures
    - strips alternate-texture entries where the source had any
    - relinks ARMO->ARMA and WEAP->1st person STAT onto the new copies

  Because these are new records nothing references them: no leveled list and
  no crafting recipe points at them, so the gear cannot be found in the world
  or crafted until something deliberately adds it.

  Three things this script has to get right, all learned the hard way:

  1. The source plugins MUST be masters of the target before copying, or
     every FormID reference fails with "Load order FileID can not be mapped".
     AddMasterIfMissing is called up front for exactly that reason.

  2. Model filenames are NOT found by signature. The element carrying the
     MOD2/MODL signature is the struct, whose own edit value is empty; the
     path lives on a child. So this walks to the leaves and matches on the
     value ending in .nif instead.

  3. A FormID leaf's edit value reads like "Foo [ARMA:FE00C9C6]", never a
     bare 8-char hex, so relinking matches on the source EditorID appearing
     in that text and then assigns the new FormID natively.

  MESH_PREFIX uses Chr(92) rather than a literal backslash so a trailing
  separator cannot be swallowed in transit.

  Run: right-click TARGET_PLUGIN -> Apply Script -> DBO_OrcClanVariants
}
unit DBOOrcClanVariants;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  MESH_FOLDER   = 'OrcishClan';

var
  slJobs, slMap, slLog: TStringList;
  TargetFile: IwbFile;
  MESH_PREFIX: string;
  cCopied, cFailed, cModels, cAlt, cRelink, cMasters: integer;

//===========================================================================
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

//===========================================================================
// Walk to the leaves and prefix anything that looks like a mesh path.
// Deliberately does not test the signature - see header note 2.
procedure PrefixModels(e: IwbElement);
var i: integer; v: string; c: IwbElement;
begin
  if not Assigned(e) then Exit;
  if ElementCount(e) = 0 then begin
    v := GetEditValue(e);
    if (v <> '') and (Pos('.nif', LowerCase(v)) > 0)
       and (Pos(LowerCase(MESH_PREFIX), LowerCase(v)) = 0) then begin
      SetEditValue(e, MESH_PREFIX + v);
      Inc(cModels);
    end;
    Exit;
  end;
  for i := Pred(ElementCount(e)) downto 0 do begin
    c := ElementByIndex(e, i);
    PrefixModels(c);
  end;
end;

procedure StripAltTextures(e: IwbElement);
var i: integer; sig: string; c: IwbElement;
begin
  if not Assigned(e) then Exit;
  for i := Pred(ElementCount(e)) downto 0 do begin
    c := ElementByIndex(e, i);
    if not Assigned(c) then Continue;
    sig := Signature(c);
    if (sig = 'MODS') or (sig = 'MO2S') or (sig = 'MO3S') or (sig = 'MO4S') or (sig = 'MO5S') then begin
      RemoveElement(e, i); Inc(cAlt);
    end else
      StripAltTextures(c);
  end;
end;

//===========================================================================
function CopyOne(srcPlugin, sig, srcEDID, newEDID: string): IwbMainRecord;
var f: IwbFile; src, dst: IwbMainRecord;
begin
  Result := nil;
  f := FileByName(srcPlugin);
  if not Assigned(f) then begin
    slLog.Add('NO PLUGIN      ' + srcPlugin); Inc(cFailed); Exit;
  end;
  src := RecByEDID(f, sig, srcEDID);
  if not Assigned(src) then begin
    slLog.Add('NOT FOUND      ' + sig + ' ' + srcEDID + ' in ' + srcPlugin);
    Inc(cFailed); Exit;
  end;
  if Assigned(RecByEDID(TargetFile, sig, newEDID)) then begin
    slLog.Add('ALREADY EXISTS ' + newEDID); Exit;
  end;

  dst := wbCopyElementToFile(src, TargetFile, True, True);   // AsNew, DeepCopy
  if not Assigned(dst) then begin
    slLog.Add('COPY FAILED    ' + srcEDID); Inc(cFailed); Exit;
  end;

  SetElementEditValues(dst, 'EDID', newEDID);
  if not SameText(GetElementEditValues(dst, 'EDID'), newEDID) then begin
    slLog.Add('EDID NOT SET   ' + newEDID); Inc(cFailed);
  end;

  StripAltTextures(dst);
  PrefixModels(dst);
  // srcEDID -> new FormID, for the relink pass
  slMap.Add(srcEDID + '=' + IntToHex(FormID(dst), 8));
  Inc(cCopied);
  Result := dst;
end;

//===========================================================================
// Repoint any FormID leaf that still names a source record at its new copy.
procedure Relink(e: IwbElement);
var i, k: integer; c: IwbElement; v, key, hex: string;
begin
  if not Assigned(e) then Exit;
  if ElementCount(e) = 0 then begin
    v := GetEditValue(e);
    if v <> '' then
      for k := 0 to Pred(slMap.Count) do begin
        key := slMap.Names[k];
        if (key <> '') and (Pos(key + ' [', v) > 0) then begin
          hex := slMap.ValueFromIndex[k];
          SetNativeValue(e, StrToInt64('$' + hex));
          Inc(cRelink);
          Exit;
        end;
      end;
    Exit;
  end;
  for i := 0 to Pred(ElementCount(e)) do begin
    c := ElementByIndex(e, i);
    Relink(c);
  end;
end;

//===========================================================================
function Initialize: integer;
var i, k: integer; r: IwbMainRecord; sl: TStringList;
begin
  Result := 0;
  cCopied := 0; cFailed := 0; cModels := 0; cAlt := 0; cRelink := 0; cMasters := 0;
  MESH_PREFIX := MESH_FOLDER + Chr(92);
  slMap := TStringList.Create;
  slLog := TStringList.Create;
  slJobs := TStringList.Create;

  TargetFile := FileByName(TARGET_PLUGIN);
  if not Assigned(TargetFile) then begin
    AddMessage('ERROR: ' + TARGET_PLUGIN + ' is not loaded.');
    Result := 1; Exit;
  end;

  // Masters first, or every cross-plugin reference fails to map.
  if Assigned(FileByName('Sentinel.esp')) then begin
    AddMasterIfMissing(TargetFile, 'Sentinel.esp'); Inc(cMasters);
  end else
    slLog.Add('MISSING PLUGIN Sentinel.esp');
  if Assigned(FileByName('Immersive Weapons.esp')) then begin
    AddMasterIfMissing(TargetFile, 'Immersive Weapons.esp'); Inc(cMasters);
  end else
    slLog.Add('MISSING PLUGIN Immersive Weapons.esp');
  if Assigned(FileByName('Hothtrooper44_ArmorCompilation.esp')) then begin
    AddMasterIfMissing(TargetFile, 'Hothtrooper44_ArmorCompilation.esp'); Inc(cMasters);
  end else
    slLog.Add('MISSING PLUGIN Hothtrooper44_ArmorCompilation.esp');

  // source plugin | signature | source EditorID | new EditorID
  // ARMA first so the ARMO relink pass has copies to point at.
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc0Cuirass_AA|OrcishClanCuirassMediumAA');
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc1Cuirass_AA|OrcishClanCuirassLightAA');
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc1CuirassStudded_AA|OrcishClanCuirassStuddedAA');
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc1Boots_AA|OrcishClanBootsMediumAA');
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc1Gauntlets_AA|OrcishClanGauntletsHeavyAA');
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc1Helmet_AA|OrcishClanHelmetMediumAA');
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc1Helmet_AAa|OrcishClanHelmetMediumAAa');
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc1Helmet_AAk|OrcishClanHelmetMediumAAk');
  slJobs.Add('Sentinel.esp|ARMA|TH_Orc1Helmet_AAo|OrcishClanHelmetMediumAAo');
  slJobs.Add('Sentinel.esp|ARMO|TH_Orc0Cuirass|ArmorOrcishClanCuirassMedium');
  slJobs.Add('Sentinel.esp|ARMO|TH_Orc1Cuirass|ArmorOrcishClanCuirassLight');
  slJobs.Add('Sentinel.esp|ARMO|TH_Orc1CuirassStudded|ArmorOrcishClanCuirassStudded');
  slJobs.Add('Sentinel.esp|ARMO|TH_Orc1Boots|ArmorOrcishClanBootsMedium');
  slJobs.Add('Sentinel.esp|ARMO|TH_Orc1Gauntlets|ArmorOrcishClanGauntletsHeavy');
  slJobs.Add('Sentinel.esp|ARMO|TH_Orc1Helmet|ArmorOrcishClanHelmetMedium');
  slJobs.Add('Immersive Weapons.esp|STAT|IW1stPersonOrcishSabre|1stPersonOrcishClanSabre');
  slJobs.Add('Immersive Weapons.esp|STAT|IW1stPersonOrcishLongsword|1stPersonOrcishClanLongsword');
  slJobs.Add('Immersive Weapons.esp|STAT|IW1stPersonOrcishCripplerSpear|1stPersonOrcishClanCripplerSpear');
  slJobs.Add('Immersive Weapons.esp|WEAP|IWOrcishSaber|OrcishClanSabre');
  slJobs.Add('Immersive Weapons.esp|WEAP|IWOrcishLongsword|OrcishClanLongsword');
  slJobs.Add('Immersive Weapons.esp|WEAP|IWOrcishCripplerSpear|OrcishClanCripplerSpear');
  // Immersive Armors' Orcish Masked Helmet. Its meshes were extracted from
  // Hothtrooper44_Armor_Ecksstra.bsa and re-emitted under meshes\OrcishClan\
  // with the helmet diffuse/normal repointed at the clan textures. FaceMask
  // is left resolving from the BSA - measured 2.84% green, nothing to fix.
  slJobs.Add('Hothtrooper44_ArmorCompilation.esp|ARMA|IAOrcishMaskHelmAA|OrcishClanMaskHelmetAA');
  slJobs.Add('Hothtrooper44_ArmorCompilation.esp|ARMA|IAOrcishMaskHelmArgAA|OrcishClanMaskHelmetArgAA');
  slJobs.Add('Hothtrooper44_ArmorCompilation.esp|ARMA|IAOrcishMaskHelmKhaAA|OrcishClanMaskHelmetKhaAA');
  slJobs.Add('Hothtrooper44_ArmorCompilation.esp|ARMA|IAOrcishMaskHelmOrcAA|OrcishClanMaskHelmetOrcAA');
  slJobs.Add('Hothtrooper44_ArmorCompilation.esp|ARMO|IAOrcishMaskHelm|ArmorOrcishClanMaskHelmet');
  // Orc artifacts that already existed as records - Clan variants only, no new
  // art. The buckler needed no new texture at all: it uses the vanilla orcish
  // shield diffuse, which already has a recoloured clan counterpart.
  slJobs.Add('Immersive Weapons.esp|STAT|IW1stPersonMalacathsCleaverGreatsword|1stPersonOrcishClanMalacathsCleaver');
  slJobs.Add('Immersive Weapons.esp|STAT|IW1stPersonOrsimerChieftanBow|1stPersonOrcishClanOrsimerBow');
  slJobs.Add('Immersive Weapons.esp|WEAP|IWMalacathsCleaverGreatsword|OrcishClanMalacathsCleaver');
  slJobs.Add('Immersive Weapons.esp|WEAP|IWOrsimerChieftanBow|OrcishClanOrsimerChieftanBow');
  slJobs.Add('Hothtrooper44_ArmorCompilation.esp|ARMA|IABucklerOrcishAA|OrcishClanBucklerAA');
  slJobs.Add('Hothtrooper44_ArmorCompilation.esp|ARMO|IABucklerOrcish|ArmorOrcishClanBuckler');
  // Scourge - Malacath's mace, "Bane of Daedra" in Daggerfall and Morrowind.
  // Built on Immersive Weapons' Mace of Aevar mesh, retextured to ebony
  // (lore describes Scourge as ebony). Stats set by DBO_Scourge.pas.
  slJobs.Add('Immersive Weapons.esp|STAT|IW1stPersonAevarStoneSingerMace|1stPersonOrcishClanScourge');
  slJobs.Add('Immersive Weapons.esp|WEAP|IWAevarStoneSingerMace|OrcishClanScourge');

  AddMessage('Masters ensured: ' + IntToStr(cMasters));
  AddMessage('Copying ' + IntToStr(slJobs.Count) + ' records into ' + TARGET_PLUGIN + ' ...');

  for i := 0 to Pred(slJobs.Count) do begin
    sl := TStringList.Create;
    sl.Delimiter := '|';
    sl.StrictDelimiter := True;
    sl.DelimitedText := slJobs[i];
    if sl.Count >= 4 then CopyOne(sl[0], sl[1], sl[2], sl[3]);
    sl.Free;
  end;

  for i := 0 to Pred(slJobs.Count) do begin
    sl := TStringList.Create;
    sl.Delimiter := '|';
    sl.StrictDelimiter := True;
    sl.DelimitedText := slJobs[i];
    if sl.Count >= 4 then begin
      r := RecByEDID(TargetFile, sl[1], sl[3]);
      if Assigned(r) then Relink(r);
    end;
    sl.Free;
  end;

  AddMessage('');
  AddMessage('=====================================');
  AddMessage('  records copied     : ' + IntToStr(cCopied));
  AddMessage('  model paths fixed  : ' + IntToStr(cModels));
  AddMessage('  alt-texture blocks : ' + IntToStr(cAlt));
  AddMessage('  internal relinks   : ' + IntToStr(cRelink));
  AddMessage('  failures           : ' + IntToStr(cFailed));
  AddMessage('=====================================');
  if slLog.Count > 0 then begin
    AddMessage('Problems:');
    for k := 0 to Pred(slLog.Count) do AddMessage('  ' + slLog[k]);
  end;
  AddMessage('Review the records, then Ctrl+S to save.');

  slMap.Free;
  slLog.Free;
  slJobs.Free;
end;

end.
