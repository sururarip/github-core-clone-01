// The MCP surface (POST /mcp, Streamable HTTP): the 2026-07-28 era —
// `server/discover` answers identity, capabilities and supported versions
// in one request, no handshake and no session — plus the legacy
// `initialize` handshake for older clients. tools/list offers the forge
// tools; tools/call runs them against the same store the REST and GraphQL
// surfaces read. A missing token is HTTP 401; a body that is not JSON is
// HTTP 400 with JSON-RPC -32700; an unknown tool is JSON-RPC -32602.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticate, readBody, requestId, sendJson, urlParts } from './httpkit.ts';
import { VIEWER } from './scenario.ts';
import { mergePullRequest as squashMerge } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool set: the six the suite needs, plus the natural companions. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'discover',
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
    serverInfo: SERVER_INFO,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

/** A successful tool result: the same JSON as text and as structured content. */
function toolOk(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/** A tool execution failure (the call itself succeeded, the tool did not). */
function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
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

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

/** The repository a tool call names (the viewer's own; anything else is not found). */
function findRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function callTool(name: string, args: Record<string, unknown>, store: Store): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name.trim() : '';
      if (!repoName) return toolErr('create_repo: name is required');
      if (store.getRepo(VIEWER.login, repoName)) return toolErr(`create_repo: repository ${repoName} already exists`);
      const repo = store.createRepo(
        repoName,
        VIEWER.login,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('get_repo: repository not found');
      return toolOk(repoJson(repo));
    }
    case 'list_repos': {
      const repos = store.reposOf(VIEWER.login);
      return toolOk({ repositories: repos.map(repoJson), total_count: repos.length });
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('create_issue: repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return toolErr('create_issue: title is required');
      const number = repo.nextIssueNumber;
      repo.nextIssueNumber += 1;
      const stamp = repo.stamp();
      const issue: Issue = {
        id: repo.id * 1_000_000 + number,
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdAt: stamp,
        updatedAt: stamp,
        seq: repo.seq,
        comments: [],
      };
      repo.issues.push(issue);
      return toolOk(issueJson(issue));
    }
    case 'get_issue': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('get_issue: repository not found');
      const number = asNumber(args.number);
      const issue = number === null ? undefined : repo.issues.find((candidate) => candidate.number === number);
      if (!issue) return toolErr('get_issue: issue not found');
      return toolOk(issueJson(issue));
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('list_issues: repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      return toolOk({ issues: issues.map(issueJson), total_count: issues.length });
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('create_pull_request: repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return toolErr('create_pull_request: title is required');
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (!headTip || !baseTip) return toolErr('create_pull_request: head or base branch does not exist');
      const number = repo.nextPullNumber;
      repo.nextPullNumber += 1;
      const stamp = repo.stamp();
      const pull: Pull = {
        id: repo.id * 1_000_000 + 500_000 + number,
        number,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head: { ref: head, sha: headTip },
        base: { ref: base, sha: baseTip },
        createdAt: stamp,
        updatedAt: stamp,
        seq: repo.seq,
      };
      repo.pulls.push(pull);
      return toolOk(pullJson(pull));
    }
    case 'list_pull_requests': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('list_pull_requests: repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
      return toolOk({ pull_requests: pulls.map(pullJson), total_count: pulls.length });
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('merge_pull_request: repository not found');
      const number = asNumber(args.pull_number);
      const pull = number === null ? undefined : repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return toolErr('merge_pull_request: pull request not found');
      if (pull.merged || pull.state !== 'open') return toolErr('merge_pull_request: pull request is already closed');
      const outcome = squashMerge(repo, pull, repo.owner);
      if (outcome.conflict) return toolErr('merge_pull_request: merge conflict');
      if (!outcome.merged) return toolErr('merge_pull_request: merge failed');
      return toolOk({ merged: true, number: pull.number, sha: outcome.sha, state: pull.state });
    }
    case 'add_comment': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('add_comment: repository not found');
      const number = asNumber(args.issue_number);
      const issue = number === null ? undefined : repo.issues.find((candidate) => candidate.number === number);
      if (!issue) return toolErr('add_comment: issue not found');
      const body = typeof args.body === 'string' ? args.body : '';
      if (!body) return toolErr('add_comment: body is required');
      const id = repo.nextCommentId;
      repo.nextCommentId += 1;
      const comment = { id, body, createdAt: repo.stamp() };
      issue.comments.push(comment);
      return toolOk({ id, body, created_at: comment.createdAt });
    }
    default:
      return toolErr(`unknown tool: ${name}`);
  }
}

/**
 * Route an MCP request. Returns true when the path was /mcp.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const { path } = urlParts(req);
  if (path !== '/mcp') return false;
  const method = req.method ?? 'GET';
  // A legacy session close is a plain 204.
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'MCP needs POST' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': requestId(),
    });
    res.end(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
    return true;
  }
  if (!authenticate(req).viewerLogin) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const record = body as Record<string, unknown>;
  // A notification carries no id: answer 202 with no body.
  if (record.id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }
  const id = record.id as string | number | null;
  const rpcMethod = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;
  switch (rpcMethod) {
    case 'server/discover':
      sendJson(res, 200, rpcResult(id, discoverResult()));
      return true;
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      sendJson(
        res,
        200,
        rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      );
      return true;
    }
    case 'ping':
      sendJson(res, 200, rpcResult(id, {}));
      return true;
    case 'tools/list':
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        sendJson(res, 200, rpcError(id, -32602, `unknown tool: ${name}`));
        return true;
      }
      const missing = tool.inputSchema.required.filter((property) => args[property] === undefined);
      if (missing.length > 0) {
        sendJson(res, 200, rpcResult(id, toolErr(`missing required argument(s): ${missing.join(', ')}`)));
        return true;
      }
      let result: Record<string, unknown>;
      try {
        result = callTool(name, args, store);
      } catch (err) {
        result = toolErr(err instanceof Error ? err.message : String(err));
      }
      sendJson(res, 200, rpcResult(id, result));
      return true;
    }
    default:
      sendJson(res, 200, rpcError(id, -32601, `method not found: ${rpcMethod}`));
      return true;
  }
}
