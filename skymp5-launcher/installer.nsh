; Custom NSIS hooks for the DragonBreak Launcher installer.
;
; Refuse to install/update while the launcher is running, otherwise its files
; are locked and the update silently half-applies. nsProcess ships with
; electron-builder's bundled NSIS, so no extra plugin install is needed.

!define LEGACY_PRODUCT_EXE "DragonBreak Online Launcher.exe"

; Sets $R0 to 0 while the launcher runs under its current or its original name.
!macro findLauncherProcess
  nsProcess::_FindProcess "${PRODUCT_FILENAME}.exe"
  Pop $R0
  ${If} $R0 != 0
    nsProcess::_FindProcess "${LEGACY_PRODUCT_EXE}"
    Pop $R0
  ${EndIf}
  nsProcess::_Unload
!macroend

!macro customInit
  ${If} ${Silent}
    ; In-app auto-update (/S): the launcher is quitting itself. Wait up to ~10s
    ; for it to release its files, then proceed without any prompt.
    StrCpy $R1 0
    silent_wait:
      !insertmacro findLauncherProcess
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        ${If} $R1 < 20
          Sleep 500
          Goto silent_wait
        ${EndIf}
      ${EndIf}
  ${Else}
    ; Manual run: ask the user to close a running launcher before continuing.
    retry_running_check:
      !insertmacro findLauncherProcess
      ${If} $R0 == 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
          "DragonBreak Launcher is still running.$\n$\nPlease fully quit it (check the system tray), then click Retry." \
          IDRETRY retry_running_check
        Abort
      ${EndIf}
  ${EndIf}
!macroend
