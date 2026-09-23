{
  Dumps every EFSH (effect shader) record in the load order with its editor id and
  its fill / particle textures, so a softer glow shader can be picked by hand.
  Result: Edit Scripts\DBO_efsh.txt
}
unit DBO_DumpEffectShaders;

function TextureOf(r: IInterface; sig: string): string;
var
  e: IInterface;
begin
  Result := '';
  e := ElementBySignature(r, sig);
  if Assigned(e) then
    Result := GetEditValue(e);
end;

function Initialize: integer;
var
  i, j: integer;
  f, g, r: IInterface;
  sl: TStringList;
begin
  sl := TStringList.Create;
  sl.Add('formid' + #9 + 'file' + #9 + 'editorid' + #9 + 'fill(ICON)' + #9 + 'particle(ICO2)');
  for i := 0 to Pred(FileCount) do begin
    f := FileByIndex(i);
    g := GroupBySignature(f, 'EFSH');
    if not Assigned(g) then Continue;
    for j := 0 to Pred(ElementCount(g)) do begin
      r := ElementByIndex(g, j);
      sl.Add(IntToHex(FormID(r), 8) + #9 + GetFileName(f) + #9 + EditorID(r) + #9
        + TextureOf(r, 'ICON') + #9 + TextureOf(r, 'ICO2'));
    end;
  end;
  sl.SaveToFile(ScriptsPath + 'DBO_efsh.txt');
  sl.Free;
  Result := 1;
end;

end.
