#ifndef ToolsDirectory
  #error ToolsDirectory must be supplied by build-companion-installer.ps1
#endif
#ifndef OutputDirectory
  #define OutputDirectory "output"
#endif

#define AppName "Aura Media Companion"
#define AppVersion "0.3.0"
#define NativeHostName "com.aura.media_companion"

[Setup]
AppId={{7C7709F1-21E7-4AF4-BB0C-9E5E582F2D0B}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Aura Media\Companion
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDirectory}
OutputBaseFilename=Aura-Media-Companion-{#AppVersion}-win-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
#ifdef SignToolName
SignTool={#SignToolName}
SignedUninstaller=yes
#endif

[Files]
Source: "..\native-host\target\release\aura-media-companion.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ToolsDirectory}\*"; DestDir: "{app}\tools"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Aura Media Companion"; Filename: "{app}\aura-media-companion.exe"; Parameters: "--manager"; WorkingDir: "{app}"

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#NativeHostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#NativeHostName}.json"; Flags: uninsdeletekey
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

function AllowedOriginsJson(): String;
begin
  Result := '';
#ifdef ChromeExtensionId
  Result := Result + '"chrome-extension://{#ChromeExtensionId}/"';
#endif
#ifdef EdgeExtensionId
  if Result <> '' then Result := Result + ',';
  Result := Result + '"chrome-extension://{#EdgeExtensionId}/"';
#endif
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  HostPath: String;
  ManifestPath: String;
  ManifestJson: String;
begin
  if CurStep <> ssPostInstall then Exit;
  HostPath := ExpandConstant('{app}\aura-media-companion.exe');
  ManifestPath := ExpandConstant('{app}\{#NativeHostName}.json');
  ManifestJson := '{' + #13#10 +
    '  "name": "{#NativeHostName}",' + #13#10 +
    '  "description": "Aura Media Companion",' + #13#10 +
    '  "path": "' + JsonEscape(HostPath) + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": [' + AllowedOriginsJson() + ']' + #13#10 +
    '}' + #13#10;
  if not SaveStringToFile(ManifestPath, ManifestJson, False) then
    RaiseException('Native messaging manifest could not be written.');
end;
