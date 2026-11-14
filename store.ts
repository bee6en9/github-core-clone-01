// The in-memory store: repositories, issues, pull requests, users and orgs,
// all in Maps. No disk I/O on the request path; a fresh process starts empty
// and every check builds what it needs through the API.
//
// Deterministic logical clock: every timestamp the store stamps comes from the
// fixed scenario epoch plus a counter, never from Date.now(). Two runs that
// take the same requests therefore leave the same state.

import { GitRepo } from './git.ts';
import { SCENARIO_EPOCH_SEC, type ScenarioUser } from './scenario.ts';

export interface RepoOwner {
  login: string;
  id: number;
  type: string;
}

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: RepoOwner;
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  fork: boolean;
  forks_count: number;
  stargazers_count: number;
  watchers_count: number;
  open_issues_count: number;
  size: number;
  /** Labels defined in this repo, by name. */
  labels: Map<string, { name: string; color: string }>;
  /** Shared issue + pull-request counter (GitHub numbers both from one sequence), starts at 1. */
  nextNumber: number;
  /** Issue-comment counter within the repo, starts at 1. */
  nextCommentId: number;
  /** Creation order within the owner's repo list (monotonic). */
  seq: number;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  /** Creation order within the repo (monotonic; drives sort=created). */
  seq: number;
  comments: IssueComment[];
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** Head branch tip at creation time; base branch tip at creation time. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** Files changed by the PR, computed at creation from base vs head trees. */
  files: PullFile[];
  /** Creation order within the repo (monotonic). */
  seq: number;
}

/** First id for repositories created through the API (seeded scenario repos use 5000-7999). */
const FIRST_CREATED_REPO_ID = 10000;

export class Store {
  readonly users: Map<string, ScenarioUser>;
  readonly repos: Map<string, Repo>;
  readonly issues: Map<string, Issue[]>;
  readonly pulls: Map<string, Pull[]>;
  /** Per-repository git state (objects + refs), created lazily on first git access. */
  readonly gitRepos: Map<string, GitRepo>;
  private nextRepoId = FIRST_CREATED_REPO_ID;
  private nextRepoSeq = 0;
  private clockTick = 0;

  constructor(users: readonly ScenarioUser[]) {
    this.users = new Map(users.map((user) => [user.login, user]));
    this.repos = new Map();
    this.issues = new Map();
    this.pulls = new Map();
    this.gitRepos = new Map();
  }

  /** The next deterministic timestamp in epoch seconds (one second after the previous). */
  nowSec(): number {
    this.clockTick += 1;
    return SCENARIO_EPOCH_SEC + this.clockTick;
  }

  /** The next deterministic timestamp (ISO-8601), one second after the previous. */
  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** The git state of a repo, created lazily on first git access. */
  getGitRepo(owner: string, name: string): GitRepo {
    const key = this.repoKey(owner, name);
    let git = this.gitRepos.get(key);
    if (git === undefined) {
      git = new GitRepo();
      this.gitRepos.set(key, git);
    }
    return git;
  }

  createRepo(owner: ScenarioUser, name: string, isPrivate: boolean, description: string | null): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      full_name: `${owner.login}/${name}`,
      owner: { login: owner.login, id: owner.id, type: 'User' },
      private: isPrivate,
      description,
      default_branch: 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      fork: false,
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      open_issues_count: 0,
      size: 0,
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextRepoSeq,
    };
    this.nextRepoSeq += 1;
    this.nextRepoId += 1;
    const key = this.repoKey(owner.login, name);
    this.repos.set(key, repo);
    this.issues.set(key, []);
    this.pulls.set(key, []);
    return repo;
  }

  /** The viewer's repositories in creation order (Map insertion order). */
  listReposByOwner(ownerLogin: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.login === ownerLogin) out.push(repo);
    }
    return out;
  }

  listIssues(owner: string, name: string): Issue[] {
    return this.issues.get(this.repoKey(owner, name)) ?? [];
  }

  getIssue(owner: string, name: string, number: number): Issue | undefined {
    return this.listIssues(owner, name).find((issue) => issue.number === number);
  }

  /** Create an issue, taking the next number from the repo's shared issue/PR counter. */
  createIssue(
    owner: string,
    name: string,
    title: string,
    body: string,
    labels: string[],
  ): Issue {
    const repo = this.getRepo(owner, name) as Repo;
    const issue: Issue = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      seq: repo.nextNumber,
      comments: [],
    };
    repo.nextNumber += 1;
    this.listIssues(owner, name).push(issue);
    return issue;
  }

  createLabel(
    owner: string,
    name: string,
    labelName: string,
    color: string,
  ): { name: string; color: string } {
    const repo = this.getRepo(owner, name) as Repo;
    const label = { name: labelName, color };
    repo.labels.set(labelName, label);
    return label;
  }

  getLabel(owner: string, name: string, labelName: string): { name: string; color: string } | undefined {
    return this.getRepo(owner, name)?.labels.get(labelName);
  }

  listPulls(owner: string, name: string): Pull[] {
    return this.pulls.get(this.repoKey(owner, name)) ?? [];
  }

  getPull(owner: string, name: string, number: number): Pull | undefined {
    return this.listPulls(owner, name).find((pull) => pull.number === number);
  }

  /** Create a pull request, taking the next number from the repo's shared issue/PR counter. */
  createPull(
    owner: string,
    name: string,
    title: string,
    body: string,
    head: string,
    base: string,
    headSha: string,
    baseSha: string,
    files: PullFile[],
  ): Pull {
    const repo = this.getRepo(owner, name) as Repo;
    const pull: Pull = {
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      files,
      seq: repo.nextNumber,
    };
    repo.nextNumber += 1;
    this.listPulls(owner, name).push(pull);
    return pull;
  }

  /** Delete a repository and all of its REST + git state. */
  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    const existed = this.repos.delete(key);
    this.issues.delete(key);
    this.pulls.delete(key);
    this.gitRepos.delete(key);
    return existed;
  }
}
