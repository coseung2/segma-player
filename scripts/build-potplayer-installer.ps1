[CmdletBinding()]
param(
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedOutput = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $ProjectRoot 'dist' }
$OutputDirectory = [System.IO.Path]::GetFullPath($resolvedOutput)
$ProtocolScript = Join-Path $ProjectRoot 'potplayer-protocol.ps1'

if (-not (Test-Path -LiteralPath $ProtocolScript -PathType Leaf)) {
  throw "potplayer-protocol.ps1 not found: $ProtocolScript"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$scriptBytes = [System.IO.File]::ReadAllBytes($ProtocolScript)
$scriptBase64 = [System.Convert]::ToBase64String($scriptBytes)

$source = @"
using System;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

public static class AuraPotPlayerSetup
{
  private const string ScriptBase64 = "$scriptBase64";

  [STAThread]
  public static void Main(string[] args)
  {
    try
    {
      string installDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Aura Media", "PotPlayer");
      string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
      string defaultSubs = Path.Combine(userProfile, "Downloads", "Subtitles");
      Directory.CreateDirectory(defaultSubs);

      string subtitleDir = null;
      bool silent = false;
      for (int i = 0; i < args.Length; i++)
      {
        if (args[i] == "--silent" && i + 1 < args.Length)
        {
          subtitleDir = args[i + 1];
          silent = true;
        }
      }
      if (subtitleDir == null)
      {
        using (var dialog = new FolderBrowserDialog())
        {
          dialog.Description = "PotPlayer 자막 폴더를 선택해 주세요. 새 폴더를 만들어 주세요.\r\n선택한 폴더의 자막(.srt)이 PotPlayer에서 자동으로 표시됩니다.";
          dialog.SelectedPath = defaultSubs;
          dialog.ShowNewFolderButton = true;
          if (dialog.ShowDialog() != DialogResult.OK) { return; }
          subtitleDir = dialog.SelectedPath;
        }
      }
      Directory.CreateDirectory(subtitleDir);

      Directory.CreateDirectory(installDir);
      string scriptPath = Path.Combine(installDir, "potplayer-protocol.ps1");
      byte[] scriptBytes = Convert.FromBase64String(ScriptBase64);
      File.WriteAllBytes(scriptPath, scriptBytes);
      File.WriteAllText(
        Path.Combine(installDir, "config.json"),
        "{\"subtitleDir\": " + JsonEncode(subtitleDir) + "}",
        new UTF8Encoding(false));

      using (RegistryKey root = Registry.CurrentUser.CreateSubKey("Software\\Classes\\aura-player"))
      {
        root.SetValue("", "URL:Aura PotPlayer Protocol");
        root.SetValue("URL Protocol", "");
        using (RegistryKey command = root.CreateSubKey("shell\\open\\command"))
        {
          string powershell = Path.Combine(
            Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
          command.SetValue(
            "",
            "\"" + powershell + "\" -NoProfile -ExecutionPolicy Bypass -File \"" +
            scriptPath + "\" \"%1\"");
        }
      }

      if (!silent)
      {
        MessageBox.Show(
          "PotPlayer 연동 설치가 완료되었습니다.\r\n\r\n자막 폴더: " + subtitleDir,
          "Aura PotPlayer",
          MessageBoxButtons.OK,
          MessageBoxIcon.Information);
      }
    }
    catch (Exception ex)
    {
      MessageBox.Show(
        "설치 중 오류가 발생했습니다: " + ex.Message,
        "Aura PotPlayer",
        MessageBoxButtons.OK,
        MessageBoxIcon.Error);
    }
  }

  private static string JsonEncode(string value)
  {
    StringBuilder builder = new StringBuilder();
    foreach (char ch in value)
    {
      if (ch == '"' || ch == '\\') { builder.Append('\\'); }
      builder.Append(ch);
    }
    return "\"" + builder.ToString() + "\"";
  }
}
"@

Add-Type -TypeDefinition $source -Language CSharp `
  -OutputAssembly (Join-Path $OutputDirectory 'AuraPotPlayerSetup.exe') `
  -OutputType WindowsApplication `
  -ReferencedAssemblies 'System.Windows.Forms.dll', 'System.Drawing.dll'

Write-Output "PotPlayer installer created at $(Join-Path $OutputDirectory 'AuraPotPlayerSetup.exe')"
