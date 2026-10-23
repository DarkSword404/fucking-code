export interface GitHubRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRepo(remote: string): GitHubRepo | null {
  const normalized = remote.trim().replace(/\.git$/, "");
  const https = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https) return { owner: https[1]!, repo: https[2]! };
  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  const sshUrl = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (sshUrl) return { owner: sshUrl[1]!, repo: sshUrl[2]! };
  return null;
}

export async function createPullRequest(input: {
  remote: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  token?: string;
}): Promise<{ url: string; number: number } | null> {
  const token = input.token ?? process.env.GITHUB_TOKEN;
  const repo = parseGitHubRepo(input.remote);
  if (!token || !repo) return null;
  const response = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "fucking-code",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        base: input.baseBranch,
        body: input.body,
      }),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub PR creation failed (${response.status}): ${text.slice(0, 500)}`);
  }
  const data = (await response.json()) as { html_url?: string; number?: number };
  if (!data.html_url || !data.number) {
    throw new Error("GitHub PR response did not include html_url/number");
  }
  return { url: data.html_url, number: data.number };
}
