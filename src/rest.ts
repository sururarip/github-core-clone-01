// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, plus the protocol rules (JSON
// everywhere, a request id on every reply, message-bearing error bodies).
// Written from the checks' exact expectations, not from any existing API.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authenticate,
  decodeSegment,
  parseJsonBody,
  readBody,
  requestId,
  sendJson,
  urlParts,
} from './httpkit.ts';
import { parseCommit } from './gitcore.ts';
import { VIEWER } from './scenario.ts';
import { diffTrees, mergePullRequest } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

const API = '/api/v3';

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

/** The repo a REST call names, with the viewer/foreign/auth rules applied. */
function repoFor(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
): Repo | null {
  if (owner !== VIEWER.login) {
    notFound(res);
    return null;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return null;
  }
  if (!authenticate(req).viewerLogin) {
    unauthorized(res);
    return null;
  }
  return repo;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.key,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** Parse a page of query params the way the list endpoints use them. */
function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

/** Slice a list into one page and build the Link header for the next page. */
function paginate<T>(
  items: readonly T[],
  perPage: number,
  page: number,
  req: IncomingMessage,
  path: string,
  query: URLSearchParams,
): { page: T[]; link: string | undefined } {
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | undefined;
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('per_page', String(perPage));
    next.set('page', String(page + 1));
    const host = req.headers.host ?? 'entry';
    link = `<http://${host}${path}?${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

/**
 * Route a REST v3 request. Returns true when the path was under /api/v3
 * (handled or 404'd); false when it is not a REST path at all.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const { path, query } = urlParts(req);
  if (!path.startsWith(API)) return false;
  const method = req.method ?? 'GET';
  const auth = authenticate(req);

  // The API root and meta are public.
  if ((path === `${API}` || path === `${API}/`) && method === 'GET') {
    sendJson(
      res,
      200,
      { current_user_url: `${API}/user`, rate_limit_url: `${API}/rate_limit` },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }
  if (path === `${API}/meta` && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // The viewer.
  if (path === `${API}/user` && method === 'GET') {
    if (!auth.viewerLogin) {
      unauthorized(res);
      return true;
    }
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
    return true;
  }

  // Create a repository.
  if (path === `${API}/user/repos` && method === 'POST') {
    if (!auth.viewerLogin) {
      unauthorized(res);
      return true;
    }
    let body: unknown;
    try {
      body = parseJsonBody(await readBody(req));
    } catch {
      badRequest(res, 'request body too large');
      return true;
    }
    if (body === null || typeof body !== 'object') {
      badRequest(res, 'malformed JSON body');
      return true;
    }
    const record = body as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) {
      unprocessable(res, 'name is required');
      return true;
    }
    if (store.getRepo(VIEWER.login, name)) {
      unprocessable(res, 'name already exists on this account');
      return true;
    }
    const repo = store.createRepo(
      name,
      VIEWER.login,
      typeof record.description === 'string' ? record.description : '',
      record.private !== false,
    );
    sendJson(res, 201, repoJson(repo));
    return true;
  }

  // List the viewer's repositories (paginated).
  if (path === `${API}/user/repos` && method === 'GET') {
    if (!auth.viewerLogin) {
      unauthorized(res);
      return true;
    }
    const { perPage, page } = pageParams(query);
    const repos = store.reposOf(VIEWER.login);
    const { page: slice, link } = paginate(repos, perPage, page, req, path, query);
    sendJson(res, 200, slice.map(repoJson), link ? { link } : {});
    return true;
  }

  // Everything below is /repos/{owner}/{name}[...].
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const owner = decodeSegment(repoMatch[1] ?? '');
  const repoName = decodeSegment(repoMatch[2] ?? '');
  const rest = repoMatch[3] ?? '';

  // The repository itself.
  if (rest === '') {
    if (method === 'GET') {
      const repo = repoFor(req, res, store, owner, repoName);
      if (!repo) return true;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = repoFor(req, res, store, owner, repoName);
      if (!repo) return true;
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        badRequest(res, 'request body too large');
        return true;
      }
      if (body === null || typeof body !== 'object') {
        badRequest(res, 'malformed JSON body');
        return true;
      }
      const record = body as Record<string, unknown>;
      if (typeof record.description === 'string') repo.description = record.description;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = repoFor(req, res, store, owner, repoName);
      if (!repo) return true;
      store.repos.delete(repo.key);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Branches.
  if (rest === 'branches' && method === 'GET') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const branches = repo
      .sortedRefs()
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
    sendJson(res, 200, branches);
    return true;
  }

  // Create a ref.
  if (rest === 'git/refs' && method === 'POST') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    let body: unknown;
    try {
      body = parseJsonBody(await readBody(req));
    } catch {
      badRequest(res, 'request body too large');
      return true;
    }
    if (body === null || typeof body !== 'object') {
      badRequest(res, 'malformed JSON body');
      return true;
    }
    const record = body as Record<string, unknown>;
    const ref = typeof record.ref === 'string' ? record.ref : '';
    const sha = typeof record.sha === 'string' ? record.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha) || !repo.objects.has(sha.toLowerCase())) {
      unprocessable(res, 'invalid ref or sha');
      return true;
    }
    if (repo.refs.has(ref)) {
      unprocessable(res, 'ref already exists');
      return true;
    }
    repo.refs.set(ref, sha.toLowerCase());
    sendJson(res, 201, { ref, object: { sha: sha.toLowerCase() } });
    return true;
  }

  // Commits.
  if (rest === 'commits' && method === 'GET') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const shaParam = query.get('sha');
    const ref = shaParam ? `refs/heads/${shaParam}` : `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(ref);
    const commits: Array<Record<string, unknown>> = [];
    if (tip) {
      for (const oid of repo.ancestry(ref)) {
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const parsed = parseCommit(object.data);
        // Git stores the message with a trailing newline; the API
        // presents the message as it was submitted, without it.
        const message = parsed.message.endsWith('\n') ? parsed.message.slice(0, -1) : parsed.message;
        commits.push({
          sha: oid,
          commit: {
            message,
            author: { name: parsed.author.split(' <')[0] ?? '', email: VIEWER.email },
            committer: { name: parsed.committer.split(' <')[0] ?? '', email: VIEWER.email },
          },
        });
      }
    }
    sendJson(res, 200, commits);
    return true;
  }

  // Contents (the path may contain slashes).
  if (rest.startsWith('contents/')) {
    const contentPath = rest.slice('contents/'.length).split('/').map(decodeSegment).join('/');
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    if (method === 'GET') {
      const refParam = query.get('ref');
      const ref = refParam ? `refs/heads/${refParam}` : `refs/heads/${repo.defaultBranch}`;
      const file = repo.fileAt(ref, contentPath);
      if (file) {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: file.data.toString('base64'),
          sha: file.oid,
          size: file.data.length,
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
        });
        return true;
      }
      // A directory: the entries directly under this path.
      const entries = repo.treeEntriesAt(ref);
      const prefix = contentPath ? `${contentPath}/` : '';
      const children = new Map<string, { type: string; sha: string }>();
      for (const [pathKey, entry] of entries) {
        if (!pathKey.startsWith(prefix)) continue;
        const remainder = pathKey.slice(prefix.length);
        const first = remainder.split('/')[0] ?? '';
        if (!first) continue;
        if (remainder.includes('/')) {
          if (!children.has(first)) children.set(first, { type: 'dir', sha: entry.oid });
        } else {
          children.set(first, { type: 'file', sha: entry.oid });
        }
      }
      if (children.size === 0) {
        notFound(res);
        return true;
      }
      const listing = [...children.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, child]) => ({
          type: child.type,
          name,
          path: prefix + name,
          sha: child.sha,
        }));
      sendJson(res, 200, listing);
      return true;
    }
    if (method === 'PUT') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        badRequest(res, 'request body too large');
        return true;
      }
      if (body === null || typeof body !== 'object') {
        badRequest(res, 'malformed JSON body');
        return true;
      }
      const record = body as Record<string, unknown>;
      const message = typeof record.message === 'string' ? record.message : 'Update file';
      const content = typeof record.content === 'string' ? record.content : '';
      const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
      const sha = typeof record.sha === 'string' ? record.sha.toLowerCase() : undefined;
      let data: Buffer;
      try {
        data = Buffer.from(content, 'base64');
      } catch {
        badRequest(res, 'content is not valid base64');
        return true;
      }
      const ref = `refs/heads/${branch}`;
      const existing = repo.fileAt(ref, contentPath);
      if (sha === undefined && existing) {
        sendJson(res, 409, { message: 'file already exists' });
        return true;
      }
      if (sha !== undefined) {
        if (!existing) {
          notFound(res);
          return true;
        }
        if (existing.oid !== sha) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
      }
      const result = repo.commitFile({ branch, path: contentPath, data, message });
      sendJson(
        res,
        sha === undefined ? 201 : 200,
        {
          content: { sha: result.blobOid, encoding: 'base64' },
          commit: { sha: result.commitOid },
        },
      );
      return true;
    }
    if (method === 'DELETE') {
      let body: unknown;
      try {
        body = parseJsonBody(await readBody(req));
      } catch {
        badRequest(res, 'request body too large');
        return true;
      }
      if (body === null || typeof body !== 'object') {
        badRequest(res, 'malformed JSON body');
        return true;
      }
      const record = body as Record<string, unknown>;
      const message = typeof record.message === 'string' ? record.message : 'Delete file';
      const sha = typeof record.sha === 'string' ? record.sha.toLowerCase() : '';
      const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
      const ref = `refs/heads/${branch}`;
      const existing = repo.fileAt(ref, contentPath);
      if (!existing) {
        notFound(res);
        return true;
      }
      if (sha && existing.oid !== sha) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return true;
      }
      const result = repo.commitFile({ branch, path: contentPath, data: null, message });
      sendJson(res, 200, { commit: { sha: result.commitOid } });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Labels.
  if (rest === 'labels' && method === 'POST') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    let body: unknown;
    try {
      body = parseJsonBody(await readBody(req));
    } catch {
      badRequest(res, 'request body too large');
      return true;
    }
    if (body === null || typeof body !== 'object') {
      badRequest(res, 'malformed JSON body');
      return true;
    }
    const record = body as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (!name) {
      unprocessable(res, 'name is required');
      return true;
    }
    const color = typeof record.color === 'string' ? record.color : 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color });
    return true;
  }

  // Issues.
  if (rest === 'issues' && method === 'POST') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    let body: unknown;
    try {
      body = parseJsonBody(await readBody(req));
    } catch {
      badRequest(res, 'request body too large');
      return true;
    }
    if (body === null || typeof body !== 'object') {
      badRequest(res, 'malformed JSON body');
      return true;
    }
    const record = body as Record<string, unknown>;
    const labels = Array.isArray(record.labels) ? (record.labels as unknown[]).map(String) : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) {
        unprocessable(res, `label ${label} does not exist`);
        return true;
      }
    }
    const number = repo.nextIssueNumber;
    repo.nextIssueNumber += 1;
    const stamp = repo.stamp();
    const issue: Issue = {
      id: repo.id * 1_000_000 + number,
      number,
      title: typeof record.title === 'string' ? record.title : '',
      body: typeof record.body === 'string' ? record.body : '',
      state: 'open',
      labels,
      createdAt: stamp,
      updatedAt: stamp,
      seq: repo.seq,
      comments: [],
    };
    repo.issues.push(issue);
    sendJson(res, 201, issueJson(issue));
    return true;
  }
  if (rest === 'issues' && method === 'GET') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    let issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
    if (sort === 'created') {
      issues = [...issues].sort((a, b) =>
        direction === 'asc' ? a.seq - b.seq : b.seq - a.seq,
      );
    }
    const { perPage, page } = pageParams(query);
    const { page: slice, link } = paginate(issues, perPage, page, req, path, query);
    sendJson(res, 200, slice.map(issueJson), link ? { link } : {});
    return true;
  }
  const issueMatch = /^issues\/(\d+)$/.exec(rest);
  if (issueMatch && (method === 'GET' || method === 'PATCH')) {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const number = parseInt(issueMatch[1] ?? '0', 10);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (!issue) {
      notFound(res);
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(issue));
      return true;
    }
    let body: unknown;
    try {
      body = parseJsonBody(await readBody(req));
    } catch {
      badRequest(res, 'request body too large');
      return true;
    }
    if (body === null || typeof body !== 'object') {
      badRequest(res, 'malformed JSON body');
      return true;
    }
    const record = body as Record<string, unknown>;
    if (typeof record.state === 'string' && (record.state === 'open' || record.state === 'closed')) {
      issue.state = record.state;
    }
    if (typeof record.title === 'string') issue.title = record.title;
    if (typeof record.body === 'string') issue.body = record.body;
    issue.updatedAt = repo.stamp();
    sendJson(res, 200, issueJson(issue));
    return true;
  }
  const commentMatch = /^issues\/(\d+)\/comments$/.exec(rest);
  if (commentMatch && (method === 'POST' || method === 'GET')) {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const number = parseInt(commentMatch[1] ?? '0', 10);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (!issue) {
      notFound(res);
      return true;
    }
    if (method === 'GET') {
      sendJson(
        res,
        200,
        issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt })),
      );
      return true;
    }
    let body: unknown;
    try {
      body = parseJsonBody(await readBody(req));
    } catch {
      badRequest(res, 'request body too large');
      return true;
    }
    if (body === null || typeof body !== 'object') {
      badRequest(res, 'malformed JSON body');
      return true;
    }
    const record = body as Record<string, unknown>;
    const commentBody = typeof record.body === 'string' ? record.body : '';
    const id = repo.nextCommentId;
    repo.nextCommentId += 1;
    const comment = { id, body: commentBody, createdAt: repo.stamp() };
    issue.comments.push(comment);
    sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt });
    return true;
  }

  // Pull requests.
  if (rest === 'pulls' && method === 'POST') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    let body: unknown;
    try {
      body = parseJsonBody(await readBody(req));
    } catch {
      badRequest(res, 'request body too large');
      return true;
    }
    if (body === null || typeof body !== 'object') {
      badRequest(res, 'malformed JSON body');
      return true;
    }
    const record = body as Record<string, unknown>;
    const headRef = typeof record.head === 'string' ? record.head : '';
    const baseRef = typeof record.base === 'string' ? record.base : repo.defaultBranch;
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headTip || !baseTip) {
      unprocessable(res, 'head or base branch does not exist');
      return true;
    }
    const number = repo.nextPullNumber;
    repo.nextPullNumber += 1;
    const stamp = repo.stamp();
    const pull: Pull = {
      id: repo.id * 1_000_000 + 500_000 + number,
      number,
      title: typeof record.title === 'string' ? record.title : '',
      body: typeof record.body === 'string' ? record.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: headRef, sha: headTip },
      base: { ref: baseRef, sha: baseTip },
      createdAt: stamp,
      updatedAt: stamp,
      seq: repo.seq,
    };
    repo.pulls.push(pull);
    sendJson(res, 201, pullJson(pull));
    return true;
  }
  if (rest === 'pulls' && method === 'GET') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const state = query.get('state') ?? 'open';
    const pulls = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
    const { perPage, page } = pageParams(query);
    const { page: slice, link } = paginate(pulls, perPage, page, req, path, query);
    sendJson(res, 200, slice.map(pullJson), link ? { link } : {});
    return true;
  }
  const pullFilesMatch = /^pulls\/(\d+)\/files$/.exec(rest);
  if (pullFilesMatch && method === 'GET') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const number = parseInt(pullFilesMatch[1] ?? '0', 10);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (!pull) {
      notFound(res);
      return true;
    }
    const baseEntries = repo.treeEntriesAt(`refs/heads/${pull.base.ref}`);
    const headEntries = repo.treeEntriesAt(`refs/heads/${pull.head.ref}`);
    const files = diffTrees(baseEntries, headEntries, repo.lookup);
    sendJson(
      res,
      200,
      files.map((file) => ({
        filename: file.filename,
        status: file.status === 'removed' ? 'removed' : file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    );
    return true;
  }
  const pullMergeMatch = /^pulls\/(\d+)\/merge$/.exec(rest);
  if (pullMergeMatch && method === 'PUT') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const number = parseInt(pullMergeMatch[1] ?? '0', 10);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (!pull) {
      notFound(res);
      return true;
    }
    if (pull.merged || pull.state !== 'open') {
      sendJson(res, 405, { message: 'pull request is already closed' });
      return true;
    }
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    if (!headTip || !baseTip) {
      notFound(res);
      return true;
    }
    const outcome = mergePullRequest(repo, pull, owner);
    if (outcome.conflict) {
      sendJson(res, 405, { message: 'merge conflict' });
      return true;
    }
    if (!outcome.merged || !outcome.sha) {
      sendJson(res, 409, { message: 'merge failed' });
      return true;
    }
    const message = `Merge pull request #${pull.number} from ${owner}/${pull.head.ref}\n\n${pull.title}`;
    sendJson(res, 200, { merged: true, sha: outcome.sha, message });
    return true;
  }
  const pullMatch = /^pulls\/(\d+)$/.exec(rest);
  if (pullMatch && method === 'GET') {
    const repo = repoFor(req, res, store, owner, repoName);
    if (!repo) return true;
    const number = parseInt(pullMatch[1] ?? '0', 10);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (!pull) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, pullJson(pull));
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}
