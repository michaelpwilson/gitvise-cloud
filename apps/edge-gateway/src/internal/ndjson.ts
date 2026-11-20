/**
 * Streams each value as one JSON line. A line is written as soon as its value is ready, so a client sees each event
 * without waiting for the stream to finish. Cancelling the response cancels the source.
 */
export function ndjsonResponse(source: ReadableStream<unknown>): Response {
  const encoder = new TextEncoder();
  const lines = source.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(value, controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      },
    }),
  );
  return new Response(lines, {
    headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
  });
}
