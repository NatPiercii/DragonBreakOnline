@echo off
rem Rewrites %LOCALAPPDATA%\Skyrim Special Edition\Plugins.txt and loadorder.txt from the server's
rem load order (server-settings.json). Close Vortex first: while it runs it reverts both files
rem within about thirty seconds. Run this, then launch the game through SKSE from the dev copy.
setlocal
cd /d "%~dp0"
node -e "const fs=require('fs');const lo=JSON.parse(fs.readFileSync('server-settings.json','utf8')).loadOrder;const base=new Set(['Skyrim.esm','Update.esm','Dawnguard.esm','HearthFires.esm','Dragonborn.esm','ccBGSSSE001-Fish.esm','ccQDRSSE001-SurvivalMode.esl','ccBGSSSE037-Curios.esl','ccBGSSSE025-AdvDSGS.esm','_ResourcePack.esl']);const d=process.env.LOCALAPPDATA+'/Skyrim Special Edition/';const ts=new Date().toISOString().replace(/[:.]/g,'-');for(const f of ['Plugins.txt','loadorder.txt']){try{fs.copyFileSync(d+f,d+f+'.bak-sync-'+ts);}catch(e){}}const active=lo.filter(p=>!base.has(p));fs.writeFileSync(d+'Plugins.txt','# This file is used by Skyrim to keep track of your downloaded content.\n# Please do not modify this file.\n'+active.map(p=>'*'+p).join('\n')+'\n');fs.writeFileSync(d+'loadorder.txt',lo.join('\n')+'\n');console.log('Plugins.txt: '+active.length+' active plugins, loadorder.txt: '+lo.length+' entries (server order)');"
if errorlevel 1 echo FAILED: is node installed and server-settings.json present?
endlocal
pause
