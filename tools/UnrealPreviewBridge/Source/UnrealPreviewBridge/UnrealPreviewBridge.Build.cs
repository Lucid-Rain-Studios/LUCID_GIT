using UnrealBuildTool;
public class UnrealPreviewBridge : ModuleRules {
 public UnrealPreviewBridge(ReadOnlyTargetRules Target) : base(Target) {
  PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
  PublicDependencyModuleNames.AddRange(new[]{"Core","CoreUObject","Engine"});
 }
}
