/**
 * /state HTTP routes — the dev harness's workspace persistence, backed by the
 * shared ~/.chorus profile tree. Request/response fits load/save better than
 * the PTY websocket (no correlation ids, no wait-for-open races), so the
 * server speaks both: ws for terminals, HTTP for state.
 */
import type http from 'node:http';
import { parseWorkspaceState, type Persistence } from '@app/core';

// Vite serves the page from a different port than this server — permissive
// CORS is fine for a localhost dev harness.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
} as const;

/**
 * Handle `GET/PUT/OPTIONS /state`. Returns false when the URL is not /state
 * so the caller can 404. GET answers 204 when the store is empty; PUT
 * validates with parseWorkspaceState and rejects garbage with 400 rather
 * than persisting it.
 */
export async function handleStateRequest(
  store: Persistence,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if ((req.url ?? '').split('?')[0] !== '/state') return false;
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  switch (req.method) {
    case 'OPTIONS': {
      res.statusCode = 204;
      res.end();
      return true;
    }
    case 'GET': {
      const state = await store.load();
      if (state === null) {
        res.statusCode = 204;
        res.end();
      } else {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(state));
      }
      return true;
    }
    case 'PUT': {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let state = null;
      try {
        state = parseWorkspaceState(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
      } catch {
        // fall through to 400
      }
      if (!state) {
        res.statusCode = 400;
        res.end();
        return true;
      }
      await store.save(state);
      res.statusCode = 204;
      res.end();
      return true;
    }
    default: {
      res.statusCode = 405;
      res.end();
      return true;
    }
  }
}
