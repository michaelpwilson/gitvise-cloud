import {
  GitViseError,
  type AgentCursorPresence,
  type RealtimeEvent,
  type RealtimeRoomRef,
  type RealtimeSyncPort,
} from '@gitvise/core';
import type { RealtimeRoom, RoomFrame } from './realtime-room';
import { fromBase64, toBase64 } from '../shared/bytes';
import { upstreamError } from '../shared/errors';

const ROOM_ORIGIN = 'https://room.internal';

/**
 * `RealtimeSyncPort` backed by one `RealtimeRoom` Durable Object per `worktreeId:roomId`. Publishing
 * is a single HTTP call into the room. Subscribing opens a hibernating WebSocket and maps its frames
 * to `RealtimeEvent`s.
 */
export class CloudflareDurableRealtimeAdapter implements RealtimeSyncPort {
  constructor(private readonly rooms: DurableObjectNamespace<RealtimeRoom>) {}

  async publishUpdate(room: RealtimeRoomRef, update: Uint8Array, origin: string): Promise<void> {
    if (update.byteLength === 0) throw new GitViseError('INVALID_REQUEST', 'update is empty');
    await this.post(room, '/update', { origin, update: toBase64(update) });
  }

  async publishPresence(room: RealtimeRoomRef, presence: AgentCursorPresence): Promise<void> {
    await this.post(room, '/presence', presence);
  }

  subscribe(room: RealtimeRoomRef): ReadableStream<RealtimeEvent> {
    const stub = this.stubFor(room);
    let socket: WebSocket | undefined;

    return new ReadableStream<RealtimeEvent>({
      start: async (controller) => {
        let response: Response;
        try {
          response = await stub.fetch(`${ROOM_ORIGIN}/subscribe`, { headers: { upgrade: 'websocket' } });
        } catch (error) {
          controller.error(upstreamError('subscribing to realtime room failed', error));
          return;
        }
        const opened = response.webSocket;
        if (opened === null || opened === undefined) {
          controller.error(upstreamError(`realtime room refused subscription (${response.status})`));
          return;
        }
        opened.accept();
        socket = opened;

        opened.addEventListener('message', (event) => {
          const frame = parseFrame(event.data);
          if (frame === undefined) return;
          controller.enqueue(toEvent(room, frame));
        });
        opened.addEventListener('close', () => {
          try {
            controller.close();
          } catch {
            // Already cancelled.
          }
        });
        opened.addEventListener('error', () => {
          try {
            controller.error(upstreamError('realtime subscription failed'));
          } catch {
            // Already cancelled.
          }
        });
      },
      cancel: () => {
        socket?.close(1000, 'unsubscribed');
      },
    });
  }

  private stubFor(room: RealtimeRoomRef): DurableObjectStub<RealtimeRoom> {
    return this.rooms.getByName(`${room.worktreeId}:${room.roomId}`);
  }

  private async post(room: RealtimeRoomRef, path: string, body: unknown): Promise<void> {
    const response = await this.stubFor(room).fetch(`${ROOM_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 400 || response.status === 413) {
      throw new GitViseError('INVALID_REQUEST', await response.text());
    }
    if (!response.ok) {
      throw upstreamError(`realtime publish failed (${response.status})`);
    }
  }
}

/** Malformed frames are dropped rather than failing the whole subscription. */
function parseFrame(data: unknown): RoomFrame | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const frame = JSON.parse(data) as Partial<RoomFrame>;
    return frame.type === 'yjs-update' || frame.type === 'presence' ? (frame as RoomFrame) : undefined;
  } catch {
    return undefined;
  }
}

function toEvent(room: RealtimeRoomRef, frame: RoomFrame): RealtimeEvent {
  if (frame.type === 'presence') {
    return { type: 'presence', room, presence: frame.presence };
  }
  return { type: 'yjs-update', room, origin: frame.origin, update: fromBase64(frame.update) };
}
