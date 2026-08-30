export interface SseFrame {
  /**
   * The `event:` name, `message` when the stream omitted one, or `comment` for a
   * `:` line. Comments are surfaced rather than dropped because the server's
   * heartbeat is one, and the heartbeat is the only thing that tells a quiet
   * stream from a dead one.
   */
  readonly event: string;
  readonly data: string;
}

/**
 * Read an SSE body as named frames.
 *
 * The event NAME is carried, not dropped: `protocol-state-unauthorized` is how
 * the server says a credential died mid-stream, and a reader that only collects
 * `data:` lines would deliver that as an ordinary payload.
 */
export async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  let dataLines: string[] = [];
  let event = 'message';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
          dataLines = [];
          event = 'message';
          continue;
        }
        if (line.startsWith(':')) {
          yield { event: 'comment', data: line.slice(1).trimStart() };
          continue;
        }
        if (line.startsWith('event:')) {
          event = line.slice(6).trimStart();
          continue;
        }
        if (line.startsWith('data:')) {
          let payload = line.slice(5);
          if (payload.startsWith(' ')) payload = payload.slice(1);
          dataLines.push(payload);
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }
}
