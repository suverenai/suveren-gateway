import { useState, useCallback } from 'react';
import { MCP_CONFIGS, MCP_CONFIG_ORDER } from '../lib/mcp-connect-configs';

interface Props {
  mcpEndpoint: string;
}

/**
 * MCP endpoint + per-client tabs + copyable snippet — the manual fallback for
 * connecting an AI client. Shared by SetupGuide's "Connect your agent" step
 * and the dashboard first-run card's "Set it up by hand" fold, so the two
 * never show different (or differently wrong) instructions.
 */
export function McpConnectDetails({ mcpEndpoint }: Props) {
  const [configTab, setConfigTab] = useState<string>(MCP_CONFIG_ORDER[0]);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, []);

  const snippet = MCP_CONFIGS[configTab].snippet(mcpEndpoint);

  return (
    <div>
      <div className="gate-content-label">MCP Endpoint</div>
      <div className="mcp-endpoint">{mcpEndpoint}</div>

      <div className="mcp-tabs">
        {MCP_CONFIG_ORDER.map((key) => (
          <button
            key={key}
            className={`mcp-tab${configTab === key ? ' active' : ''}`}
            onClick={() => setConfigTab(key)}
          >
            {MCP_CONFIGS[key].label}
          </button>
        ))}
      </div>

      <pre className="mcp-snippet">{snippet}</pre>

      <button className="btn btn-secondary btn-sm" onClick={() => handleCopy(snippet)}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
