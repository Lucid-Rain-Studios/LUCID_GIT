// Classifying a git command line, and what follows from that classification.
//
// The per-repo gate needs to know whether a command only reads, so it can let
// a user's write pre-empt reads that are going nowhere without ever killing
// something that writes.
//
// This deliberately does NOT drive `--no-optional-locks`. That flag stops git
// writing back its refreshed index, so on a repository where a merge has just
// changed every file's stat data, each status re-hashes all of them through
// the LFS clean filter and the work is never cached — measured at 2658ms
// repeating, against 31ms once git is allowed to persist the refresh. The lock
// it avoids taking is optional in git's own sense: if it cannot be had, git
// skips the write rather than failing. There was nothing to buy.

/**
 * Index of the subcommand in an argument list, skipping leading global options
 * and `-c key=value` pairs. -1 when there is nothing that looks like one.
 */
export function subcommandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    // `-c` takes its value as the next argument, so step over both.
    if (arg === '-c') { i++; continue }
    if (arg.startsWith('-')) continue
    return i
  }
  return -1
}

/**
 * Subcommands that never modify the repository.
 *
 * Deliberately an allowlist. `branch` is absent because `branch --list` reads
 * and `branch -m` does not, and the cost of being wrong is a write treated as
 * a read — which is the one mistake the gate must not make.
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-remote', 'rev-parse',
  'rev-list', 'for-each-ref', 'merge-base', 'cat-file', 'describe',
  'shortlog', 'blame', 'count-objects', 'symbolic-ref', 'check-attr',
  'check-ignore', 'var', 'version',
])

/** True when this command only reads the repository. */
export function isReadOnlyCommand(args: string[]): boolean {
  const i = subcommandIndex(args)
  if (i === -1) return false
  const sub = args[i]
  // `git lfs ls-files` and friends read; anything else under lfs may not.
  if (sub === 'lfs') return args[i + 1] === 'ls-files' || args[i + 1] === 'env'
  return READ_ONLY_SUBCOMMANDS.has(sub)
}
