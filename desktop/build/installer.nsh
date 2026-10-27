; coredotdocs — Windows 파일 연결은 "연결 프로그램" 후보로만 등록한다 (OpenWithProgids).
; 기본 프로그램(UserChoice)은 바꾸지 않으므로 한컴 한글·Word의 기본값이 그대로 남는다. (설계 문서 04 §2 A8)
; SHELL_CONTEXT는 NSIS의 설치 범위에 따라 현재 사용자(HKCU) 또는 모든 사용자(HKLM)를 고른다.
; 설치 후 해당 범위의 Software\Classes\.hwpx\OpenWithProgids에 coredotdocs.hwpx가 있고 기본값은 그대로여야 한다.

!macro coredotdocsRegisterOpenWith EXT PROGID DESC
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
!macroend

!macro coredotdocsUnregisterOpenWith EXT PROGID
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PROGID}"
!macroend

!macro customInstall
  !insertmacro coredotdocsRegisterOpenWith "hwpx" "coredotdocs.hwpx" "HWPX 문서"
  !insertmacro coredotdocsRegisterOpenWith "hwp" "coredotdocs.hwp" "HWP 문서"
  !insertmacro coredotdocsRegisterOpenWith "docx" "coredotdocs.docx" "Word 문서"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "coredotdocs" "Software\coredotdocs\Capabilities"
  WriteRegStr SHELL_CONTEXT "Software\coredotdocs\Capabilities" "ApplicationName" "coredotdocs"
  WriteRegStr SHELL_CONTEXT "Software\coredotdocs\Capabilities" "ApplicationDescription" "HWPX·DOCX를 AI와 함께 고치는 편집기"
  WriteRegStr SHELL_CONTEXT "Software\coredotdocs\Capabilities\FileAssociations" ".hwpx" "coredotdocs.hwpx"
  WriteRegStr SHELL_CONTEXT "Software\coredotdocs\Capabilities\FileAssociations" ".hwp" "coredotdocs.hwp"
  WriteRegStr SHELL_CONTEXT "Software\coredotdocs\Capabilities\FileAssociations" ".docx" "coredotdocs.docx"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro coredotdocsUnregisterOpenWith "hwpx" "coredotdocs.hwpx"
  !insertmacro coredotdocsUnregisterOpenWith "hwp" "coredotdocs.hwp"
  !insertmacro coredotdocsUnregisterOpenWith "docx" "coredotdocs.docx"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "coredotdocs"
  DeleteRegKey SHELL_CONTEXT "Software\coredotdocs\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
