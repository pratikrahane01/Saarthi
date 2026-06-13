import * as vscode from 'vscode';
import { Mission, fetchExpertSolution, SolutionRequest, evaluateHypothesisAPI } from '../missions';
import * as interceptor from '../interceptor';
import * as path from 'path';
import { getRitualState, advanceStep, skipRitual, DebugRitualState } from '../debugTrainer';
import { globalContext } from '../extension';

import { getQueueState, advanceBugQueue } from '../bugQueue';

/**
 * The seven possible UI states for the Socratic Dashboard.
 * Each state maps to a distinct visual presentation in the webview.
 */
export type DashboardState = 'IDLE' | 'RITUAL' | 'QUESTIONING' | 'HINTING' | 'TESTING' | 'PASSED' | 'FAILED' | 'SOLUTION' | 'MISSION_COMPLETE';

export class SocraticSidebarProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'zeroMagic.socraticSidebar';

    /** Singleton reference so other modules can send messages to the sidebar */
    public static instance: SocraticSidebarProvider | undefined;

    private _view?: vscode.WebviewView;
    private _currentState: DashboardState = 'IDLE';
    private _isTesting: boolean = false;
    private _currentMission?: Mission;
    private _attempts: number = 0;
    private _revealedHints: number = 0;
    private _customFailedMessage?: string;
    private _expertSolution?: {
        fixedCode: string;
        explanation: string;
        conceptSummary: string;
    };
    private _missionCompletePayload?: any;
    private _canSkipRitual: boolean = false;
    private _ritualState: DebugRitualState | null = null;

    // Game state variables matching user specifications
    private _currentPage: number = 1;
    private _hearts: number = 3;
    private _hintsUsed: number = 0;
    private _startTime: number = 0;
    private _socraticChallengeUri?: vscode.Uri;
    private _hasFailedSubmit: boolean = false;

    constructor(private readonly _extensionUri: vscode.Uri) {
        SocraticSidebarProvider.instance = this;
    }

    /**
     * Called by VS Code when the sidebar view is first made visible.
     */
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Set the HTML
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Send initial state
        this._postState();

        // Listen for messages FROM the webview
        webviewView.webview.onDidReceiveMessage((message) => {
            this._handleWebviewMessage(message);
        });
    }

    // ──────────────────────────────────────────────
    //  PUBLIC API — called by other extension modules
    // ──────────────────────────────────────────────

    /**
     * Load a new mission and transition to QUESTIONING or RITUAL state.
     * For Tier 1 errors (syntax/typo) we skip the ritual entirely.
     */
    public showMission(mission: Mission, canSkipRitual: boolean = false) {
        this._currentMission = mission;
        this._canSkipRitual = canSkipRitual;
        this._ritualState = getRitualState(globalContext, mission.id);

        // Tier 1 = Syntax/Typo: skip ritual, show mission card directly
        const tier = mission.tier ?? 2;
        const needsRitual = tier >= 2;

        if (needsRitual && this._ritualState && this._ritualState.step < 3) {
            this._currentState = 'RITUAL';
        } else {
            this._currentState = 'QUESTIONING';
        }
        
        this._currentPage = 1;
        this._hearts = 3;
        this._hintsUsed = 0;
        this._startTime = Date.now();
        this._socraticChallengeUri = undefined;
        this._hasFailedSubmit = false;
        this._attempts = 0;
        this._revealedHints = 0;
        this._expertSolution = undefined;
        this._postState();

        // Make sure the sidebar is visible
        if (this._view) {
            this._view.show?.(true);
        }
    }

    public showMissionComplete(payload: any) {
        this._currentState = 'MISSION_COMPLETE';
        this._currentPage = 4;
        this._currentMission = undefined;
        this._missionCompletePayload = payload;
        this._postState();
        if (this._view) {
            this._view.show?.(true);
        }
    }

    /**
     * Called when the runner reports test results.
     */
    public reportTestResult(passed: boolean, customFailedMessage?: string) {
        this._attempts++;
        if (passed) {
            this._currentState = 'PASSED';
            this._customFailedMessage = undefined;
        } else {
            this._currentState = 'FAILED';
            this._customFailedMessage = customFailedMessage;
        }
        this._postState();
    }

    /**
     * Reset the sidebar back to IDLE (e.g. after unlock cleanup).
     */
    public reset() {
        this._currentState = 'IDLE';
        this._currentPage = 1;
        this._hearts = 3;
        this._hintsUsed = 0;
        this._startTime = 0;
        this._socraticChallengeUri = undefined;
        this._hasFailedSubmit = false;
        this._currentMission = undefined;
        this._attempts = 0;
        this._revealedHints = 0;
        this._customFailedMessage = undefined;
        this._expertSolution = undefined;
        this._postState();
    }

    /**
     * Post an arbitrary message to the webview.
     */
    public postMessage(message: any) {
        this._view?.webview.postMessage(message);
    }

    // ──────────────────────────────────────────────
    //  INBOUND — handle messages from the webview JS
    // ──────────────────────────────────────────────

    private _handleWebviewMessage(message: any) {
        switch (message.type) {
            case 'REQUEST_HINT':
                this._onRequestHint();
                break;

            case 'SUBMIT_RITUAL_STEP':
                this._onSubmitRitualStep(message.response, message.force);
                break;

            case 'SKIP_RITUAL':
                this._onSkipRitual();
                break;

            case 'SUBMIT_ANSWER':
                if (this._isTesting) {
                    console.log('Zero-Magic Sidebar: Ignoring SUBMIT_ANSWER, test already running.');
                    break;
                }
                this._retrigger();
                break;

            case 'REQUEST_STATE':
                this._postState();
                break;

            case 'ABORT':
                this._abortMission();
                break;

            case 'REQUEST_SOLUTION':
                this._onRequestSolution();
                break;

            case 'MORE_EXPLANATION':
                this._onMoreExplanation();
                break;

            case 'NAVIGATE_ERROR':
                this._cycleErrors(message.direction);
                break;

            case 'RESET':
                this.reset();
                break;

            case 'SUBMIT_TIER2_ATTEMPT':
                this._onSubmitTier2Attempt(message.hypothesis);
                break;

            case 'USE_TIER2_HINT':
                if (this._hearts > 1) {
                    this._hearts--;
                    this._postState();
                }
                break;

            case 'GO_TO_LINE':
                this._goToLine(message.line);
                break;

            case 'CHANGE_PAGE':
                this._handleChangePage(message.direction);
                break;

            case 'GAMES_CLICKED':
                vscode.window.showInformationMessage('Launching Socratic Games! Check back soon for interactive exercises.');
                break;

            default:
                console.log('Zero-Magic Sidebar: Unknown message type', message.type);
        }
    }

    private async _onSubmitRitualStep(response: string, force: boolean = false) {
        if (!this._currentMission) return;
        const currentState = this._ritualState;
        
        // If we are submitting hypothesis, evaluate it via LLM first
        if (this._currentState === 'RITUAL' && currentState && currentState.step < 3 && !force) {
            this.postMessage({ type: 'HYPOTHESIS_FEEDBACK', status: 'LOADING' });
            
            // Reconstruct code snippet (using targetUri)
            let snippet = "";
            if (currentState.errorLines && currentState.errorLines.length > 0) {
                snippet = currentState.errorLines.map(l => `Line ${l.line}: ${l.text}`).join('\n');
            }
            
            const evalResult = await evaluateHypothesisAPI(
                response,
                this._currentMission.originalMessage || this._currentMission.originalErrorCode,
                snippet
            );
            
            this.postMessage({ type: 'HYPOTHESIS_FEEDBACK', status: evalResult.status, nudge: evalResult.nudge });
            
            if (evalResult.status !== 'PASS') {
                // Do not advance step if fail/close
                return;
            }
        }
        
        const state = await advanceStep(globalContext, this._currentMission.id, response);
        this._ritualState = state;
        await this._onRequestSolution();
    }
    
    private async _onSubmitTier2Attempt(hypothesis: string) {
        if (!this._currentMission || this._isTesting) return;

        this._isTesting = true;
        this.postMessage({ type: 'HYPOTHESIS_FEEDBACK', status: 'LOADING' });

        if (hypothesis && hypothesis.trim().length > 0) {
            evaluateHypothesisAPI(
                hypothesis,
                this._currentMission.originalMessage || this._currentMission.originalErrorCode,
                this._currentMission.errorLineNumber?.toString() || ""
            ).then(res => {
                this.postMessage({ type: 'HYPOTHESIS_FEEDBACK', status: res.status, nudge: res.nudge });
            }).catch(console.error);
        }

        this._isTesting = false; 
        await this._retrigger();
    }

    private async _goToLine(line: number) {
        if (this._currentMission && this._currentMission.targetUri) {
            const uri = vscode.Uri.parse(this._currentMission.targetUri);
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(doc);
                const range = new vscode.Range(line - 1, 0, line - 1, 0);
                editor.selection = new vscode.Selection(range.start, range.end);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            } catch (e) {
                console.error("Failed to jump to line:", e);
            }
        }
    }
    
    private async _onSkipRitual() {
        if (!this._currentMission) return;
        const state = await skipRitual(globalContext, this._currentMission.id);
        this._ritualState = state;
        this._currentState = 'QUESTIONING';
        this._postState();
    }

    /**
     * Reveal the next hint in the Socratic sequence.
     */
    private _onRequestHint() {
        if (!this._currentMission) { return; }

        if (this._revealedHints < this._currentMission.hints.length) {
            this._revealedHints++;
            this._hintsUsed++;
        }

        this._currentState = 'HINTING';
        this._postState();
    }

    private async _onRequestSolution() {
        if (!this._currentMission) return;

        let sourceCode = '';
        if (this._currentMission.targetUri) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this._currentMission.targetUri));
                sourceCode = doc.getText();
            } catch (e) {
                console.error("Could not read source code", e);
            }
        }

        const request: SolutionRequest = {
            language: this._currentMission.language,
            errorCode: this._currentMission.originalErrorCode,
            diagnosticMessage: this._currentMission.originalMessage,
            sourceCode: sourceCode
        };

        const result = await fetchExpertSolution(request);
        if (result) {
            this._expertSolution = result;
        } else {
            this._expertSolution = {
                fixedCode: "// Failed to load solution",
                explanation: "There was a network error reaching the backend.",
                conceptSummary: "Please check if the backend server is running."
            };
        }

        // Generate challenge file
        try {
            const targetPath = vscode.Uri.parse(this._currentMission.targetUri).fsPath;
            const dir = path.dirname(targetPath);
            const ext = path.extname(targetPath);
            const challengePath = path.join(dir, `socratic_challenge${ext}`);
            this._socraticChallengeUri = vscode.Uri.file(challengePath);

            const commentPrefix = this._currentMission.language === 'python' ? '# ' : '// ';
            const explanationLines = this._expertSolution.explanation.split('\n').map(line => `${commentPrefix}${line}`);

            const fileContent = [
                `${commentPrefix}=====================================================================`,
                `${commentPrefix}ZERO-MAGIC SOCRATIC CHALLENGE`,
                `${commentPrefix}=====================================================================`,
                `${commentPrefix}Socratic Question:`,
                `${commentPrefix}${this._currentMission.socraticQuestion}`,
                `${commentPrefix}`,
                `${commentPrefix}Detailed Explanation of the Error:`,
                ...explanationLines,
                `${commentPrefix}`,
                `${commentPrefix}INSTRUCTIONS:`,
                `${commentPrefix}Fix the code below so it passes the hidden tests.`,
                `${commentPrefix}Click "Submit Answer" in the sidebar when you're ready!`,
                `${commentPrefix}=====================================================================`,
                ``,
                sourceCode
            ].join('\n');

            await vscode.workspace.fs.writeFile(this._socraticChallengeUri, Buffer.from(fileContent, 'utf8'));

            const doc = await vscode.workspace.openTextDocument(this._socraticChallengeUri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
        } catch (err) {
            console.error("Failed to generate challenge file:", err);
        }

        this._currentPage = 2;
        this._hearts = 3;
        this._hasFailedSubmit = false;
        this._currentState = 'SOLUTION';
        this._postState();
    }

    private async _onMoreExplanation() {
        if (!this._currentMission || this._hearts <= 0) return;

        this._hearts--;
        this._hintsUsed++;
        if (this._revealedHints < this._currentMission.hints.length) {
            this._revealedHints++;
        }

        if (this._hearts <= 0) {
            this._currentPage = 3;
            this._currentState = 'FAILED';
            await this._saveStepHistory(false);
        } else if (this._socraticChallengeUri) {
            try {
                const doc = await vscode.workspace.openTextDocument(this._socraticChallengeUri);
                const text = doc.getText();
                const commentPrefix = this._currentMission.language === 'python' ? '# ' : '// ';
                const nextHintText = this._currentMission.hints[this._revealedHints - 1] || "Check the syntax and logic carefully.";
                const extraComment = `\n${commentPrefix}---------------------------------------------------------------------\n${commentPrefix}EXTRA HINT (Heart Consumed):\n${commentPrefix}${nextHintText}\n${commentPrefix}---------------------------------------------------------------------\n`;

                // Insert it after the instructions banner separator
                const separator = `=====================================================================`;
                const parts = text.split(separator);
                let newText = text;
                if (parts.length >= 3) {
                    newText = parts[0] + separator + parts[1] + extraComment + separator + parts[2];
                } else {
                    newText = extraComment + text;
                }

                await vscode.workspace.fs.writeFile(this._socraticChallengeUri, Buffer.from(newText, 'utf8'));
            } catch (e) {
                console.error("Could not append extra hint to challenge file", e);
            }
        }

        this._postState();
    }

    private async _handleChangePage(direction: 'prev' | 'next') {
        if (direction === 'prev') {
            if (this._currentPage > 1) {
                this._currentPage--;
                this._postState();
            }
        } else {
            if (this._currentPage < 3) {
                if (this._currentPage === 1 && !this._expertSolution && this._currentMission) {
                    await this._fetchSolutionOnly();
                }
                this._currentPage++;
                this._postState();
            }
        }
    }

    private async _fetchSolutionOnly() {
        if (!this._currentMission) return;

        let sourceCode = '';
        if (this._currentMission.targetUri) {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this._currentMission.targetUri));
                sourceCode = doc.getText();
            } catch (e) {
                console.error("Could not read source code", e);
            }
        }

        const request: SolutionRequest = {
            language: this._currentMission.language,
            errorCode: this._currentMission.originalErrorCode,
            diagnosticMessage: this._currentMission.originalMessage,
            sourceCode: sourceCode
        };

        const result = await fetchExpertSolution(request);
        if (result) {
            this._expertSolution = result;
        } else {
            this._expertSolution = {
                fixedCode: "// Failed to load solution",
                explanation: "There was a network error reaching the backend.",
                conceptSummary: "Please check if the backend server is running."
            };
        }
    }

    private async _cycleErrors(direction: 'next' | 'prev') {
        const diagnostics = vscode.languages.getDiagnostics();
        const errorEvents: any[] = [];

        for (const [uri, diags] of diagnostics) {
            const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
            for (const err of errors) {
                // Skip the socratic challenge file itself when navigating to avoid loops
                if (uri.fsPath.includes('socratic_challenge')) continue;

                errorEvents.push({
                    uri,
                    filePath: uri.fsPath,
                    languageId: uri.fsPath.endsWith('.py') ? 'python' : 'javascript',
                    errorMessage: err.message,
                    lineText: '',
                    lineNumber: err.range.start.line
                });
            }
        }

        if (errorEvents.length === 0) {
            vscode.window.showInformationMessage("No active compiler errors found in the workspace!");
            return;
        }

        let currentIndex = -1;
        if (this._currentMission) {
            currentIndex = errorEvents.findIndex(e => e.errorMessage === this._currentMission?.originalMessage);
        }

        let newIndex = 0;
        if (currentIndex !== -1) {
            if (direction === 'next') {
                newIndex = (currentIndex + 1) % errorEvents.length;
            } else {
                newIndex = (currentIndex - 1 + errorEvents.length) % errorEvents.length;
            }
        } else {
            newIndex = 0;
        }

        const nextError = errorEvents[newIndex];

        try {
            const doc = await vscode.workspace.openTextDocument(nextError.uri);
            nextError.languageId = doc.languageId;
            nextError.lineText = doc.lineAt(nextError.lineNumber).text;

            await vscode.commands.executeCommand('zeroMagic.triggerSocraticHelp', nextError);
        } catch (e) {
            console.error("Failed to cycle errors:", e);
        }
    }

    private async _saveStepHistory(passed: boolean) {
        if (!this._currentMission) return;

        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) return;

            const rootUri = workspaceFolders[0].uri;
            const historyDir = vscode.Uri.joinPath(rootUri, '.zero_magic');
            const historyUri = vscode.Uri.joinPath(historyDir, 'history.txt');

            await vscode.workspace.fs.createDirectory(historyDir);

            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const timeTaken = this._startTime ? Math.round((Date.now() - this._startTime) / 1000) : 0;

            const entry = [
                `==================================================`,
                `ZERO-MAGIC SESSION SUMMARY - ${timestamp}`,
                `==================================================`,
                `Mission ID      : ${this._currentMission.id}`,
                `Mission Title   : ${this._currentMission.title}`,
                `Language        : ${this._currentMission.language}`,
                `Error Code      : ${this._currentMission.originalErrorCode}`,
                `Socratic Q      : ${this._currentMission.socraticQuestion}`,
                `Attempts        : ${this._attempts}`,
                `Hearts Left     : ${this._hearts}`,
                `Hints Used      : ${this._hintsUsed}`,
                `Time Taken      : ${timeTaken} seconds`,
                `Result          : ${passed ? 'PASSED (Success)' : 'FAILED (Run out of hearts)'}`,
                `==================================================\n\n`
            ].join('\n');

            let existingContent = '';
            try {
                const data = await vscode.workspace.fs.readFile(historyUri);
                existingContent = Buffer.from(data).toString('utf8');
            } catch (e) {
                // File does not exist yet
            }

            await vscode.workspace.fs.writeFile(historyUri, Buffer.from(entry + existingContent, 'utf8'));
        } catch (err) {
            console.error("Failed to save step history:", err);
        }
    }

    private async _retrigger() {
        if (!this._currentMission || this._isTesting) {
            console.warn('Zero-Magic Sidebar: Cannot retrigger. No mission or test already running.');
            return;
        }

        this._isTesting = true;
        this._currentState = 'TESTING';
        this._postState();
        const mission = this._currentMission;
        console.log(`Zero-Magic Sidebar: Re-running test for mission "${mission.id}"`);
        console.log("[ZERO-MAGIC] Test execution started");

        let executionId: number | undefined;
        try {
            const result = await interceptor.trigger(mission);
            executionId = result.executionId;

            if (!interceptor.isLatestExecution(executionId)) {
                console.log(`Zero-Magic Sidebar: Execution ${executionId} is stale. Ignoring.`);
                return;
            }

            // --- Two-Factor Validation ---
            let finalPassed = false;
            let twoFactorFailedMessage: string | undefined;

            const mode = mission.validationMode || 'logic';
            const checkUri = mission.targetUri ? vscode.Uri.parse(mission.targetUri) : undefined;

            if (mode === 'diagnostic') {
                if (checkUri) {
                    const diagnostics = vscode.languages.getDiagnostics(checkUri);
                    const hasOriginalError = diagnostics.some(d =>
                        d.severity === vscode.DiagnosticSeverity.Error &&
                        (d.message === mission.originalMessage || d.message.includes(mission.originalErrorCode))
                    );

                    finalPassed = !hasOriginalError;
                    if (!finalPassed) {
                        twoFactorFailedMessage = "The original error is still present. Please fix it in your code before submitting.";
                    }
                } else {
                    finalPassed = result.passed; // Fallback
                }
            } else {
                finalPassed = result.passed;
                if (!finalPassed) {
                    twoFactorFailedMessage = "The concept check test failed. Please review your logic.";
                }
            }

            if (finalPassed) {
                this._customFailedMessage = undefined;
                await this._saveStepHistory(true);
                await interceptor.unlockMission(mission.id, mission.language);

                const qState = getQueueState();
                if (qState.isActive) {
                    await advanceBugQueue(100, this._hintsUsed);
                    return; // Stop here, bugQueue will take over
                } else {
                    this._currentPage = 3;
                    this._currentState = 'PASSED';
                    this._postState();
                }
            } else {
                this._hearts--;
                this._hasFailedSubmit = true;
                this._customFailedMessage = twoFactorFailedMessage || "The concept check test failed.";

                if (this._hearts <= 0) {
                    this._currentPage = 3;
                    this._currentState = 'FAILED';
                    await this._saveStepHistory(false);
                } else {
                    if (mission.tier === 2) {
                        await this._fetchSolutionOnly();
                        this._currentPage = 2;
                        this._currentState = 'SOLUTION';
                    } else {
                        this._currentState = 'FAILED';
                    }
                }
                this._postState();
            }
        } catch (err) {
            console.error('Zero-Magic Sidebar: Retrigger failed:', err);
            vscode.window.setStatusBarMessage('⚠️ Zero-Magic: Test re-run failed.', 5000);

            this._hearts--;
            this._hasFailedSubmit = true;
            if (this._hearts <= 0) {
                this._currentPage = 3;
                this._currentState = 'FAILED';
                await this._saveStepHistory(false);
            } else {
                if (mission.tier === 2) {
                    await this._fetchSolutionOnly();
                    this._currentPage = 2;
                    this._currentState = 'SOLUTION';
                } else {
                    this._currentState = 'FAILED';
                }
            }
            this._postState();
        } finally {
            if (executionId === undefined || interceptor.isLatestExecution(executionId)) {
                this._isTesting = false;
            }
        }
    }

    private async _abortMission() {
        console.log('Zero-Magic Sidebar: Aborting mission.');
        interceptor.invalidateAllExecutions();
        this._isTesting = false;
        await interceptor.cleanUpAllTests();

        // Clean up socratic challenge file if it exists
        if (this._socraticChallengeUri) {
            try {
                await vscode.workspace.fs.delete(this._socraticChallengeUri, { useTrash: false });
            } catch (e) {
                // Ignore if already deleted
            }
        }

        this.reset();
    }

    private _postState() {
        if (!this._view) return;
        console.log("[EXTENSION] Posting updated state");

        this._view.webview.postMessage({
            type: 'STATE_UPDATE',
            state: this._currentState,
            page: this._currentPage,
            hearts: this._hearts,
            hintsUsed: this._hintsUsed,
            hasFailedSubmit: this._hasFailedSubmit,
            timeElapsed: this._startTime ? Math.round((Date.now() - this._startTime) / 1000) : 0,
            mission: this._currentMission ? {
                id: this._currentMission.id,
                title: this._currentMission.title,
                language: this._currentMission.language,
                description: this._currentMission.description,
                socraticQuestion: this._currentMission.socraticQuestion,
                hints: this._currentMission.hints.slice(0, this._revealedHints),
                allHints: this._currentMission.hints,
                tier: this._currentMission.tier ?? 2,
                errorLineNumber: this._currentMission.errorLineNumber ?? null,
                errorRegions: this._currentMission.errorRegions ?? [],
            } : null,
            attempts: this._attempts,
            totalHints: this._currentMission?.hints.length ?? 0,
            revealedHints: this._revealedHints,
            customFailedMessage: this._customFailedMessage,
            expertSolution: this._expertSolution,
            runtimeSummary: this._currentMission?.runtimeSummary ?? null,
            canSkipRitual: this._canSkipRitual,
            ritualState: this._ritualState,
            missionCompletePayload: this._missionCompletePayload,
            analysisMode: (() => {
                try {
                    return getQueueState().isActive ? 'full-file' : 'single';
                } catch (e) {
                    return 'single';
                }
            })(),
            queueState: (() => {
                try {
                    const qState = getQueueState();
                    if (qState.isActive && qState.bugs.length > 0) {
                        const currentBug = qState.bugs[qState.currentIndex];
                        return {
                            currentIndex: qState.currentIndex,
                            total: qState.totalBugs,
                            currentLine: currentBug ? currentBug.errorLineNumber : null,
                            currentErrorType: currentBug ? currentBug.originalMessage.split(':')[0] : null
                        };
                    }
                } catch (e) {}
                return null;
            })()
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   font-src https://fonts.gstatic.com;">
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <title>Zero-Magic Dashboard</title>
    <style>
        *, *::before, *::after {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'DM Mono', 'Courier New', monospace;
            background-color: #1c1e26;
            color: #a6accd;
            padding: 0;
            overflow-x: hidden;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        /* Terminal Window Container */
        .terminal-window {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            background-color: #1c1e26;
            overflow: hidden;
            position: relative;
        }

        /* Loading Overlay matching vladburca theme */
        .loading-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-color: rgba(19, 20, 28, 0.85);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            z-index: 9999;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            gap: 32px;
            transition: opacity 0.65s ease, visibility 0.65s ease;
            opacity: 1;
            visibility: visible;
        }

        .loading-overlay.hidden {
            opacity: 0;
            visibility: hidden;
            pointer-events: none;
        }

        /* Pacman Eating Dots Animation */
        .pacman-container {
            position: relative;
            width: 200px;
            height: 50px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .pacman {
            position: relative;
            width: 44px;
            height: 44px;
            z-index: 2;
        }

        .pacman-top, .pacman-bottom {
            position: absolute;
            width: 44px;
            height: 22px;
            background-color: #f29879;
        }

        .pacman-top {
            top: 0;
            border-radius: 22px 22px 0 0;
            transform-origin: bottom center;
            animation: spin-up 0.55s infinite ease-in-out alternate;
        }

        .pacman-bottom {
            bottom: 0;
            border-radius: 0 0 22px 22px;
            transform-origin: top center;
            animation: spin-down 0.55s infinite ease-in-out alternate;
        }

        @keyframes spin-up {
            0% { transform: rotate(-35deg); }
            100% { transform: rotate(0deg); }
        }

        @keyframes spin-down {
            0% { transform: rotate(35deg); }
            100% { transform: rotate(0deg); }
        }

        .dots-container {
            position: absolute;
            left: 100px; /* Center point aligned with Pacman mouth */
            top: 21px;
            width: 100px;
            height: 7px;
            z-index: 1;
        }

        .dot {
            position: absolute;
            left: 0;
            top: 0;
            width: 7px;
            height: 7px;
            background-color: #f29879;
            border-radius: 50%;
            animation: dot-slide 1.2s infinite linear;
        }

        .dot:nth-child(1) { animation-delay: 0s; }
        .dot:nth-child(2) { animation-delay: 0.3s; }
        .dot:nth-child(3) { animation-delay: 0.6s; }
        .dot:nth-child(4) { animation-delay: 0.9s; }

        @keyframes dot-slide {
            0% {
                transform: translateX(100px);
                opacity: 0;
            }
            15% {
                opacity: 1;
            }
            85% {
                opacity: 1;
            }
            100% {
                transform: translateX(0px);
                opacity: 0;
            }
        }

        .loading-text {
            color: #f29879;
            font-family: 'DM Mono', monospace;
            font-size: 0.8rem;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            text-align: center;
        }




        /* Content Wrapper */
        .content {
            display: flex;
            flex-direction: column;
            padding: 8px;
            gap: 10px;
            flex-grow: 1;
        }

        /* Main Panel - Dashed outline block */
        .main-panel {
            background-color: rgba(0, 0, 0, 0.1);
            border: 1px dashed rgba(166, 172, 205, 0.25);
            border-radius: 8px;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            flex: 1;
            overflow-y: auto;
            transition: all 0.2s ease;
        }

        .section-header {
            color: #f29879;
            font-size: 0.9rem;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin-bottom: 4px;
        }

        /* Retro Socratic Card Styles */
        .socratic-card {
            border: 1px dashed rgba(166, 172, 205, 0.25);
            border-radius: 6px;
            background-color: rgba(0, 0, 0, 0.1);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            flex: 1.5;
            min-height: 180px;
        }

        .socratic-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px 8px;
            border-bottom: 1px dashed rgba(166, 172, 205, 0.15);
        }

        .socratic-card-title {
            font-size: 0.85rem;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #f29879;
        }

        .socratic-card-body {
            padding: 12px 14px 14px;
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .socratic-card-text {
            font-size: 0.82rem;
            line-height: 1.6;
            color: #a6accd;
            flex: 1;
            overflow-y: auto;
        }

        .socratic-textarea {
            width: 100%;
            box-sizing: border-box;
            background: transparent;
            border: none;
            color: #e6edf3;
            font-family: 'DM Mono', monospace;
            font-size: 0.82rem;
            line-height: 1.5;
            resize: none;
            outline: none;
            flex: 1;
        }

        .socratic-btn-hint {
            width: 42px;
            height: 42px;
            flex-shrink: 0;
            border-radius: 6px;
            border: 1px solid rgba(166, 172, 205, 0.25);
            background: transparent;
            color: #a6accd;
            font-size: 1.1rem;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
        }

        .socratic-btn-hint:hover {
            color: #c3e88d;
            border-color: #c3e88d;
            background: rgba(195, 232, 141, 0.05);
        }

        .socratic-btn-submit {
            flex: 1;
            height: 42px;
            border-radius: 6px;
            border: 1px solid #f29879;
            background: #f29879;
            color: #13141c;
            font-family: inherit;
            font-weight: 700;
            font-size: 0.85rem;
            cursor: pointer;
            letter-spacing: 0.05em;
            transition: all 0.2s ease;
        }

        .socratic-btn-submit:hover {
            background: #efa88d;
            border-color: #efa88d;
        }

        .socratic-btn-games {
            height: 32px;
            border-radius: 6px;
            border: 1px dashed rgba(166, 172, 205, 0.4);
            background: transparent;
            color: #f29879;
            font-family: inherit;
            font-weight: 700;
            font-size: 0.8rem;
            cursor: pointer;
            letter-spacing: 0.05em;
            transition: all 0.2s ease;
        }

        .socratic-btn-games:hover {
            background: rgba(242, 152, 121, 0.08);
            border-color: #f29879;
        }

        #btn-page2-submit {
            height: 32px;
            font-size: 0.8rem;
            flex: none;
        }

        .socratic-explanation-card {
            border: 1px dashed rgba(56, 189, 248, 0.3);
            border-radius: 6px;
            overflow: hidden;
            background: rgba(56, 189, 248, 0.04);
            display: flex;
            flex-direction: column;
            flex: 1;
            height: 280px;
            min-height: 280px;
        }

        .socratic-explanation-header {
            padding: 8px 14px;
            border-bottom: 1px dashed rgba(56, 189, 248, 0.2);
            font-size: 0.75rem;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #38bdf8;
        }

        .socratic-explanation-text {
            padding: 12px 14px;
            font-size: 0.82rem;
            line-height: 1.6;
            color: #a6accd;
            flex: 1;
            overflow-y: auto;
        }

        /* Page Navigation Buttons styling */
        .page-nav-btn {
            background: none;
            border: none;
            color: #f29879;
            cursor: pointer;
            font-family: inherit;
            font-size: 0.95rem;
            font-weight: bold;
            padding: 2px 8px;
            transition: all 0.2s ease;
        }
        .page-nav-btn:hover {
            opacity: 0.8;
            transform: scale(1.15);
        }

        /* Retro Socratic Line Navigator Styles */
        .error-navigator-container {
            display: none;
            align-items: center;
            gap: 0;
            background: rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(242, 152, 121, 0.25);
            border-radius: 6px;
            overflow: hidden;
        }

        .error-navigator-btn {
            background: none;
            border: none;
            color: #f29879;
            font-family: 'DM Mono', monospace;
            font-size: 0.85rem;
            padding: 3px 8px;
            cursor: pointer;
            line-height: 1;
            transition: background 0.15s;
        }

        #btn-error-prev.error-navigator-btn {
            border-right: 1px solid rgba(242, 152, 121, 0.15);
        }

        #btn-error-next.error-navigator-btn {
            border-left: 1px solid rgba(242, 152, 121, 0.15);
        }

        .error-navigator-btn:hover {
            background: rgba(242, 152, 121, 0.05);
        }

        .error-navigator-display {
            color: #f29879;
            font-family: 'DM Mono', monospace;
            font-size: 0.80rem;
            padding: 3px 8px;
            min-width: 28px;
            text-align: center;
            letter-spacing: 0.04em;
            cursor: default;
            user-select: none;
        }

        .question-text {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 0.9rem;
            line-height: 1.6;
            color: #e6edf3;
            white-space: pre-wrap;
            word-wrap: break-word;
        }



        .heart-icon {
            font-size: 1.1rem;
            margin-right: 4px;
            transition: transform 0.2s ease;
        }

        /* Navigation equivalent - Actions list */
        .actions-panel {
            border-top: 1px dashed rgba(166, 172, 205, 0.15);
            padding-top: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        /* Terminal Menu Style Buttons */
        .btn {
            font-family: inherit;
            font-size: 0.82rem;
            font-weight: 500;
            height: 38px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0 16px;
            border-radius: 6px;
            transition: all 0.2s ease;
            width: 100%;
        }

        /* Outline retro buttons */
        .btn-outline {
            background-color: transparent;
            color: #a6accd;
            border: 1px solid rgba(166, 172, 205, 0.25);
        }
        .btn-outline:hover {
            color: #f29879;
            border-color: #f29879;
            background-color: rgba(242, 152, 121, 0.03);
        }

        /* Specific retro hover colors for different buttons */
        #btn-hint.btn-outline:hover {
            color: #c3e88d;
            border-color: #c3e88d;
            background-color: rgba(195, 232, 141, 0.05);
        }

        #btn-resubmit.btn-outline:hover {
            color: #c792ea;
            border-color: #c792ea;
            background-color: rgba(199, 146, 234, 0.05);
        }

        #btn-more-explanation.btn-outline:hover {
            color: #89ddff;
            border-color: #89ddff;
            background-color: rgba(137, 221, 255, 0.05);
        }

        #btn-nav.btn-outline:hover {
            color: #ffcb6b;
            border-color: #ffcb6b;
            background-color: rgba(255, 203, 107, 0.05);
        }

        /* Solid terminal action button */
        .btn-solid {
            background-color: #f29879;
            color: #13141c;
            border: 1px solid #f29879;
        }
        .btn-solid:hover {
            background-color: #efa88d;
            border-color: #efa88d;
        }

        .btn-green {
            width: 100%;
        }

        .btn-blue {
            width: 100%;
        }

        /* Row of action buttons */
        .action-row {
            display: flex;
            flex-direction: column;
            gap: 8px;
            width: 100%;
        }

        .extra-actions {
            display: flex;
            flex-direction: column;
            gap: 8px;
            width: 100%;
        }



        /* Success & Failure Glass Banners */
        .result-box {
            border-radius: 8px;
            padding: 12px;
            border: 1px dashed rgba(166, 172, 205, 0.25);
            background-color: rgba(0, 0, 0, 0.1);
        }

        .success-banner {
            color: #27c93f;
            line-height: 1.5;
        }

        .fail-banner {
            color: #ff5f56;
            line-height: 1.5;
        }

        /* Runtime Context Panel */
        .runtime-panel {
            border-top: 1px dashed rgba(166, 172, 205, 0.15);
            padding-top: 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .runtime-panel.hidden {
            display: none;
        }

        .runtime-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 0.72rem;
            font-weight: 500;
            letter-spacing: 0.05em;
            text-transform: uppercase;
        }

        .badge-fail {
            color: #ff5f56;
        }

        .badge-ok {
            color: #27c93f;
        }

        .runtime-error-text {
            font-size: 0.78rem;
            color: rgba(166, 172, 205, 0.75);
            background: rgba(255, 95, 86, 0.06);
            border: 1px dashed rgba(255, 95, 86, 0.2);
            border-radius: 6px;
            padding: 8px 10px;
            line-height: 1.55;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 90px;
            overflow-y: auto;
        }

        .runtime-summary {
            font-size: 0.75rem;
            color: rgba(166, 172, 205, 0.5);
            font-style: italic;
        }

        /* Scrollbar */
        ::-webkit-scrollbar {
            width: 4px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: rgba(166, 172, 205, 0.15);
            border-radius: 2px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: rgba(166, 172, 205, 0.3);
        }

        #theme-select {
            background-color: #1c1e26;
            color: #a6accd;
            border: 1px solid rgba(166, 172, 205, 0.25);
            border-radius: 4px;
            padding: 2px 6px;
            outline: none;
            cursor: pointer;
            font-size: 0.75rem;
            font-family: inherit;
        }

        #theme-select option {
            background-color: #1c1e26;
            color: #a6accd;
        }

        /* ── RITUAL PANEL CSS (Base/Retro) ── */
        .ritual-step-indicator { flex: 1; height: 3px; border-radius: 2px; transition: opacity 0.3s, background-color 0.3s; }
        .ritual-step-indicator.active { background-color: #f29879; }
        .ritual-step-indicator.inactive { background-color: rgba(166,172,205,0.2); }
        .ritual-title-text { color: #f29879 !important; }
        .ritual-card { border-radius: 6px; padding: 12px; }
        .ritual-card-info { background: rgba(242,152,121,0.08); border: 1px dashed rgba(242,152,121,0.3); }
        .ritual-card-warning { background: rgba(100,120,200,0.08); border: 1px dashed rgba(100,120,200,0.25); }
        .ritual-card-title { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px; color: rgba(242,152,121,0.8); }
        .ritual-card-title-warning { color: rgba(140,160,220,0.8); }
        .ritual-code-block { font-family: 'DM Mono', monospace; font-size: 0.8rem; line-height: 1.7; color: #c5cdd8; }
        .ritual-subtitle { font-size: 0.85rem; line-height: 1.6; color: rgba(166,172,205,0.8); }
        .ritual-highlight { color: #e6edf3; }
        .ritual-textarea { width: 100%; background: rgba(0,0,0,0.2); border: 1px dashed rgba(166,172,205,0.2); border-radius: 6px; color: #e6edf3; padding: 10px; font-family: inherit; font-size: 0.82rem; resize: vertical; outline: none; transition: border-color 0.2s ease; }
        .ritual-textarea:focus { border-color: rgba(242,152,121,0.5); }
        .ritual-counter { font-size: 0.78rem; color: rgba(166,172,205,0.5); }
        .ritual-skip-link { color: rgba(166,172,205,0.45); font-size: 0.75rem; text-decoration: underline; transition: color 0.2s ease; }
        .ritual-skip-link:hover { color: rgba(166,172,205,0.8); }

        /* ── MODERN STARTUP THEME (Vercel/Linear Style) ── */
        body.theme-startup {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background-color: #09090b;
            color: #a1a1aa;
            padding: 0;
        }

        body.theme-startup .terminal-window {
            background-color: #09090b;
        }

        body.theme-startup .content {
            padding: 8px;
            gap: 10px;
        }

        body.theme-startup .main-panel {
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
            padding: 10px;
        }

        body.theme-startup .main-panel:hover {
            border-color: #3f3f46;
        }

        body.theme-startup .section-header {
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #71717a;
        }

        body.theme-startup .question-text {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            font-size: 0.95rem;
            line-height: 1.6;
            color: #d4d4d8;
        }

        body.theme-startup .question-text code {
            background-color: #27272a;
            color: #8b5cf6;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Fira Code', monospace;
            font-size: 0.85em;
        }

        body.theme-startup .heart-icon {
            font-size: 1.1rem;
            transition: transform 0.2s ease;
        }

        body.theme-startup .theme-switcher-container {
            border-top: 1px solid #27272a !important;
        }

        body.theme-startup #theme-select {
            background-color: #18181b !important;
            border: 1px solid #3f3f46 !important;
            color: #fafafa !important;
        }

        body.theme-startup #theme-select option {
            background-color: #18181b !important;
            color: #fafafa !important;
        }

        body.theme-startup .btn {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            border-radius: 8px;
            font-size: 0.82rem;
            font-weight: 600;
            transition: all 0.2s ease;
            height: 38px;
        }

        body.theme-startup .btn:active {
            transform: scale(0.98);
        }

        body.theme-startup .btn-solid {
            background: #fafafa;
            color: #09090b;
            border: none;
        }

        body.theme-startup .btn-solid:hover {
            background: #e4e4e7;
        }

        body.theme-startup .btn-outline {
            background: transparent;
            color: #fafafa;
            border: 1px solid #3f3f46;
        }

        body.theme-startup .btn-outline:hover {
            background: #27272a;
            color: #fafafa;
            border-color: #3f3f46;
        }

        body.theme-startup #btn-hint.btn-outline:hover,
        body.theme-startup #btn-resubmit.btn-outline:hover,
        body.theme-startup #btn-more-explanation.btn-outline:hover,
        body.theme-startup #btn-nav.btn-outline:hover {
            color: #fafafa;
            background: #27272a;
            border-color: #3f3f46;
        }

        body.theme-startup .actions-panel {
            border-top: 1px solid #27272a;
        }

        body.theme-startup .result-box {
            border: 1px solid #27272a;
            background: #18181b;
        }

        body.theme-startup .success-banner {
            color: #10b981;
        }

        body.theme-startup .fail-banner {
            color: #ef4444;
        }

        body.theme-startup .page-footer {
            border-top: 1px solid #27272a;
            color: #71717a;
        }

        body.theme-startup .page-footer span {
            color: #fafafa !important;
        }

        body.theme-startup .loading-overlay {
            background-color: rgba(9, 9, 11, 0.9);
        }

        body.theme-startup .pacman-top, 
        body.theme-startup .pacman-bottom {
            background-color: #8b5cf6;
        }

        body.theme-startup .dot {
            background-color: #8b5cf6;
        }

        body.theme-startup .loading-text {
            color: #8b5cf6;
            font-family: 'Inter', -apple-system, sans-serif;
            font-weight: 600;
        }

        body.theme-startup ::-webkit-scrollbar-thumb {
            background: rgba(63, 63, 70, 0.5);
        }
        body.theme-startup ::-webkit-scrollbar-thumb:hover {
            background: rgba(113, 113, 122, 0.8);
        }

        /* ── RITUAL PANEL CSS (Startup Override) ── */
        body.theme-startup .ritual-step-indicator.active { background-color: #8b5cf6; }
        body.theme-startup .ritual-step-indicator.inactive { background-color: #27272a; }
        body.theme-startup .ritual-title-text { color: #8b5cf6 !important; }
        body.theme-startup .ritual-card-info {
            background: rgba(139, 92, 246, 0.05);
            border: 1px solid #3f3f46;
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-startup .ritual-card-info:hover {
            border-color: rgba(139, 92, 246, 0.6);
            box-shadow: 0 -2px 6px rgba(139, 92, 246, 0.4);
        }
        body.theme-startup .ritual-card-warning {
            background: rgba(14, 165, 233, 0.05);
            border: 1px solid #3f3f46;
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-startup .ritual-card-warning:hover {
            border-color: rgba(14, 165, 233, 0.6);
            box-shadow: 0 -2px 6px rgba(14, 165, 233, 0.4);
        }
        body.theme-startup .ritual-card-title { color: #a78bfa; font-weight: 600; font-family: 'Inter', sans-serif; }
        body.theme-startup .ritual-card-title-warning { color: #38bdf8; }
        body.theme-startup .ritual-code-block { font-family: 'Fira Code', monospace; color: #d4d4d8; }
        body.theme-startup .ritual-subtitle { color: #a1a1aa; font-family: 'Inter', sans-serif; font-size: 0.9rem; }
        body.theme-startup .ritual-highlight { color: #fafafa; }
        body.theme-startup .ritual-textarea { background: #09090b; border: 1px solid #3f3f46; color: #fafafa; font-family: 'Inter', sans-serif; }
        body.theme-startup .ritual-textarea:focus { border-color: #8b5cf6; box-shadow: 0 0 0 1px #8b5cf6; }
        body.theme-startup .ritual-counter { color: #71717a; }
        body.theme-startup .ritual-skip-link { color: #71717a; }
        body.theme-startup .ritual-skip-link:hover { color: #a1a1aa; }

        /* Startup theme overrides for Socratic Cards & Buttons */
        body.theme-startup .socratic-card {
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 14px;
            background: rgba(255, 255, 255, 0.03);
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-startup .socratic-card:hover {
            border-color: rgba(139, 92, 246, 0.6);
            box-shadow: 0 -2px 6px rgba(139, 92, 246, 0.4);
        }
        body.theme-startup .socratic-card-header {
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        body.theme-startup .socratic-card-title {
            color: rgba(255, 255, 255, 0.45);
        }
        body.theme-startup .socratic-card-text {
            color: rgba(255, 255, 255, 0.75);
        }
        body.theme-startup .socratic-textarea {
            color: rgba(255, 255, 255, 0.8);
        }
        body.theme-startup .socratic-btn-hint {
            border-radius: 10px;
            border: 1px solid rgba(244, 63, 94, 0.35);
            background: rgba(244, 63, 94, 0.07);
            color: #f43f5e;
        }
        body.theme-startup .socratic-btn-hint:hover {
            background: rgba(244, 63, 94, 0.15);
        }
        body.theme-startup .socratic-btn-submit {
            border-radius: 10px;
            border: none;
            background: rgba(255, 255, 255, 0.9);
            color: #09090b;
        }
        body.theme-startup .socratic-btn-submit:hover {
            background: rgba(255, 255, 255, 1);
        }
        body.theme-startup .socratic-btn-games {
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: rgba(255, 255, 255, 0.04);
            color: rgba(255, 255, 255, 0.9);
            font-family: inherit;
            font-size: 0.8rem;
            cursor: pointer;
            height: 32px;
        }
        body.theme-startup .socratic-btn-games:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.3);
        }
        body.theme-startup #btn-page2-submit {
            height: 32px;
            font-size: 0.8rem;
            border-radius: 8px;
            flex: none;
        }
        body.theme-startup .socratic-explanation-card {
            border: 1px solid rgba(56, 189, 248, 0.2);
            border-radius: 12px;
            background: rgba(56, 189, 248, 0.04);
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-startup .socratic-explanation-card:hover {
            border-color: rgba(56, 189, 248, 0.6);
            box-shadow: 0 -2px 6px rgba(56, 189, 248, 0.4);
        }
        body.theme-startup .socratic-explanation-header {
            border-bottom: 1px solid rgba(56, 189, 248, 0.15);
        }
        body.theme-startup .socratic-explanation-text {
            color: rgba(255, 255, 255, 0.75);
        }

        body.theme-startup .error-navigator-container {
            background: rgba(167, 139, 250, 0.08);
            border: 1px solid rgba(167, 139, 250, 0.25);
            border-radius: 8px;
        }

        body.theme-startup .error-navigator-btn {
            color: #a78bfa;
        }

        body.theme-startup #btn-error-prev.error-navigator-btn {
            border-right: 1px solid rgba(167, 139, 250, 0.2);
        }

        body.theme-startup #btn-error-next.error-navigator-btn {
            border-left: 1px solid rgba(167, 139, 250, 0.2);
        }

        body.theme-startup .error-navigator-btn:hover {
            background: rgba(167, 139, 250, 0.08);
        }

        body.theme-startup .error-navigator-display {
            color: #a78bfa;
        }

        body.theme-startup .page-nav-btn {
            color: #fafafa;
        }

        /* ── THE "NATIVE VS CODE" CHAMELEON THEME ── */
        body.theme-native {
            font-family: var(--vscode-font-family), sans-serif;
            background-color: var(--vscode-sideBar-background);
            color: var(--vscode-foreground);
            padding: 0;
        }

        body.theme-native .terminal-window {
            background-color: var(--vscode-sideBar-background);
        }

        body.theme-native .content {
            padding: 8px;
            gap: 10px;
        }

        body.theme-native .main-panel {
            background: var(--vscode-sideBar-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
            border-radius: 6px;
            padding: 10px;
            box-shadow: none;
        }

        body.theme-native .main-panel:hover {
            border-color: var(--vscode-panel-border, var(--vscode-sideBar-border, transparent));
        }

        body.theme-native .section-header {
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            letter-spacing: 0.05em;
        }

        body.theme-native .question-text {
            font-family: var(--vscode-font-family), sans-serif;
            font-size: 0.95rem;
            line-height: 1.6;
            color: var(--vscode-editor-foreground);
        }

        body.theme-native .question-text code {
            background-color: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 0.85em;
        }

        body.theme-native .heart-icon {
            font-size: 1.1rem;
            transition: transform 0.2s ease;
        }

        body.theme-native #theme-select {
            background-color: var(--vscode-sideBar-background) !important;
            border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.3)))) !important;
            color: var(--vscode-foreground) !important;
        }

        body.theme-native #theme-select option {
            background-color: var(--vscode-sideBar-background) !important;
            color: var(--vscode-foreground) !important;
        }

        body.theme-native .btn {
            font-family: var(--vscode-font-family), sans-serif;
            border-radius: 4px;
            font-size: 0.82rem;
            border: 1px solid transparent;
            transition: all 0.2s ease;
            height: 38px;
        }

        body.theme-native .btn-solid {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
        }

        body.theme-native .btn-solid:hover {
            background: var(--vscode-button-hoverBackground);
        }

        body.theme-native .btn-outline {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-button-border, rgba(128, 128, 128, 0.3))));
        }

        body.theme-native .btn-outline:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        body.theme-native #btn-hint.btn-outline:hover,
        body.theme-native #btn-resubmit.btn-outline:hover,
        body.theme-native #btn-more-explanation.btn-outline:hover,
        body.theme-native #btn-nav.btn-outline:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        body.theme-native .actions-panel {
            border-top: 1px solid var(--vscode-panel-border);
        }

        body.theme-native .result-box {
            border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.3))));
            background: var(--vscode-editor-background);
        }

        body.theme-native .success-banner {
            color: var(--vscode-terminal-ansiGreen, #10b981);
        }

        body.theme-native .fail-banner {
            color: var(--vscode-errorForeground);
        }

        body.theme-native .page-footer {
            border-top: 1px dashed var(--vscode-panel-border);
            color: var(--vscode-descriptionForeground);
        }

        body.theme-native .page-footer span {
            color: var(--vscode-foreground) !important;
        }

        body.theme-native .loading-overlay {
            background-color: var(--vscode-sideBar-background);
            opacity: 0.95;
        }

        body.theme-native .pacman-top, 
        body.theme-native .pacman-bottom {
            background-color: var(--vscode-terminal-ansiYellow);
        }

        body.theme-native .dot {
            background-color: var(--vscode-terminal-ansiYellow);
        }

        body.theme-native .loading-text {
            color: var(--vscode-terminal-ansiYellow);
            font-family: var(--vscode-font-family), sans-serif;
            font-weight: bold;
        }

        /* ── RITUAL PANEL CSS (Native Override) ── */
        body.theme-native .ritual-step-indicator.active { background-color: var(--vscode-button-background); }
        body.theme-native .ritual-step-indicator.inactive { background-color: var(--vscode-editorHoverWidget-background); }
        body.theme-native .ritual-title-text { color: var(--vscode-foreground) !important; font-family: var(--vscode-font-family); }
        body.theme-native .ritual-card { border-radius: 4px; border-style: solid; border-width: 1px; }
        body.theme-native .ritual-card-info {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25)));
            border-left: 4px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border, var(--vscode-focusBorder, #007acc)));
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-native .ritual-card-info:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 -2px 6px var(--vscode-focusBorder);
        }
        body.theme-native .ritual-card-warning {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25)));
            border-left: 4px solid var(--vscode-editorWarning-foreground, var(--vscode-focusBorder, #f29879));
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-native .ritual-card-warning:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 -2px 6px var(--vscode-focusBorder);
        }
        body.theme-native .ritual-card-title { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); text-transform: none; font-size: 0.85rem; font-weight: bold; }
        body.theme-native .ritual-card-title-warning { color: var(--vscode-editorWarning-foreground); }
        body.theme-native .ritual-code-block { font-family: var(--vscode-editor-font-family); color: var(--vscode-editor-foreground); background-color: var(--vscode-textCodeBlock-background); padding: 4px; border-radius: 4px; }
        body.theme-native .ritual-subtitle { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); font-size: 0.9rem; }
        body.theme-native .ritual-highlight { color: var(--vscode-foreground); font-weight: bold; }
        body.theme-native .ritual-textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); font-family: var(--vscode-font-family); border-radius: 2px; }
        body.theme-native .ritual-textarea:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
        body.theme-native .ritual-counter { color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
        body.theme-native .ritual-skip-link { color: var(--vscode-textLink-foreground); font-family: var(--vscode-font-family); }
        body.theme-native .ritual-skip-link:hover { color: var(--vscode-textLink-activeForeground); }

        /* ── HINT MODAL OVERLAY ── */
        .hint-modal-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.65);
            z-index: 9999;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(4px);
            animation: hintFadeIn 0.2s ease;
        }
        .hint-modal-overlay.visible {
            display: flex;
        }
        @keyframes hintFadeIn {
            from { opacity: 0; }
            to   { opacity: 1; }
        }
        .hint-modal-box {
            background: #13141c;
            border: 1px dashed rgba(242, 152, 121, 0.4);
            border-radius: 6px;
            width: 90%;
            max-width: 360px;
            padding: 0;
            box-shadow: 0 8px 30px rgba(0,0,0,0.6);
            font-family: 'DM Mono', 'Courier New', monospace;
            animation: hintSlideUp 0.25s ease;
        }
        @keyframes hintSlideUp {
            from { transform: translateY(20px); opacity: 0; }
            to   { transform: translateY(0); opacity: 1; }
        }
        .hint-modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 14px 18px 10px;
        }
        .hint-modal-title {
            font-size: 0.82rem;
            font-weight: 700;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: #f29879;
            font-family: 'DM Mono', 'Courier New', monospace;
        }
        .hint-modal-close {
            background: none;
            border: none;
            color: rgba(242, 152, 121, 0.6);
            font-size: 1.1rem;
            cursor: pointer;
            padding: 2px 6px;
            border-radius: 4px;
            transition: color 0.15s, background 0.15s;
        }
        .hint-modal-close:hover {
            color: #f29879;
            background: rgba(242, 152, 121, 0.08);
        }
        .hint-modal-divider {
            border: none;
            border-top: 1px dashed rgba(242, 152, 121, 0.25);
            margin: 0 18px;
        }
        .hint-modal-body {
            padding: 14px 18px 10px;
            font-size: 0.82rem;
            line-height: 1.65;
            color: #a6accd;
            min-height: 60px;
            font-family: 'DM Mono', 'Courier New', monospace;
        }
        .hint-modal-counter {
            padding: 0 18px 6px;
            font-size: 0.7rem;
            color: rgba(242, 152, 121, 0.5);
            letter-spacing: 0.06em;
            font-family: 'DM Mono', 'Courier New', monospace;
        }
        .hint-modal-actions {
            display: flex;
            gap: 8px;
            padding: 8px 18px 16px;
        }
        .hint-modal-btn {
            flex: 1;
            height: 36px;
            border-radius: 6px;
            font-family: 'DM Mono', 'Courier New', monospace;
            font-size: 0.8rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.15s ease;
            letter-spacing: 0.03em;
        }
        .hint-btn-next {
            background: #f29879;
            color: #13141c;
            border: 1px solid #f29879;
        }
        .hint-btn-next:hover {
            background: #efa88d;
            border-color: #efa88d;
        }
        .hint-btn-next:disabled {
            opacity: 0.35;
            cursor: default;
        }
        .hint-btn-quit {
            background: transparent;
            color: #f29879;
            border: 1px dashed rgba(242, 152, 121, 0.4);
        }
        .hint-btn-quit:hover {
            background: rgba(242, 152, 121, 0.08);
            border-color: #f29879;
        }

        /* ── HINT MODAL: Startup theme override ── */
        body.theme-startup .hint-modal-box {
            background: #09090b;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 14px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-startup .hint-modal-box:hover {
            border-color: rgba(139, 92, 246, 0.6);
            box-shadow: 0 -2px 10px rgba(139, 92, 246, 0.35), 0 20px 50px rgba(0, 0, 0, 0.6);
        }
        body.theme-startup .hint-modal-title {
            color: #8b5cf6;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            font-weight: 600;
            letter-spacing: 0.05em;
        }
        body.theme-startup .hint-modal-divider {
            border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        body.theme-startup .hint-modal-body {
            color: rgba(255, 255, 255, 0.85);
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            font-size: 0.82rem;
        }
        body.theme-startup .hint-modal-counter {
            color: rgba(255, 255, 255, 0.4);
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        }
        body.theme-startup .hint-modal-btn {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            border-radius: 8px;
        }
        body.theme-startup .hint-btn-next {
            background: #8b5cf6;
            color: #ffffff;
            border: none;
        }
        body.theme-startup .hint-btn-next:hover {
            background: #a78bfa;
        }
        body.theme-startup .hint-btn-quit {
            background: rgba(255, 255, 255, 0.04);
            color: rgba(255, 255, 255, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.12);
        }
        body.theme-startup .hint-btn-quit:hover {
            background: rgba(255, 255, 255, 0.08);
            border-color: rgba(255, 255, 255, 0.25);
            color: #ffffff;
        }
        body.theme-startup .hint-modal-close {
            color: rgba(255, 255, 255, 0.4);
        }
        body.theme-startup .hint-modal-close:hover {
            color: #ffffff;
            background: rgba(255, 255, 255, 0.08);
        }

        /* ── HINT MODAL: Native VS Code theme override ── */
        body.theme-native .hint-modal-box {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.3))));
            border-radius: 6px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
            font-family: var(--vscode-font-family), sans-serif;
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-native .hint-modal-box:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 -2px 10px var(--vscode-focusBorder), 0 10px 30px rgba(0, 0, 0, 0.35);
        }
        body.theme-native .hint-modal-title {
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family), sans-serif;
            font-weight: bold;
            letter-spacing: normal;
            text-transform: none;
        }
        body.theme-native .hint-modal-divider {
            border-top: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, rgba(128, 128, 128, 0.2)));
        }
        body.theme-native .hint-modal-body {
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family), sans-serif;
            font-size: 0.82rem;
        }
        body.theme-native .hint-modal-counter {
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-font-family), sans-serif;
        }
        body.theme-native .hint-modal-btn {
            font-family: var(--vscode-font-family), sans-serif;
            border-radius: 4px;
        }
        body.theme-native .hint-btn-next {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
        }
        body.theme-native .hint-btn-next:hover {
            background: var(--vscode-button-hoverBackground);
        }
        body.theme-native .hint-btn-quit {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.3))));
        }
        body.theme-native .hint-btn-quit:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        body.theme-native .hint-modal-close {
            color: var(--vscode-descriptionForeground);
        }
        body.theme-native .hint-modal-close:hover {
            color: var(--vscode-foreground);
            background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
        }

        /* Native theme overrides for Socratic Cards & Buttons */
        body.theme-native .socratic-card {
            border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.3))));
            border-radius: 6px;
            background: var(--vscode-editor-background);
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-native .socratic-card:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 -2px 6px var(--vscode-focusBorder);
        }
        body.theme-native .socratic-card-header {
            border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.2))));
        }
        body.theme-native .socratic-card-title {
            color: var(--vscode-descriptionForeground);
        }
        body.theme-native .socratic-card-text {
            color: var(--vscode-foreground);
        }
        body.theme-native .socratic-textarea {
            color: var(--vscode-input-foreground);
        }
        body.theme-native .socratic-btn-hint {
            border-radius: 6px;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.3))));
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        body.theme-native .socratic-btn-hint:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        body.theme-native .socratic-btn-submit {
            border-radius: 6px;
            border: none;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        body.theme-native .socratic-btn-submit:hover {
            background: var(--vscode-button-hoverBackground);
        }
        body.theme-native .socratic-btn-games {
            border-radius: 4px;
            border: 1px solid var(--vscode-button-border, transparent);
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            font-family: inherit;
            font-size: 0.8rem;
            cursor: pointer;
            height: 32px;
        }
        body.theme-native .socratic-btn-games:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        body.theme-native #btn-page2-submit {
            height: 32px;
            font-size: 0.8rem;
            border-radius: 4px;
            flex: none;
        }
        body.theme-native .socratic-explanation-card {
            border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.3))));
            border-radius: 6px;
            background: var(--vscode-textBlockQuote-background);
            transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        body.theme-native .socratic-explanation-card:hover {
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 -2px 6px var(--vscode-focusBorder);
        }
        body.theme-native .socratic-explanation-header {
            border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.2))));
            color: var(--vscode-foreground);
        }
        body.theme-native .socratic-explanation-text {
            color: var(--vscode-foreground);
        }

        body.theme-native .error-navigator-container {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.3))));
            border-radius: 6px;
        }

        body.theme-native .error-navigator-btn {
            color: var(--vscode-foreground);
        }

        body.theme-native #btn-error-prev.error-navigator-btn {
            border-right: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.2))));
        }

        body.theme-native #btn-error-next.error-navigator-btn {
            border-left: 1px solid var(--vscode-panel-border, var(--vscode-sideBar-border, var(--vscode-input-border, rgba(128, 128, 128, 0.2))));
        }

        body.theme-native .error-navigator-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        body.theme-native .error-navigator-display {
            color: var(--vscode-foreground);
        }

        body.theme-native .page-nav-btn {
            color: var(--vscode-foreground);
        }
    </style>
</head>
<body>
    <div class="terminal-window">
        <!-- Loading Overlay -->
        <div class="loading-overlay" id="loading-overlay">
            <div class="pacman-container">
                <div class="pacman">
                    <div class="pacman-top"></div>
                    <div class="pacman-bottom"></div>
                </div>
                <div class="dots-container">
                    <div class="dot"></div>
                    <div class="dot"></div>
                    <div class="dot"></div>
                    <div class="dot"></div>
                </div>
            </div>
            <div class="loading-text" id="loading-text">Initializing Socratic Mission...</div>
        </div>

        <!-- ── HINT POPUP MODAL ── -->
        <div class="hint-modal-overlay" id="hint-modal-overlay">
            <div class="hint-modal-box">
                <div class="hint-modal-header">
                    <span class="hint-modal-title">HINT REVEALED</span>
                    <button class="hint-modal-close" id="hint-modal-close" title="Close">&times;</button>
                </div>
                <hr class="hint-modal-divider">
                <div class="hint-modal-body" id="hint-modal-body">Loading hint…</div>
                <div class="hint-modal-counter" id="hint-modal-counter">Hint 1 of 3</div>
                <div class="hint-modal-actions">
                    <button class="hint-modal-btn hint-btn-quit" id="hint-btn-quit">Quit &amp; Build</button>
                    <button class="hint-modal-btn hint-btn-next" id="hint-btn-next">Next Hint &rarr;</button>
                </div>
            </div>
        </div>

        <!-- content area -->
        <div class="content">

            <!-- Bug Queue Progress Panel (Hidden by default) -->
            <div id="queue-progress-panel" style="display: none; background: rgba(167, 139, 250, 0.1); border: 1px dashed rgba(167, 139, 250, 0.4); border-radius: 8px; padding: 12px; margin-bottom: -10px;">
                <div class="section-header" style="color: #a78bfa; margin-bottom: 8px;">MISSION PROGRESS</div>
                <div style="display: flex; justify-content: space-between; font-family: 'DM Mono', monospace; font-size: 0.85rem; color: #e6edf3;">
                    <span id="queue-bug-count">Bug 1/4</span>
                    <span id="queue-current-target" style="color: #a78bfa;">Current Target: Line X</span>
                </div>
                <div style="font-family: 'DM Mono', monospace; font-size: 0.8rem; color: #e6edf3; margin-top: 4px; opacity: 0.8;">
                    Error Type: <span id="queue-error-type" style="color: #ff5f56;">NameError</span>
                </div>
            </div>

            <!-- MAIN PANEL -->
            <div class="main-panel" id="main-panel">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed rgba(166, 172, 205, 0.15); padding-bottom: 8px; margin-bottom: 4px;">
                    <div class="section-header" id="panel-title" style="margin-bottom: 0;">EXPLANATION</div>
                    <div id="hearts-capsule" style="display: flex; gap: 4px;">
                        <span class="heart-icon">♥</span>
                        <span class="heart-icon">♥</span>
                        <span class="heart-icon">♥</span>
                    </div>
                </div>
                
                <!-- Page 1 Paper Layout (Tier 2 wireframe-accurate) [DEPRECATED BUT KEPT FOR FALLBACK] -->
                <div id="page-1-layout" style="display: none; flex-direction: column; gap: 14px; margin-top: 12px; flex: 1; height: 100%; overflow: hidden; padding: 2px 4px; box-sizing: border-box;">

                    <!-- ───── MEANING CARD ───── -->
                    <div id="meaning-card" class="socratic-card">
                        <!-- Card header row: "Meaning" label + < [line#] > error navigator -->
                        <div class="socratic-card-header">
                            <span class="socratic-card-title">Meaning</span>
                            <!-- Error line navigator: < [12] > -->
                            <div id="error-line-navigator" class="error-navigator-container">
                                <button id="btn-error-prev" title="Previous error" class="error-navigator-btn">&lt;</button>
                                <span id="error-line-display" class="error-navigator-display">–</span>
                                <button id="btn-error-next" title="Next error" class="error-navigator-btn">&gt;</button>
                            </div>
                        </div>
                        <!-- Card body: error description -->
                        <div class="socratic-card-body">
                            <div id="explanation-error-summary" class="socratic-card-text">Loading...</div>
                        </div>
                    </div>

                    <!-- Tier 3 Location card (hidden for tier 2) -->
                    <div class="ritual-card ritual-card-warning" id="location-card" style="margin-top:12px;">
                        <div class="ritual-card-title ritual-card-title-warning">LOCATION</div>
                        <input type="text" id="explanation-line-input" class="ritual-textarea" placeholder="Line #" style="width: 100px; padding: 6px; margin-top: 4px; box-sizing: border-box;">
                        <div class="ritual-subtitle" style="margin-top: 8px;">Check the terminal and analyze the code to find the exact line.</div>
                    </div>

                    <!-- Tier 3 Hypothesis input (hidden for tier 2) -->
                    <div id="hypothesis-section" style="margin-top:14px;">
                        <div class="ritual-card-title" style="margin-bottom: 4px; color: var(--vscode-foreground);">HYPOTHESIS</div>
                        <div class="ritual-subtitle" style="margin-bottom: 10px;">
                            <b class="ritual-highlight" id="explanation-question-text">Before you can fix the error...</b><br>
                            Write your best guess — even if you're not sure. No code, just words.
                        </div>
                        <textarea id="explanation-input" class="ritual-textarea" rows="6" placeholder="e.g. I think the variable is missing a value before being used..."></textarea>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
                            <span id="explanation-counter" class="ritual-counter">0 / 20 min</span>
                            <button class="btn btn-solid btn-blue" id="btn-explanation-submit" style="width: auto; padding: 0 18px; opacity: 0.5;" disabled>Submit &amp; Start &rarr;</button>
                        </div>
                    </div>

                    <!-- ───── TIER 2: THINK CRITICALLY ───── -->
                    <div id="tier2-hypothesis-section" style="display: none; flex: 1; flex-direction: column; overflow: hidden;">
                        <div class="socratic-card">
                            <!-- Card header row -->
                            <div class="socratic-card-header">
                                <span class="socratic-card-title">Think critically</span>
                            </div>
                            
                            <!-- Card body -->
                            <div class="socratic-card-body">
                                <textarea
                                    id="tier2-hypothesis-input"
                                    rows="6"
                                    placeholder="Best guess"
                                    class="socratic-textarea"
                                ></textarea>
                            </div>
                        </div>
                        <!-- Bottom row: Hint square + Submit pill -->
                        <div style="display: flex; gap: 10px; margin-top: 10px; align-items: center; padding-bottom: 2px;">
                            <button
                                id="btn-tier2-hint"
                                title="Get a hint (costs 1 heart)"
                                class="socratic-btn-hint"
                            >💡</button>
                            <button
                                id="btn-tier2-submit"
                                class="socratic-btn-submit"
                            >&gt; /submit</button>
                        </div>
                    </div>



                    <!-- Skip link -->
                    <div id="ritual-skip-container" style="display: none; text-align: center; margin-top: 8px;">
                        <a href="#" id="link-ritual-skip" class="ritual-skip-link">Skip ritual (Rank 3+)</a>
                    </div>
                </div>

                <!-- DASHBOARD V2 LAYOUT -->
                <div id="dashboard-v2-layout" style="display: none; flex-direction: column; gap: 14px; margin-top: 12px; flex: 1; height: 100%; overflow: auto; padding: 2px 4px; box-sizing: border-box;">
                    <!-- SECTION 2: GOAL -->
                    <div id="v2-goal-card" class="socratic-card">
                        <div class="socratic-card-header">
                            <span class="socratic-card-title">Goal</span>
                        </div>
                        <div class="socratic-card-body">
                            <div id="v2-goal-text" class="socratic-card-text">Loading...</div>
                        </div>
                    </div>

                    <!-- SECTION 4: ACTUAL BEHAVIOR -->
                    <div id="v2-actual-behavior-card" class="socratic-card">
                        <div class="socratic-card-header">
                            <span class="socratic-card-title">Actual Behavior</span>
                        </div>
                        <div class="socratic-card-body">
                            <div id="v2-actual-behavior-text" class="socratic-card-text" style="color: #ff5f56; font-family: monospace; font-size: 0.9em; padding: 4px; background: rgba(255, 95, 86, 0.1); border-radius: 4px; white-space: pre-wrap;">Loading...</div>
                        </div>
                    </div>

                    <!-- SECTION: OBSERVE -->
                    <div id="v2-observe-card" class="socratic-card">
                        <div class="socratic-card-header">
                            <span class="socratic-card-title">Observe</span>
                        </div>
                        <div class="socratic-card-body" id="v2-observe-body" style="font-size: 0.9em;">
                            Loading...
                        </div>
                    </div>

                    <!-- SECTION 5: QUESTION -->
                    <div id="v2-question-card" class="socratic-card">
                        <div class="socratic-card-header">
                            <span class="socratic-card-title">Question</span>
                        </div>
                        <div class="socratic-card-body">
                            <div id="v2-question-text" class="socratic-card-text" style="font-weight: 600; color: #a78bfa;">Loading...</div>
                        </div>
                    </div>

                    <!-- SECTION 6: HYPOTHESIS & SECTION 9: SUBMIT -->
                    <div id="v2-hypothesis-section" style="display: flex; flex-direction: column;">
                        <div class="socratic-card">
                            <div class="socratic-card-header">
                                <span class="socratic-card-title">Hypothesis</span>
                            </div>
                            <div class="socratic-card-body">
                                <textarea id="v2-hypothesis-input" rows="4" placeholder="e.g. I think the loop ends too early..." class="socratic-textarea"></textarea>
                            </div>
                        </div>
                        
                        <!-- SECTION 7: HINT SYSTEM -->
                        <div style="display: flex; gap: 10px; margin-top: 10px; align-items: center; justify-content: space-between;">
                            <div style="display: flex; gap: 8px;">
                                <button id="btn-v2-hint" title="Get a hint (costs 1 heart)" class="socratic-btn-hint" style="padding: 4px 12px;">💡 Hint (<span id="v2-hints-remaining">3</span> left)</button>
                            </div>
                            <button class="socratic-btn-submit" id="btn-v2-submit" style="padding: 4px 24px; font-weight: bold;">&gt; /submit</button>
                        </div>
                    </div>

                    <!-- SECTION 8: EXPLANATION (LOCKED) -->
                    <div id="v2-explanation-card" class="socratic-explanation-card" style="display: none; margin-top: 10px; flex: none;">
                        <div class="socratic-explanation-header">Root Cause & Explanation</div>
                        <div id="v2-explanation-text" class="socratic-explanation-text" style="padding: 12px; font-size: 0.9em; white-space: pre-wrap;"></div>
                    </div>
                </div>

                <!-- Page 2 Detailed Explanation Layout -->
                <div id="page-2-layout" style="display: none; flex: 1; flex-direction: column; overflow: hidden; margin-top: 12px; padding: 2px 4px; box-sizing: border-box;">
                    <div class="socratic-explanation-card" style="flex: 1;">
                        <div class="socratic-explanation-header">Detailed Explanation</div>
                        <div id="page-2-explanation-text" class="socratic-explanation-text">Loading...</div>
                    </div>
                    <button
                        id="btn-page2-games"
                        class="socratic-btn-games"
                        style="margin-top: 8px; width: 100%; box-sizing: border-box;"
                    >&gt; /games</button>
                    <button
                        id="btn-page2-submit"
                        class="socratic-btn-submit"
                        style="margin-top: 6px; width: 100%; box-sizing: border-box;"
                    >&gt; /submit</button>
                </div>

                <div class="question-text" id="question-text" style="display: none; margin-top: 8px;"></div>
            </div>


            <!-- RUNTIME CONTEXT PANEL -->
            <div class="runtime-panel hidden" id="runtime-panel">
                <div class="section-header">Runtime Context</div>
                <div class="stats-row">
                    <span class="stats-key">Exit Code</span>
                    <span class="stats-val" id="runtime-exit-code">
                        <span class="runtime-badge badge-fail" id="runtime-exit-badge">✗ 1</span>
                    </span>
                </div>
                <div class="runtime-error-text" id="runtime-error-text"></div>
                <div class="runtime-summary" id="runtime-summary">Runtime failure detected — mission questions target this specific error.</div>
            </div>

            <!-- Actions Section Removed per request -->

            <!-- Page Indicator at the bottom -->
            <div class="page-footer" style="display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: auto; font-size: 0.8rem; color: rgba(166, 172, 205, 0.5); border-top: 1px dashed rgba(166, 172, 205, 0.1); padding-top: 12px; padding-bottom: 8px;">
                <div id="page-indicator" style="display: none;">
                    Page <span id="page-display" style="color: #c5cdd8; font-weight: 500;">1 of 3</span>
                </div>
                <!-- Theme Switcher Option -->
                <div class="theme-switcher-container" style="display: flex; align-items: center; gap: 8px;">
                    <span>Theme:</span>
                    <select id="theme-select">
                        <option value="retro">Retro Terminal</option>
                        <option value="startup">Startup (Vercel/Linear)</option>
                        <option value="native">Native VS Code</option>
                    </select>
                </div>
            </div>


        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let canProceedAnyway = false;
        
        let currentRegionIndex = 0;
        let regionHypotheses = [];
        let currentErrorRegions = [];

        function renderCurrentRegion() {
            if (!currentErrorRegions || currentErrorRegions.length === 0) return;
            const region = currentErrorRegions[currentRegionIndex];
            const errorLineDisplay = document.getElementById('error-line-display');
            const expSummary = document.getElementById('explanation-error-summary');
            const hypInput = document.getElementById('tier2-hypothesis-input');
            
            if (errorLineDisplay) {
                let rangeText = region.formattedRange || (region.lineStart === region.lineEnd ? '#' + String(region.lineStart) : '#' + String(region.lineStart) + '-' + String(region.lineEnd));
                if (rangeText.startsWith('#L')) {
                    rangeText = '#' + rangeText.substring(2);
                } else if (rangeText.startsWith('L')) {
                    rangeText = '#' + rangeText.substring(1);
                }
                errorLineDisplay.textContent = rangeText;
            }
            if (expSummary) {
                expSummary.textContent = region.meaning;
            }
            if (hypInput) {
                hypInput.value = regionHypotheses[currentRegionIndex] || '';
            }
            
            vscode.postMessage({ type: 'GO_TO_LINE', line: region.lineStart });
        }

        const loadingOverlay = document.getElementById('loading-overlay');
        const loadingText = document.getElementById('loading-text');

        // Function to run a loading animation
        function runLoader(durationMs, text, callback) {
            loadingOverlay.classList.remove('hidden');
            loadingText.textContent = text;
            
            setTimeout(() => {
                loadingOverlay.classList.add('hidden');
                if (callback) {
                    callback();
                }
            }, durationMs);
        }

        // Utility: prevent XSS when rendering line content
        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        // Run introduction loader on start
        window.addEventListener('DOMContentLoaded', () => {
            runLoader(3000, "Initializing Socratic Mission...");
            vscode.postMessage({ type: 'REQUEST_STATE' });
        });

        // ── Error line navigator (prev / next) ──────────────────────────────────
        const btnErrorPrev = document.getElementById('btn-error-prev');
        const btnErrorNext = document.getElementById('btn-error-next');
        if (btnErrorPrev) {
            btnErrorPrev.addEventListener('click', () => {
                if (currentErrorRegions && currentErrorRegions.length > 0) {
                    const hypInput = document.getElementById('tier2-hypothesis-input');
                    if (hypInput) regionHypotheses[currentRegionIndex] = hypInput.value;
                    currentRegionIndex = (currentRegionIndex - 1 + currentErrorRegions.length) % currentErrorRegions.length;
                    renderCurrentRegion();
                } else {
                    vscode.postMessage({ type: 'NAVIGATE_ERROR', direction: 'prev' });
                }
            });
        }
        if (btnErrorNext) {
            btnErrorNext.addEventListener('click', () => {
                if (currentErrorRegions && currentErrorRegions.length > 0) {
                    const hypInput = document.getElementById('tier2-hypothesis-input');
                    if (hypInput) regionHypotheses[currentRegionIndex] = hypInput.value;
                    currentRegionIndex = (currentRegionIndex + 1) % currentErrorRegions.length;
                    renderCurrentRegion();
                } else {
                    vscode.postMessage({ type: 'NAVIGATE_ERROR', direction: 'next' });
                }
            });
        }
        // ──────────────────────────────────────────────────────────────────────

        // ── Tier 2 event listeners ─────────────────────────────────────────────

        const btnTier2Submit = document.getElementById('btn-tier2-submit');
        if (btnTier2Submit) {
            btnTier2Submit.addEventListener('click', () => {
                const hypInput = document.getElementById('tier2-hypothesis-input');
                if (currentErrorRegions && currentErrorRegions.length > 0) {
                    if (hypInput) regionHypotheses[currentRegionIndex] = hypInput.value;
                    const combined = currentErrorRegions.map((r, i) => 'Region ' + r.lineStart + ': ' + (regionHypotheses[i] || 'No guess')).join('\\n');
                    vscode.postMessage({ type: 'SUBMIT_TIER2_ATTEMPT', hypothesis: combined });
                } else {
                    const hypVal = hypInput ? hypInput.value : '';
                    vscode.postMessage({ type: 'SUBMIT_TIER2_ATTEMPT', hypothesis: hypVal });
                }
            });
        }

        const btnTier2Hint = document.getElementById('btn-tier2-hint');
        if (btnTier2Hint) {
            btnTier2Hint.addEventListener('click', () => {
                openHintModal();
            });
        }
        // ──────────────────────────────────────────────────────────────────────

        // ── Hint Modal logic ──────────────────────────────────────────────
        let allAvailableHints = [];
        let currentHintIndex = 0;
        const hintOverlay = document.getElementById('hint-modal-overlay');
        const hintBody = document.getElementById('hint-modal-body');
        const hintCounter = document.getElementById('hint-modal-counter');
        const hintBtnNext = document.getElementById('hint-btn-next');
        const hintBtnQuit = document.getElementById('hint-btn-quit');
        const hintBtnClose = document.getElementById('hint-modal-close');

        function openHintModal() {
            if (!allAvailableHints || allAvailableHints.length === 0) return;
            currentHintIndex = 0;
            renderHintModal();
            hintOverlay.classList.add('visible');
        }

        function renderHintModal() {
            hintBody.textContent = allAvailableHints[currentHintIndex] || 'No hint available.';
            hintCounter.textContent = 'Hint ' + (currentHintIndex + 1) + ' of ' + allAvailableHints.length;
            if (currentHintIndex >= allAvailableHints.length - 1) {
                hintBtnNext.disabled = true;
                hintBtnNext.textContent = 'No more hints';
            } else {
                hintBtnNext.disabled = false;
                hintBtnNext.innerHTML = 'Next Hint &rarr;';
            }
        }

        function closeHintModal() {
            hintOverlay.classList.remove('visible');
        }

        if (hintBtnNext) hintBtnNext.addEventListener('click', () => {
            if (currentHintIndex < allAvailableHints.length - 1) {
                currentHintIndex++;
                renderHintModal();
            }
        });
        if (hintBtnQuit) hintBtnQuit.addEventListener('click', closeHintModal);
        if (hintBtnClose) hintBtnClose.addEventListener('click', closeHintModal);

        const btnHint = document.getElementById('btn-hint');
        if (btnHint) btnHint.addEventListener('click', () => {
            openHintModal();
        });
        // Also open hint modal when Tier 2 hint button is clicked
        const btnTier2HintModal = document.getElementById('btn-tier2-hint');
        if (btnTier2HintModal) {
            btnTier2HintModal.removeEventListener && null; // placeholder
        }

        const btnAction = document.getElementById('btn-action');
        if (btnAction) btnAction.addEventListener('click', () => {
            const text = btnAction.textContent || "";
            const isSubmit = text.indexOf('submit') !== -1 || text.indexOf('Submit') !== -1;
            if (isSubmit) {
                runLoader(1500, "Running diagnostic verification...", () => {
                    vscode.postMessage({ type: 'SUBMIT_ANSWER' });
                });
            } else {
                runLoader(1500, "Deconstructing logic...", () => {
                    vscode.postMessage({ type: 'REQUEST_SOLUTION' });
                });
            }
        });

        const btnResubmit = document.getElementById('btn-resubmit');
        if (btnResubmit) btnResubmit.addEventListener('click', () => {
            runLoader(1500, "Running diagnostic verification...", () => {
                vscode.postMessage({ type: 'SUBMIT_ANSWER' });
            });
        });

        const btnMoreExplanation = document.getElementById('btn-more-explanation');
        if (btnMoreExplanation) btnMoreExplanation.addEventListener('click', () => {
            runLoader(1500, "Extracting more details...", () => {
                vscode.postMessage({ type: 'MORE_EXPLANATION' });
            });
        });

        const btnPagePrev = document.getElementById('btn-page-prev');
        const btnPageNext = document.getElementById('btn-page-next');
        if (btnPagePrev) {
            btnPagePrev.addEventListener('click', () => {
                vscode.postMessage({ type: 'CHANGE_PAGE', direction: 'prev' });
            });
        }
        if (btnPageNext) {
            btnPageNext.addEventListener('click', () => {
                vscode.postMessage({ type: 'CHANGE_PAGE', direction: 'next' });
            });
        }

        const btnPage2Submit = document.getElementById('btn-page2-submit');
        if (btnPage2Submit) {
            btnPage2Submit.addEventListener('click', () => {
                runLoader(1500, "Running diagnostic verification...", () => {
                    vscode.postMessage({ type: 'SUBMIT_ANSWER' });
                });
            });
        }

        const btnPage2Games = document.getElementById('btn-page2-games');
        if (btnPage2Games) {
            btnPage2Games.addEventListener('click', () => {
                vscode.postMessage({ type: 'GAMES_CLICKED' });
            });
        }

        // Explanation / Ritual text input
        const explanationInput = document.getElementById('explanation-input');
        const explanationCounter = document.getElementById('explanation-counter');
        const btnExplanationSubmit = document.getElementById('btn-explanation-submit');
        const linkRitualSkip = document.getElementById('link-ritual-skip');

        explanationInput.addEventListener('input', () => {
            const len = explanationInput.value.length;
            explanationCounter.textContent = len + ' / 20 min';
            
            if (canProceedAnyway) {
                canProceedAnyway = false;
                btnExplanationSubmit.textContent = 'Submit & Start \u2192';
                const feedbackDiv = document.getElementById('ritual-feedback');
                if (feedbackDiv) {
                    feedbackDiv.style.display = 'none';
                }
            }
            
            btnExplanationSubmit.disabled = len < 20;
            btnExplanationSubmit.style.opacity = len < 20 ? '0.5' : '1';
        });

        btnExplanationSubmit.addEventListener('click', () => {
            const lineInput = document.getElementById('explanation-line-input');
            const hypVal = explanationInput.value;
            const lineVal = lineInput ? lineInput.value : '';
            const combinedVal = "Line: " + lineVal + "\\nReason: " + hypVal;

            if (canProceedAnyway) {
                vscode.postMessage({ type: 'SUBMIT_RITUAL_STEP', response: combinedVal, force: true });
                explanationInput.value = '';
                if (lineInput) lineInput.value = '';
                explanationInput.dispatchEvent(new Event('input'));
                canProceedAnyway = false;
            } else if (hypVal.length >= 20) {
                vscode.postMessage({ type: 'SUBMIT_RITUAL_STEP', response: combinedVal });
            }
        });

        // Dashboard V2 Bindings
        const btnV2Submit = document.getElementById('btn-v2-submit');
        const btnV2Hint = document.getElementById('btn-v2-hint');

        if (btnV2Submit) {
            btnV2Submit.addEventListener('click', () => {
                const hypVal = document.getElementById('v2-hypothesis-input').value;
                if (!hypVal || hypVal.length < 5) {
                    // Just prompt them to type something, no hard enforcement
                    const hypEl = document.getElementById('v2-hypothesis-input');
                    hypEl.style.border = '1px solid #ff5f56';
                    setTimeout(() => hypEl.style.border = '', 1500);
                    return;
                }
                
                runLoader(1500, "Validating logic...", () => {
                    vscode.postMessage({ type: 'SUBMIT_ANSWER' });
                });
            });
        }

        if (btnV2Hint) {
            btnV2Hint.addEventListener('click', () => {
                vscode.postMessage({ type: 'REQUEST_HINT' });
            });
        }
        
        linkRitualSkip.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'SKIP_RITUAL' });
        });

        let navDirection = 'next';
        const btnNav = document.getElementById('btn-nav');
        if (btnNav) btnNav.addEventListener('click', () => {
            vscode.postMessage({ type: 'NAVIGATE_ERROR', direction: navDirection });
            navDirection = navDirection === 'next' ? 'prev' : 'next';
        });

        function updateButtonTexts() {
            const btnTier2Submit = document.getElementById('btn-tier2-submit');
            const btnPage2Submit = document.getElementById('btn-page2-submit');
            const btnPage2Games = document.getElementById('btn-page2-games');
            const theme = document.getElementById('theme-select')?.value || activeTheme;
            
            const submitText = (theme === 'retro') ? '> /submit' : 'Submit';
            const gamesText = (theme === 'retro') ? '> /games' : 'GAMES';
            
            if (btnTier2Submit) btnTier2Submit.textContent = submitText;
            if (btnPage2Submit) btnPage2Submit.textContent = submitText;
            if (btnPage2Games) btnPage2Games.textContent = gamesText;
        }

        // Theme switching logic
        const themeSelect = document.getElementById('theme-select');
        let activeTheme = 'retro';
        try {
            const state = vscode.getState();
            if (state && state.theme) {
                activeTheme = state.theme;
            } else {
                activeTheme = localStorage.getItem('socratic-theme') || 'retro';
            }
        } catch (e) {
            try {
                activeTheme = localStorage.getItem('socratic-theme') || 'retro';
            } catch (err) {}
        }

        if (themeSelect) themeSelect.value = activeTheme;
        document.body.classList.remove('theme-startup', 'theme-native');
        if (activeTheme === 'startup') {
            document.body.classList.add('theme-startup');
        } else if (activeTheme === 'native') {
            document.body.classList.add('theme-native');
        }
        updateButtonTexts();

        if (themeSelect) {
            themeSelect.addEventListener('change', (e) => {
                const theme = e.target.value;
                document.body.classList.remove('theme-startup', 'theme-native');
                if (theme === 'startup') {
                    document.body.classList.add('theme-startup');
                } else if (theme === 'native') {
                    document.body.classList.add('theme-native');
                }
                try {
                    const currentState = vscode.getState() || {};
                    currentState.theme = theme;
                    vscode.setState(currentState);
                } catch (err) {}
                try {
                    localStorage.setItem('socratic-theme', theme);
                } catch (err) {}
                updateButtonTexts();
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.type === 'HYPOTHESIS_FEEDBACK') {
                const btnExplanationSubmit = document.getElementById('btn-explanation-submit');
                const explanationInput = document.getElementById('explanation-input');
                let feedbackDiv = document.getElementById('ritual-feedback');
                
                if (!feedbackDiv) {
                    feedbackDiv = document.createElement('div');
                    feedbackDiv.id = 'ritual-feedback';
                    feedbackDiv.className = 'ritual-feedback';
                    feedbackDiv.style.marginTop = '8px';
                    feedbackDiv.style.borderRadius = '4px';
                    explanationInput.parentNode.insertBefore(feedbackDiv, explanationInput.nextSibling);
                }

                if (message.status === 'LOADING') {
                    btnExplanationSubmit.textContent = 'Evaluating...';
                    btnExplanationSubmit.disabled = true;
                    explanationInput.disabled = true;
                    feedbackDiv.style.display = 'none';
                } else {
                    explanationInput.disabled = false;
                    feedbackDiv.style.display = 'block';
                    feedbackDiv.className = 'ritual-feedback ' + message.status.toLowerCase();
                    
                    if (message.status === 'PASS') {
                        btnExplanationSubmit.textContent = 'Submit & Start \u2192';
                        btnExplanationSubmit.disabled = false;
                        feedbackDiv.innerHTML = '<strong>PASS:</strong> Hypothesis accepted. Unlocking mission...';
                        feedbackDiv.style.backgroundColor = 'var(--vscode-editorInfo-background, rgba(39, 201, 63, 0.1))';
                        feedbackDiv.style.color = 'var(--vscode-testing-iconPassed, #27c93f)';
                        feedbackDiv.style.borderLeft = '4px solid var(--vscode-testing-iconPassed, #27c93f)';
                        feedbackDiv.style.padding = '8px';
                        canProceedAnyway = false;
                    } else {
                        btnExplanationSubmit.textContent = 'Proceed anyway \u2192';
                        btnExplanationSubmit.disabled = false;
                        btnExplanationSubmit.style.opacity = '1';
                        feedbackDiv.innerHTML = '<strong>' + message.status + ':</strong> ' + message.nudge;
                        feedbackDiv.style.backgroundColor = 'var(--vscode-editorError-background, rgba(255, 95, 86, 0.1))';
                        feedbackDiv.style.color = 'var(--vscode-errorForeground, #ff5f56)';
                        feedbackDiv.style.borderLeft = '4px solid var(--vscode-errorForeground, #ff5f56)';
                        feedbackDiv.style.padding = '8px';
                        canProceedAnyway = true;
                    }
                }
                return;
            }

            if (message.type === 'STATE_UPDATE') {
                const { state, page, hearts, hintsUsed, totalHints, revealedHints, hasFailedSubmit, mission, expertSolution, attempts, timeElapsed, terminalOutput, exitCode, ritualState, canSkipRitual } = message;

                const mainPanel = document.getElementById('main-panel');
                const actionsPanel = document.querySelector('.actions-panel');
                const pageFooter = document.querySelector('.page-footer');
                const page1Layout = document.getElementById('page-1-layout');
                const questionText = document.getElementById('question-text');
                const queueProgressPanel = document.getElementById('queue-progress-panel');

                if (state === 'MISSION_COMPLETE') {
                    if (mainPanel) mainPanel.style.display = 'none';
                    if (actionsPanel) actionsPanel.style.display = 'none';
                    if (pageFooter) pageFooter.style.display = 'none';
                    if (queueProgressPanel) queueProgressPanel.style.display = 'none';

                    let mcPanel = document.getElementById('mission-complete-panel');
                    if (!mcPanel) {
                        mcPanel = document.createElement('div');
                        mcPanel.id = 'mission-complete-panel';
                        mcPanel.className = 'main-panel';
                        document.querySelector('.content').appendChild(mcPanel);
                    }
                    
                    const p = message.missionCompletePayload || {};
                    mcPanel.innerHTML = \`
                        <div style="text-align: center; margin-top: 20px;">
                            <div style="font-size: 3rem; margin-bottom: 10px;">🏆</div>
                            <h2 style="color: #a78bfa; margin-bottom: 20px;">MISSION COMPLETE</h2>
                            <div style="background: rgba(0,0,0,0.2); padding: 16px; border-radius: 8px; text-align: left; margin: 0 auto; max-width: 250px;">
                                <p style="margin: 8px 0; color: #e6edf3;"><strong>Total Bugs Solved:</strong> <span style="float: right; color: #a78bfa;">\${p.totalBugs || 0}</span></p>
                                <p style="margin: 8px 0; color: #e6edf3;"><strong>Hints Used:</strong> <span style="float: right; color: #ff9800;">\${p.hintsUsed || 0}</span></p>
                                <p style="margin: 8px 0; color: #e6edf3;"><strong>Total XP Earned:</strong> <span style="float: right; color: #27c93f;">+\${p.totalXP || 0}</span></p>
                            </div>
                            <button class="btn btn-solid" onclick="vscode.postMessage({type: 'RESET'})" style="margin-top: 30px; width: 200px;">Return to Editor</button>
                        </div>
                    \`;
                    mcPanel.style.display = 'block';
                    return;
                } else {
                    let mcPanel = document.getElementById('mission-complete-panel');
                    if (mcPanel) mcPanel.style.display = 'none';
                }

                if (mainPanel) mainPanel.style.display = 'flex';
                if (actionsPanel) actionsPanel.style.display = 'flex';
                if (pageFooter) pageFooter.style.display = 'flex';

                if (message.analysisMode === 'full-file' && message.queueState && queueProgressPanel) {
                    queueProgressPanel.style.display = 'block';
                    document.getElementById('queue-bug-count').textContent = \`Bug \${message.queueState.currentIndex + 1}/\${message.queueState.total}\`;
                    document.getElementById('queue-current-target').textContent = \`Current Target: Line \${message.queueState.currentLine}\`;
                    document.getElementById('queue-error-type').textContent = message.queueState.currentErrorType;
                } else if (queueProgressPanel) {
                    queueProgressPanel.style.display = 'none';
                }

                // Populate hint modal data from all hints
                if (mission && mission.allHints && mission.allHints.length > 0) {
                    allAvailableHints = mission.allHints;
                }

                if (page === 1) {
                    page1Layout.style.display = 'none'; // Replaced by Dashboard V2
                    const page2Layout = document.getElementById('page-2-layout');
                    if (page2Layout) page2Layout.style.display = 'none';
                    questionText.style.display = 'none';

                    const ritualSkipContainer = document.getElementById('ritual-skip-container');

                    // If tier is 1, ritualState might be null, but we still show the layout
                    const summaryEl = document.getElementById('explanation-error-summary');
                    if (summaryEl) {
                        summaryEl.textContent = (ritualState && ritualState.errorSummary) ? ritualState.errorSummary : (mission ? mission.description || mission.originalMessage : 'Examine the problem to proceed.');
                    }

                    // Lines card is now interactive input, so we don't populate error lines block.

                    // ── PHASE 3 — HIDE LEGACY COMPONENTS ──
                    if (ritualSkipContainer) ritualSkipContainer.style.display = 'none';

                    const locationCard = document.getElementById('location-card');
                    if (locationCard) locationCard.style.display = 'none';

                    const hypothesisSection = document.getElementById('hypothesis-section');
                    if (hypothesisSection) hypothesisSection.style.display = 'none';

                    // ── DASHBOARD V2 POPULATION ──
                    const dashboardV2 = document.getElementById('dashboard-v2-layout');
                    if (dashboardV2) {
                        dashboardV2.style.display = 'flex';
                        
                        // Goal
                        const goalText = document.getElementById('v2-goal-text');
                        if (goalText) {
                            goalText.textContent = mission ? (mission.description || mission.concept || 'Analyze the context to determine the goal.') : 'Loading...';
                        }
                        
                        // Actual Behavior
                        const actualText = document.getElementById('v2-actual-behavior-text');
                        if (actualText && mission) {
                            let behavior = mission.originalMessage || mission.originalErrorCode;
                            if (mission.runtimeSummary && mission.runtimeSummary.lastTerminalError) {
                                behavior += "\\n\\n[Terminal Output]\\n" + mission.runtimeSummary.lastTerminalError.substring(0, 300);
                            }
                            actualText.textContent = behavior;
                        }

                        // Observe
                        const observeBody = document.getElementById('v2-observe-body');
                        if (observeBody && mission) {
                            let isRuntime = mission.runtimeSummary && mission.runtimeSummary.lastTerminalError;
                            let typeLabel = isRuntime ? "Runtime Error:" : (mission.errorType ? "Compiler Error:" : "Error Type:");
                            let errorType = mission.errorType || mission.errorCode || "Unknown";
                            
                            let lineNum = mission.lineNumber;
                            if (!lineNum && currentErrorRegions && currentErrorRegions.length > 0) {
                                lineNum = currentErrorRegions[0].lineStart;
                            }
                            
                            let diagnostic = mission.originalMessage;
                            if (!diagnostic && isRuntime) {
                                diagnostic = mission.runtimeSummary.lastTerminalError.split('\\n').filter(l => l.trim().length > 0).pop();
                            }

                            let html = \`<div style="margin-bottom: 12px;"><div style="color: #a78bfa; margin-bottom: 2px;">\${typeLabel}</div><div style="font-family: monospace;">\${errorType}</div></div>\`;
                            
                            if (lineNum) {
                                html += \`<div style="margin-bottom: 12px;"><div style="color: #a78bfa; margin-bottom: 2px;">Line:</div><div style="font-family: monospace;">\${lineNum}</div></div>\`;
                            }
                            
                            if (diagnostic) {
                                // Extract just the pure error fact, strip away explanations if any
                                // Since we're using originalMessage, it's usually factual, e.g. "name 'user_input' is not defined"
                                let cleanDiag = diagnostic.replace(/^Exception: |^Error: |^.*Error: /g, '').trim();
                                html += \`<div style="margin-bottom: 0;"><div style="color: #a78bfa; margin-bottom: 2px;">Diagnostic:</div><div style="font-family: monospace; color: #ff5f56;">\${cleanDiag}</div></div>\`;
                            }
                            
                            observeBody.innerHTML = html;
                        }

                        // Question
                        const questionText = document.getElementById('v2-question-text');
                        if (questionText && mission) {
                            questionText.textContent = mission.socraticQuestion || 'What might be causing this behavior?';
                        }

                        // Hints & Unlock Logic
                        const hintsRemainingEl = document.getElementById('v2-hints-remaining');
                        const hintsRemaining = hearts;
                        if (hintsRemainingEl) hintsRemainingEl.textContent = hintsRemaining;

                        const btnV2Hint = document.getElementById('btn-v2-hint');
                        if (btnV2Hint) {
                            if (hintsRemaining <= 0) {
                                btnV2Hint.style.opacity = '0.5';
                                btnV2Hint.style.pointerEvents = 'none';
                                btnV2Hint.textContent = '💡 Hint (0 left)';
                            } else {
                                btnV2Hint.style.opacity = '1';
                                btnV2Hint.style.pointerEvents = 'auto';
                                btnV2Hint.textContent = '💡 Hint (' + hintsRemaining + ' left)';
                            }
                        }

                        // Locked Explanation
                        const explanationCard = document.getElementById('v2-explanation-card');
                        const explanationTextEl = document.getElementById('v2-explanation-text');
                        
                        // Unlock if 0 hearts or exhausted attempts (hasFailedSubmit)
                        if (explanationCard && explanationTextEl) {
                            if (hearts <= 0 || hasFailedSubmit) {
                                explanationCard.style.display = 'block';
                                let exp = (expertSolution && expertSolution.explanation) ? expertSolution.explanation : '';
                                if (!exp && ritualState && ritualState.errorSummary) {
                                    exp = ritualState.errorSummary;
                                }
                                explanationTextEl.textContent = exp || 'The root cause revolves around the incorrect logic state or algorithm flow.';
                            } else {
                                explanationCard.style.display = 'none';
                            }
                        }
                    }

                    // ── PHASE 2 — FORCE SINGLE DASHBOARD LAYOUT ──
                    // Show the error line navigator with the current line number
                    const errorLineNavigator = document.getElementById('error-line-navigator');
                    const errorLineDisplay = document.getElementById('error-line-display');
                    if (errorLineNavigator) errorLineNavigator.style.display = 'flex';
                    
                    if (mission && mission.errorRegions && mission.errorRegions.length > 0) {
                        currentErrorRegions = mission.errorRegions;
                        // Only reset hypothesis arrays if it's a completely new set of regions
                        if (regionHypotheses.length !== mission.errorRegions.length) {
                            regionHypotheses = new Array(mission.errorRegions.length).fill('');
                        }
                        currentRegionIndex = 0;
                        renderCurrentRegion();
                    } else {
                        currentErrorRegions = [];
                        if (errorLineDisplay && mission && mission.errorLineNumber) {
                            errorLineDisplay.textContent = '#L' + String(mission.errorLineNumber);
                        }
                    }

                    const t2Hyp = document.getElementById('tier2-hypothesis-section');
                    const t2Exp = document.getElementById('tier2-explanation-section');
                    
                    if (hearts === 3) {
                        if (t2Hyp) t2Hyp.style.display = 'block';
                        if (t2Exp) t2Exp.style.display = 'none';
                    } else {
                        if (t2Hyp) t2Hyp.style.display = 'none';
                        if (t2Exp) t2Exp.style.display = 'block';
                        
                        const expText = document.getElementById('tier2-explanation-text');
                        if (expText) {
                            if (hearts === 2) {
                                expText.innerHTML = (mission && mission.hints && mission.hints.length > 0) ? escapeHtml(mission.hints[0]) : 'Look closely at your logic and references.';
                            } else if (hearts === 1) {
                                expText.innerHTML = (mission && mission.hints && mission.hints.length > 1) ? escapeHtml(mission.hints[1]) : 'Are you calling the function or assigning the variable correctly?';
                            }
                        }
                    }
                } else if (page === 2) {
                    page1Layout.style.display = 'none';
                    const page2Layout = document.getElementById('page-2-layout');
                    if (page2Layout) page2Layout.style.display = 'flex';
                    questionText.style.display = 'none';
                } else {
                    page1Layout.style.display = 'none';
                    const page2Layout = document.getElementById('page-2-layout');
                    if (page2Layout) page2Layout.style.display = 'none';
                    questionText.style.display = 'block';
                }


                // ── Runtime Context Panel ────────────────────────────────────────
                const runtimePanel = document.getElementById('runtime-panel');
                const runtimeExitBadge = document.getElementById('runtime-exit-badge');

                const hasRuntime = exitCode !== undefined && exitCode !== -1 && terminalOutput;
                if (hasRuntime && runtimePanel) {
                    runtimePanel.classList.remove('hidden');

                    // Exit code badge
                    if (runtimeExitBadge) {
                        if (exitCode === 0) {
                            runtimeExitBadge.textContent = '✓ 0';
                            runtimeExitBadge.className = 'runtime-badge badge-ok';
                        } else {
                            runtimeExitBadge.textContent = '✗ ' + exitCode;
                            runtimeExitBadge.className = 'runtime-badge badge-fail';
                        }
                    }

                    // Last terminal error — show the last 300 chars (tail of traceback)
                    const runtimeErrorText = document.getElementById('runtime-error-text');
                    if (runtimeErrorText && terminalOutput) {
                        const tail = terminalOutput.length > 300
                            ? '…' + terminalOutput.slice(-300)
                            : terminalOutput;
                        runtimeErrorText.textContent = tail;
                    }

                    // Summary line
                    const runtimeSummaryEl = document.getElementById('runtime-summary');
                    if (runtimeSummaryEl) {
                        if (exitCode === 0) {
                            runtimeSummaryEl.textContent = 'Last run succeeded — mission targets the diagnostic error.';
                        } else {
                            runtimeSummaryEl.textContent = 'Runtime failure detected — questions target this specific error.';
                        }
                    }
                } else if (runtimePanel) {
                    runtimePanel.classList.add('hidden');
                }


                // Update Page Indicator display
                const pageDisplay = document.getElementById('page-display');
                if (pageDisplay) {
                    pageDisplay.textContent = page + " of 3";
                }

                // Update Panel Title & Main Panel Content
                const panelTitle = document.getElementById('panel-title');

                if (page === 1) {
                    panelTitle.textContent = "EXPLANATION";
                    const explanationQuestionText = document.getElementById('explanation-question-text');
                    if (explanationQuestionText) {
                        explanationQuestionText.innerHTML = mission ? mission.socraticQuestion : "Before you can fix the error, what information do you need to gather?";
                    }
                } else if (page === 2) {
                    panelTitle.textContent = "EXPLANATION";
                    const page2ExpText = document.getElementById('page-2-explanation-text');
                    const expContent = expertSolution ? expertSolution.explanation.replace(/\\n/g, '<br>') : "Detailed Explanation of the error";
                    if (page2ExpText) {
                        page2ExpText.innerHTML = expContent;
                    } else {
                        questionText.innerHTML = expContent;
                    }
                } else if (page === 3) {
                    panelTitle.textContent = "MISSION END";
                    if (hearts > 0) {
                        questionText.innerHTML = "PASSED\\n\\nSummary of Debugging Process and Learning:\\n" + (expertSolution ? expertSolution.conceptSummary : "Good job fixing the error!");
                    } else {
                        questionText.innerHTML = "FAILED\\n\\n..... sorry but u have end with hearts you need to improve your basics";
                    }
                }

                // Update Hearts Capsule
                const heartsCapsule = document.getElementById('hearts-capsule');
                heartsCapsule.innerHTML = '';
                for (let i = 0; i < 3; i++) {
                    const span = document.createElement('span');
                    span.className = 'heart-icon';
                    span.textContent = '♥';
                    if (i < hearts) {
                        span.style.color = '#ff5f56';
                        span.style.webkitTextStroke = 'none';
                    } else {
                        span.className = 'heart-icon empty';
                        span.style.color = 'transparent';
                        const theme = document.getElementById('theme-select')?.value || activeTheme;
                        if (theme === 'startup') {
                            span.style.webkitTextStroke = '1.2px rgba(255, 255, 255, 0.15)';
                        } else if (theme === 'native') {
                            span.style.webkitTextStroke = '1px var(--vscode-disabledForeground, rgba(255, 255, 255, 0.25))';
                        } else {
                            span.style.webkitTextStroke = '1px rgba(166, 172, 205, 0.35)';
                        }
                    }
                    heartsCapsule.appendChild(span);
                }

                // Update Hints Display
                const hintsDisplay = document.getElementById('hints-display');
                if (hintsDisplay) {
                    hintsDisplay.textContent = revealedHints + " / " + totalHints;
                }

                // Update Buttons
                if (typeof btnHint !== 'undefined' && btnHint) btnHint.textContent = '> /hint (' + revealedHints + '/' + totalHints + ')';

                const actionRow = document.getElementById('action-row');
                const extraActions = document.getElementById('extra-actions');
                const resultBox = document.getElementById('result-box');

                if (page === 1) {
                    if (actionRow) actionRow.style.display = 'flex';
                    if (extraActions) extraActions.style.display = 'none';
                    if (resultBox) resultBox.style.display = 'none';
                    if (typeof btnAction !== 'undefined' && btnAction) btnAction.textContent = "> /explain";
                } else if (page === 2) {
                    if (actionRow) actionRow.style.display = 'flex';
                    if (typeof btnAction !== 'undefined' && btnAction) btnAction.textContent = "> /submit";
                    
                    if (hasFailedSubmit) {
                        if (extraActions) extraActions.style.display = 'flex';
                    } else {
                        if (extraActions) extraActions.style.display = 'none';
                    }
                    if (resultBox) resultBox.style.display = 'none';
                } else if (page === 3) {
                    if (actionRow) actionRow.style.display = 'none';
                    if (extraActions) extraActions.style.display = 'none';
                    if (resultBox) {
                        resultBox.style.display = 'block';
                        if (hearts > 0) {
                            resultBox.innerHTML = '<div class="success-banner">' +
                                '<p>🎉 CONGRATULATIONS! 🎉</p>' +
                                '<p style="font-size: 0.8rem; margin-top: 6px;">' +
                                    'You solved the challenge with ' + hearts + ' hearts remaining.' +
                                '</p>' +
                                '<p style="font-size: 0.75rem; margin-top: 4px;">' +
                                    'Time taken: ' + timeElapsed + 's | Hints used: ' + hintsUsed +
                                '</p>' +
                            '</div>';
                        } else {
                            resultBox.innerHTML = '<div class="fail-banner">' +
                                '<p>💔 MISSION FAILED 💔</p>' +
                                '<p style="font-size: 0.8rem; margin-top: 6px;">' +
                                    'No hearts remaining. Review the core concepts and try again!' +
                                '</p>' +
                            '</div>';
                        }
                    }
                }
                updateButtonTexts();
            }
        });
    </script>
</body>
</html>`;
    }
}

/** Generate a random nonce for CSP */
function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
