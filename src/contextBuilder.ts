/**
 * contextBuilder.ts — Context Builder for Zero-Magic.
 *
 * Aggregates all diagnostic signals into a single BuiltContext object:
 *   - language / errorCode / diagnosticMessage   (from IDE diagnostics)
 *   - activeFilePath / sourceCode                 (from the active editor)
 *   - terminalOutput / exitCode                   (from child_process execution)
 *
 * Usage:
 *   import { ContextBuilder } from './contextBuilder';
 *   const ctx = await ContextBuilder.instance.build(event);
 */

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { DiagnosticEvent } from './watcher';
import { detectExecutable } from './runner';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BuiltContext {
    language: string;
    errorCode: string;
    diagnosticMessage: string;
    activeFilePath: string;
    sourceCode: string;
    terminalOutput: string;
    exitCode: number;
}

export interface RuntimeSummary {
    exitCode: number;
    lastTerminalError: string;
    runtimeFailureSummary: string;
    hasRuntimeData: boolean;
}

// ── ContextBuilder ────────────────────────────────────────────────────────────

export class ContextBuilder {
    private static _instance: ContextBuilder | undefined;

    private _lastTerminalOutput: string = '';
    private _lastExitCode: number = -1;

    /** Max chars kept from execution output (≈8 KB) */
    private static readonly BUFFER_SIZE = 8_000;

    private constructor() {}

    static get instance(): ContextBuilder {
        if (!ContextBuilder._instance) {
            ContextBuilder._instance = new ContextBuilder();
        }
        return ContextBuilder._instance;
    }

    /** No longer requires active listeners, kept for interface compatibility */
    activate(): void {
        // We now capture terminal output purely via child_process.execFile
        // to avoid any proposed/unstable VS Code terminal APIs.
    }

    dispose(): void {
        this._lastTerminalOutput = '';
        this._lastExitCode = -1;
        ContextBuilder._instance = undefined;
    }

    // ── Public build API ─────────────────────────────────────────────────────

    async build(event: DiagnosticEvent): Promise<BuiltContext> {
        const errorCodeMatch = event.errorMessage.match(/^([A-Za-z][A-Za-z0-9_]*)/);
        const errorCode = errorCodeMatch ? errorCodeMatch[1] : 'UnknownError';

        let sourceCode = '';
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(event.filePath));
            sourceCode = doc.getText();
        } catch {
            // Non-fatal
        }

        // Execute the active file to capture its actual runtime output + exit code
        await this._executeFile(event.filePath, event.languageId);

        return {
            language: event.languageId,
            errorCode,
            diagnosticMessage: event.errorMessage,
            activeFilePath: event.filePath,
            sourceCode,
            terminalOutput: this._lastTerminalOutput,
            exitCode: this._lastExitCode,
        };
    }

    private async _executeFile(filePath: string, languageId: string): Promise<void> {
        let runnerLang: 'python' | 'node' | null = null;
        if (languageId === 'python') runnerLang = 'python';
        else if (languageId === 'javascript' || languageId === 'typescript') runnerLang = 'node';

        if (!runnerLang) {
            this._lastTerminalOutput = '';
            this._lastExitCode = -1;
            return;
        }

        let executable: string;
        try {
            executable = detectExecutable(runnerLang);
        } catch (e) {
            this._lastTerminalOutput = '';
            this._lastExitCode = -1;
            return;
        }

        return new Promise((resolve) => {
            // Give it 2 seconds max to avoid hanging on long-running/server code
            execFile(executable, [filePath], { timeout: 2000 }, (error, stdout, stderr) => {
                let output = (stdout + '\n' + stderr).trim();
                if (output.length > ContextBuilder.BUFFER_SIZE) {
                    output = output.slice(-ContextBuilder.BUFFER_SIZE);
                }
                
                this._lastTerminalOutput = output;
                this._lastExitCode = error ? (error as any).code ?? -1 : 0;
                resolve();
            });
        });
    }

    getRuntimeSummary(): RuntimeSummary {
        const raw = this._lastTerminalOutput;
        const exitCode = this._lastExitCode;
        const hasRuntimeData = raw.length > 0 || exitCode !== -1;

        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        const lastTerminalError = lines.length > 0 ? lines[lines.length - 1] : '(none)';

        let runtimeFailureSummary = '';
        if (!hasRuntimeData) {
            runtimeFailureSummary = 'No execution data available.';
        } else if (exitCode === 0) {
            runtimeFailureSummary = 'Last run exited cleanly (exit code 0). Error is static / compile-time.';
        } else if (exitCode === -1) {
            runtimeFailureSummary = 'Execution timed out or exited unexpectedly.';
        } else {
            const errorLine = lines.find(l =>
                /error|exception|traceback|fatal|failed/i.test(l)
            ) ?? lastTerminalError;
            runtimeFailureSummary = `Process exited with code ${exitCode}. Root cause: ${errorLine}`;
        }

        return { exitCode, lastTerminalError, runtimeFailureSummary, hasRuntimeData };
    }
}
