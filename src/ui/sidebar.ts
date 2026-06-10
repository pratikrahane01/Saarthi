import * as vscode from 'vscode';
import { Mission, fetchExpertSolution, SolutionRequest } from '../missions';
import * as interceptor from '../interceptor';
import * as path from 'path';

/**
 * The six possible UI states for the Socratic Dashboard.
 * Each state maps to a distinct visual presentation in the webview.
 */
export type DashboardState = 'IDLE' | 'QUESTIONING' | 'HINTING' | 'TESTING' | 'PASSED' | 'FAILED' | 'SOLUTION';

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
     * Load a new mission and transition to the QUESTIONING state.
     */
    public showMission(mission: Mission) {
        this._currentMission = mission;
        this._currentState = 'QUESTIONING';
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

            default:
                console.log('Zero-Magic Sidebar: Unknown message type', message.type);
        }
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
            let finalPassed = result.passed;
            let twoFactorFailedMessage: string | undefined;

            const checkUri = mission.targetUri ? vscode.Uri.parse(mission.targetUri) : undefined;
            if (result.passed && checkUri) {
                const diagnostics = vscode.languages.getDiagnostics(checkUri);

                const hasOriginalError = diagnostics.some(d =>
                    d.severity === vscode.DiagnosticSeverity.Error &&
                    (d.message === mission.originalMessage || d.message.includes(mission.originalErrorCode))
                );

                if (hasOriginalError) {
                    finalPassed = false;
                    twoFactorFailedMessage = "The concept test passed, but your original error is still present. Apply the concept to your code.";
                    console.log(`Zero-Magic Sidebar: Two-factor failed. Original error still present.`);
                }
            }

            if (finalPassed) {
                this._currentPage = 3;
                this._currentState = 'PASSED';
                this._customFailedMessage = undefined;
                await this._saveStepHistory(true);
                await interceptor.unlockMission(mission.id, mission.language);
                this._postState();
            } else {
                this._hearts--;
                this._hasFailedSubmit = true;
                this._customFailedMessage = twoFactorFailedMessage || "The concept check test failed.";

                if (this._hearts <= 0) {
                    this._currentPage = 3;
                    this._currentState = 'FAILED';
                    await this._saveStepHistory(false);
                } else {
                    this._currentState = 'FAILED';
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
                this._currentState = 'FAILED';
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
            } : null,
            attempts: this._attempts,
            totalHints: this._currentMission?.hints.length ?? 0,
            revealedHints: this._revealedHints,
            customFailedMessage: this._customFailedMessage,
            expertSolution: this._expertSolution,
            runtimeSummary: this._currentMission?.runtimeSummary ?? null,
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
            background-color: #13141c;
            color: #a6accd;
            padding: 12px;
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
            border: 1px solid rgba(166, 172, 205, 0.15);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
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

        /* Title Bar with traffic lights */
        .title-bar {
            display: flex;
            align-items: center;
            justify-content: flex-start;
            gap: 12px;
            height: 38px;
            background-color: rgba(0, 0, 0, 0.15);
            border-bottom: 1px solid rgba(166, 172, 205, 0.1);
            padding: 0 16px;
        }

        .window-controls {
            display: flex;
            gap: 8px;
            flex-shrink: 0;
        }

        .control-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
        }
        .dot-red { background-color: #ff5f56; }
        .dot-yellow { background-color: #ffbd2e; }
        .dot-green { background-color: #27c93f; }

        .window-title {
            font-size: 0.8rem;
            color: rgba(166, 172, 205, 0.6);
            letter-spacing: 0.05em;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            flex-grow: 1;
        }


        /* Content Wrapper */
        .content {
            display: flex;
            flex-direction: column;
            padding: 20px;
            gap: 20px;
            flex-grow: 1;
        }

        /* Main Panel - Dashed outline block */
        .main-panel {
            background-color: rgba(0, 0, 0, 0.1);
            border: 1px dashed rgba(166, 172, 205, 0.25);
            border-radius: 8px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            min-height: 160px;
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

        .question-text {
            font-size: 0.9rem;
            line-height: 1.6;
            color: #c5cdd8;
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        /* Capabilities equivalent - Key/Value Table */
        .stats-panel {
            border-top: 1px dashed rgba(166, 172, 205, 0.15);
            padding-top: 16px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .stats-row {
            display: flex;
            font-size: 0.85rem;
            line-height: 1.5;
        }

        .stats-key {
            width: 110px;
            color: rgba(166, 172, 205, 0.5);
        }

        .stats-val {
            color: #c5cdd8;
            font-weight: 500;
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
            margin-top: auto;
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
            justify-content: flex-start;
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

        /* Terminal System Footer */
        .system-footer {
            font-size: 0.72rem;
            color: rgba(166, 172, 205, 0.45);
            margin-top: auto;
            border-top: 1px dashed rgba(166, 172, 205, 0.15);
            padding-top: 12px;
            line-height: 1.4;
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

        <!-- Window Title Bar -->
        <div class="title-bar">
            <div class="window-controls">
                <span class="control-dot dot-red"></span>
                <span class="control-dot dot-yellow"></span>
                <span class="control-dot dot-green"></span>
            </div>
            <div class="window-title">zero-magic ~ /challenge</div>
        </div>

        <!-- content area -->
        <div class="content">

            <!-- MAIN PANEL -->
            <div class="main-panel" id="main-panel">
                <div class="section-header" id="panel-title">Welcome, developer.</div>
                <div class="question-text" id="question-text">Before you can fix the error, what information do you need to gather?</div>
            </div>

            <!-- CAPABILITIES PANEL (Stats) -->
            <div class="stats-panel">
                <div class="section-header">Status</div>
                <div class="stats-row">
                    <span class="stats-key">Health</span>
                    <span class="stats-val" id="hearts-capsule">
                        <span class="heart-icon">♥</span>
                        <span class="heart-icon">♥</span>
                        <span class="heart-icon">♥</span>
                    </span>
                </div>
                <div class="stats-row">
                    <span class="stats-key">Hints</span>
                    <span class="stats-val" id="hints-display">0 / 3</span>
                </div>
                <div class="stats-row">
                    <span class="stats-key">Page</span>
                    <span class="stats-val" id="page-display">1 of 3</span>
                </div>
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

            <!-- NAVIGATION PANEL (Actions) -->
            <div class="actions-panel">
                <div class="section-header">Actions</div>
                
                <!-- Hint + Solution Actions -->
                <div class="action-row" id="action-row">
                    <button class="btn btn-outline btn-green" id="btn-hint">> /hint</button>
                    <button class="btn btn-solid btn-blue" id="btn-action">> /explain</button>
                </div>

                <!-- Page 2 extra actions -->
                <div class="extra-actions" id="extra-actions" style="display: none;">
                    <button class="btn btn-solid" id="btn-resubmit">> /resubmit</button>
                    <button class="btn btn-outline" id="btn-more-explanation">> /more_details</button>
                </div>

                <!-- Page 3 result box -->
                <div class="result-box" id="result-box" style="display: none;"></div>

                <!-- Navigation navigation-row -->
                <div class="action-row">
                    <button class="btn btn-outline" id="btn-nav">> /navigate_errors</button>
                </div>
            </div>

            <!-- Terminal System Footer -->
            <div class="system-footer">
                [system] Zero-Magic Socratic Engine v1.0.0 active.
                <br>
                [system] Listening for code diagnostic changes.
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

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

        // Run introduction loader on start
        window.addEventListener('DOMContentLoaded', () => {
            runLoader(3000, "Initializing Socratic Mission...");
            vscode.postMessage({ type: 'REQUEST_STATE' });
        });

        const btnHint = document.getElementById('btn-hint');
        btnHint.addEventListener('click', () => {
            vscode.postMessage({ type: 'REQUEST_HINT' });
        });

        const btnAction = document.getElementById('btn-action');
        btnAction.addEventListener('click', () => {
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
        btnResubmit.addEventListener('click', () => {
            runLoader(1500, "Running diagnostic verification...", () => {
                vscode.postMessage({ type: 'SUBMIT_ANSWER' });
            });
        });

        const btnMoreExplanation = document.getElementById('btn-more-explanation');
        btnMoreExplanation.addEventListener('click', () => {
            runLoader(1500, "Extracting more details...", () => {
                vscode.postMessage({ type: 'MORE_EXPLANATION' });
            });
        });

        let navDirection = 'next';
        const btnNav = document.getElementById('btn-nav');
        btnNav.addEventListener('click', () => {
            vscode.postMessage({ type: 'NAVIGATE_ERROR', direction: navDirection });
            navDirection = navDirection === 'next' ? 'prev' : 'next';
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'STATE_UPDATE') {
                const { page, hearts, hintsUsed, totalHints, revealedHints, hasFailedSubmit, mission, expertSolution, attempts, timeElapsed, terminalOutput, exitCode } = message;

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
                const questionText = document.getElementById('question-text');

                if (page === 1) {
                    panelTitle.textContent = "Explanation";
                    questionText.innerHTML = mission ? mission.socraticQuestion : "Before you can fix the error, what information do you need to gather?";
                } else if (page === 2) {
                    panelTitle.textContent = "Explanation";
                    questionText.innerHTML = expertSolution ? expertSolution.explanation.replace(/\\n/g, '<br>') : "Detailed Explanation of the error";
                } else if (page === 3) {
                    panelTitle.textContent = "Mission end";
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
                    if (i < hearts) {
                        span.textContent = '♥';
                        span.style.color = '#ff5f56';
                    } else {
                        span.textContent = '♡';
                        span.style.color = 'rgba(166, 172, 205, 0.2)';
                    }
                    heartsCapsule.appendChild(span);
                }

                // Update Hints Display
                const hintsDisplay = document.getElementById('hints-display');
                if (hintsDisplay) {
                    hintsDisplay.textContent = revealedHints + " / " + totalHints;
                }

                // Update Buttons
                btnHint.textContent = '> /hint (' + revealedHints + '/' + totalHints + ')';

                const actionRow = document.getElementById('action-row');
                const extraActions = document.getElementById('extra-actions');
                const resultBox = document.getElementById('result-box');

                if (page === 1) {
                    actionRow.style.display = 'flex';
                    extraActions.style.display = 'none';
                    resultBox.style.display = 'none';
                    btnAction.textContent = "> /explain";
                } else if (page === 2) {
                    actionRow.style.display = 'flex';
                    btnAction.textContent = "> /submit";
                    
                    if (hasFailedSubmit) {
                        extraActions.style.display = 'flex';
                    } else {
                        extraActions.style.display = 'none';
                    }
                    resultBox.style.display = 'none';
                } else if (page === 3) {
                    actionRow.style.display = 'none';
                    extraActions.style.display = 'none';
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
