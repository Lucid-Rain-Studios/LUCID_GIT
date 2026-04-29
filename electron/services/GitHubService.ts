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

export interface PRListArgs {
  owner: string
  repo: string
}

async function ghFetch(token: string, path: string, method = 'GET', body?: object): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'LucidGit',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string; errors?: Array<{ message: string }> }
    const msg = err.errors?.[0]?.message ?? err.message ?? `GitHub API error ${res.status}`
    throw new Error(msg)
  }
  return res.json()
}

class GitHubService {
  async createPR(token: string, args: PRCreateArgs): Promise<PRResult> {
    const data = await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls`, 'POST', {
      head: args.head,
      base: args.base,
      title: args.title,
      body: args.body,
      draft: args.draft,
    }) as { number: number; html_url: string; title: string }
    return { number: data.number, htmlUrl: data.html_url, title: data.title }
  }

  async listPRs(token: string, args: PRListArgs): Promise<PullRequest[]> {
    const data = await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`) as Array<{
      number: number; title: string; html_url: string; draft: boolean
      created_at: string; updated_at: string
      user: { login: string }
      head: { ref: string }
      base: { ref: string }
    }>
    return data.map(pr => ({
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
  }

  async mergePR(token: string, args: PRActionArgs): Promise<void> {
    await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}/merge`, 'PUT', {
      merge_method: 'squash',
    })
  }

  async closePR(token: string, args: PRActionArgs): Promise<void> {
    await ghFetch(token, `/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}`, 'PATCH', {
      state: 'closed',
    })
  }
}

export const gitHubService = new GitHubService()
