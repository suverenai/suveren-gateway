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
export { ReportStore, type StoredReport } from './report-store';
export { renderReportHtml, escapeHtml, DRAWN_ELEMENT_STYLES } from './render-report';
export {
  formatDateTime, formatDuration, formatCurrency, formatBoundValue, formatBoundLabel,
  formatOwnerLabel, profileShortLabel, formatActionLabel, formatMetricValue, METRIC_LABELS,
} from './format';
export { resolveTicketElement, resolveApprovalElement, resolveMandateElement } from './ticket-resolvers';
export { buildTicketDetails, type TicketDetail } from './ticket-details';
export * from './types';
export { buildExportBundle, buildExportDocument, suggestedFilename, type BuildExportBundleParams, type BuildExportDocumentParams } from './export-report';
export { isExportBundle, type ExportBundle } from './export-types';
export { verifyExportBundle, collectReferencedTicketIds, type VerifyExportResult, type VerifyExportOptions, type TicketVerification, type AuthorizationVerification, type KeyConfirmation } from './verify-export';
