export async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  let dataLines: string[] = [];
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
          if (dataLines.length > 0) {
            yield dataLines.join('\n');
            dataLines = [];
          }
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
