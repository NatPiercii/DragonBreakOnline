{
  DBO_RaceReport - read only.

  Dumps every element under DATA for the ten playable RACE records so the exact element names
  are known before anything is written. Writes its own result file, because headless SSEEdit
  gives no console back.

  Run: SSEEdit.exe -autoload -script:DBO_RaceReport.pas -autoexit
       -D:"...\Skyrim Special Edition - dev\Data" -P:"...\server\plugins.server.txt"
}
unit DBO_RaceReport;

var
  outLines: TStringList;
  wanted: TStringList;

function Initialize: integer;
begin
  outLines := TStringList.Create;
  wanted := TStringList.Create;
  wanted.Add('ArgonianRace');
  wanted.Add('BretonRace');
  wanted.Add('DarkElfRace');
  wanted.Add('HighElfRace');
  wanted.Add('ImperialRace');
  wanted.Add('KhajiitRace');
  wanted.Add('NordRace');
  wanted.Add('OrcRace');
  wanted.Add('RedguardRace');
  wanted.Add('WoodElfRace');
  outLines.Add('=== DBO race report ===');
  Result := 0;
end;

procedure DumpContainer(e: IInterface; prefix: string);
var
  i: integer;
  child: IInterface;
  nm, vs: string;
begin
  for i := 0 to ElementCount(e) - 1 do begin
    child := ElementByIndex(e, i);
    nm := Name(child);
    vs := GetEditValue(child);
    if ElementCount(child) > 0 then begin
      outLines.Add(prefix + nm + ':');
      DumpContainer(child, prefix + '    ');
    end else
      outLines.Add(prefix + nm + ' = ' + vs);
  end;
end;

function Process(e: IInterface): integer;
var
  edid: string;
  data: IInterface;
begin
  Result := 0;
  if Signature(e) <> 'RACE' then Exit;
  edid := GetElementEditValues(e, 'EDID');
  if wanted.IndexOf(edid) < 0 then Exit;
  { only report the winning override, once }
  if not IsWinningOverride(e) then Exit;

  outLines.Add('');
  outLines.Add('---- ' + edid + '  [' + IntToHex(FormID(e), 8) + ']  from ' + GetFileName(GetFile(e)));
  data := ElementByPath(e, 'DATA');
  if Assigned(data) then DumpContainer(data, '  ')
  else outLines.Add('  (no DATA element)');
end;

function Finalize: integer;
begin
  outLines.SaveToFile(ScriptsPath + 'DBO_RaceReport.txt');
  outLines.Free;
  wanted.Free;
  Result := 0;
end;

end.
