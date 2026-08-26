#ifndef ToolsDirectory
  #error ToolsDirectory must be supplied by build-companion-installer.ps1
#endif
#ifndef OutputDirectory
  #define OutputDirectory "output"
#endif

#define AppName "Segma Player"
#ifndef AppVersion
  #error AppVersion must be supplied by build-companion-installer.ps1
#endif
#ifndef AllowedExtensionIds
  #error AllowedExtensionIds must be supplied by build-companion-installer.ps1
#endif
#define NativeHostName "com.aura.media_companion"

[Setup]
AppId={{7C7709F1-21E7-4AF4-BB0C-9E5E582F2D0B}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Aura Media\Companion
UsePreviousAppDir=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDirectory}
OutputBaseFilename=Aura-Media-Companion-{#AppVersion}-win-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\assets\microsoft-store\source\segma-player.ico
UninstallDisplayIcon={app}\aura-media-manager.exe
UninstallDisplayName={#AppName}
#ifdef SignToolName
SignTool={#SignToolName}
SignedUninstaller=yes
#endif

[Files]
Source: "..\native-host\target\release\aura-media-companion.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\companion-gui\target\release\aura-media-manager.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ToolsDirectory}\*"; DestDir: "{app}\tools"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\assets\microsoft-store\source\segma-player.ico"; DestDir: "{app}"; DestName: "segma-player.ico"; Flags: ignoreversion

[Icons]
; Points straight at the GUI binary. The host still accepts `--manager` and
; relaunches this executable, so an old shortcut keeps working.
Name: "{autoprograms}\Segma Player"; Filename: "{app}\aura-media-manager.exe"; WorkingDir: "{app}"; IconFilename: "{app}\segma-player.ico"
Name: "{autodesktop}\Segma Player"; Filename: "{app}\aura-media-manager.exe"; WorkingDir: "{app}"; IconFilename: "{app}\segma-player.ico"

[InstallDelete]
Type: files; Name: "{autodesktop}\Aura Media Companion.lnk"
Type: files; Name: "{autoprograms}\Aura Media Companion.lnk"

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#NativeHostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#NativeHostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Naver\Naver Whale\NativeMessagingHosts\{#NativeHostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#NativeHostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#NativeHostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#NativeHostName}.json"; Flags: uninsdeletekey

[Code]
function JsonEscape(Value: String): String;
var
  I: Integer;
  Ch: Char;
begin
  Result := '';
  for I := 1 to Length(Value) do begin
    Ch := Value[I];
    if Ch = '\' then Result := Result + '\\'
    else if Ch = '"' then Result := Result + '\"'
    else Result := Result + Ch;
  end;
end;

procedure AddAllowedOrigin(var Json: String; ExtensionId: String);
var
  Origin: String;
begin
  if ExtensionId = '' then Exit;
  Origin := '"chrome-extension://' + ExtensionId + '/"';
  if Pos(Origin, Json) > 0 then Exit;
  if Json <> '' then Json := Json + ',';
  Json := Json + Origin;
end;

function AllowedOriginsJson(): String;
var
  Remaining: String;
  ExtensionId: String;
  DelimiterPos: Integer;
begin
  Result := '';
  Remaining := '{#AllowedExtensionIds}';
  while Remaining <> '' do begin
    DelimiterPos := Pos('|', Remaining);
    if DelimiterPos > 0 then begin
      ExtensionId := Copy(Remaining, 1, DelimiterPos - 1);
      Delete(Remaining, 1, DelimiterPos);
    end else begin
      ExtensionId := Remaining;
      Remaining := '';
    end;
    AddAllowedOrigin(Result, ExtensionId);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  HostPath: String;
  ManifestPath: String;
  ManifestLines: TArrayOfString;
begin
  if CurStep <> ssPostInstall then Exit;
  HostPath := ExpandConstant('{app}\aura-media-companion.exe');
  ManifestPath := ExpandConstant('{app}\{#NativeHostName}.json');
  SetArrayLength(ManifestLines, 7);
  ManifestLines[0] := '{';
  ManifestLines[1] := '  "name": "{#NativeHostName}",';
  ManifestLines[2] := '  "description": "Segma Player",';
  ManifestLines[3] := '  "path": "' + JsonEscape(HostPath) + '",';
  ManifestLines[4] := '  "type": "stdio",';
  ManifestLines[5] := '  "allowed_origins": [' + AllowedOriginsJson() + ']';
  ManifestLines[6] := '}';
  if not SaveStringsToUTF8FileWithoutBOM(ManifestPath, ManifestLines, False) then
    RaiseException('Native messaging manifest could not be written.');
end;
