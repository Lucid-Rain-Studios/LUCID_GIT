#pragma once
#include "Kismet/BlueprintFunctionLibrary.h"
#include "LucidPreviewLibrary.generated.h"
class ALevelInstance;
class ULevel;
class UAnimSequence;
class UAnimComposite;
class UAnimationAsset;
class USkeletalMesh;
UCLASS()
class UNREALPREVIEWBRIDGE_API ULucidPreviewLibrary : public UBlueprintFunctionLibrary {
 GENERATED_BODY()
public:
 // Only used in disposable captured preview projects; never saves a package.
 UFUNCTION(BlueprintCallable, Category="Lucid Preview")
 static ULevel* LoadInstance(ALevelInstance* Instance);
 UFUNCTION(BlueprintCallable, Category="Lucid Preview")
 static USkeletalMesh* AnimationPreviewMesh(UAnimationAsset* Animation);
 // Authoring support for the isolated integration fixtures only.
 UFUNCTION(BlueprintCallable, Category="Lucid Preview Tests")
 static UAnimComposite* CreateCompositeFixture(UAnimSequence* First, UAnimSequence* Second);
};
