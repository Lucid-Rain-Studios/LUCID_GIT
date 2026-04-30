# Fixing `git lfs` "Bad credentials" and `Unable to write index` errors (Windows)

This guide is for pull/merge failures like:

- `Smudge error ... batch response: Bad credentials`
- `external filter 'git-lfs filter-process' failed`
- `fatal: ... smudge filter lfs failed`
- `error: Unable to write index`

## What this means

Your teammate is successfully authenticating the **app session**, but Git LFS is still using stale or invalid credentials for the remote that hosts large files. In that state, normal Git auth can appear to work while LFS downloads fail during smudge/checkout.

The follow-up `Unable to write index` is often a secondary symptom after a failed merge/pull, or a local filesystem/lock issue.

## Step-by-step recovery (Windows)

Run these in the repo root in PowerShell or Git Bash.

### 1) Confirm remote and LFS endpoint

```bash
git remote -v
git lfs env
```

Verify the repository URL is the expected account/org and that `Endpoint=` points to the same host.

### 2) Clear cached Git + LFS credentials

```bash
git credential-manager-core erase
printf "protocol=https\nhost=<your-git-host>\n" | git credential-manager-core erase
```

If using Windows Credential Manager UI, remove entries for your Git host (for example, GitHub/Azure/Bitbucket).

### 3) Re-authenticate for the same account that has LFS access

```bash
git fetch --all
git lfs fetch --all
```

When prompted, sign in as the account that has access to the repo's LFS objects.

### 4) Reinstall/repair local LFS hooks and config

```bash
git lfs uninstall
git lfs install
git lfs env
```

### 5) Abort any half-failed merge and clean lock files

```bash
git merge --abort 2>nul || true
rm -f .git/index.lock
```

If `rm` is unavailable in PowerShell, use:

```powershell
Remove-Item .git\index.lock -ErrorAction SilentlyContinue
```

### 6) Retry with explicit LFS pull

```bash
git pull --rebase
git lfs pull
```

If pull still fails, test the exact object path from logs:

```bash
git lfs logs last
git lfs fetch --include="Content/Inferius/AI_Module/Character/Husk/ST_HuskNoEvil.uasset"
```

## Fixing `Unable to write index` specifically

If you still get `error: Unable to write index`:

1. Ensure no other Git process/editor is holding the repo (close IDEs, Lucid Git, terminals using repo).
2. Check write permissions on `.git` directory.
3. Ensure antivirus/ransomware protection is not locking `.git/index`.
4. Verify disk free space.
5. Run:

```bash
git status
git fsck
git gc --prune=now
```

## Team-level prevention

- Standardize authentication method (all PAT, all OAuth device flow, or all SSH where supported).
- Ensure LFS permissions are granted at org/repo level for all contributors.
- Document the canonical remote URL and expected account.
- Consider a short onboarding check:

```bash
git lfs env
git lfs ls-files
```

## Notes for this exact incident

From the provided logs, the user re-authenticated successfully in-app, but LFS still returned `batch response: Bad credentials` for object `a186ac1...`. That strongly suggests cached credentials mismatch specifically for LFS HTTP requests rather than general app login failure.
