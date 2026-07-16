import { logService } from './LogService'

export interface PRCreateArgs {
  owner: string
  repo: string
  head: string
  base: string
  title: string
  body: string
  draft: boolean
}

export interface PRResult {
  number: number
  htmlUrl: string
  title: string
}

export interface PullRequest {
  number: number
  title: string
  htmlUrl: string
  author: string
  headBranch: string
  baseBranch: string
  draft: boolean
  createdAt: string
  updatedAt: string
}

export interface PRActionArgs {
  owner: string
  repo: string
  prNumber: number
}

export interface PRStatus {
  number: number
  state: 'open' | 'closed'
  merged: boolean
  title: string
}

export interface PRListArgs {
  owner: string
  repo: string
}

// Error carrying the HTTP status so callers can tell transient failures
// (5xx outage, 429 rate limit, network unreachable → status undefined)
// apart from real ones (401/403/404/422).
export class GitHubApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'GitHubApiError'
  }
  get isTransient(): boolean {
    return this.status === undefined || this.status >= 500 || this.status === 429
  }
}

async function ghFetch(token: string, path: string, method = 'GET', body?: object): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'LucidGit',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    throw new GitHubApiError(
      `GitHub API unreachable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string; errors?: Array<{ message: string }> }
    const msg = err.errors?.[0]?.message ?? err.message ?? `GitHub API error ${res.status}`
    throw new GitHubApiError(msg, res.status)
  }
  return res.json()
}

// Successful PR-list responses are reused for this long. Several UI surfaces
// (sidebar, overview, dashboard, PR monitor, lock overlay) poll the same
// endpoint independently; this collapses them into ~2 requests/minute.
const PR_LIST_TTL_MS = 20 * 1000

class GitHubService {
  // `${owner}/${repo}` → last successfully fetched open-PR list. Serves two
  // purposes: a short-TTL response cache for the many independent pollers,
  // and a stale fallback when GitHub is temporarily down so the UI degrades
  // to old data instead of surfacing an error every cycle.
  private lastGoodPRs = new Map<string, { prs: PullRequest[]; fetchedAt: number }>()
  // `${owner}/${repo}` → in-flight request shared by concurrent callers
  private prListInFlight = new Map<string, Promise<PullRequest[]>>()

  async createPR(token: string, args: PRCreateArgs): Promise<PRResult> {
    const data = await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls`, 'POST', {
      head: args.head,
      base: args.base,
      title: args.title,
      body: args.body,
      draft: args.draft,
    }) as { number: number; html_url: string; title: string }
    this.expirePRCache(args.owner, args.repo)
    return { number: data.number, htmlUrl: data.html_url, title: data.title }
  }

  // Mark the cached PR list stale (without discarding it — it stays available
  // as the outage fallback) so the next listPRs after a mutation refetches.
  private expirePRCache(owner: string, repo: string): void {
    const entry = this.lastGoodPRs.get(`${owner}/${repo}`)
    if (entry) entry.fetchedAt = 0
  }

  async listPRs(token: string, args: PRListArgs): Promise<PullRequest[]> {
    const cacheKey = `${args.owner}/${args.repo}`

    const cached = this.lastGoodPRs.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < PR_LIST_TTL_MS) return cached.prs

    let inFlight = this.prListInFlight.get(cacheKey)
    if (!inFlight) {
      inFlight = this.fetchPRs(token, args, cacheKey)
        .finally(() => this.prListInFlight.delete(cacheKey))
      this.prListInFlight.set(cacheKey, inFlight)
    }
    return inFlight
  }

  private async fetchPRs(token: string, args: PRListArgs, cacheKey: string): Promise<PullRequest[]> {
    let data: Array<{
      number: number; title: string; html_url: string; draft: boolean
      created_at: string; updated_at: string
      user: { login: string }
      head: { ref: string }
      base: { ref: string }
    }>
    try {
      data = await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`) as typeof data
    } catch (error) {
      // Transient failure (5xx outage, rate limit, network blip): serve the
      // last-known-good list so the UI degrades to stale data rather than an
      // error banner on every poll cycle. Real errors still propagate.
      const stale = this.lastGoodPRs.get(cacheKey)
      if (error instanceof GitHubApiError && error.isTransient && stale) {
        logService.warn('github.listPRs', `GitHub unavailable (${error.message}) — serving ${stale.prs.length} cached PRs for ${cacheKey}`)
        return stale.prs
      }
      throw error
    }
    const prs = data.map(pr => ({
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      author: pr.user.login,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      draft: pr.draft,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    }))
    this.lastGoodPRs.set(cacheKey, { prs, fetchedAt: Date.now() })
    return prs
  }

  async mergePR(token: string, args: PRActionArgs): Promise<void> {
    // 'merge' creates a merge commit and preserves every commit on the source
    // branch — matching GitHub Desktop's default and the local merge() path
    // (which uses --no-ff). 'squash' would collapse the source branch into a
    // single commit on main, hiding the original commit history.
    await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}/merge`, 'PUT', {
      merge_method: 'merge',
    })
    this.expirePRCache(args.owner, args.repo)
  }

  async closePR(token: string, args: PRActionArgs): Promise<void> {
    await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}`, 'PATCH', {
      state: 'closed',
    })
    this.expirePRCache(args.owner, args.repo)
  }

  async getPRFiles(token: string, args: PRActionArgs): Promise<string[]> {
    const data = await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}/files?per_page=100`) as Array<{ filename: string }>
    return data.map(f => f.filename.replace(/\\/g, '/'))
  }

  async getPRStatus(token: string, args: PRActionArgs): Promise<PRStatus> {
    const data = await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}`) as {
      number: number; state: string; merged: boolean; title: string
    }
    return {
      number: data.number,
      state:  data.state as 'open' | 'closed',
      merged: !!data.merged,
      title:  data.title,
    }
  }
}

export const gitHubService = new GitHubService()
