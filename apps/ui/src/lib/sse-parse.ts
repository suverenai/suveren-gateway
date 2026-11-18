/**
 * A minimal Server-Sent Events reader for the event stream when the page cannot use EventSource (a gateway with an
 * unlock password needs the session header, which EventSource cannot send). Feed it text as it arrives; it returns
 * the complete events. Comments (": ping") and `retry:` lines are ignored; `event:` defaults to "message".
 */
export interface SseMessage { event: string; data: string }

export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const out: SseMessage[] = [];
    let i: number;
    while ((i = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c === -1 ? line : line.slice(0, c);
        let value = c === -1 ? '' : line.slice(c + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}
