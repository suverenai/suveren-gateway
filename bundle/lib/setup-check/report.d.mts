/** Types for the Setup check's output (plain ESM; see report.mjs). */
import type { CheckReport } from './engine.mjs';
export declare function renderText(report: CheckReport): string;
export declare function renderJson(report: CheckReport): string;
