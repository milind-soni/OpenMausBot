!macro customInstall
  WriteRegStr HKCU "Software\Classes\OpenMausBot.GrokBot" "" "OpenMausBot Grok Bot link"
  WriteRegStr HKCU "Software\Classes\OpenMausBot.GrokBot" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\OpenMausBot.GrokBot\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\OpenMausBot.GrokBot\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""

  WriteRegStr HKCU "Software\OpenMausBot\Capabilities" "ApplicationName" "OpenMausBot"
  WriteRegStr HKCU "Software\OpenMausBot\Capabilities" "ApplicationDescription" "Open public Grok Bot links in OpenMausBot for review and import."
  WriteRegStr HKCU "Software\OpenMausBot\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\OpenMausBot\Capabilities\UrlAssociations" "grokbot" "OpenMausBot.GrokBot"
  WriteRegStr HKCU "Software\RegisteredApplications" "OpenMausBot" "Software\OpenMausBot\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\RegisteredApplications" "OpenMausBot"
  DeleteRegKey HKCU "Software\OpenMausBot\Capabilities"
  DeleteRegKey HKCU "Software\Classes\OpenMausBot.GrokBot"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
