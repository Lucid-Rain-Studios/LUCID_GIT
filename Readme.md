# Patching for Updates

1) Repository must have Releases enabled/publicly accessible to your users
Your updater is configured to read from GitHub Releases on this repo/owner, so releases must actually exist there and be published.

Go to Repo → Releases and make sure you can create/publish releases.

Don’t leave production releases as draft if you expect clients to detect them.

2) Configure publish credentials for build/release pipeline
To run npm run release (which uses electron-builder --publish always), your environment needs a GitHub token with release upload permission.

If using a PAT (recommended for local/manual releases)
Create a token at:

https://github.com/settings/personal-access-tokens

Give it:

Repository access: the LUCID_GIT repo

Repository permissions: Contents = Read and write
(This is what electron-builder’s GitHub publishing flow uses for release creation/upload per docs.)

Reference:

https://www.electron.build/publish.html

If using GitHub Actions
Set workflow/job permissions:

permissions:
  contents: write
And ensure the workflow uses GITHUB_TOKEN or a PAT secret.

GitHub docs:

https://docs.github.com/actions/security-for-github-actions/security-guides/automatic-token-authentication

3) Add secrets in repo/org settings (if CI-driven)
In Repo → Settings → Secrets and variables → Actions:

GH_TOKEN (or GITHUB_TOKEN depending pipeline)

Optional: GITHUB_RELEASE_TOKEN (electron-builder supports separate token for publish)

Reference:

https://www.electron.build/publish.html

4) Keep versioning discipline (required for updates)
Updates won’t work correctly if you republish same version.

Bump version in package.json every release (or use release:patch / release:minor).

5) Optional but strongly recommended: code signing setup
Not strictly required for update mechanics, but highly recommended for trust/SmartScreen behavior on Windows.
Your config currently has signing disabled.

6) Installer target is already aligned
You’ve kept NSIS installer for Windows, which is good for proper installed-app updates.

Quick checklist you can follow now
Create PAT with Contents: Read and write to repo.

Save as GH_TOKEN secret (or set in local env before npm run release).

Run patch release script (npm run release:patch) or bump version then npm run release.

Verify release is published in GitHub Releases page.

Test in installed app: Settings → Check updates → Download → Restart & Install.