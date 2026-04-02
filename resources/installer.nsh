!macro customCheckAppRunning
  ; Kill the entire process tree: main app + children (node.exe, MCP servers, WSL)
  ; /T = kill child processes, /F = force (TerminateProcess, no graceful shutdown)
  nsExec::Exec 'taskkill /T /F /IM "Open Cowork.exe"'

  ; Kill orphaned node.exe launched from the install directory (MCP stdio servers, bundled node)
  ; Uses wmic to filter by executable path so we don't kill unrelated Node.js processes
  nsExec::Exec `cmd.exe /c wmic process where "name='node.exe' and ExecutablePath like '%Open Cowork%'" call terminate`

  ; Wait for processes to fully exit and release file locks
  Sleep 5000

  ; Verify the app is no longer running
  nsExec::ExecToStack `cmd.exe /c tasklist /FI "IMAGENAME eq Open Cowork.exe" /NH | find /C /I "Open Cowork.exe"`
  Pop $R0 ; return code: 0 = found (still running), nonzero = not found (stopped)
  Pop $R1 ; output (unused)
  StrCmp $R0 "0" 0 _oc_check_app_done

  ; Process is still running — ask the user to close it manually
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
    "Open Cowork is still running and could not be stopped automatically.$\r$\n$\r$\nPlease close Open Cowork manually, then click Retry.$\r$\nClick Cancel to abort the installation." \
    IDRETRY _oc_check_app_retry
  Quit

  _oc_check_app_retry:
    nsExec::Exec 'taskkill /T /F /IM "Open Cowork.exe"'
    Sleep 3000

  _oc_check_app_done:
!macroend

Function OpenCoworkShowLegacyUninstallHelp
  Exch $0
  DetailPrint `Legacy Open Cowork uninstall failed: $0`

  IfFileExists "$EXEDIR\Open-Cowork-Legacy-Cleanup.cmd" 0 no_cleanup_tool
    MessageBox MB_OK|MB_ICONEXCLAMATION "Open Cowork could not remove the previously installed version.$\r$\n$\r$\nThis usually means the legacy Windows uninstaller is damaged.$\r$\n$\r$\nNext steps:$\r$\n1. Close all Open Cowork windows.$\r$\n2. Run:$\r$\n$EXEDIR\Open-Cowork-Legacy-Cleanup.cmd$\r$\n3. Start this installer again.$\r$\n$\r$\nAdd -RemoveAppData to the cleanup tool only if you also want to clear local settings."
    SetErrorLevel 2
    Quit

  no_cleanup_tool:
    MessageBox MB_OK|MB_ICONEXCLAMATION "Open Cowork could not remove the previously installed version.$\r$\n$\r$\nThis usually means the legacy Windows uninstaller is damaged.$\r$\n$\r$\nPlease close Open Cowork, delete:$\r$\n$LOCALAPPDATA\Programs\Open Cowork$\r$\nand then run this installer again.$\r$\n$\r$\nLocal settings may remain in AppData by design."
    SetErrorLevel 2
    Quit
FunctionEnd

!macro customUnInstallCheck
  IfErrors 0 _oc_uninst_no_launch_err
    Push "could not launch the old uninstaller"
    Call OpenCoworkShowLegacyUninstallHelp
  _oc_uninst_no_launch_err:
  StrCmp $R0 0 _oc_uninst_ok
    Push "old uninstaller returned code $R0"
    Call OpenCoworkShowLegacyUninstallHelp
  _oc_uninst_ok:
!macroend

!macro customUnInstallCheckCurrentUser
  IfErrors 0 _oc_curuninst_no_launch_err
    Push "could not launch the old current-user uninstaller"
    Call OpenCoworkShowLegacyUninstallHelp
  _oc_curuninst_no_launch_err:
  StrCmp $R0 0 _oc_curuninst_ok
    Push "old current-user uninstaller returned code $R0"
    Call OpenCoworkShowLegacyUninstallHelp
  _oc_curuninst_ok:
!macroend
