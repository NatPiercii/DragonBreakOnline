{
  DBO_BlacksmithTiers.pas - set armor rating and weapon damage to the approved Blacksmith ladder.

  Nate approved every default in BLACKSMITH_TIERS_PROPOSAL.md except choice 3: Dragonscale beats Ebony outright
  (44/17/17/22/33). The values live in ladder.tsv beside this script - edit that, never this file.

  Edits ARMO DNAM (armor rating, a uint32 holding rating x 100 - verified: ArmorIronCuirass 2500, ArmorDaedricCuirass
  4900) and WEAP DATA damage (a uint16 at offset 8 - verified: IronSword 7, DaedricSword 14). Nothing else.

  Vanilla, DLC and USSEP records are overridden into DragonBreak Online Edits.esp; everything third-party, Creation
  Club included, into DragonBreak Nexus Patches.esp. A mod's own file is never edited.
  Records carrying a script (VMAD) are listed and left alone.

  RUN IT TWICE. DRY_RUN is True below: the first pass changes nothing and writes the full report, including the raw
  and displayed value of every record it would touch. Read the report, confirm the scale and the counts, then set
  DRY_RUN to False and run again.

    SSEEdit64.exe -IKnowWhatImDoing -autoload -script:DBO_BlacksmithTiers.pas -autoexit
    -D:"<dev Data>" -P:"server\plugins.server.txt"

  The -D and -P flags matter: without them Vortex's load order is used instead of the server's
  (memory vortex-rewrites-plugins-txt-while-running). The report is written whether or not the run saves, because a
  headless run that saves nothing must still leave its result behind (memory sseedit-runs-scripts-headless).

  AFTER A REAL PASS, PROVE IT: re-run tools/materials/material_census.py --all and diff against the census taken
  before, with tools/materials/verify_ladder.py. A full xEdit save has silently changed 93 unrelated records before
  (memory xedit-resave-mutates-unrelated-records), so the diff is not optional.
}
unit DBO_BlacksmithTiers;

const
  DRY_RUN     = True;
  LADDER_FILE = 'ladder.tsv';
  RESULT_FILE = 'DBO_BlacksmithTiers_result.txt';
  DLE_NAME    = 'DragonBreak Online Edits.esp';
  NEX_NAME    = 'DragonBreak Nexus Patches.esp';

var
  slKeys, slVals, slReport, slScripted, slUnmatched, slSeen: TStringList;
  fDLE, fNEX: IInterface;
  nEdited, nSameAlready, nScripted, nNoTarget: Integer;

// ---------------------------------------------------------------------------------------------------------------
// The files whose records belong in DragonBreak Online Edits rather than Nexus Patches.
function IsVanillaOrigin(const fn: string): Boolean;
var
  l: string;
begin
  l := LowerCase(fn);
  Result := (l = 'skyrim.esm') or (l = 'update.esm') or (l = 'dawnguard.esm')
         or (l = 'hearthfires.esm') or (l = 'dragonborn.esm')
         or (l = 'unofficial skyrim special edition patch.esp');
end;

function FileByName(const fn: string): IInterface;
var
  i: Integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), fn) then begin
      Result := FileByIndex(i);
      Exit;
    end;
end;

// Substring search from an offset. PosEx is not relied on: only Pos and Copy are.
function PosFrom(const needle, hay: string; start: Integer): Integer;
var
  p: Integer;
begin
  if start < 1 then start := 1;
  p := Pos(needle, Copy(hay, start, Length(hay)));
  if p = 0 then Result := 0 else Result := p + start - 1;
end;

// A simple * wildcard match, enough for CYR*Chainmail*
function Matches(const pat, s: string): Boolean;
var
  i, p: Integer;
  part: string;
  parts: TStringList;
begin
  Result := False;
  parts := TStringList.Create;
  try
    parts.Delimiter := '*';
    parts.StrictDelimiter := True;
    parts.DelimitedText := LowerCase(pat);
    p := 1;
    for i := 0 to Pred(parts.Count) do begin
      part := parts[i];
      if part = '' then Continue;
      p := PosFrom(part, LowerCase(s), p);
      if p = 0 then Exit;
      p := p + Length(part);
    end;
    Result := True;
  finally
    parts.Free;
  end;
end;

// ---------------------------------------------------------------------------------------------------------------
// ladder.tsv: kind <tab> selector <tab> how <tab> slot <tab> value. Stored as kind|selector|slot = value.
procedure LoadLadder;
var
  i: Integer;
  line, kind, sel, how, slot, val: string;
  f: TStringList;
  path: string;
begin
  path := ScriptsPath + LADDER_FILE;
  if not FileExists(path) then
    raise Exception.Create('ladder.tsv not found beside the script at ' + path);
  f := TStringList.Create;
  try
    f.LoadFromFile(path);
    for i := 0 to Pred(f.Count) do begin
      line := Trim(f[i]);
      if (line = '') or (Copy(line, 1, 1) = '#') then Continue;
      kind := Trim(Copy(line, 1, Pos(#9, line) - 1));
      line := Copy(line, Pos(#9, line) + 1, Length(line));
      sel  := Trim(Copy(line, 1, Pos(#9, line) - 1));
      line := Copy(line, Pos(#9, line) + 1, Length(line));
      how  := Trim(Copy(line, 1, Pos(#9, line) - 1));
      line := Copy(line, Pos(#9, line) + 1, Length(line));
      slot := Trim(Copy(line, 1, Pos(#9, line) - 1));
      val  := Trim(Copy(line, Pos(#9, line) + 1, Length(line)));
      slKeys.Add(kind + '|' + sel + '|' + slot);
      slVals.Add(val);
      // remember the selector so an unused one is reported rather than silently ignored
      if slSeen.IndexOf(kind + '|' + sel + '|' + how) < 0 then
        slSeen.Add(kind + '|' + sel + '|' + how);
    end;
  finally
    f.Free;
  end;
  AddMessage(Format('ladder.tsv: %d rules, %d selectors', [slKeys.Count, slSeen.Count]));
end;

// ---------------------------------------------------------------------------------------------------------------
function KeywordList(r: IInterface): TStringList;
var
  kwda, kw: IInterface;
  i: Integer;
  e: string;
begin
  Result := TStringList.Create;
  kwda := ElementBySignature(r, 'KWDA');
  if not Assigned(kwda) then Exit;
  for i := 0 to Pred(ElementCount(kwda)) do begin
    kw := LinksTo(ElementByIndex(kwda, i));
    if not Assigned(kw) then Continue;
    e := EditorID(kw);
    if e <> '' then Result.Add(e);
  end;
end;

function ArmorSlot(r: IInterface): string;
var
  mask: Cardinal;
begin
  Result := '';
  if not ElementExists(r, 'BOD2') then Exit;
  mask := GetElementNativeValues(r, 'BOD2\First Person Flags');
  if (mask and $200) <> 0 then Result := 'shield'         // slot 39
  else if (mask and $4) <> 0 then Result := 'body'        // slot 32
  else if (mask and $8) <> 0 then Result := 'hands'       // slot 33
  else if (mask and $80) <> 0 then Result := 'feet'       // slot 37
  else if ((mask and $1) <> 0) or ((mask and $1000) <> 0) then Result := 'head';  // slot 30 / 42
end;

function WeaponType(r: IInterface; kws: TStringList): string;
var
  a: Integer;
begin
  Result := '';
  a := GetElementNativeValues(r, 'DNAM\Animation Type');
  case a of
    1: Result := 'sword';
    2: Result := 'dagger';
    3: Result := 'waraxe';
    4: Result := 'mace';
    5: Result := 'greatsword';
    // Battleaxe and warhammer share this animation type and need different numbers, so the keyword decides
    6: if kws.IndexOf('WeapTypeWarhammer') >= 0 then Result := 'warhammer' else Result := 'battleaxe';
    7: Result := 'bow';
  end;
end;

// The rule that applies to this record, or '' - and the selector it came from, for the unused-selector report
function RuleFor(const kind, slot: string; kws: TStringList; const edid: string; var usedSel: string): string;
var
  i, j, bar1, bar2: Integer;
  key, pat: string;
begin
  Result := '';
  usedSel := '';
  if slot = '' then Exit;
  // keyword rules first
  for j := 0 to Pred(kws.Count) do begin
    key := kind + '|' + kws[j] + '|' + slot;
    i := slKeys.IndexOf(key);
    if i >= 0 then begin
      Result := slVals[i];
      usedSel := kind + '|' + kws[j] + '|keyword';
      Exit;
    end;
  end;
  // then editor-id patterns: Beyond Skyrim's chainmail carries no material keyword of its own
  for i := 0 to Pred(slKeys.Count) do begin
    key := slKeys[i];
    if Pos('*', key) = 0 then Continue;
    bar1 := Pos('|', key);
    if Copy(key, 1, bar1 - 1) <> kind then Continue;
    bar2 := PosFrom('|', key, bar1 + 1);
    if bar2 = 0 then Continue;
    if Copy(key, bar2 + 1, Length(key)) <> slot then Continue;
    pat := Copy(key, bar1 + 1, bar2 - bar1 - 1);
    if Matches(pat, edid) then begin
      Result := slVals[i];
      usedSel := kind + '|' + pat + '|edid';
      Exit;
    end;
  end;
end;

// ---------------------------------------------------------------------------------------------------------------
function Initialize: Integer;
var
  i, j, k: Integer;
  f, grp, rec, ovr, target: IInterface;
  sig, edid, slot, ruleVal, usedSel, originName, targetName: string;
  kws: TStringList;
  wantRaw, haveRaw: Integer;
  wantF: Double;
begin
  Result := 0;
  slKeys := TStringList.Create;
  slVals := TStringList.Create;
  slReport := TStringList.Create;
  slScripted := TStringList.Create;
  slUnmatched := TStringList.Create;
  slSeen := TStringList.Create;
  nEdited := 0; nSameAlready := 0; nScripted := 0; nNoTarget := 0;

  LoadLadder;
  fDLE := FileByName(DLE_NAME);
  fNEX := FileByName(NEX_NAME);
  if not Assigned(fDLE) then raise Exception.Create(DLE_NAME + ' is not in the load order');
  if not Assigned(fNEX) then raise Exception.Create(NEX_NAME + ' is not in the load order');

  slReport.Add('DBO_BlacksmithTiers, ' + DateToStr(Date) + ' ' + TimeToStr(Time));
  if DRY_RUN then slReport.Add('DRY RUN - nothing was changed') else slReport.Add('LIVE RUN - records were changed');
  slReport.Add('');
  slReport.Add('sig  formid    editorid                             slot/type    from -> to   target');
  slReport.Add('------------------------------------------------------------------------------------------------------------');

  for i := 0 to Pred(FileCount) do begin
    f := FileByIndex(i);
    for k := 0 to 1 do begin
      if k = 0 then sig := 'ARMO' else sig := 'WEAP';
      grp := GroupBySignature(f, sig);
      if not Assigned(grp) then Continue;
      for j := 0 to Pred(ElementCount(grp)) do begin
        rec := ElementByIndex(grp, j);
        if Signature(rec) <> sig then Continue;
        // one pass per record, not one per override
        if not IsWinningOverride(rec) then Continue;

        edid := EditorID(rec);
        kws := KeywordList(rec);
        try
          if sig = 'ARMO' then slot := ArmorSlot(rec) else slot := WeaponType(rec, kws);
          if sig = 'ARMO' then ruleVal := RuleFor('armor', slot, kws, edid, usedSel)
          else ruleVal := RuleFor('weapon', slot, kws, edid, usedSel);
          if ruleVal = '' then Continue;

          if slSeen.IndexOf(usedSel) >= 0 then slSeen.Delete(slSeen.IndexOf(usedSel));

          // A scripted record is listed, never touched: its script may read or set these values itself.
          if ElementExists(rec, 'VMAD') then begin
            Inc(nScripted);
            slScripted.Add(Format('%s  %s  %s  %s  (rule wanted %s)',
              [sig, IntToHex(GetLoadOrderFormID(rec), 8), edid, slot, ruleVal]));
            Continue;
          end;

          originName := GetFileName(GetFile(MasterOrSelf(rec)));
          if SameText(originName, DLE_NAME) then targetName := DLE_NAME
          else if SameText(originName, NEX_NAME) then targetName := NEX_NAME
          else if IsVanillaOrigin(originName) then targetName := DLE_NAME
          else targetName := NEX_NAME;
          if targetName = DLE_NAME then target := fDLE else target := fNEX;

          if sig = 'ARMO' then begin
            haveRaw := GetElementNativeValues(rec, 'DNAM');
            wantF := StrToFloat(ruleVal);
            wantRaw := Round(wantF * 100);
          end else begin
            haveRaw := GetElementNativeValues(rec, 'DATA\Damage');
            wantRaw := StrToInt(ruleVal);
          end;

          if haveRaw = wantRaw then begin
            Inc(nSameAlready);
            Continue;
          end;

          slReport.Add(Format('%-4s %-9s %-36s %-12s %5d -> %-5d %s',
            [sig, IntToHex(GetLoadOrderFormID(rec), 8), Copy(edid, 1, 36), slot, haveRaw, wantRaw, targetName]));

          if not DRY_RUN then begin
            ovr := wbCopyElementToFile(rec, target, False, True);
            if not Assigned(ovr) then begin
              Inc(nNoTarget);
              slUnmatched.Add('could not override into ' + targetName + ': ' + edid);
              Continue;
            end;
            if sig = 'ARMO' then SetElementNativeValues(ovr, 'DNAM', wantRaw)
            else SetElementNativeValues(ovr, 'DATA\Damage', wantRaw);
            // read back, so a silent failure is caught here and not in game
            if sig = 'ARMO' then haveRaw := GetElementNativeValues(ovr, 'DNAM')
            else haveRaw := GetElementNativeValues(ovr, 'DATA\Damage');
            if haveRaw <> wantRaw then
              slUnmatched.Add(Format('write did not stick: %s %s wanted %d got %d',
                [sig, edid, wantRaw, haveRaw]));
          end;
          Inc(nEdited);
        finally
          kws.Free;
        end;
      end;
    end;
  end;
end;

// ---------------------------------------------------------------------------------------------------------------
function Finalize: Integer;
var
  i: Integer;
  path: string;
begin
  Result := 0;
  slReport.Add('');
  if DRY_RUN then slReport.Add(Format('records that would change: %d', [nEdited]))
  else slReport.Add(Format('records changed: %d', [nEdited]));
  slReport.Add(Format('records already at the ladder value, left alone: %d', [nSameAlready]));
  slReport.Add(Format('records carrying a script, listed not edited: %d', [nScripted]));

  slReport.Add('');
  slReport.Add('--- scripted records, for a decision by hand ---');
  if slScripted.Count = 0 then slReport.Add('(none)')
  else for i := 0 to Pred(slScripted.Count) do slReport.Add('  ' + slScripted[i]);

  slReport.Add('');
  slReport.Add('--- selectors in ladder.tsv that matched NOTHING (a typo, or a mod not installed) ---');
  if slSeen.Count = 0 then slReport.Add('(none - every selector matched at least one record)')
  else for i := 0 to Pred(slSeen.Count) do slReport.Add('  ' + slSeen[i]);

  if slUnmatched.Count > 0 then begin
    slReport.Add('');
    slReport.Add('--- PROBLEMS ---');
    for i := 0 to Pred(slUnmatched.Count) do slReport.Add('  ' + slUnmatched[i]);
  end;

  path := ProgramPath + RESULT_FILE;
  slReport.SaveToFile(path);
  AddMessage('wrote ' + path);
  if DRY_RUN then AddMessage(Format('%d record(s) would change, %d already right, %d scripted and skipped',
    [nEdited, nSameAlready, nScripted]))
  else AddMessage(Format('%d record(s) changed, %d already right, %d scripted and skipped',
    [nEdited, nSameAlready, nScripted]));
  if slUnmatched.Count > 0 then AddMessage('PROBLEMS: ' + IntToStr(slUnmatched.Count) + ' - see the result file');
  if slSeen.Count > 0 then AddMessage('WARNING: ' + IntToStr(slSeen.Count) + ' ladder selector(s) matched nothing');

  slKeys.Free; slVals.Free; slReport.Free; slScripted.Free; slUnmatched.Free; slSeen.Free;
end;

end.
