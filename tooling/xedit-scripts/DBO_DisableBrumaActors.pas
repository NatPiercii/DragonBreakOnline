{
  DBO - disable 175 plugin-placed actors (bandits, ogres, guards, horses, named NPCs ...) in the Bruma
  worldspaces (BSHeartland.esm). The server never spawns plugin-placed NPCs, so they only ever ran client-side,
  out of sync between players, and their pathing can hit the NaN heading loop that freezes the game
  (HANDOFF section 14; Grimclaw 07264E froze a player 2026-09-16 17:53). Corpses and start-dead actors are kept.
  Overrides each ACHR into DragonBreak Online Edits.esp with Initially Disabled set; an enable parent (XESP) is
  removed from the override so the flag sticks. Idempotent.
  Result: Edit ScriptsDBO_DisableBrumaActors_result.txt
  Run: SSEEdit.exe -D:"<dev Data>" -P:"<serverplugins.server.txt>" -autoload -script:DBO_DisableBrumaActors.pas -autoexit
}
unit DBODisableBrumaActors;

const
  TARGET_PLUGIN = 'DragonBreak Online Edits.esp';
  SOURCE_PLUGIN = 'BSHeartland.esm';
  RESULT_FILE   = 'DBO_DisableBrumaActors_result.txt';

var
  slLog: TStringList;
  TargetFile, SourceFile: IwbFile;
  SourceLO: integer;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

procedure DisableRef(refId: cardinal);
var srcRef, win, ov: IInterface;
begin
  srcRef := RecordByFormID(SourceFile, (SourceLO shl 24) or refId, True);
  if not Assigned(srcRef) then begin slLog.Add('ERROR|ref ' + IntToHex(refId, 6) + ' not found'); Exit; end;
  win := WinningOverride(srcRef);
  if Equals(GetFile(win), TargetFile) then ov := win
  else ov := wbCopyElementToFile(win, TargetFile, False, True);
  if not Assigned(ov) then begin slLog.Add('ERROR|override failed for ' + IntToHex(refId, 6)); Exit; end;
  if Assigned(ElementBySignature(ov, 'XESP')) then RemoveElement(ov, 'XESP');
  SetIsInitiallyDisabled(ov, True);
  slLog.Add(IntToHex(GetLoadOrderFormID(ov), 8) + '|' + Signature(ov) + '|' + Name(LinksTo(ElementByName(ov, 'NAME - Base'))) + '|disabled=' + IntToStr(Ord(GetIsInitiallyDisabled(ov))) + '|xesp=' + IntToStr(Ord(Assigned(ElementBySignature(ov, 'XESP')))));
end;

function Initialize: integer;
begin
  Result := 0;
  slLog := TStringList.Create;
  TargetFile := FileByName(TARGET_PLUGIN);
  SourceFile := FileByName(SOURCE_PLUGIN);
  if (not Assigned(TargetFile)) or (not Assigned(SourceFile)) then begin
    slLog.Add('FATAL  target or source plugin not loaded; ' + IntToStr(FileCount) + ' files');
    slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit;
  end;
  SourceLO := GetLoadOrder(SourceFile);
  slLog.Add('source load order ' + IntToHex(SourceLO, 2));
  DisableRef($0CC056);
  DisableRef($0CC049);
  DisableRef($07264E);
  DisableRef($07264F);
  DisableRef($072650);
  DisableRef($072651);
  DisableRef($072652);
  DisableRef($078E31);
  DisableRef($078E3A);
  DisableRef($072364);
  DisableRef($0C88A0);
  DisableRef($0C9C49);
  DisableRef($0D24B3);
  DisableRef($06DF29);
  DisableRef($06DF28);
  DisableRef($07F00F);
  DisableRef($0CC04A);
  DisableRef($0038BA);
  DisableRef($0038B9);
  DisableRef($06DA99);
  DisableRef($065108);
  DisableRef($0B95D5);
  DisableRef($08AF5B);
  DisableRef($08AF5C);
  DisableRef($0B4BA6);
  DisableRef($0B4BBB);
  DisableRef($0B4BA5);
  DisableRef($0D70E1);
  DisableRef($0D70E2);
  DisableRef($0C8DFB);
  DisableRef($0C8DFC);
  DisableRef($0C8DFD);
  DisableRef($06D95C);
  DisableRef($06D95F);
  DisableRef($061B1F);
  DisableRef($061B20);
  DisableRef($0D6B0F);
  DisableRef($0D6B10);
  DisableRef($08ACAD);
  DisableRef($08ACAE);
  DisableRef($08ACAF);
  DisableRef($08ACB0);
  DisableRef($08ACB1);
  DisableRef($08ACB2);
  DisableRef($0B44D1);
  DisableRef($0B44E2);
  DisableRef($0B44CD);
  DisableRef($0B44CF);
  DisableRef($0B44CE);
  DisableRef($0B44D0);
  DisableRef($0D6B11);
  DisableRef($073C29);
  DisableRef($05CF9F);
  DisableRef($07AE6A);
  DisableRef($0FC769);
  DisableRef($0FCC3F);
  DisableRef($0621E8);
  DisableRef($0623A5);
  DisableRef($0B6421);
  DisableRef($0B64E9);
  DisableRef($0FC768);
  DisableRef($07AEBB);
  DisableRef($0B4C42);
  DisableRef($07AF15);
  DisableRef($07AF16);
  DisableRef($07AEBA);
  DisableRef($05CF9E);
  DisableRef($0621E0);
  DisableRef($0623AD);
  DisableRef($07AEBC);
  DisableRef($07AF3B);
  DisableRef($07AF3C);
  DisableRef($08BF43);
  DisableRef($0AB519);
  DisableRef($0B64E8);
  DisableRef($0FC767);
  DisableRef($0FCC40);
  DisableRef($0FCC41);
  DisableRef($07114C);
  DisableRef($07AE69);
  DisableRef($0FC766);
  DisableRef($08C2D1);
  DisableRef($0FC71D);
  DisableRef($0E2680);
  DisableRef($0B5946);
  DisableRef($0B5945);
  DisableRef($08BAF6);
  DisableRef($0CBD68);
  DisableRef($0B5944);
  DisableRef($0CBD67);
  DisableRef($072361);
  DisableRef($06329B);
  DisableRef($06329C);
  DisableRef($07235E);
  DisableRef($07235F);
  DisableRef($0859B3);
  DisableRef($0EDA42);
  DisableRef($063287);
  DisableRef($06329A);
  DisableRef($0FC80C);
  DisableRef($0FC80D);
  DisableRef($0FC80E);
  DisableRef($0FC80F);
  DisableRef($06F99B);
  DisableRef($06F99C);
  DisableRef($06F99E);
  DisableRef($082029);
  DisableRef($08202A);
  DisableRef($0826A1);
  DisableRef($0826A2);
  DisableRef($0D9587);
  DisableRef($0D9588);
  DisableRef($0D9589);
  DisableRef($0E4852);
  DisableRef($07AAA1);
  DisableRef($08C3DC);
  DisableRef($0B62FE);
  DisableRef($073C26);
  DisableRef($073C27);
  DisableRef($073C28);
  DisableRef($086310);
  DisableRef($0B62FD);
  DisableRef($0D6B0E);
  DisableRef($07AAA2);
  DisableRef($07AAA3);
  DisableRef($07AAA5);
  DisableRef($08C222);
  DisableRef($08C3DD);
  DisableRef($08C3DE);
  DisableRef($0B4850);
  DisableRef($089A79);
  DisableRef($089A7A);
  DisableRef($089A7B);
  DisableRef($089A7C);
  DisableRef($0D556B);
  DisableRef($0ED9D3);
  DisableRef($0ED9D4);
  DisableRef($0ED9D5);
  DisableRef($0ED9D6);
  DisableRef($06F93E);
  DisableRef($08ACD6);
  DisableRef($06DA9A);
  DisableRef($0651A6);
  DisableRef($065083);
  DisableRef($065066);
  DisableRef($0C9B20);
  DisableRef($0C9B22);
  DisableRef($0EE1AA);
  DisableRef($0EE1AB);
  DisableRef($0EE1AC);
  DisableRef($0EE1AD);
  DisableRef($0EE1AE);
  DisableRef($0D2669);
  DisableRef($0CC04B);
  DisableRef($067A02);
  DisableRef($067A03);
  DisableRef($082775);
  DisableRef($082776);
  DisableRef($0D0365);
  DisableRef($0D0366);
  DisableRef($0D0364);
  DisableRef($06C017);
  DisableRef($0B5AD2);
  DisableRef($0C885B);
  DisableRef($0C885A);
  DisableRef($0B61CA);
  DisableRef($0635F1);
  DisableRef($049F84);
  DisableRef($0B9790);
  DisableRef($0B99C0);
  DisableRef($0B9B5E);
  DisableRef($0C807D);
  DisableRef($0CC1C4);
  DisableRef($0CC1C5);
  DisableRef($0CC1C6);
  slLog.Add('SUMMARY done');
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
end;

function Finalize: integer;
begin
  Result := 0;
end;

end.
