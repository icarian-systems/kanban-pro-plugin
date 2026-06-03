/**
 * GitHub Issues sync — roadmap feature (post-1.0).
 *
 * Architecture: @octokit/core with a custom requestUrl adapter, OAuth via
 * registerObsidianProtocolHandler. None of that is implemented yet — this
 * stub exists so the settings UI can compile and surface a "Roadmap"
 * placeholder.
 */

export interface GitHubConfig {
  owner: string;
  repo: string;
  token?: string;
}

export function connectGitHub(_cfg: GitHubConfig): Promise<never> {
  return Promise.reject(
    new Error(
      'GitHub sync is a roadmap feature — see https://github.com/kanban-pro/issues for the tracking issue.',
    ),
  );
}
