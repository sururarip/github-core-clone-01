// The server: one process, one in-memory store, four surfaces — git smart
// HTTP, REST v3, GraphQL and MCP — plus the health probe the env boots
// against. A request that no surface claims gets a JSON 404, and a handler
// that throws gets a JSON 500; the process never dies on a bad request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { sendJson, urlParts } from './httpkit.ts';
import { Store } from './store.ts';

export interface ForgeApp {
  readonly server: Server;
  readonly store: Store;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): ForgeApp {
  const store = new Store();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { path } = urlParts(req);
        const method = req.method ?? 'GET';
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (await handleGit(req, res, store)) return;
        if (await handleRest(req, res, store)) return;
        if (await handleGraphql(req, res, store)) return;
        if (await handleMcp(req, res, store)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
  return { server, store };
}
