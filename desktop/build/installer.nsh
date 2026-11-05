; One-click update: Инвиз often keeps running in the tray, so close it quietly instead of the
; old-style «Приложение запущено — нажмите OK» dialog.
!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Sleep 700
!macroend
