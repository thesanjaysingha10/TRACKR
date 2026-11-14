; TRACKR for Premiere Pro - Windows installer.
; Built by package.sh:  makensis -DVERSION=.. -DSRCDIR=.. -DOUTFILE=.. windows-installer.nsi
; Installs for the current user only, so it never asks for administrator rights.
Unicode true
!include "MUI2.nsh"

!define APPNAME "TRACKR"
!define EXTID "com.studio.trackr"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TRACKRPremiere"

Name "${APPNAME} ${VERSION}"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$APPDATA\Adobe\CEP\extensions\${EXTID}"
ShowInstDetails nevershow

!define MUI_WELCOMEPAGE_TITLE "Install ${APPNAME} for Premiere Pro"
!define MUI_WELCOMEPAGE_TEXT "This adds the ${APPNAME} panel to Adobe Premiere Pro.$\r$\n$\r$\nClose Premiere Pro before you continue. After installing, open it from Window > Extensions > ${APPNAME}."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "${APPNAME} is installed.$\r$\n$\r$\nIn Premiere Pro, choose Window > Extensions > ${APPNAME}."
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; Replace any earlier copy so no stale files are left beside the signed ones.
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${SRCDIR}/*"

  ; The uninstaller lives outside the extension folder, which must hold only the signed files.
  CreateDirectory "$LOCALAPPDATA\TRACKR"
  WriteUninstaller "$LOCALAPPDATA\TRACKR\uninstall.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME} for Premiere Pro"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$LOCALAPPDATA\TRACKR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  RMDir /r "$APPDATA\Adobe\CEP\extensions\${EXTID}"
  Delete "$LOCALAPPDATA\TRACKR\uninstall.exe"
  RMDir "$LOCALAPPDATA\TRACKR"
  DeleteRegKey HKCU "${UNINSTKEY}"
SectionEnd
