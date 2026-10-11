{
  DBO - the conjured scamps cast their fire (Nate, 11 Oct: "the conjure scamp needs their fireball attack not just melee").
  BSAssets' BSKSummonCreatureScamp (601FB2) and BSKSummonCreatureScampPotent (601FB7) take their AI data from their
  templates (BSKEncScamp 601FAE, BSKEncScampPrime 60292D), whose combat style is Skyrim's csFalmerMelee1H (052388), so they
  hold their Firebolt / Fireball and Flame Cloak but fight in melee. BSAssets' own BSKcsScamp (601FAF, magic 5) is used by
  no record. Overrides each summon into DragonBreak Nexus Patches.esp: "Use AI Data" cleared from its template flags, the
  template's AIDT copied in, and ZNAM set to BSKcsScamp. Wild scamps are left melee. Idempotent.
  Result: Edit Scripts\DBO_ScampCaster_result.txt
  Run: SSEEdit.exe -D:"<dev Data>" -P:"<server\plugins.server.txt>" -autoload -script:DBO_ScampCaster.pas -autoexit
}
unit DBOScampCaster;

const
  TARGET_PLUGIN = 'DragonBreak Nexus Patches.esp';
  SOURCE_PLUGIN = 'BSAssets.esm';
  RESULT_FILE   = 'DBO_ScampCaster_result.txt';
  USE_AI_DATA   = $10;
  CSTY_SCAMP    = $601FAF;   // BSKcsScamp

var
  slLog: TStringList;
  TargetFile, SourceFile: IwbFile;
  SourceLO: integer;
  Errors: integer;

function FileByName(aName: string): IwbFile;
var i: integer;
begin
  Result := nil;
  for i := 0 to Pred(FileCount) do
    if SameText(GetFileName(FileByIndex(i)), aName) then begin
      Result := FileByIndex(i); Exit;
    end;
end;

function Src(localId: cardinal): IInterface;
begin
  Result := RecordByFormID(SourceFile, (SourceLO shl 24) or localId, True);
  if Assigned(Result) then Result := WinningOverride(Result);
end;

procedure MakeCaster(npcId, templateId: cardinal);
var npc, tpl, ov, csty, aidt: IInterface; flags: cardinal;
begin
  npc := Src(npcId); tpl := Src(templateId); csty := Src(CSTY_SCAMP);
  if not (Assigned(npc) and Assigned(tpl) and Assigned(csty)) then begin
    slLog.Add('ERROR|' + IntToHex(npcId, 6) + ' or its template or BSKcsScamp not found'); Inc(Errors); Exit;
  end;
  if Equals(GetFile(npc), TargetFile) then ov := npc
  else ov := wbCopyElementToFile(npc, TargetFile, False, True);
  if not Assigned(ov) then begin slLog.Add('ERROR|override failed for ' + EditorID(npc)); Inc(Errors); Exit; end;

  // The template keeps traits, stats, spells and the rest; only AI data becomes the summon's own
  flags := GetElementNativeValues(ov, 'ACBS\Template Flags');
  SetElementNativeValues(ov, 'ACBS\Template Flags', flags and not USE_AI_DATA);
  aidt := ElementBySignature(tpl, 'AIDT');
  if Assigned(aidt) then begin
    if Assigned(ElementBySignature(ov, 'AIDT')) then RemoveElement(ov, 'AIDT');
    wbCopyElementToRecord(aidt, ov, False, True);
  end else begin
    slLog.Add('WARN|' + EditorID(tpl) + ' has no AIDT');
  end;
  if not Assigned(ElementBySignature(ov, 'ZNAM')) then Add(ov, 'ZNAM', True);
  SetElementNativeValues(ov, 'ZNAM', GetLoadOrderFormID(csty));

  slLog.Add(EditorID(ov) + '|templateFlags ' + IntToHex(flags, 4) + ' -> ' + IntToHex(GetElementNativeValues(ov, 'ACBS\Template Flags'), 4)
    + '|ZNAM ' + GetElementEditValues(ov, 'ZNAM') + '|AIDT ' + IntToStr(Ord(Assigned(ElementBySignature(ov, 'AIDT'))))
    + '|aggression ' + GetElementEditValues(ov, 'AIDT\Aggression') + '|confidence ' + GetElementEditValues(ov, 'AIDT\Confidence'));
  if GetElementNativeValues(ov, 'ACBS\Template Flags') and USE_AI_DATA <> 0 then begin slLog.Add('ERROR|' + EditorID(ov) + ' still uses AI data'); Inc(Errors); end;
  if not Equals(LinksTo(ElementBySignature(ov, 'ZNAM')), csty) then begin slLog.Add('ERROR|' + EditorID(ov) + ' ZNAM is not BSKcsScamp'); Inc(Errors); end;
end;

function Initialize: integer;
begin
  Result := 0; Errors := 0;
  slLog := TStringList.Create;
  TargetFile := FileByName(TARGET_PLUGIN);
  SourceFile := FileByName(SOURCE_PLUGIN);
  if (not Assigned(TargetFile)) or (not Assigned(SourceFile)) then begin
    slLog.Add('FATAL|target or source plugin not loaded; ' + IntToStr(FileCount) + ' files');
    slLog.SaveToFile(ScriptsPath + RESULT_FILE); Result := 1; Exit;
  end;
  SourceLO := GetLoadOrder(SourceFile);
  MakeCaster($601FB2, $601FAE);   // BSKSummonCreatureScamp <- BSKEncScamp
  MakeCaster($601FB7, $60292D);   // BSKSummonCreatureScampPotent <- BSKEncScampPrime
  slLog.Add('DONE|errors ' + IntToStr(Errors));
  slLog.SaveToFile(ScriptsPath + RESULT_FILE);
  if Errors > 0 then Result := 1;
end;

function Finalize: integer;
begin
  Result := 0;
end;

end.
