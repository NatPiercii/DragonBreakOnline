{
  DBO_BlacksmithTiers.pas - set armor rating and weapon damage to the approved Blacksmith ladder.

  Nate approved every default in BLACKSMITH_TIERS_PROPOSAL.md except choice 3: Dragonscale beats Ebony outright
  (44/17/17/22/33). The values live in ladder.tsv beside this script - edit that, never this file.

  Edits ARMO DNAM (armor rating, a uint32 holding rating x 100 - verified: ArmorIronCuirass 2500, ArmorDaedricCuirass
  4900) and WEAP DATA damage (a uint16 at offset 8 - verified: IronSword 7, DaedricSword 14).

  Since 2026-09-30 the same run also does the crafting tiers (tools/recipes, beside it in Edit Scripts):
    - stat_clamps.tsv   tier 4 gear above the tier 4 ceiling comes down to it and tier 5 gear below the tier 5 floor goes
                        up to it, per slot and weight class (Nate: "tier 5 needs to be better"), after the ladder
    - manuals.tsv       one inert marker SPEL (a copy of DBO_Skill_cook_T1) and one BOOK (a copy of
                        DBO_RecipeRevivePotion) per smithing manual, created in DragonBreak Online Edits.esp; the book text
                        is manuals\<manual>.txt
    - recipe_tiers.tsv  every Cook and Blacksmith recipe loses its vanilla HasPerk conditions and gains HasSpell(tier
                        marker) == 1 and, for a forge recipe of a material with a manual, HasSpell(manual marker) == 1.
                        A recipe whose HasPerk sits in an OR group with another condition is listed, never edited.

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
  before, with tools/materials/verify_ladder.py; and tools/recipes/recipe_census.py before and after, with
  tools/recipes/verify_recipes.py. A full xEdit save has silently changed 93 unrelated records before
  (memory xedit-resave-mutates-unrelated-records), so the diff is not optional.
}
unit DBO_BlacksmithTiers;

const
  DRY_RUN     = True;
  LADDER_FILE = 'ladder.tsv';
  RESULT_FILE = 'DBO_BlacksmithTiers_result.txt';
  DLE_NAME    = 'DragonBreak Online Edits.esp';
  NEX_NAME    = 'DragonBreak Nexus Patches.esp';
  CLAMP_FILE  = 'stat_clamps.tsv';
  MANUAL_FILE = 'manuals.tsv';
  RECIPE_FILE = 'recipe_tiers.tsv';
  MANUAL_DIR  = 'manuals\';
  MARKER_TEMPLATE = 'DBO_Skill_cook_T1';        // an inert marker SPEL in DragonBreak Online Edits
  BOOK_TEMPLATE   = 'DBO_RecipeRevivePotion';   // the Draught of Revival's recipe book: no skill, no script
  BOOK_LOOK       = 'Book3ValuableForgeHammerAndAnvil';  // Skyrim.esm: the manuals look like the book they quote
  BOOK_MODEL      = 'Clutter\Books\BasicBook07a.nif';

var
  slKeys, slVals, slReport, slScripted, slUnmatched, slSeen: TStringList;
  slClampKeys, slClampVals, slRecKeys, slRecVals, slRecUsed, slRefused, slManReport: TStringList;
  fDLE, fNEX: IInterface;
  nEdited, nSameAlready, nScripted, nNoTarget, nClamped: Integer;
  nRecEdited, nRecSame, nRecScripted, nManMade, nManSame: Integer;
  nexNeedsDLE: Boolean;

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

// A line split on tabs. Only Pos and Copy, as elsewhere in this script.
procedure SplitTabs(const line: string; parts: TStringList);
var
  rest: string;
  p: Integer;
begin
  parts.Clear;
  rest := line;
  p := Pos(#9, rest);
  while p > 0 do begin
    parts.Add(Trim(Copy(rest, 1, p - 1)));
    rest := Copy(rest, p + 1, Length(rest));
    p := Pos(#9, rest);
  end;
  parts.Add(Trim(rest));
end;

// Where a record was first defined, as the CT 115 tables name it: origin plugin (lower case) | local form id (6 hex)
function RecKey(rec: IInterface): string;
var
  m: IInterface;
begin
  m := MasterOrSelf(rec);
  Result := LowerCase(GetFileName(GetFile(m))) + '|' + IntToHex(FormID(m) and $FFFFFF, 6);
end;

// A table beside the script, comment lines skipped, into keys (origin|localid from columns ki, ki+1) and whole lines
procedure LoadKeyed(const fn: string; ki: Integer; keys, vals: TStringList);
var
  f, parts: TStringList;
  i: Integer;
  line: string;
begin
  if not FileExists(ScriptsPath + fn) then
    raise Exception.Create(fn + ' not found beside the script at ' + ScriptsPath + fn);
  f := TStringList.Create;
  parts := TStringList.Create;
  try
    f.LoadFromFile(ScriptsPath + fn);
    for i := 0 to Pred(f.Count) do begin
      line := f[i];
      if (Trim(line) = '') or (Copy(line, 1, 1) = '#') then Continue;
      SplitTabs(line, parts);
      keys.Add(LowerCase(parts[ki]) + '|' + UpperCase(parts[ki + 1]));
      vals.Add(line);
    end;
  finally
    f.Free;
    parts.Free;
  end;
  AddMessage(Format('%s: %d rows', [fn, keys.Count]));
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
// The smithing manuals: one inert marker SPEL and one BOOK each, in DragonBreak Online Edits (manuals.tsv)
function IfNew(existing: Boolean): string;
begin
  if existing then Result := '  (text or value updated)' else Result := '  (new)';
end;

function IfManual(const m: string): string;
begin
  if m = '-' then Result := '' else Result := ' + ' + m;
end;

function DleRecord(const sig, edid: string): IInterface;
begin
  Result := MainRecordByEditorID(GroupBySignature(fDLE, sig), edid);
end;

function ReadText(const fn: string): string;
var
  f: TStringList;
begin
  Result := '';
  if not FileExists(ScriptsPath + fn) then Exit;
  f := TStringList.Create;
  try
    f.LoadFromFile(ScriptsPath + fn);
    Result := Trim(f.Text);
  finally
    f.Free;
  end;
end;

procedure DoManuals;
var
  f, parts: TStringList;
  i: Integer;
  line, text: string;
  tmplS, tmplB, look, spel, book, e: IInterface;
begin
  tmplS := DleRecord('SPEL', MARKER_TEMPLATE);
  tmplB := DleRecord('BOOK', BOOK_TEMPLATE);
  look := MainRecordByEditorID(GroupBySignature(FileByName('Skyrim.esm'), 'BOOK'), BOOK_LOOK);
  if not Assigned(tmplS) then raise Exception.Create(MARKER_TEMPLATE + ' not found in ' + DLE_NAME);
  if not Assigned(tmplB) then raise Exception.Create(BOOK_TEMPLATE + ' not found in ' + DLE_NAME);
  if not Assigned(look) then raise Exception.Create(BOOK_LOOK + ' not found in Skyrim.esm');
  if not FileExists(ScriptsPath + MANUAL_FILE) then raise Exception.Create(MANUAL_FILE + ' not found beside the script');
  f := TStringList.Create;
  parts := TStringList.Create;
  try
    f.LoadFromFile(ScriptsPath + MANUAL_FILE);
    for i := 0 to Pred(f.Count) do begin
      line := f[i];
      if (Trim(line) = '') or (Copy(line, 1, 1) = '#') then Continue;
      // manual, marker, book, title, lowest tier, value, source
      SplitTabs(line, parts);
      text := ReadText(MANUAL_DIR + parts[0] + '.txt');
      if text = '' then begin
        slUnmatched.Add('no text for manual ' + parts[0] + ' (' + MANUAL_DIR + parts[0] + '.txt)');
        Continue;
      end;
      spel := DleRecord('SPEL', parts[1]);
      book := DleRecord('BOOK', parts[2]);
      if Assigned(spel) and Assigned(book) then
        if (GetElementEditValues(book, 'FULL') = parts[3]) and (Trim(GetElementEditValues(book, 'DESC')) = text)
           and (GetElementEditValues(book, 'DATA\Value') = parts[5]) and (GetElementNativeValues(book, 'DATA\Flags') = 0) then begin
          Inc(nManSame);
          Continue;
        end;
      slManReport.Add(Format('%-15s %-26s %-30s %s%s', [parts[0], parts[1], parts[2], parts[3],
        IfNew(Assigned(spel) and Assigned(book))]));
      Inc(nManMade);
      if DRY_RUN then Continue;
      if not Assigned(spel) then begin
        spel := wbCopyElementToFile(tmplS, fDLE, True, True);
        SetElementEditValues(spel, 'EDID', parts[1]);
      end;
      SetElementEditValues(spel, 'FULL', 'Manual: ' + parts[3]);
      if not Assigned(book) then begin
        book := wbCopyElementToFile(tmplB, fDLE, True, True);
        SetElementEditValues(book, 'EDID', parts[2]);
        // the look of the book Thorbald's notes are printed in: model and inventory art
        SetElementEditValues(book, 'Model\MODL', BOOK_MODEL);
        e := ElementByPath(book, 'Model\MODT');
        if Assigned(e) then Remove(e);
        SetEditValue(ElementBySignature(book, 'INAM'), GetEditValue(ElementBySignature(look, 'INAM')));
      end;
      SetElementEditValues(book, 'FULL', parts[3]);
      SetElementEditValues(book, 'DESC', text);
      SetElementEditValues(book, 'DATA\Value', parts[5]);
      // DATA flags 0: no Teaches Skill, no Can't be Taken, and above all no Teaches Spell (0x04), which would let the
      // engine add the marker and eat the book on a read the server did not block, around the tier gate
      SetElementNativeValues(book, 'DATA\Flags', 0);
      // read back
      if (EditorID(spel) <> parts[1]) or (EditorID(book) <> parts[2]) or (GetElementEditValues(book, 'FULL') <> parts[3]) then
        slUnmatched.Add('manual ' + parts[0] + ': the new records did not take their editor ids or title');
      if GetElementNativeValues(book, 'DATA\Flags') <> 0 then
        slUnmatched.Add('manual ' + parts[0] + ': the book''s DATA flags are not 0 (Teaches Spell would bypass the tier gate)');
    end;
  finally
    f.Free;
    parts.Free;
  end;
end;

// ---------------------------------------------------------------------------------------------------------------
// The recipes: HasPerk out, HasSpell(tier marker) and HasSpell(manual marker) in (recipe_tiers.tsv)
// The editor id a condition's first parameter points at, or '' when it points at no record. Every caller may reach
// here for any condition: this script does not rely on "and" stopping early.
function ParamEdid(c: IInterface): string;
var
  r: IInterface;
begin
  Result := '';
  r := LinksTo(ElementByPath(c, 'CTDA\Parameter #1'));
  if Assigned(r) then Result := EditorID(r);
end;

function IsDboMarker(c: IInterface): Boolean;
var
  e: string;
begin
  Result := False;
  if GetElementEditValues(c, 'CTDA\Function') <> 'HasSpell' then Exit;
  e := ParamEdid(c);
  Result := (Copy(e, 1, 10) = 'DBO_Skill_') or (Copy(e, 1, 11) = 'DBO_Manual_');
end;

function HasMarker(conds: IInterface; const edid: string): Boolean;
var
  j: Integer;
  c: IInterface;
begin
  Result := False;
  for j := 0 to Pred(ElementCount(conds)) do begin
    c := ElementByIndex(conds, j);
    if (GetElementEditValues(c, 'CTDA\Function') = 'HasSpell') and (ParamEdid(c) = edid)
       and ((GetElementNativeValues(c, 'CTDA\Type') and 1) = 0)
       and (GetElementNativeValues(c, 'CTDA\Comparison Value') = 1) then begin
      Result := True;
      Exit;
    end;
  end;
end;

// A HasPerk that shares an OR group with anything but another HasPerk: removing it would change what the rest means
function MixedPerkGroup(conds: IInterface): Boolean;
var
  j: Integer;
  c: IInterface;
  inGroup, sawPerk, sawOther: Boolean;
begin
  Result := False;
  inGroup := False; sawPerk := False; sawOther := False;
  for j := 0 to Pred(ElementCount(conds)) do begin
    c := ElementByIndex(conds, j);
    if not inGroup then begin sawPerk := False; sawOther := False; end;
    if GetElementEditValues(c, 'CTDA\Function') = 'HasPerk' then sawPerk := True else sawOther := True;
    inGroup := (GetElementNativeValues(c, 'CTDA\Type') and 1) <> 0;   // the OR flag binds the next condition
    if (not inGroup) and sawPerk and sawOther then begin
      Result := True;
      Exit;
    end;
  end;
  if sawPerk and sawOther then Result := True;
end;

procedure AddHasSpell(rec, marker: IInterface);
var
  conds, c: IInterface;
begin
  conds := ElementByPath(rec, 'Conditions');
  if not Assigned(conds) then begin
    Add(rec, 'Conditions', True);
    conds := ElementByPath(rec, 'Conditions');
    c := ElementByIndex(conds, 0);
  end else
    c := ElementAssign(conds, HighInteger, nil, False);
  SetElementEditValues(c, 'CTDA\Function', 'HasSpell');
  SetElementEditValues(c, 'CTDA\Parameter #1', IntToHex(GetLoadOrderFormID(marker), 8));
  SetElementEditValues(c, 'CTDA\Type', '10000000');      // Equal to, no OR
  SetElementEditValues(c, 'CTDA\Comparison Value', '1');
  SetElementEditValues(c, 'CTDA\Run On', 'Subject');
end;

procedure DoRecipes;
var
  i, j, k, idx, nPerk, nNew: Integer;
  f, grp, rec, ovr, conds, c, target, tierM, manM: IInterface;
  parts: TStringList;
  key, targetName, originName, pe: string;
  ok: Boolean;
begin
  parts := TStringList.Create;
  try
    for i := 0 to Pred(FileCount) do begin
      f := FileByIndex(i);
      grp := GroupBySignature(f, 'COBJ');
      if not Assigned(grp) then Continue;
      for j := 0 to Pred(ElementCount(grp)) do begin
        rec := ElementByIndex(grp, j);
        if Signature(rec) <> 'COBJ' then Continue;
        if not IsWinningOverride(rec) then Continue;
        key := RecKey(rec);
        idx := slRecKeys.IndexOf(key);
        if idx < 0 then Continue;
        slRecUsed.Add(key);
        // origin, local id, recipe editor id, tier marker, manual marker (or -)
        SplitTabs(slRecVals[idx], parts);
        if not SameText(EditorID(rec), parts[2]) then begin
          slUnmatched.Add(Format('recipe_tiers.tsv names %s for %s, the record is %s: left alone', [parts[2], key, EditorID(rec)]));
          Continue;
        end;
        if ElementExists(rec, 'VMAD') then begin
          Inc(nRecScripted);
          slScripted.Add('COBJ  ' + IntToHex(GetLoadOrderFormID(rec), 8) + '  ' + parts[2]);
          Continue;
        end;
        conds := ElementByPath(rec, 'Conditions');
        nPerk := 0;
        ok := Assigned(conds);
        if Assigned(conds) then begin
          if MixedPerkGroup(conds) then begin
            slRefused.Add(IntToHex(GetLoadOrderFormID(rec), 8) + '  ' + parts[2] + '  (a HasPerk shares an OR group with another condition)');
            Continue;
          end;
          for k := 0 to Pred(ElementCount(conds)) do begin
            c := ElementByIndex(conds, k);
            if GetElementEditValues(c, 'CTDA\Function') = 'HasPerk' then Inc(nPerk)
            else if IsDboMarker(c) then begin
              pe := ParamEdid(c);
              if not (SameText(pe, parts[3]) or SameText(pe, parts[4])) then ok := False;
            end;
          end;
          ok := ok and (nPerk = 0) and HasMarker(conds, parts[3]) and ((parts[4] = '-') or HasMarker(conds, parts[4]));
        end;
        if ok then begin
          Inc(nRecSame);
          Continue;
        end;
        originName := GetFileName(GetFile(MasterOrSelf(rec)));
        if SameText(originName, DLE_NAME) then targetName := DLE_NAME
        else if SameText(originName, NEX_NAME) then targetName := NEX_NAME
        else if IsVanillaOrigin(originName) then targetName := DLE_NAME
        else targetName := NEX_NAME;
        if targetName = DLE_NAME then target := fDLE else target := fNEX;
        slReport.Add(Format('COBJ %-9s %-40s %d perk(s) out, %s%s  %s',
          [IntToHex(GetLoadOrderFormID(rec), 8), Copy(parts[2], 1, 40), nPerk, parts[3], IfManual(parts[4]), targetName]));
        Inc(nRecEdited);
        if DRY_RUN then Continue;
        tierM := DleRecord('SPEL', parts[3]);
        manM := nil;
        if parts[4] <> '-' then manM := DleRecord('SPEL', parts[4]);
        if (not Assigned(tierM)) or ((parts[4] <> '-') and not Assigned(manM)) then begin
          slUnmatched.Add('marker missing for ' + parts[2] + ': ' + parts[3] + ' / ' + parts[4]);
          Continue;
        end;
        if Equals(GetFile(rec), target) then ovr := rec
        else ovr := wbCopyElementToFile(rec, target, False, True);
        if not Assigned(ovr) then begin
          slUnmatched.Add('could not override into ' + targetName + ': ' + parts[2]);
          Continue;
        end;
        // the new gates go in first, so the list is never left empty; then the vanilla perks and any older marker
        // go (the two just added are the last ElementCount entries and are skipped)
        AddHasSpell(ovr, tierM);
        nNew := 1;
        if Assigned(manM) then begin
          AddHasSpell(ovr, manM);
          nNew := 2;
        end;
        conds := ElementByPath(ovr, 'Conditions');
        for k := Pred(ElementCount(conds) - nNew) downto 0 do begin
          c := ElementByIndex(conds, k);
          if (GetElementEditValues(c, 'CTDA\Function') = 'HasPerk') or IsDboMarker(c) then Remove(c);
        end;
        // read back
        conds := ElementByPath(ovr, 'Conditions');
        nPerk := 0;
        for k := 0 to Pred(ElementCount(conds)) do
          if GetElementEditValues(ElementByIndex(conds, k), 'CTDA\Function') = 'HasPerk' then Inc(nPerk);
        if (nPerk > 0) or not HasMarker(conds, parts[3]) or ((parts[4] <> '-') and not HasMarker(conds, parts[4])) then
          slUnmatched.Add('recipe gates did not stick: ' + parts[2]);
        // the condition just before the new ones must not carry an OR into them
        k := ElementCount(conds) - nNew - 1;
        if (k >= 0) and ((GetElementNativeValues(ElementByIndex(conds, k), 'CTDA\Type') and 1) <> 0) then
          slUnmatched.Add('an OR runs into the new gates: ' + parts[2]);
      end;
    end;
  finally
    parts.Free;
  end;
end;

// "11.5" -> 1150, whatever the PC's decimal separator (StrToFloat would read "11.5" as an error on a comma locale)
function Hundredths(const v: string): Integer;
var
  p: Integer;
  frac: string;
begin
  p := Pos('.', v);
  if p = 0 then begin
    Result := StrToInt(Trim(v)) * 100;
    Exit;
  end;
  frac := Copy(Trim(Copy(v, p + 1, Length(v))) + '00', 1, 2);
  Result := StrToInt(Trim(Copy(v, 1, p - 1))) * 100 + StrToInt(frac);
end;

function IfClamp(b: Boolean): string;
begin
  if b then Result := '  (tier 4/5 clamp)' else Result := '';
end;

// ---------------------------------------------------------------------------------------------------------------
function Initialize: Integer;
var
  i, j, k: Integer;
  f, grp, rec, ovr, target: IInterface;
  sig, edid, slot, ruleVal, usedSel, originName, targetName: string;
  kws, parts: TStringList;
  wantRaw, haveRaw, clampIdx: Integer;
  usedClamp: Boolean;
begin
  Result := 0;
  parts := TStringList.Create;
  slKeys := TStringList.Create;
  slVals := TStringList.Create;
  slReport := TStringList.Create;
  slScripted := TStringList.Create;
  slUnmatched := TStringList.Create;
  slSeen := TStringList.Create;
  slClampKeys := TStringList.Create; slClampVals := TStringList.Create;
  slRecKeys := TStringList.Create; slRecVals := TStringList.Create; slRecUsed := TStringList.Create;
  slRefused := TStringList.Create; slManReport := TStringList.Create;
  nEdited := 0; nSameAlready := 0; nScripted := 0; nNoTarget := 0; nClamped := 0;
  nRecEdited := 0; nRecSame := 0; nRecScripted := 0; nManMade := 0; nManSame := 0;
  nexNeedsDLE := False;

  LoadLadder;
  LoadKeyed(CLAMP_FILE, 1, slClampKeys, slClampVals);
  LoadKeyed(RECIPE_FILE, 0, slRecKeys, slRecVals);
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
        usedClamp := False;
        usedSel := '';
        try
          if sig = 'ARMO' then slot := ArmorSlot(rec) else slot := WeaponType(rec, kws);
          if sig = 'ARMO' then ruleVal := RuleFor('armor', slot, kws, edid, usedSel)
          else ruleVal := RuleFor('weapon', slot, kws, edid, usedSel);
          // a tier 4 / tier 5 clamp (stat_clamps.tsv) was worked out from the value after the ladder, so it wins
          clampIdx := slClampKeys.IndexOf(RecKey(rec));
          if clampIdx >= 0 then begin
            SplitTabs(slClampVals[clampIdx], parts);
            if not SameText(parts[3], edid) then begin
              slUnmatched.Add(Format('stat_clamps.tsv names %s for %s, the record is %s: not clamped', [parts[3], slClampKeys[clampIdx], edid]));
              clampIdx := -1;
            end else begin
              ruleVal := parts[7];
              usedClamp := True;
            end;
          end;
          if ruleVal = '' then Continue;

          if (usedSel <> '') and (slSeen.IndexOf(usedSel) >= 0) then slSeen.Delete(slSeen.IndexOf(usedSel));

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
            wantRaw := Hundredths(ruleVal);
          end else begin
            haveRaw := GetElementNativeValues(rec, 'DATA\Damage');
            wantRaw := StrToInt(ruleVal);
          end;

          if haveRaw = wantRaw then begin
            Inc(nSameAlready);
            Continue;
          end;

          slReport.Add(Format('%-4s %-9s %-36s %-12s %5d -> %-5d %s%s',
            [sig, IntToHex(GetLoadOrderFormID(rec), 8), Copy(edid, 1, 36), slot, haveRaw, wantRaw, targetName,
             IfClamp(usedClamp)]));
          if usedClamp then Inc(nClamped);

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
  parts.Free;

  // The manuals first: the recipes refer to their markers
  if not DRY_RUN then AddMasterIfMissing(fNEX, DLE_NAME);
  DoManuals;
  DoRecipes;
end;

// ---------------------------------------------------------------------------------------------------------------
function Finalize: Integer;
var
  i, j: Integer;
  path: string;
begin
  Result := 0;
  slReport.Add('');
  if DRY_RUN then slReport.Add(Format('records that would change: %d', [nEdited]))
  else slReport.Add(Format('records changed: %d', [nEdited]));
  slReport.Add(Format('records already at the ladder value, left alone: %d', [nSameAlready]));
  slReport.Add(Format('records carrying a script, listed not edited: %d', [nScripted]));
  slReport.Add(Format('  of the changes, tier 4 / tier 5 clamps (stat_clamps.tsv): %d', [nClamped]));
  slReport.Add('');
  if DRY_RUN then slReport.Add(Format('recipes that would get their tier gates: %d', [nRecEdited]))
  else slReport.Add(Format('recipes given their tier gates: %d', [nRecEdited]));
  slReport.Add(Format('recipes already gated as the table says, left alone: %d', [nRecSame]));
  slReport.Add(Format('recipes carrying a script, listed not edited: %d', [nRecScripted]));
  slReport.Add(Format('recipes refused (a HasPerk in an OR group with another condition): %d', [slRefused.Count]));

  slReport.Add('');
  slReport.Add('--- manuals (manuals.tsv) ---');
  if slManReport.Count = 0 then slReport.Add(Format('(none to make: all %d already as the table says)', [nManSame]))
  else for i := 0 to Pred(slManReport.Count) do slReport.Add('  ' + slManReport[i]);

  slReport.Add('');
  slReport.Add('--- recipes refused, for a decision by hand ---');
  if slRefused.Count = 0 then slReport.Add('(none)')
  else for i := 0 to Pred(slRefused.Count) do slReport.Add('  ' + slRefused[i]);

  slReport.Add('');
  slReport.Add('--- rows of recipe_tiers.tsv that matched no recipe (a plugin changed since the table was made) ---');
  j := 0;
  for i := 0 to Pred(slRecKeys.Count) do
    if slRecUsed.IndexOf(slRecKeys[i]) < 0 then begin
      slReport.Add('  ' + slRecVals[i]);
      Inc(j);
    end;
  if j = 0 then slReport.Add('(none)');

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
  AddMessage(Format('recipes: %d to gate, %d already right, %d refused; manuals: %d to make or update',
    [nRecEdited, nRecSame, slRefused.Count, nManMade]));

  slClampKeys.Free; slClampVals.Free; slRecKeys.Free; slRecVals.Free; slRecUsed.Free; slRefused.Free; slManReport.Free;
  slKeys.Free; slVals.Free; slReport.Free; slScripted.Free; slUnmatched.Free; slSeen.Free;
end;

end.
