import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import type { AgentCursorPresence } from '@gitvise/core';
import { fromBase64, toArrayBuffer, toBase64 } from '../shared/bytes';

/** Compact the update log once it grows past this many rows. Keeps replay cheap for late joiners. */
const COMPACT_AFTER_ROWS = 256;
const MAX_UPDATE_BYTES = 1_048_576;

/** Frames sent to subscribers as text WebSocket messages. */
export type RoomFrame =
  | { readonly type: 'yjs-update'; readonly origin: string; readonly update: string }
  | { readonly type: 'presence'; readonly presence: AgentCursorPresence };

interface UpdateRow {
  readonly origin: string;
  readonly body: ArrayBuffer;
  readonly [key: string]: SqlStorageValue;
}

interface UpdateBody {
  readonly origin: string;
  /** Base64-encoded Yjs update. */
  readonly update: string;
}

/**
 * One Durable Object per realtime room. Yjs updates are appended to an embedded SQLite log and
 * broadcast to hibernating WebSocket subscribers. The log is compacted with `Y.mergeUpdates`, so a
 * new subscriber replays a bounded state rather than the full edit history.
 *
 * Presence is ephemeral: it is broadcast but never stored.
 */
export class RealtimeRoom extends DurableObject<unknown> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS yjs_updates (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          origin TEXT NOT NULL,
          body BLOB NOT NULL
        )
      `);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/subscribe' && request.headers.get('upgrade') === 'websocket') {
      return this.subscribe();
    }
    if (url.pathname === '/update' && request.method === 'POST') {
      return this.acceptUpdate(request);
    }
    if (url.pathname === '/presence' && request.method === 'POST') {
      return this.acceptPresence(request);
    }
    return new Response('not found', { status: 404 });
  }

  /** Subscribers only receive. Their messages are ignored. */
  override async webSocketMessage(_socket: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    return;
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    socket.close(code, reason);
  }

  override async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    socket.close(1011, 'room error');
  }

  private subscribe(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Replay the compacted log before accepting, so the subscriber sees state in order.
    const rows = this.sql
      .exec<UpdateRow>('SELECT origin, body FROM yjs_updates ORDER BY seq ASC')
      .toArray();
    this.ctx.acceptWebSocket(server);
    for (const row of rows) {
      const frame: RoomFrame = {
        type: 'yjs-update',
        origin: row.origin,
        update: toBase64(new Uint8Array(row.body)),
      };
      server.send(JSON.stringify(frame));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptUpdate(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<UpdateBody>;
    if (typeof body.origin !== 'string' || typeof body.update !== 'string') {
      return new Response('origin and update are required', { status: 400 });
    }
    const bytes = fromBase64(body.update);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPDATE_BYTES) {
      return new Response('update size is out of range', { status: 413 });
    }

    // SQL calls below run without awaiting, so the append and compaction are atomic for this room.
    this.sql.exec('INSERT INTO yjs_updates (origin, body) VALUES (?, ?)', body.origin, toArrayBuffer(bytes));
    this.compactIfNeeded();

    this.broadcast({ type: 'yjs-update', origin: body.origin, update: body.update });
    return new Response(null, { status: 204 });
  }

  private async acceptPresence(request: Request): Promise<Response> {
    const presence = (await request.json()) as AgentCursorPresence;
    if (typeof presence.agentId !== 'string' || typeof presence.path !== 'string') {
      return new Response('presence is malformed', { status: 400 });
    }
    this.broadcast({ type: 'presence', presence });
    return new Response(null, { status: 204 });
  }

  private compactIfNeeded(): void {
    const count = this.sql.exec<{ readonly n: number }>('SELECT COUNT(*) AS n FROM yjs_updates').one().n;
    if (count <= COMPACT_AFTER_ROWS) return;
    const rows = this.sql.exec<UpdateRow>('SELECT origin, body FROM yjs_updates ORDER BY seq ASC').toArray();
    const merged = Y.mergeUpdates(rows.map((row) => new Uint8Array(row.body)));
    this.sql.exec('DELETE FROM yjs_updates');
    this.sql.exec('INSERT INTO yjs_updates (origin, body) VALUES (?, ?)', 'compaction', toArrayBuffer(merged));
  }

  private broadcast(frame: RoomFrame): void {
    const payload = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, 'send failed');
      }
    }
  }
}
