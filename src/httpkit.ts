// Small HTTP helpers shared by every surface: JSON replies, request ids,
// auth (the single shop token names the viewer), and body reading.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** A request id for every reply (the protocol group requires it): the check only needs it non-empty, so a counter replaces the crypto UUID. */
let requestCounter = 0;
export function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16)}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

/** Read a request body whole (with a generous cap for packs). */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body, or null when it is not valid JSON. */
export function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

export interface Auth {
  /** The viewer, when the request carries the shop token. */
  readonly viewerLogin: string | null;
  /** True when any Authorization header was present. */
  readonly hasToken: boolean;
}

/** The shop token (MAKEFUN_SHOP_TOKEN) names the viewer; anything else is anonymous. */
export function authenticate(req: IncomingMessage): Auth {
  const header = req.headers.authorization ?? '';
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!header) return { viewerLogin: null, hasToken: false };
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!match) return { viewerLogin: null, hasToken: true };
  if (token && match[1] === token) return { viewerLogin: VIEWER.login, hasToken: true };
  return { viewerLogin: null, hasToken: true };
}

/** The path and query of a request URL. */
export function urlParts(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

/** Percent-decode one path segment, or the raw segment when it is not encoded. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
