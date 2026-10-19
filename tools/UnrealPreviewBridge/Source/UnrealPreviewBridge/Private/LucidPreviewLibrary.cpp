#include "LucidPreviewLibrary.h"
#include "LevelInstance/LevelInstanceActor.h"
#include "LevelInstance/LevelInstanceSubsystem.h"
#include "Engine/World.h"
#include "Modules/ModuleManager.h"
#include "Animation/AnimSequence.h"
#include "Animation/AnimComposite.h"
#include "Misc/Paths.h"
IMPLEMENT_MODULE(FDefaultModuleImpl, UnrealPreviewBridge)
ULevel* ULucidPreviewLibrary::LoadInstance(ALevelInstance* Instance) {
 if (!IsRunningCommandlet() || !Instance || !Instance->GetWorld()) return nullptr;
 ULevelInstanceSubsystem* Subsystem = Instance->GetWorld()->GetSubsystem<ULevelInstanceSubsystem>();
 if (!Subsystem) return nullptr;
 Subsystem->BlockLoadLevelInstance(Instance);
 return Instance->GetLoadedLevel();
}
USkeletalMesh* ULucidPreviewLibrary::AnimationPreviewMesh(UAnimationAsset* Animation) {
 return IsRunningCommandlet() && Animation ? Animation->GetPreviewMesh() : nullptr;
}
UAnimComposite* ULucidPreviewLibrary::CreateCompositeFixture(UAnimSequence* First, UAnimSequence* Second) {
 FString Project=FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()); Project.ReplaceInline(TEXT("\\"),TEXT("/"));
 if (!IsRunningCommandlet() || !Project.Contains(TEXT("/.blueprint-build/")) || !First || !Second || First->GetSkeleton()!=Second->GetSkeleton()) return nullptr;
 UPackage* Package=CreatePackage(TEXT("/Game/SocketComposite"));
 if (FindObject<UObject>(Package,TEXT("SocketComposite"))) return nullptr;
 UAnimComposite* Composite=NewObject<UAnimComposite>(Package,TEXT("SocketComposite"),RF_Public|RF_Standalone);
 Composite->SetSkeleton(First->GetSkeleton());
 Composite->SetPreviewMesh(First->GetPreviewMesh());
 FAnimSegment A; A.SetAnimReference(First,true); A.StartPos=0; A.AnimStartTime=0; A.AnimEndTime=First->GetPlayLength(); A.AnimPlayRate=1; A.LoopingCount=1;
 FAnimSegment B; B.SetAnimReference(Second,true); B.StartPos=A.AnimEndTime; B.AnimStartTime=0; B.AnimEndTime=Second->GetPlayLength(); B.AnimPlayRate=1; B.LoopingCount=1;
 Composite->AnimationTrack.AnimSegments={A,B}; Composite->SetCompositeLength(A.AnimEndTime+B.AnimEndTime);
 Composite->MarkPackageDirty();
 return Composite;
}
