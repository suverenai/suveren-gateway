/**
 * The AI apps the Setup check recognises. Adding an app = adding one data
 * file next to this one and listing it here; the engine has no per-app code.
 */
import claudeDesktop from './claude-desktop.mjs';
import claudeCode from './claude-code.mjs';
import codex from './codex.mjs';
import copilotVscode from './copilot-vscode.mjs';

export const APPS = [claudeDesktop, claudeCode, codex, copilotVscode];
