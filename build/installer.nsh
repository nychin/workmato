; NSIS selects the initial language from Windows. Keep shortcut creation,
; upgrade renaming and uninstall cleanup in electron-builder's standard flow.
; Define the runtime expression here: electron-builder escapes '$' in JSON
; configuration values before passing them to makensis.
!undef SHORTCUT_NAME
!define SHORTCUT_NAME "$(localizedShortcutName)"
LangString localizedShortcutName 2052 "工作番茄"
LangString localizedShortcutName 1033 "Workmato"
LangString localizedShortcutName 1041 "Workmato"
