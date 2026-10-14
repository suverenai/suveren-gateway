/**
 * AU10 wire shapes — the interface contract in
 * doc/au10-request-context.md ("Card (gateway UI)"). Mirrors
 * apps/mcp-server/src/lib/request-context.ts's own result types; kept as a
 * separate copy the same way preview-types.ts duplicates the MCP server's
 * preview shapes (the two apps don't share a TS project).
 */

export interface RequestChainItem {
  author?: string;
  at?: string;
  title?: string;
  body?: string;
}

export type RequestResult =
  | { status: 'none' }
  | { status: 'unreadable'; reason: string }
  | { status: 'not_found' }
  | {
      status: 'ok';
      connector: string;
      kind: string;
      implicit: boolean;
      author?: string;
      at?: string;
      title?: string;
      body?: string;
      chain: RequestChainItem[];
    };

export interface HistoryItem {
  kind?: string;
  title?: string;
  body?: string;
  at?: string;
  author?: string;
  type?: string;
  aiWritten?: { at?: number };
}

export interface ConnectorHistoryMatch {
  connectorId: string;
  matchedKeyType: 'email' | 'email_domain';
  matchedKeyValue: string;
  items: HistoryItem[];
}

export type HistoryResult =
  | { status: 'no_customer_link' }
  | { status: 'no_match' }
  | { status: 'unreachable'; connectorIds: string[] }
  | { status: 'ok'; matches: ConnectorHistoryMatch[]; unreachableConnectorIds: string[] };

export interface RequestContextResult {
  request: RequestResult;
  history: HistoryResult;
}
