/**
 * Report Verifier — public surface (work-plan "evidence-backed reports", R5
 * backend half). See `types.ts` for the stable contract with whatever renders
 * this later (a UI step, out of scope here).
 */
export { verifyReport } from './verify-report';
export { sanitizeReportHtml } from './sanitize';
export { parseElements, type ParsedElement } from './parse-elements';
export { createConnectorExportRunner, ConnectorExportError, type ConnectorExportConfig } from './connector-export';
export { METRIC_KINDS, type MetricKind } from './metric-resolvers';
export * from './types';
