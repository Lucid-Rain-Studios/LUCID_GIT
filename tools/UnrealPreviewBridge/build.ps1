param([Parameter(Mandatory=$true)][string]$EngineRoot)
$ErrorActionPreference='Stop'
$repoRoot=(Resolve-Path "$PSScriptRoot/../..").Path
$buildRoot=Join-Path $repoRoot '.blueprint-build/bridge-host'
$pluginRoot=Join-Path $buildRoot 'Plugins/UnrealPreviewBridge'
New-Item -ItemType Directory -Path "$buildRoot/Source",$pluginRoot -Force | Out-Null
Copy-Item "$PSScriptRoot/UnrealPreviewBridge.uplugin" $pluginRoot -Force
Copy-Item "$PSScriptRoot/Source" $pluginRoot -Recurse -Force
'{"FileVersion":3,"Plugins":[{"Name":"UnrealPreviewBridge","Enabled":true}]}' | Set-Content "$buildRoot/HostProject.uproject"
@'
using UnrealBuildTool;
public class LucidPreviewHostEditorTarget : TargetRules {
 public LucidPreviewHostEditorTarget(TargetInfo Target) : base(Target) {
  Type=TargetType.Editor; DefaultBuildSettings=BuildSettingsVersion.Latest;
  IncludeOrderVersion=EngineIncludeOrderVersion.Latest;
  bBuildAllModules=false; bWithLiveCoding=false; bOverrideBuildEnvironment=true;
  EnablePlugins.Add("UnrealPreviewBridge");
 }
}
'@ | Set-Content "$buildRoot/Source/LucidPreviewHostEditor.Target.cs"
& dotnet "$EngineRoot/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll" LucidPreviewHostEditor Win64 Development "-Project=$buildRoot/HostProject.uproject" -NoUBTMakefiles -NoHotReloadFromIDE -NoEngineChanges -DisablePlugins=CommonGame
if($LASTEXITCODE -ne 0){throw 'Preview bridge build failed'}
$version=Get-Content "$EngineRoot/Engine/Build/Build.version" -Raw | ConvertFrom-Json
$output=Join-Path $PSScriptRoot "bin/$($version.MajorVersion).$($version.MinorVersion)"
New-Item -ItemType Directory -Path "$output/Binaries/Win64" -Force | Out-Null
Copy-Item "$pluginRoot/UnrealPreviewBridge.uplugin" $output -Force
Copy-Item "$pluginRoot/Binaries/Win64/UnrealEditor.modules","$pluginRoot/Binaries/Win64/UnrealEditor-UnrealPreviewBridge.dll" "$output/Binaries/Win64" -Force
