# Blueprint reader dependencies

UAssetAPI is used at commit `3228c1e86261aa08131f7ec0ff1a395f5d0b2a84` under the MIT license. Its complete LICENSE and NOTICE are distributed beside this file.

Klee is used at commit `3c694f280ea1702624f81e7b0d20b9292d635cc5` under the MIT license. Its complete license is distributed as `blueprint/KLEE-LICENSE.txt` in the renderer resources.

The self-contained helper includes Newtonsoft.Json 13.0.4 (MIT), ZstdSharp.Port 0.8.1 (MIT) and the Microsoft .NET runtime (MIT). Their upstream license and notice sources are:

- https://github.com/JamesNK/Newtonsoft.Json/blob/13.0.4/LICENSE.md
- https://github.com/oleg-st/ZstdSharp/blob/0.8.1/LICENSE
- https://github.com/dotnet/runtime/blob/main/LICENSE.TXT
- https://github.com/dotnet/runtime/blob/main/THIRD-PARTY-NOTICES.TXT

No Epic Games engine source is copied into or distributed with this helper. Native serialization decoding is independently implemented; Unreal Engine is not required at runtime.
