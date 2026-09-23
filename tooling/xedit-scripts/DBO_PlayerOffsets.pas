{ DBO_PlayerOffsets - read only. Dumps the Player NPC_ (00000007) ACBS block, because
  GetBaseActorValues.cpp computes raceData.startingHealth + attributesNpcData.healthOffset,
  so the offsets decide what has to be written onto the RACE records. }
unit DBO_PlayerOffsets;

var
  outLines: TStringList;

function Initialize: integer;
begin
  outLines := TStringList.Create;
  outLines.Add('=== Player NPC_ offsets ===');
  Result := 0;
end;

procedure DumpContainer(e: IInterface; prefix: string);
var
  i: integer;
  child: IInterface;
begin
  for i := 0 to ElementCount(e) - 1 do begin
    child := ElementByIndex(e, i);
    if ElementCount(child) > 0 then begin
      outLines.Add(prefix + Name(child) + ':');
      DumpContainer(child, prefix + '    ');
    end else
      outLines.Add(prefix + Name(child) + ' = ' + GetEditValue(child));
  end;
end;

function Process(e: IInterface): integer;
var
  acbs: IInterface;
begin
  Result := 0;
  if Signature(e) <> 'NPC_' then Exit;
  if FormID(e) <> $00000007 then Exit;
  if not IsWinningOverride(e) then Exit;
  outLines.Add('---- ' + GetElementEditValues(e, 'EDID') + ' from ' + GetFileName(GetFile(e)));
  acbs := ElementByPath(e, 'ACBS');
  if Assigned(acbs) then DumpContainer(acbs, '  ') else outLines.Add('  (no ACBS)');
  outLines.Add('  RACE = ' + GetElementEditValues(e, 'RNAM'));
end;

function Finalize: integer;
begin
  outLines.SaveToFile(ScriptsPath + 'DBO_PlayerOffsets.txt');
  outLines.Free;
  Result := 0;
end;

end.
