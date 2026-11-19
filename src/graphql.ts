// The GraphQL v4 surface (POST /api/graphql): viewer, repository, issues,
// pull requests, node ids, mutations and __type introspection, over the
// same in-memory store the REST surface reads — so a mutation over GraphQL
// is visible over REST and vice versa. A small hand-written parser covers
// the fixed document shapes the suite sends (variables, aliases, inline
// fragments, batched arrays); unknown fields are GraphQL errors (HTTP 200
// with an `errors` array naming the field), while a missing token is 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticate, parseJsonBody, readBody, sendJson, urlParts } from './httpkit.ts';
import { VIEWER } from './scenario.ts';
import {
  diffTrees,
  findMergeBase,
  hasMergeConflict,
  mergePullRequest as squashMerge,
} from './store.ts';
import type { Comment, Issue, Pull, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, deterministic — base64url of a typed
// key, never the bare database id or number the checks forbid.
// ---------------------------------------------------------------------------------------------------------

function encodeB64(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeB64(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeB64(`R:${repo.id}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeB64(`I:${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeB64(`P:${repo.id}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return encodeB64(`C:${repo.id}:${issue.number}:${comment.id}`);
}

interface ParsedGlobalId {
  kind: string;
  repoId: number;
  num: number;
  extra: number;
}

function parseGlobalId(id: string): ParsedGlobalId | null {
  const raw = decodeB64(id);
  if (raw === null) return null;
  const m = /^([RIPC]):(\d+)(?::(\d+))?(?::(\d+))?$/.exec(raw);
  if (!m) return null;
  return {
    kind: m[1]!,
    repoId: parseInt(m[2]!, 10),
    num: m[3] !== undefined ? parseInt(m[3], 10) : 0,
    extra: m[4] !== undefined ? parseInt(m[4], 10) : 0,
  };
}

/** Cursor pagination: the cursor names the last index a page returned. */
function encodeCursor(index: number): string {
  return encodeB64(`cur:${index}`);
}

function decodeCursor(cursor: string): number | null {
  const raw = decodeB64(cursor);
  if (raw === null) return null;
  const m = /^cur:(\d+)$/.exec(raw);
  return m ? parseInt(m[1]!, 10) : null;
}

// ---------------------------------------------------------------------------------------------------------
// The document parser (lexer + recursive descent for the suite's shapes).
// ---------------------------------------------------------------------------------------------------------

interface GqlSelection {
  kind: 'field' | 'fragment';
  name: string;
  alias?: string;
  args?: Record<string, unknown>;
  selections?: GqlSelection[];
  typeCondition?: string;
}

interface GqlOperation {
  type: 'query' | 'mutation';
  selections: GqlSelection[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const esc = src[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u' && j + 5 < n) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j]!;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && src[j]! >= '0' && src[j]! <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.' && src[j + 1] !== undefined && src[j + 1]! >= '0' && src[j + 1]! <= '9') {
        isFloat = true;
        j += 1;
        while (j < n && src[j]! >= '0' && src[j]! <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && src[j]! >= '0' && src[j]! <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
  }

  /** Skip a balanced (...) / [...] / {...} run (variable definitions). */
  private skipBalanced(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t.kind === 'punct' && (t.value === '(' || t.value === '[' || t.value === '{')) depth += 1;
      else if (t.kind === 'punct' && (t.value === ')' || t.value === ']' || t.value === '}')) depth -= 1;
      else if (t.kind === 'eof') throw new Error('unterminated variable definitions');
    } while (depth > 0);
  }

  parseDocument(): GqlOperation {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { type: 'query', selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const type = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') this.next(); // operation name
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalanced();
      return { type, selections: this.parseSelectionSet() };
    }
    throw new Error('expected a query or mutation');
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const t = this.peek();
    if (t.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeName = this.next();
        if (typeName.kind !== 'name') throw new Error('expected a type name after on');
        return { kind: 'fragment', name: '', typeCondition: typeName.value, selections: this.parseSelectionSet() };
      }
      throw new Error('named fragment spreads are not supported');
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error(`expected a field name, got ${first.value}`);
    let alias: string | undefined;
    let name = first.value;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      const real = this.next();
      if (real.kind !== 'name') throw new Error('expected a field name after alias');
      alias = name;
      name = real.value;
    }
    let args: Record<string, unknown> | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    let selections: GqlSelection[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated arguments');
      const nameTok = this.next();
      if (nameTok.kind !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args[nameTok.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      const nameTok = this.next();
      if (nameTok.kind !== 'name') throw new Error('expected a variable name');
      return { __var: nameTok.value };
    }
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'float') return parseFloat(t.value);
    if (t.kind === 'punct' && t.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected an object key');
        this.expectPunct(':');
        obj[key.value] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    throw new Error(`unexpected token ${t.value} in a value`);
  }
}

/** Replace variable references and enum markers with their values. */
function resolveVars(value: unknown, vars: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveVars(entry, vars));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.__var === 'string') return vars[record.__var] ?? null;
    if (typeof record.__enum === 'string') return record.__enum;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveVars(entry, vars);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------
// The schema (for __type) and the executor's field tables.
// ---------------------------------------------------------------------------------------------------------

interface SchemaDef {
  kind: 'OBJECT' | 'ENUM';
  fields: string[];
  enumValues?: string[];
}

/** The type surface the introspection probes read (names only; the executor's tables decide what resolves). */
const SCHEMA_TYPES: Record<string, SchemaDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Viewer: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email', 'avatarUrl', 'url', 'repositories'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'labels', 'comments', 'url'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'url'],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  Label: { kind: 'OBJECT', fields: ['name', 'color', 'description'] },
  Node: { kind: 'OBJECT', fields: ['id'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PULL_REQUEST', 'CODE'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues', 'description'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
};

interface GqlCtx {
  store: Store;
  vars: Record<string, unknown>;
}

type GqlObj = { __typename: string; [key: string]: unknown };

type FieldResolver = (obj: GqlObj, args: Record<string, unknown>, ctx: GqlCtx) => { value: unknown; type?: string };

function viewerObj(): GqlObj {
  return { __typename: 'Viewer', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function userObj(login: string): GqlObj {
  const isViewer = login === VIEWER.login;
  return {
    __typename: 'User',
    login,
    id: isViewer ? VIEWER.id : 0,
    name: isViewer ? VIEWER.name : login,
    email: isViewer ? VIEWER.email : '',
  };
}

function repoObj(repo: Repo): GqlObj {
  return { __typename: 'Repository', repo };
}

function refObj(name: string): GqlObj {
  return { __typename: 'Ref', name };
}

function issueObj(repo: Repo, issue: Issue): GqlObj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): GqlObj {
  return { __typename: 'PullRequest', repo, pull };
}

function commentObj(repo: Repo, issue: Issue, comment: Comment): GqlObj {
  return { __typename: 'Comment', repo, issue, comment };
}

/** The issues connection: states filter, CREATED_AT order, cursor paging. */
function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(
      states.map((state) => {
        const upper = String(state).toUpperCase();
        return upper === 'OPEN' ? 'open' : upper === 'CLOSED' ? 'closed' : String(state).toLowerCase();
      }),
    );
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = decodeCursor(args.after);
    if (index !== null) start = index + 1;
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  const endCursor = page.length > 0 ? encodeCursor(start + page.length - 1) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObj(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
    totalCount: list.length,
  };
}

/** The changed files of a pull request (same diff as the REST files view). */
function pullFiles(repo: Repo, pull: Pull, first: number): GqlObj {
  const baseEntries = repo.treeEntriesAt(`refs/heads/${pull.base.ref}`);
  const headEntries = repo.treeEntriesAt(`refs/heads/${pull.head.ref}`);
  const files = diffTrees(baseEntries, headEntries, repo.lookup);
  const sliced = files.slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: sliced.map((file) => ({
      __typename: 'PullRequestChangedFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status.toUpperCase(),
    })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > sliced.length, endCursor: null },
    totalCount: files.length,
  };
}

function mergeableOf(repo: Repo, pull: Pull): string {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = findMergeBase(repo, headTip, baseTip);
  if (!base) return 'UNKNOWN';
  return hasMergeConflict(repo, base, `refs/heads/${pull.base.ref}`, `refs/heads/${pull.head.ref}`)
    ? 'CONFLICTING'
    : 'MERGEABLE';
}

function asRepo(obj: GqlObj): Repo {
  return obj.repo as Repo;
}

function asIssue(obj: GqlObj): Issue {
  return obj.issue as Issue;
}

function asPull(obj: GqlObj): Pull {
  return obj.pull as Pull;
}

const F: Record<string, Record<string, FieldResolver>> = {
  Query: {
    viewer: () => ({ value: viewerObj(), type: 'Viewer' }),
    repository: (_obj, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (owner !== VIEWER.login) return { value: null };
      const repo = ctx.store.getRepo(owner, name);
      return { value: repo ? repoObj(repo) : null, type: 'Repository' };
    },
    node: (_obj, args, ctx) => {
      const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
      if (!parsed) return { value: null };
      const repo = ctx.store.getRepoById(parsed.repoId);
      if (!repo) return { value: null };
      if (parsed.kind === 'R') return { value: repoObj(repo), type: 'Repository' };
      if (parsed.kind === 'I') {
        const issue = repo.issues.find((candidate) => candidate.number === parsed.num);
        return { value: issue ? issueObj(repo, issue) : null, type: 'Issue' };
      }
      if (parsed.kind === 'P') {
        const pull = repo.pulls.find((candidate) => candidate.number === parsed.num);
        return { value: pull ? pullObj(repo, pull) : null, type: 'PullRequest' };
      }
      if (parsed.kind === 'C') {
        const issue = repo.issues.find((candidate) => candidate.number === parsed.num);
        const comment = issue?.comments.find((candidate) => candidate.id === parsed.extra);
        return { value: issue && comment ? commentObj(repo, issue, comment) : null, type: 'Comment' };
      }
      return { value: null };
    },
    __type: (_obj, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      const def = SCHEMA_TYPES[name];
      if (!def) return { value: null };
      return {
        value: {
          __typename: '__Type',
          name,
          kind: def.kind,
          fields: def.fields.map((field) => ({ __typename: '__Field', name: field })),
          enumValues: (def.enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value })),
        },
        type: '__Type',
      };
    },
  },
  Viewer: {
    login: (obj) => ({ value: obj.login as string }),
    id: (obj) => ({ value: obj.id as number }),
    name: (obj) => ({ value: obj.name as string }),
    email: (obj) => ({ value: obj.email as string }),
    avatarUrl: () => ({ value: '' }),
    url: (obj) => ({ value: `https://example.invalid/${String(obj.login)}` }),
  },
  User: {
    login: (obj) => ({ value: obj.login as string }),
    id: (obj) => ({ value: obj.id as number }),
    name: (obj) => ({ value: obj.name as string }),
    email: (obj) => ({ value: obj.email as string }),
    avatarUrl: () => ({ value: '' }),
    url: (obj) => ({ value: `https://example.invalid/${String(obj.login)}` }),
  },
  Repository: {
    id: (obj) => ({ value: repoGlobalId(asRepo(obj)) }),
    databaseId: (obj) => ({ value: asRepo(obj).id }),
    name: (obj) => ({ value: asRepo(obj).name }),
    nameWithOwner: (obj) => ({ value: asRepo(obj).key }),
    owner: (obj) => ({ value: userObj(asRepo(obj).owner), type: 'User' }),
    defaultBranchRef: (obj) => {
      const repo = asRepo(obj);
      return {
        value: repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? refObj(repo.defaultBranch) : null,
        type: 'Ref',
      };
    },
    viewerPermission: () => ({ value: 'ADMIN' }),
    hasIssuesEnabled: () => ({ value: true }),
    description: (obj) => ({ value: asRepo(obj).description }),
    private: (obj) => ({ value: asRepo(obj).isPrivate }),
    createdAt: (obj) => ({ value: asRepo(obj).createdAt }),
    updatedAt: (obj) => ({ value: asRepo(obj).createdAt }),
    url: (obj) => ({ value: `https://example.invalid/${asRepo(obj).key}` }),
    issue: (obj, args) => {
      const repo = asRepo(obj);
      const issue = repo.issues.find((candidate) => candidate.number === args.number);
      return { value: issue ? issueObj(repo, issue) : null, type: 'Issue' };
    },
    issues: (obj, args) => ({ value: issueConnection(asRepo(obj), args), type: 'IssueConnection' }),
    pullRequests: (obj, args) => {
      const repo = asRepo(obj);
      const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
      const nodes = [...repo.pulls].slice(0, first).map((pull) => pullObj(repo, pull));
      return {
        value: {
          __typename: 'PullRequestConnection',
          nodes,
          pageInfo: { __typename: 'PageInfo', hasNextPage: repo.pulls.length > first, endCursor: null },
          totalCount: repo.pulls.length,
        },
        type: 'PullRequestConnection',
      };
    },
    pullRequest: (obj, args) => {
      const repo = asRepo(obj);
      const pull = repo.pulls.find((candidate) => candidate.number === args.number);
      return { value: pull ? pullObj(repo, pull) : null, type: 'PullRequest' };
    },
  },
  Ref: {
    name: (obj) => ({ value: obj.name as string }),
    target: () => ({ value: null }),
  },
  Issue: {
    id: (obj) => ({ value: issueGlobalId(asRepo(obj), asIssue(obj)) }),
    number: (obj) => ({ value: asIssue(obj).number }),
    title: (obj) => ({ value: asIssue(obj).title }),
    body: (obj) => ({ value: asIssue(obj).body }),
    state: (obj) => ({ value: asIssue(obj).state === 'open' ? 'OPEN' : 'CLOSED' }),
    author: () => ({ value: userObj(VIEWER.login), type: 'User' }),
    createdAt: (obj) => ({ value: asIssue(obj).createdAt }),
    updatedAt: (obj) => ({ value: asIssue(obj).updatedAt }),
    url: (obj) => ({ value: `https://example.invalid/${asRepo(obj).key}/issues/${asIssue(obj).number}` }),
  },
  IssueConnection: {
    nodes: (obj) => ({ value: obj.nodes as GqlObj[], type: 'Issue' }),
    pageInfo: (obj) => ({ value: obj.pageInfo as GqlObj, type: 'PageInfo' }),
    totalCount: (obj) => ({ value: obj.totalCount as number }),
    edges: (obj) => ({
      value: (obj.nodes as GqlObj[]).map((node, index) => ({ __typename: 'IssueEdge', node, cursor: encodeCursor(index) })),
      type: 'IssueEdge',
    }),
  },
  IssueEdge: {
    node: (obj) => ({ value: obj.node as GqlObj, type: 'Issue' }),
    cursor: (obj) => ({ value: obj.cursor as string }),
  },
  PageInfo: {
    hasNextPage: (obj) => ({ value: obj.hasNextPage as boolean }),
    hasPreviousPage: () => ({ value: false }),
    startCursor: () => ({ value: null }),
    endCursor: (obj) => ({ value: obj.endCursor as string | null }),
  },
  PullRequest: {
    id: (obj) => ({ value: pullGlobalId(asRepo(obj), asPull(obj)) }),
    number: (obj) => ({ value: asPull(obj).number }),
    title: (obj) => ({ value: asPull(obj).title }),
    body: (obj) => ({ value: asPull(obj).body }),
    state: (obj) => {
      const pull = asPull(obj);
      return { value: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED' };
    },
    merged: (obj) => ({ value: asPull(obj).merged }),
    mergeable: (obj) => ({ value: mergeableOf(asRepo(obj), asPull(obj)) }),
    headRefName: (obj) => ({ value: asPull(obj).head.ref }),
    baseRefName: (obj) => ({ value: asPull(obj).base.ref }),
    headRefOid: (obj) => ({ value: asPull(obj).head.sha }),
    baseRefOid: (obj) => ({ value: asPull(obj).base.sha }),
    files: (obj, args) => {
      const first = typeof args.first === 'number' ? args.first : 100;
      return { value: pullFiles(asRepo(obj), asPull(obj), first), type: 'PullRequestChangedFileConnection' };
    },
    author: () => ({ value: userObj(VIEWER.login), type: 'User' }),
    createdAt: (obj) => ({ value: asPull(obj).createdAt }),
    updatedAt: (obj) => ({ value: asPull(obj).updatedAt }),
    mergedAt: (obj) => ({ value: asPull(obj).mergedAt }),
    url: (obj) => ({ value: `https://example.invalid/${asRepo(obj).key}/pull/${asPull(obj).number}` }),
  },
  PullRequestConnection: {
    nodes: (obj) => ({ value: obj.nodes as GqlObj[], type: 'PullRequest' }),
    pageInfo: (obj) => ({ value: obj.pageInfo as GqlObj, type: 'PageInfo' }),
    totalCount: (obj) => ({ value: obj.totalCount as number }),
    edges: (obj) => ({
      value: (obj.nodes as GqlObj[]).map((node, index) => ({ __typename: 'PullRequestEdge', node, cursor: encodeCursor(index) })),
      type: 'PullRequestEdge',
    }),
  },
  PullRequestEdge: {
    node: (obj) => ({ value: obj.node as GqlObj, type: 'PullRequest' }),
    cursor: (obj) => ({ value: obj.cursor as string }),
  },
  PullRequestChangedFileConnection: {
    nodes: (obj) => ({ value: obj.nodes as GqlObj[], type: 'PullRequestChangedFile' }),
    pageInfo: (obj) => ({ value: obj.pageInfo as GqlObj, type: 'PageInfo' }),
    totalCount: (obj) => ({ value: obj.totalCount as number }),
  },
  PullRequestChangedFile: {
    path: (obj) => ({ value: obj.path as string }),
    additions: (obj) => ({ value: obj.additions as number }),
    deletions: (obj) => ({ value: obj.deletions as number }),
    changeType: (obj) => ({ value: obj.changeType as string }),
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'R' ? ctx.store.getRepoById(parsed.repoId) : undefined;
      if (!repo) throw new Error('repository not found');
      const number = repo.nextIssueNumber;
      repo.nextIssueNumber += 1;
      const stamp = repo.stamp();
      const issue: Issue = {
        id: repo.id * 1_000_000 + number,
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        createdAt: stamp,
        updatedAt: stamp,
        seq: repo.seq,
        comments: [],
      };
      repo.issues.push(issue);
      return { value: { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) }, type: 'CreateIssuePayload' };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      if (parsed === null || parsed.kind !== 'I') throw new Error('issue not found');
      const repo = ctx.store.getRepoById(parsed.repoId);
      const issue = repo?.issues.find((candidate) => candidate.number === parsed.num);
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedAt = repo.stamp();
      return { value: { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue) }, type: 'CloseIssuePayload' };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'R' ? ctx.store.getRepoById(parsed.repoId) : undefined;
      if (!repo) throw new Error('repository not found');
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const headTip = repo.refs.get(`refs/heads/${headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headTip || !baseTip) throw new Error('head or base branch does not exist');
      const number = repo.nextPullNumber;
      repo.nextPullNumber += 1;
      const stamp = repo.stamp();
      const pull: Pull = {
        id: repo.id * 1_000_000 + 500_000 + number,
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
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
      return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull) }, type: 'CreatePullRequestPayload' };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      if (parsed === null || parsed.kind !== 'P') throw new Error('pull request not found');
      const repo = ctx.store.getRepoById(parsed.repoId);
      const pull = repo?.pulls.find((candidate) => candidate.number === parsed.num);
      if (!repo || !pull) throw new Error('pull request not found');
      if (pull.merged || pull.state !== 'open') throw new Error('pull request is already closed');
      const outcome = squashMerge(repo, pull, repo.owner);
      if (outcome.conflict) throw new Error('merge conflict');
      if (!outcome.merged) throw new Error('merge failed');
      return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull) }, type: 'MergePullRequestPayload' };
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      if (parsed === null || parsed.kind !== 'I') throw new Error('subject not found');
      const repo = ctx.store.getRepoById(parsed.repoId);
      const issue = repo?.issues.find((candidate) => candidate.number === parsed.num);
      if (!repo || !issue) throw new Error('subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const id = repo.nextCommentId;
      repo.nextCommentId += 1;
      const comment: Comment = { id, body, createdAt: repo.stamp() };
      issue.comments.push(comment);
      return {
        value: {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'CommentEdge',
            node: commentObj(repo, issue, comment),
            cursor: encodeCursor(issue.comments.length - 1),
          },
        },
        type: 'AddCommentPayload',
      };
    },
  },
  CreateIssuePayload: {
    issue: (obj) => ({ value: obj.issue as GqlObj, type: 'Issue' }),
    clientMutationId: () => ({ value: null }),
  },
  CloseIssuePayload: {
    issue: (obj) => ({ value: obj.issue as GqlObj, type: 'Issue' }),
    clientMutationId: () => ({ value: null }),
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => ({ value: obj.pullRequest as GqlObj, type: 'PullRequest' }),
    clientMutationId: () => ({ value: null }),
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => ({ value: obj.pullRequest as GqlObj, type: 'PullRequest' }),
    clientMutationId: () => ({ value: null }),
  },
  AddCommentPayload: {
    commentEdge: (obj) => ({ value: obj.commentEdge as GqlObj, type: 'CommentEdge' }),
    clientMutationId: () => ({ value: null }),
  },
  CommentEdge: {
    node: (obj) => ({ value: obj.node as GqlObj, type: 'Comment' }),
    cursor: (obj) => ({ value: obj.cursor as string }),
  },
  Comment: {
    id: (obj) => ({ value: commentGlobalId(asRepo(obj), asIssue(obj), obj.comment as Comment) }),
    body: (obj) => ({ value: (obj.comment as Comment).body }),
    author: () => ({ value: userObj(VIEWER.login), type: 'User' }),
    createdAt: (obj) => ({ value: (obj.comment as Comment).createdAt }),
    updatedAt: (obj) => ({ value: (obj.comment as Comment).createdAt }),
    url: (obj) => ({ value: `https://example.invalid/${asRepo(obj).key}/issues/${asIssue(obj).number}#comment-${(obj.comment as Comment).id}` }),
  },
  Label: {
    name: (obj) => ({ value: obj.name as string }),
    color: (obj) => ({ value: obj.color as string }),
    description: () => ({ value: null }),
  },
  __Type: {
    name: (obj) => ({ value: obj.name as string }),
    kind: (obj) => ({ value: obj.kind as string }),
    fields: (obj) => ({ value: obj.fields as GqlObj[], type: '__Field' }),
    enumValues: (obj) => ({ value: obj.enumValues as GqlObj[], type: '__EnumValue' }),
    description: () => ({ value: null }),
  },
  __Field: {
    name: (obj) => ({ value: obj.name as string }),
    description: () => ({ value: null }),
    args: () => ({ value: [] }),
    type: () => ({ value: null }),
  },
  __EnumValue: {
    name: (obj) => ({ value: obj.name as string }),
    description: () => ({ value: null }),
  },
};

/** Walk one selection set against an object of `typeName`, collecting field errors. */
function execSelections(
  typeName: string,
  obj: GqlObj,
  selections: GqlSelection[],
  ctx: GqlCtx,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === undefined || sel.typeCondition === typeName) {
        Object.assign(out, execSelections(typeName, obj, sel.selections ?? [], ctx, errors));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = F[typeName]?.[sel.name];
    if (!resolver) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args = resolveVars(sel.args ?? {}, ctx.vars) as Record<string, unknown>;
    let resolved: { value: unknown; type?: string };
    try {
      resolved = resolver(obj, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    if (sel.selections && resolved.value !== null && resolved.value !== undefined) {
      if (Array.isArray(resolved.value)) {
        out[key] = resolved.value.map((element) =>
          element !== null && typeof element === 'object'
            ? execSelections(resolved.type ?? (element as GqlObj).__typename, element as GqlObj, sel.selections!, ctx, errors)
            : element,
        );
      } else if (typeof resolved.value === 'object') {
        const element = resolved.value as GqlObj;
        out[key] = execSelections(resolved.type ?? element.__typename, element, sel.selections!, ctx, errors);
      } else {
        out[key] = resolved.value;
      }
    } else {
      out[key] = resolved.value ?? null;
    }
  }
  return out;
}

/** Run one operation document ({query, variables}) and answer its envelope. */
function runOperation(body: unknown, store: Store): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'a GraphQL operation must be a JSON object' }] };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.query !== 'string') {
    return { data: null, errors: [{ message: 'the operation needs a query string' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let operation: GqlOperation;
  try {
    operation = new Parser(tokenize(record.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const ctx: GqlCtx = { store, vars: variables };
  const errors: Array<{ message: string }> = [];
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObj = { __typename: rootType };
  const data = execSelections(rootType, root, operation.selections, ctx, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

/**
 * Route a GraphQL request. Returns true when the path was /api/graphql.
 */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const { path } = urlParts(req);
  if (path !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { errors: [{ message: 'GraphQL needs POST' }] });
    return true;
  }
  if (!authenticate(req).viewerLogin) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(await readBody(req));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'request body too large' }] });
    return true;
  }
  if (body === null) {
    sendJson(res, 400, { errors: [{ message: 'request body must be valid JSON' }] });
    return true;
  }
  if (Array.isArray(body)) {
    // GitHub's operation batching: one array in, one array out, in order.
    sendJson(
      res,
      200,
      body.map((operation) => runOperation(operation, store)),
    );
    return true;
  }
  sendJson(res, 200, runOperation(body, store));
  return true;
}
