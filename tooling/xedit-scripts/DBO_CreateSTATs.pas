{
  DOL - Create STATs from mesh list

  Creates one STAT record per model path listed in DBO_MeshList.txt so the
  meshes become placeable in the Creation Kit.

  For each line it writes:
    EDID        DBO_<DerivedName>
    MODL\MODL   the model path (relative to Data\Meshes\)
    OBND        object bounds, computed from the NIF's bounding spheres

  Input : Edit Scripts\DBO_MeshList.txt   (one model path per line,
                                           relative to Data\Meshes\)
  Output: new STAT records in TARGET_PLUGIN

  HOW TO RUN
    1. Launch SSEEdit, load your load order.
    2. Right-click any record -> Apply Script.
    3. Pick "DOL - Create STATs from mesh list", press OK.
    4. Review, then save with Ctrl+S.

  Set TEST_LIMIT to a small number for a trial run before doing all 517.
}

unit CreateStatsFromMeshList;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  EDID_PREFIX   = 'DBO_';
  LIST_FILE     = 'DBO_MeshList.txt';
  TEST_LIMIT    = 0;      // 0 = process every line; else stop after N

var
  slList, slExisting, slModels, slLog: TStringList;
  TargetFile: IwbFile;
  cMade, cSkipped, cNoBounds, cMissing, cDupe: integer;
  // bounds output - globals rather than var parameters, because
  // JvInterpreter (xEdit's Pascal engine) only supports var params
  // on event handlers, not on script-called functions
  gx1, gy1, gz1, gx2, gy2, gz2: double;

//===========================================================================
// locate the plugin we are writing into
function FindTargetFile: IwbFile;
var
  i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), TARGET_PLUGIN) then begin
      Result := FileByIndex(i);
      Exit;
    end;
end;

//===========================================================================
// Index every existing STAT: its EDID (so we never collide) and its model
// path (so we never create a second STAT for a mesh that already has one).
// This walks the loaded records, so it sees inside compressed records too -
// which a raw text scan of the plugin files cannot do.
procedure IndexExistingStats;
var
  i, j: integer;
  f: IwbFile;
  g: IwbGroupRecord;
  r: IwbMainRecord;
  m: string;
begin
  for i := 0 to Pred(FileCount) do begin
    f := FileByIndex(i);
    g := GroupBySignature(f, 'STAT');
    if not Assigned(g) then Continue;
    for j := 0 to Pred(ElementCount(g)) do begin
      r := ElementByIndex(g, j);
      if not Assigned(r) then Continue;
      slExisting.Add(LowerCase(EditorID(r)));
      m := GetElementEditValues(r, 'MODL\MODL');
      if m <> '' then
        slModels.Add(LowerCase(StringReplace(m, '/', '\', [rfReplaceAll])));
    end;
  end;
end;

//===========================================================================
// build a readable EditorID from a model path
//   clutter\bretonvase\bretonvase01a.nif  ->  DBO_BretonVase01a
function MakeEditorID(aPath: string): string;
var
  base, cand: string;
  n: integer;
begin
  base := ExtractFileName(aPath);
  base := Copy(base, 1, Length(base) - 4);        // drop .nif
  base := StringReplace(base, ' ', '', [rfReplaceAll]);
  base := StringReplace(base, '-', '', [rfReplaceAll]);
  base := StringReplace(base, '.', '', [rfReplaceAll]);
  cand := EDID_PREFIX + base;
  n := 1;
  while slExisting.IndexOf(LowerCase(cand)) <> -1 do begin
    Inc(n);
    cand := EDID_PREFIX + base + IntToStr(n);
  end;
  slExisting.Add(LowerCase(cand));
  Result := cand;
end;

//===========================================================================
// Read the NIF and derive an axis-aligned box from its bounding spheres.
// Writes the box into the gx1..gz2 globals. Returns False if no shape
// block exposed usable bounds.
function GetNifBounds(aFullPath: string): boolean;
var
  Nif: TwbNifFile;
  Block: TwbNifBlock;
  j: integer;
  cx, cy, cz, r: double;
  first: boolean;
begin
  Result := False;
  first := True;
  gx1 := 0; gy1 := 0; gz1 := 0; gx2 := 0; gy2 := 0; gz2 := 0;

  Nif := TwbNifFile.Create;
  try
    try
      Nif.LoadFromFile(aFullPath);
    except
      Exit;
    end;

    for j := 0 to Pred(Nif.BlocksCount) do begin
      Block := Nif.Blocks[j];

      // Two formats carry the Bounding Sphere in different places:
      //   SSE BSTriShape        - on the shape block itself
      //   older NiTriShape      - on its DATA block (NiTriBasedGeomData),
      //                           not on the shape, so match the data block
      if not (Block.IsNiObject('NiTriBasedGeomData', True) or
              Block.IsNiObject('BSTriShape', True)) then
        Continue;

      // The two formats also NAME the bounds differently:
      //   BSTriShape      - nested inside a "Bounding Sphere" struct
      //   NiGeometryData  - flat "Center" / "Radius" fields
      // Try the nested layout, then fall back to the flat one. A radius
      // of 0 means nothing was actually read, so it doubles as the
      // wrong-layout signal whether the lookup raises or just returns 0.
      cx := 0; cy := 0; cz := 0; r := 0;

      try
        cx := Block.NativeValues['Bounding Sphere\Center\X'];
        cy := Block.NativeValues['Bounding Sphere\Center\Y'];
        cz := Block.NativeValues['Bounding Sphere\Center\Z'];
        r  := Block.NativeValues['Bounding Sphere\Radius'];
      except
        r := 0;
      end;

      if r <= 0 then
        try
          cx := Block.NativeValues['Center\X'];
          cy := Block.NativeValues['Center\Y'];
          cz := Block.NativeValues['Center\Z'];
          r  := Block.NativeValues['Radius'];
        except
          r := 0;
        end;

      if r <= 0 then Continue;

      if first then begin
        gx1 := cx - r; gx2 := cx + r;
        gy1 := cy - r; gy2 := cy + r;
        gz1 := cz - r; gz2 := cz + r;
        first := False;
      end else begin
        if cx - r < gx1 then gx1 := cx - r;
        if cx + r > gx2 then gx2 := cx + r;
        if cy - r < gy1 then gy1 := cy - r;
        if cy + r > gy2 then gy2 := cy + r;
        if cz - r < gz1 then gz1 := cz - r;
        if cz + r > gz2 then gz2 := cz + r;
      end;
      Result := True;
    end;
  finally
    Nif.Free;
  end;
end;

//===========================================================================
procedure MakeStat(aModel: string);
var
  grp: IwbGroupRecord;
  rec: IwbMainRecord;
  full, edid: string;
begin
  full := DataPath + 'meshes\' + aModel;

  if not FileExists(full) then begin
    slLog.Add('MISSING FILE  ' + aModel);
    Inc(cMissing);
    Exit;
  end;

  // already has a STAT somewhere in the load order - leave it alone
  if slModels.IndexOf(LowerCase(aModel)) <> -1 then begin
    slLog.Add('ALREADY EXISTS ' + aModel);
    Inc(cDupe);
    Exit;
  end;
  slModels.Add(LowerCase(aModel));

  grp := GroupBySignature(TargetFile, 'STAT');
  if not Assigned(grp) then
    grp := Add(TargetFile, 'STAT', True);

  rec := Add(grp, 'STAT', True);
  if not Assigned(rec) then begin
    slLog.Add('ADD FAILED    ' + aModel);
    Inc(cSkipped);
    Exit;
  end;

  edid := MakeEditorID(aModel);
  SetElementEditValues(rec, 'EDID', edid);

  // MODL is relative to Data\Meshes\ - no "meshes\" prefix.
  // The MODL struct must be created before its MODL subrecord can be
  // set; without this Add the SetElementEditValues call silently does
  // nothing and the record ends up with no model at all.
  Add(rec, 'MODL', True);
  SetElementEditValues(rec, 'MODL\MODL', aModel);

  if GetElementEditValues(rec, 'MODL\MODL') = '' then begin
    slLog.Add('MODL NOT SET ' + aModel);
    Inc(cSkipped);
  end;

  if GetNifBounds(full) then begin
    Add(rec, 'OBND', True);
    SetElementNativeValues(rec, 'OBND\X1', Round(gx1));
    SetElementNativeValues(rec, 'OBND\Y1', Round(gy1));
    SetElementNativeValues(rec, 'OBND\Z1', Round(gz1));
    SetElementNativeValues(rec, 'OBND\X2', Round(gx2));
    SetElementNativeValues(rec, 'OBND\Y2', Round(gy2));
    SetElementNativeValues(rec, 'OBND\Z2', Round(gz2));
  end else begin
    slLog.Add('NO BOUNDS     ' + aModel);
    Inc(cNoBounds);
  end;

  Inc(cMade);
end;

//===========================================================================
function Initialize: integer;
var
  listPath, line: string;
  i: integer;
begin
  Result := 0;
  cMade := 0; cSkipped := 0; cNoBounds := 0; cMissing := 0; cDupe := 0;

  TargetFile := FindTargetFile;
  if not Assigned(TargetFile) then begin
    AddMessage('ERROR: ' + TARGET_PLUGIN + ' is not loaded. Load it and retry.');
    Result := 1;
    Exit;
  end;

  listPath := ScriptsPath + LIST_FILE;
  if not FileExists(listPath) then begin
    AddMessage('ERROR: list not found: ' + listPath);
    Result := 1;
    Exit;
  end;

  slList     := TStringList.Create;
  slExisting := TStringList.Create;
  slModels   := TStringList.Create;
  slLog      := TStringList.Create;
  slExisting.Sorted := True;
  slExisting.Duplicates := dupIgnore;
  slModels.Sorted := True;
  slModels.Duplicates := dupIgnore;

  slList.LoadFromFile(listPath);
  AddMessage('Loaded ' + IntToStr(slList.Count) + ' model paths.');
  AddMessage('Indexing existing STAT records...');
  IndexExistingStats;
  AddMessage('Indexed ' + IntToStr(slExisting.Count) + ' EditorIDs, '
             + IntToStr(slModels.Count) + ' model paths.');
  AddMessage('Writing into ' + TARGET_PLUGIN + ' ...');

  for i := 0 to Pred(slList.Count) do begin
    line := Trim(slList[i]);
    if line = '' then Continue;
    if Copy(line, 1, 2) = '//' then Continue;
    MakeStat(line);
    if (TEST_LIMIT > 0) and (cMade >= TEST_LIMIT) then begin
      AddMessage('TEST_LIMIT reached - stopping early.');
      Break;
    end;
  end;

  AddMessage('');
  AddMessage('=====================================');
  AddMessage('  STATs created      : ' + IntToStr(cMade));
  AddMessage('  no bounds computed : ' + IntToStr(cNoBounds));
  AddMessage('  already had a STAT : ' + IntToStr(cDupe));
  AddMessage('  model file missing : ' + IntToStr(cMissing));
  AddMessage('  add failed         : ' + IntToStr(cSkipped));
  AddMessage('=====================================');
  if slLog.Count > 0 then begin
    AddMessage('Problems:');
    for i := 0 to Pred(slLog.Count) do
      AddMessage('  ' + slLog[i]);
  end;
  AddMessage('Review the records, then Ctrl+S to save.');

  slList.Free;
  slExisting.Free;
  slModels.Free;
  slLog.Free;
end;

end.
