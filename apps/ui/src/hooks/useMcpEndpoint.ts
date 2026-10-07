import { useEffect, useState } from 'react';

/**
 * The MCP address AI assistants connect to, from the control plane's
 * `/health` (`mcpPort`). Null until it answers — the setup snippet is not
 * shown on a guess: the port is configurable (`config set mcp-port`, the
 * Windows installer's MCP_PORT), so the UI's own port says nothing about it.
 */
export function useMcpEndpoint(): string | null {
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/health')
      .then(r => r.json())
      .then((data: { mcpPort?: number | null }) => {
        if (!cancelled && typeof data.mcpPort === 'number') {
          setEndpoint(`http://localhost:${data.mcpPort}`);
        }
      })
      .catch(() => { /* unreachable — keep the snippet hidden */ });
    return () => { cancelled = true; };
  }, []);

  return endpoint;
}
