# Fixing `git lfs` "Bad credentials" and `Unable to write index` errors (Windows)

This guide is for pull/merge failures like:

- `Smudge error ... batch response: Bad credentials`
- `external filter 'git-lfs filter-process' failed`
- `fatal: ... smudge filter lfs failed`
- `error: Unable to write index`

## Why it works in GitHub Desktop but fails in this app

GitHub Desktop and Lucid Git can use **different Git runtimes, credential helpers, and account sessions** on the same machine.

Typical mismatch pattern:

- GitHub Desktop is signed into account **A** and has a valid token cached for LFS.
- Lucid Git invokes another Git/Git-LFS process that reads cached credentials for account **B** (or an expired token).
- Regular Git API calls can appear authenticated, but LFS `batch` requests fail with `Bad credentials`.

So the issue is usually not your repository content; it is credential/host/account mismatch at the Git+LFS layer used by the app.

## What this means

Your teammate is successfully authenticating the **app session**, but Git LFS is still using stale or invalid credentials for the remote that hosts large files. In that state, normal Git auth can appear to work while LFS downloads fail during smudge/checkout.

The follow-up `Unable to write index` is often a secondary symptom after a failed merge/pull, or a local filesystem/lock issue.


## Interpreting your `git lfs env` output

If you see values like this:

- `LocalWorkingDir=` (empty)
- `LocalGitDir=` (empty)
- `AccessDownload=none`
- `AccessUpload=none`

that usually means the command was executed **outside a valid Git working tree** (or from a context where Git cannot resolve the repo metadata).

In that state, `git lfs env` cannot determine repository-scoped auth/access, so `AccessDownload=none` is not yet a definitive permission verdict.

Run this from inside the repo root and re-check:

```bash
cd "D:\UE5 Projects\LRS_INFERIUS"
git rev-parse --show-toplevel
git remote -v
git lfs env
```

Expected improvement after running in-repo:

- `LocalWorkingDir` and `LocalGitDir` should be populated.
- `Endpoint=` should match your `origin` host.
- Access may resolve based on the active credential.

If `AccessDownload` is still `none` **in-repo**, the credential being used does not have LFS download permission (wrong account/token/scope or wrong host credential selected).

## Step-by-step recovery (Windows)

Run these in the repo root in PowerShell or Git Bash.

### 1) Confirm remote, credential helper, and LFS endpoint

```bash
git remote -v
git config --show-origin --get credential.helper
git lfs env
```

Verify:

- `origin` points to the expected org/repo.
- `credential.helper` is what you expect (typically Git Credential Manager).
- `Endpoint=` in `git lfs env` matches the same host as `origin`.

### 2) Clear cached credentials for your Git host

**Option A (Windows UI):** open Credential Manager → Windows Credentials → remove entries for your Git host.

**Option B (command line):**

```bash
printf "protocol=https\nhost=<your-git-host>\n" | git credential-manager-core erase
```

### 3) Re-authenticate using the account that has LFS access

```bash
git fetch --all
git lfs fetch --all
```

When prompted, sign in as the account that actually has permission to this repo's LFS objects.

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

If pull still fails, inspect the most recent LFS log and test the exact object path:

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

## Quick sanity check to align app vs Desktop

Run this in the same repo from both environments (terminal used by Lucid Git, and terminal launched from GitHub Desktop if available):

```bash
where git
git --version
git config --show-origin --get credential.helper
git lfs env
```

If these differ between environments, normalize them (same Git install, same helper, same signed-in account).

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
