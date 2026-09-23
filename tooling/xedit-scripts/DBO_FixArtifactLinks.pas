{
  DOL - repair the artifact record references

  Fixes three broken FormID references left by DBO_Scourge and
  DBO_MalacathBand. Verified against the SAVED plugin, not a script log:

    OrcishClanScourge            EITM      3A0A0DF9 -> EnchOrcishClanScourge
    ArmorOrcishClanMalacathBand  EITM      3A0A0DF6 -> EnchOrcishClanMalacathBand
    ArmorOrcishClanMalacathBand  armature  0008E83B -> OrcishClanMalacathBandAA

  WHY THEY BROKE

  1. The two EITM writes used SetElementNativeValues on a subrecord that had
     just been created with Add(). NativeValue writes the raw stored bytes and
     skips xEdit's reference mapping, so the plugin-index byte came out as 3A
     (The Great City of Morthal.esp in this file's master list) instead of 3F
     (the plugin itself). The local part - 0A0DF9 / 0A0DF6 - was correct, which
     is why this looked like a working write in the script log.

     SetElementEditValues with an 8-digit hex load-order FormID goes through
     the reference system instead, which is what this script uses.

     Note the earlier WNAM relink in DBO_OrcClanVariants DID survive as
     3F09BCDC. The difference is that WNAM already existed on the copied
     record; EITM had to be Added first.

  2. The armature repoint searched for the EditorID 'RingAA'. JewelryRingGold
     actually uses 'RingGoldAA', so the substring never matched and the ring
     kept pointing at the vanilla gold-band addon - meaning it would have
     rendered as a plain gold ring when worn, with the correct model only on
     the ground. Fixed here by matching on the ARMA signature rather than on
     an EditorID guess.

  Idempotent, and safe to re-run: every write is read back, and the script
  reports what each reference renders as afterwards.

  Run: right-click DragonBreak Online Edits.esp -> Apply Script -> DBO_FixArtifactLinks
}
unit DBOFixArtifactLinks;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';

var
  slLog: TStringList;
  cFixed, cFail: integer;

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

// Set a reference through the EDIT value, not the native value. This is the
// whole point of the script - see the header.
procedure SetRef(rec: IwbElement; path: string; target: IwbMainRecord;
                 caption: string);
var got: string;
begin
  if not Assigned(ElementByPath(rec, path)) then Add(rec, path, True);
  SetElementEditValues(rec, path, IntToHex(GetLoadOrderFormID(target), 8));
  got := GetElementEditValues(rec, path);
  if (Pos('Error', got) = 0) and (Pos(EditorID(target), got) > 0) then begin
    slLog.Add('OK    ' + caption + '  ' + got);
    Inc(cFixed);
  end else begin
    slLog.Add('FAIL  ' + caption + '  ' + got);
    Inc(cFail);
  end;
end;

// The armature is the only ARMA reference an ARMO carries, so matching on the
// signature in the rendered value is safer than guessing an EditorID.
procedure SetArmature(e: IwbElement; target: IwbMainRecord; var done: integer);
var i: integer; v, got: string;
begin
  if ElementCount(e) = 0 then begin
    v := GetEditValue(e);
    if (v <> '') and (Pos('[ARMA:', v) > 0) then begin
      SetEditValue(e, IntToHex(GetLoadOrderFormID(target), 8));
      got := GetEditValue(e);
      if (Pos('Error', got) = 0) and (Pos(EditorID(target), got) > 0) then begin
        slLog.Add('OK    ring armature  ' + got);
        Inc(cFixed);
      end else begin
        slLog.Add('FAIL  ring armature  ' + got);
        Inc(cFail);
      end;
      Inc(done);
    end;
    Exit;
  end;
  for i := Pred(ElementCount(e)) downto 0 do
    SetArmature(ElementByIndex(e, i), target, done);
end;

function Initialize: integer;
var
  f: IwbFile;
  weap, armo, enchS, enchB, arma: IwbMainRecord;
  k, done: integer;
begin
  Result := 0; cFixed := 0; cFail := 0;
  slLog := TStringList.Create;

  f := FileByName(TARGET_PLUGIN);
  if not Assigned(f) then begin
    AddMessage('ERROR: ' + TARGET_PLUGIN + ' is not loaded.'); Result := 1; Exit;
  end;

  weap  := RecByEDID(f, 'WEAP', 'OrcishClanScourge');
  armo  := RecByEDID(f, 'ARMO', 'ArmorOrcishClanMalacathBand');
  enchS := RecByEDID(f, 'ENCH', 'EnchOrcishClanScourge');
  enchB := RecByEDID(f, 'ENCH', 'EnchOrcishClanMalacathBand');
  arma  := RecByEDID(f, 'ARMA', 'OrcishClanMalacathBandAA');

  if not (Assigned(weap) and Assigned(armo) and Assigned(enchS)
          and Assigned(enchB) and Assigned(arma)) then begin
    AddMessage('ERROR: expected records are missing. Run DBO_Scourge and');
    AddMessage('       DBO_MalacathBand first, and save.');
    Result := 1; Exit;
  end;

  SetRef(weap, 'EITM', enchS, 'Scourge enchantment');
  SetRef(armo, 'EITM', enchB, 'ring enchantment');

  done := 0;
  SetArmature(armo, arma, done);
  if done = 0 then begin
    slLog.Add('FAIL  ring armature - no ARMA reference found on the record');
    Inc(cFail);
  end;

  AddMessage('');
  AddMessage('=====================================');
  AddMessage('  references fixed : ' + IntToStr(cFixed));
  AddMessage('  failures         : ' + IntToStr(cFail));
  AddMessage('=====================================');
  for k := 0 to Pred(slLog.Count) do AddMessage('  ' + slLog[k]);
  AddMessage('Ctrl+S, then the references will be re-checked against the file.');
  slLog.Free;
end;

end.
