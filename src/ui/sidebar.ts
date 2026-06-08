import * as vscode from 'vscode';
import { Mission, fetchExpertSolution, SolutionRequest } from '../missions';
import * as interceptor from '../interceptor';

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

        // Set the initial HTML
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Send initial IDLE state
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
        this._attempts = 0;
        this._revealedHints = 0;
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
        this._currentMission = undefined;
        this._attempts = 0;
        this._revealedHints = 0;
        this._customFailedMessage = undefined;
        this._expertSolution = undefined;
        this._postState();
    }

    /**
     * Post an arbitrary message to the webview (used by Phase 6 UNLOCK flow).
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
                console.log("[EXTENSION] REQUEST_HINT received");
                console.log("[DEBUG] currentState:", this._currentState);
                console.log("[DEBUG] revealedHints:", this._revealedHints);
                console.log("[DEBUG] mission.hints.length:", this._currentMission?.hints?.length);
                this._onRequestHint();
                break;

            case 'RETRY':
                // User clicked "Try Again" from the FAILED screen.
                // Ignore duplicate clicks if a test is already actively running.
                if (this._isTesting) {
                    console.log('Zero-Magic Sidebar: Ignoring RETRY, test already running.');
                    break;
                }
                this._retrigger();
                break;

            case 'REQUEST_STATE':
                // Webview is asking for the current state (e.g. on first load)
                this._postState();
                break;

            case 'ABORT':
                this._abortMission();
                break;

            case 'REQUEST_SOLUTION':
                this._onRequestSolution();
                break;

            default:
                console.log('Zero-Magic Sidebar: Unknown message type', message.type);
        }
    }

    /**
     * Reveal the next hint in the Socratic sequence.
     */
    private _onRequestHint() {
        console.log("[EXTENSION] _onRequestHint executed");
        if (!this._currentMission) { return; }

        if (this._revealedHints < this._currentMission.hints.length) {
            this._revealedHints++;
        }

        this._currentState = 'HINTING';
        this._postState();
    }

    private async _onRequestSolution() {
        if (!this._currentMission) return;
        
        // Show loading state by transitioning to SOLUTION temporarily or keeping TESTING spinner logic
        this._currentState = 'SOLUTION'; 
        
        // Find the text document
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
        
        this._postState();
    }

    /**
     * Re-run the hidden test for the current mission after a RETRY.
     *
     * Reuses interceptor.trigger() (Phase 3) and reportTestResult() (Phase 6)
     * so there is zero duplication of test-execution or unlock logic.
     * If the pass condition is now met, unlockMission() is called automatically
     * from missions.ts#executeMissionHandOff — but since we are already past
     * the hand-off here, we handle unlock directly to avoid a double render.
     */
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

            if (result.passed && mission.targetUri) {
                const targetUri = vscode.Uri.parse(mission.targetUri);
                const diagnostics = vscode.languages.getDiagnostics(targetUri);
                
                const hasOriginalError = diagnostics.some(d => 
                    d.severity === vscode.DiagnosticSeverity.Error && 
                    d.message === mission.originalMessage
                );

                if (hasOriginalError) {
                    finalPassed = false;
                    twoFactorFailedMessage = "You understood the concept, but the original error is still present. Apply the fix to your code and try again.";
                    console.log(`Zero-Magic Sidebar: Two-factor failed. Original error still present.`);
                }
            }

            // reportTestResult increments _attempts and drives PASSED / FAILED state.
            this.reportTestResult(finalPassed, twoFactorFailedMessage);

            // If the student finally passed, run the full unlock + cleanup flow.
            if (finalPassed) {
                await interceptor.unlockMission(mission.id, mission.language);
            }
        } catch (err) {
            console.error('Zero-Magic Sidebar: Retrigger failed:', err);
            vscode.window.setStatusBarMessage('⚠️ Zero-Magic: Test re-run failed.', 5000);
            // Fall back to FAILED state so the student still sees something.
            this._currentState = 'FAILED';
            this._postState();
        } finally {
            if (executionId === undefined || interceptor.isLatestExecution(executionId)) {
                this._isTesting = false;
            }
        }
    }

    /**
     * Safely aborts the active mission, cancels any background test processing,
     * deletes hidden files, and restores the UI to IDLE.
     */
    private async _abortMission() {
        console.log('Zero-Magic Sidebar: Aborting mission.');
        // 1. Cancel pending execution results (prevents UI lockups from stale background tests)
        interceptor.invalidateAllExecutions();
        // 2. Clear any active testing lock
        this._isTesting = false;
        // 3. Delete hidden test files
        await interceptor.cleanUpAllTests();
        // 4. Clear mission memory and return to IDLE
        this.reset();
    }

    // ──────────────────────────────────────────────
    //  OUTBOUND — push state to the webview
    // ──────────────────────────────────────────────

    private _postState() {
        if (!this._view) return;
        console.log("[EXTENSION] Posting updated state");

        this._view.webview.postMessage({
            type: 'STATE_UPDATE',
            state: this._currentState,
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
        });
    }

    // ──────────────────────────────────────────────
    //  HTML — the full webview page
    // ──────────────────────────────────────────────

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // We inline the HTML directly since VS Code webviews need special CSP handling
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
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
    <title>Zero-Magic Dashboard</title>
    <style>
        /* ── Reset & Base ── */
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: #0b0f1a;
            color: #e2e8f0;
            padding: 0;
            margin: 0;
            overflow-x: hidden;
            min-height: 100vh;
        }

        /* ── Ambient glow background ── */
        body::before {
            content: '';
            position: fixed;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle at 30% 20%, rgba(56, 189, 248, 0.04) 0%, transparent 50%),
                        radial-gradient(circle at 70% 80%, rgba(139, 92, 246, 0.04) 0%, transparent 50%);
            z-index: -1;
            pointer-events: none;
        }

        .app { position: relative; z-index: 1; padding: 20px 16px; }

        /* ── Header ── */
        .header {
            text-align: center;
            padding-bottom: 20px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            margin-bottom: 20px;
        }

        .logo {
            font-size: 1.35rem;
            font-weight: 800;
            letter-spacing: -0.02em;
            background: linear-gradient(135deg, #38bdf8 0%, #818cf8 50%, #c084fc 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            margin-top: 8px;
            padding: 4px 12px;
            border-radius: 9999px;
            font-size: 0.65rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            transition: all 0.4s ease;
        }

        .badge-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            display: inline-block;
        }

        /* Badge states */
        .badge-idle        { background: rgba(100,116,139,0.15); color: #94a3b8; border: 1px solid rgba(100,116,139,0.2); }
        .badge-idle .badge-dot        { background: #64748b; }
        .badge-questioning { background: rgba(56,189,248,0.1); color: #38bdf8; border: 1px solid rgba(56,189,248,0.2); }
        .badge-questioning .badge-dot { background: #38bdf8; box-shadow: 0 0 8px rgba(56,189,248,0.5); animation: glow-pulse 2s infinite; }
        .badge-hinting     { background: rgba(251,191,36,0.1); color: #fbbf24; border: 1px solid rgba(251,191,36,0.2); }
        .badge-hinting .badge-dot     { background: #fbbf24; box-shadow: 0 0 8px rgba(251,191,36,0.5); }
        .badge-passed      { background: rgba(16,185,129,0.1); color: #10b981; border: 1px solid rgba(16,185,129,0.2); }
        .badge-passed .badge-dot      { background: #10b981; box-shadow: 0 0 8px rgba(16,185,129,0.5); }
        .badge-failed      { background: rgba(244,63,94,0.1); color: #f43f5e; border: 1px solid rgba(244,63,94,0.2); }
        .badge-failed .badge-dot      { background: #f43f5e; box-shadow: 0 0 8px rgba(244,63,94,0.5); }

        /* ── Cards ── */
        .card {
            background: rgba(255,255,255,0.02);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 14px;
            padding: 20px;
            margin-bottom: 16px;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            transition: all 0.35s ease;
        }

        .card:hover {
            border-color: rgba(255,255,255,0.1);
            box-shadow: 0 8px 32px rgba(0,0,0,0.15);
        }

        .card-label {
            font-size: 0.65rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: #64748b;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .card-label-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            display: inline-block;
        }

        .card-label-dot.blue   { background: #38bdf8; box-shadow: 0 0 6px #38bdf8; }
        .card-label-dot.green  { background: #10b981; box-shadow: 0 0 6px #10b981; }
        .card-label-dot.amber  { background: #fbbf24; box-shadow: 0 0 6px #fbbf24; }
        .card-label-dot.red    { background: #f43f5e; box-shadow: 0 0 6px #f43f5e; }

        /* ── Typography ── */
        .text-body {
            font-size: 0.875rem;
            line-height: 1.65;
            color: #cbd5e1;
        }

        .text-question {
            font-size: 1rem;
            font-weight: 600;
            line-height: 1.55;
            color: #f1f5f9;
        }

        code {
            font-family: 'Fira Code', monospace;
            font-size: 0.8rem;
            background: rgba(0,0,0,0.35);
            padding: 2px 7px;
            border-radius: 5px;
            color: #38bdf8;
        }

        /* ── Hints List ── */
        .hints-list { list-style: none; padding: 0; }

        .hint-item {
            display: flex;
            gap: 10px;
            padding: 12px 14px;
            margin-bottom: 8px;
            background: rgba(251,191,36,0.04);
            border: 1px solid rgba(251,191,36,0.1);
            border-radius: 10px;
            font-size: 0.85rem;
            color: #e2e8f0;
            line-height: 1.5;
            animation: hint-slide-in 0.4s ease-out;
        }

        .hint-number {
            flex-shrink: 0;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            background: rgba(251,191,36,0.15);
            color: #fbbf24;
            font-size: 0.7rem;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        @keyframes hint-slide-in {
            from { opacity: 0; transform: translateX(-12px); }
            to   { opacity: 1; transform: translateX(0); }
        }

        /* ── Spinner ── */
        .spinner {
            display: inline-block;
            width: 24px;
            height: 24px;
            border: 3px solid rgba(56,189,248,0.2);
            border-top-color: #38bdf8;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* ── Buttons ── */
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 10px 20px;
            border-radius: 10px;
            font-family: 'Inter', sans-serif;
            font-size: 0.8rem;
            font-weight: 600;
            border: none;
            cursor: pointer;
            transition: all 0.25s ease;
            width: 100%;
        }

        .btn:active { transform: scale(0.97); }

        .btn-hint {
            background: rgba(251,191,36,0.12);
            color: #fbbf24;
            border: 1px solid rgba(251,191,36,0.2);
        }
        .btn-hint:hover { background: rgba(251,191,36,0.2); box-shadow: 0 0 20px rgba(251,191,36,0.1); }
        .btn-hint:disabled { opacity: 0.35; cursor: not-allowed; }

        .btn-retry {
            background: rgba(56,189,248,0.12);
            color: #38bdf8;
            border: 1px solid rgba(56,189,248,0.2);
        }
        .btn-retry:hover { background: rgba(56,189,248,0.2); box-shadow: 0 0 20px rgba(56,189,248,0.1); }
        .btn-retry:disabled { opacity: 0.35; cursor: not-allowed; }

        .btn-abort {
            background: rgba(244,63,94,0.08);
            color: #f43f5e;
            border: 1px solid rgba(244,63,94,0.15);
            margin-top: 12px;
        }
        .btn-abort:hover { background: rgba(244,63,94,0.15); box-shadow: 0 0 20px rgba(244,63,94,0.1); }

        /* ── Attempts Counter ── */
        .attempts-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 0;
            border-top: 1px solid rgba(255,255,255,0.06);
            margin-top: 8px;
            font-size: 0.75rem;
            color: #64748b;
        }

        .attempts-count {
            font-weight: 700;
            font-variant-numeric: tabular-nums;
            color: #94a3b8;
        }

        /* ── IDLE state ── */
        .idle-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 48px 16px;
        }

        .idle-icon {
            width: 64px;
            height: 64px;
            border-radius: 50%;
            background: linear-gradient(135deg, rgba(56,189,248,0.1), rgba(139,92,246,0.1));
            border: 1px solid rgba(255,255,255,0.06);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.75rem;
            margin-bottom: 20px;
            animation: idle-float 3s ease-in-out infinite;
        }

        @keyframes idle-float {
            0%, 100% { transform: translateY(0); }
            50%      { transform: translateY(-8px); }
        }

        .idle-title {
            font-size: 1rem;
            font-weight: 700;
            color: #e2e8f0;
            margin-bottom: 8px;
        }

        .idle-subtitle {
            font-size: 0.8rem;
            color: #64748b;
            line-height: 1.6;
        }

        /* ── PASSED state ── */
        .passed-container {
            text-align: center;
            padding: 32px 16px;
        }

        .passed-icon {
            width: 72px;
            height: 72px;
            border-radius: 50%;
            background: linear-gradient(135deg, rgba(16,185,129,0.15), rgba(52,211,153,0.1));
            border: 2px solid rgba(16,185,129,0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2rem;
            margin: 0 auto 20px;
            animation: success-pop 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        @keyframes success-pop {
            0%   { transform: scale(0); opacity: 0; }
            100% { transform: scale(1); opacity: 1; }
        }

        .passed-title {
            font-size: 1.15rem;
            font-weight: 800;
            background: linear-gradient(135deg, #10b981, #34d399);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
        }

        .passed-subtitle {
            font-size: 0.85rem;
            color: #94a3b8;
            line-height: 1.6;
        }

        /* ── FAILED state ── */
        .failed-container { text-align: center; padding: 24px 0; }

        .failed-icon {
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: rgba(244,63,94,0.08);
            border: 1px solid rgba(244,63,94,0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.5rem;
            margin: 0 auto 16px;
            animation: shake 0.5s ease-in-out;
        }

        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            20%      { transform: translateX(-6px); }
            40%      { transform: translateX(6px); }
            60%      { transform: translateX(-4px); }
            80%      { transform: translateX(4px); }
        }

        .failed-title {
            font-size: 1rem;
            font-weight: 700;
            color: #f43f5e;
            margin-bottom: 6px;
        }

        .failed-subtitle {
            font-size: 0.8rem;
            color: #94a3b8;
            line-height: 1.55;
            margin-bottom: 20px;
        }

        /* ── Transitions ── */
        .view-container {
            animation: view-fade-in 0.35s ease-out;
        }

        @keyframes view-fade-in {
            from { opacity: 0; transform: translateY(10px); }
            to   { opacity: 1; transform: translateY(0); }
        }

        @keyframes glow-pulse {
            0%, 100% { box-shadow: 0 0 4px currentColor; }
            50%      { box-shadow: 0 0 12px currentColor; }
        }

        /* ── Scrollbar ── */
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

        /* ── Hidden helper ── */
        .hidden { display: none !important; }
    </style>
</head>
<body>
    <div class="app">
        <!-- Header (always visible) -->
        <div class="header">
            <div style="color: #10b981; font-weight: bold; margin-bottom: 5px;">BUILD_ID_20260608</div>
            <div class="logo">Zero-Magic</div>
            <div class="badge badge-idle" id="state-badge">
                <span class="badge-dot"></span>
                <span id="badge-text">Idle</span>
            </div>
            
            <!-- DEBUG PANEL -->
            <div id="debug-panel" style="background: red; color: white; padding: 10px; margin-top: 10px; border-radius: 5px; font-family: monospace; font-size: 12px; text-align: left;">
                <div>State: <span id="debug-state">N/A</span></div>
                <div>Revealed Hints: <span id="debug-revealed">N/A</span></div>
                <div>Total Hints: <span id="debug-total">N/A</span></div>
            </div>
        </div>

        <!-- ═══ IDLE View ═══ -->
        <div id="view-idle" class="view-container">
            <div class="idle-container">
                <div class="idle-icon">🧠</div>
                <div class="idle-title">Ready to think</div>
                <div class="idle-subtitle">
                    Write some code and trigger an error.<br>
                    Click the <code>💡 Help me think</code> lightbulb to start a Socratic mission.
                </div>
            </div>
        </div>

        <!-- ═══ QUESTIONING View ═══ -->
        <div id="view-questioning" class="view-container hidden">
            <div class="card">
                <div class="card-label">
                    <span class="card-label-dot blue"></span>
                    Mission Context
                </div>
                <p class="text-body" id="mission-description"></p>
            </div>

            <div class="card" style="border-color: rgba(16,185,129,0.15); background: rgba(16,185,129,0.02);">
                <div class="card-label">
                    <span class="card-label-dot green"></span>
                    The Socratic Question
                </div>
                <p class="text-question" id="mission-question"></p>
                <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 18px;">
                    <button class="btn btn-hint" id="btn-hint">
                        💡 Reveal a Hint
                        <span id="hint-counter" style="opacity:0.6; font-weight:400;"></span>
                    </button>
                    <button class="btn btn-abort">Abort Mission</button>
                </div>
            </div>

            <div class="attempts-bar">
                <div>Language: <code id="mission-lang"></code></div>
                <div>Attempts: <span class="attempts-count" id="attempts-count">0</span></div>
            </div>
        </div>

        <!-- ═══ HINTING View ═══ -->
        <div id="view-hinting" class="view-container hidden">
            <div class="card">
                <div class="card-label">
                    <span class="card-label-dot blue"></span>
                    Mission Context
                </div>
                <p class="text-body" id="hinting-description"></p>
            </div>

            <div class="card" style="border-color: rgba(16,185,129,0.15); background: rgba(16,185,129,0.02);">
                <div class="card-label">
                    <span class="card-label-dot green"></span>
                    The Socratic Question
                </div>
                <p class="text-question" id="hinting-question"></p>
            </div>

            <div class="card" style="border-color: rgba(251,191,36,0.12); background: rgba(251,191,36,0.02);">
                <div class="card-label">
                    <span class="card-label-dot amber"></span>
                    Hints Revealed
                </div>
                <ul class="hints-list" id="hints-list"></ul>
                <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 18px;">
                    <button class="btn btn-hint" id="btn-more-hint">
                        💡 Reveal Another Hint
                        <span id="hint-counter-2" style="opacity:0.6; font-weight:400;"></span>
                    </button>
                    <button class="btn btn-hint hidden" id="btn-expert-solution" style="background: rgba(139,92,246,0.12); color: #8b5cf6; border-color: rgba(139,92,246,0.2);">
                        💡 Show Expert Solution
                    </button>
                    <button class="btn btn-abort">Abort Mission</button>
                </div>
            </div>

            <div class="attempts-bar">
                <div>Language: <code id="hinting-lang"></code></div>
                <div>Attempts: <span class="attempts-count" id="hinting-attempts">0</span></div>
            </div>
        </div>

        <!-- ═══ TESTING View ═══ -->
        <div id="view-testing" class="view-container hidden">
            <div class="card" style="text-align: center; padding: 40px 20px;">
                <div class="spinner"></div>
                <div class="text-question" style="margin-top: 20px; color: #94a3b8;">Evaluating your solution...</div>
            </div>
            <button class="btn btn-retry" disabled>↻ Try Again</button>
        </div>

        <!-- ═══ PASSED View ═══ -->
        <div id="view-passed" class="view-container hidden">
            <div class="passed-container">
                <div class="passed-icon">✓</div>
                <div class="passed-title">Milestone Unlocked!</div>
                <div class="passed-subtitle">
                    You figured it out through your own reasoning.
                    That's real understanding — not a copy-paste fix.
                </div>
            </div>
            <div class="attempts-bar">
                <div>Mission Complete</div>
                <div>Total Attempts: <span class="attempts-count" id="passed-attempts">0</span></div>
            </div>
        </div>

        <!-- ═══ FAILED View ═══ -->
        <div id="view-failed" class="view-container hidden">
            <div class="failed-container">
                <div class="failed-icon">✗</div>
                <div class="failed-title">Not quite yet</div>
                <div class="failed-subtitle" id="failed-message">
                    The test didn't pass, but that's okay.<br>
                    Re-read the question, check the hints, and try again.
                </div>
                <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 18px; width: 100%;">
                    <button class="btn btn-retry" id="btn-retry-failed">↻ Try Again</button>
                    <button class="btn btn-abort">Abort Mission</button>
                </div>
            </div>
            <div class="attempts-bar">
                <div>Keep going!</div>
                <div>Attempts: <span class="attempts-count" id="failed-attempts">0</span></div>
            </div>
        </div>
        
        <!-- ═══ SOLUTION View ═══ -->
        <div id="view-solution" class="view-container hidden">
            <div class="card" style="border-color: rgba(139,92,246,0.15); background: rgba(139,92,246,0.02);">
                <div class="card-label">
                    <span class="card-label-dot" style="background: #8b5cf6;"></span>
                    Expert Solution
                </div>
                <div id="solution-spinner" class="spinner" style="margin: 20px auto; display: block; border-top-color: #8b5cf6; border-color: rgba(139,92,246,0.2);"></div>
                
                <div id="solution-content" class="hidden">
                    <pre style="background: #0f172a; padding: 12px; border-radius: 8px; overflow-x: auto; margin: 10px 0;"><code id="solution-code" style="color: #e2e8f0; font-family: monospace; font-size: 0.8rem;"></code></pre>
                    
                    <div style="margin-top: 16px;">
                        <div style="font-size: 0.8rem; font-weight: 600; color: #8b5cf6; margin-bottom: 4px;">Explanation</div>
                        <p class="text-body" id="solution-explanation"></p>
                    </div>

                    <div style="margin-top: 16px;">
                        <div style="font-size: 0.8rem; font-weight: 600; color: #10b981; margin-bottom: 4px;">What you learned</div>
                        <p class="text-body" id="solution-concept"></p>
                    </div>
                </div>
                
                <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 18px; width: 100%;">
                    <button class="btn btn-abort">Close Mission</button>
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // ── State rendering ──
        const views = {
            IDLE:        document.getElementById('view-idle'),
            QUESTIONING: document.getElementById('view-questioning'),
            HINTING:     document.getElementById('view-hinting'),
            TESTING:     document.getElementById('view-testing'),
            PASSED:      document.getElementById('view-passed'),
            FAILED:      document.getElementById('view-failed'),
        };

        const badge       = document.getElementById('state-badge');
        const badgeText   = document.getElementById('badge-text');
        const badgeLabels = {
            IDLE:        'Idle',
            QUESTIONING: 'Socratic Mode Active',
            HINTING:     'Hints Revealed',
            TESTING:     'Evaluating',
            PASSED:      'Mission Complete',
            FAILED:      'Test Failed',
        };

        function showView(state) {
            Object.entries(views).forEach(([key, el]) => {
                el.classList.toggle('hidden', key !== state);
            });

            // Update badge
            badge.className = 'badge badge-' + state.toLowerCase();
            badgeText.textContent = badgeLabels[state] || state;
        }

        function renderState(data) {
            const { state, mission, attempts, totalHints, revealedHints } = data;
            console.log("[UI] Rendering state", state);
            console.log("[DEBUG] incoming state:", state);
            console.log("[DEBUG] incoming revealedHints:", revealedHints);
            console.log("[DEBUG] incoming hints array:", mission ? mission.hints : 'no mission');

            // Update debug panel
            const debugState = document.getElementById('debug-state');
            const debugRevealed = document.getElementById('debug-revealed');
            const debugTotal = document.getElementById('debug-total');
            if (debugState) debugState.textContent = state;
            if (debugRevealed) debugRevealed.textContent = revealedHints;
            if (debugTotal) debugTotal.textContent = totalHints;

            showView(state);

            if (state === 'QUESTIONING' && mission) {
                document.getElementById('mission-description').textContent = mission.description;
                document.getElementById('mission-question').textContent    = mission.socraticQuestion;
                document.getElementById('mission-lang').textContent        = mission.language;
                document.getElementById('attempts-count').textContent      = attempts;

                const hintBtn = document.getElementById('btn-hint');
                const counter = document.getElementById('hint-counter');
                counter.textContent = '(' + revealedHints + '/' + totalHints + ')';
                hintBtn.disabled = (revealedHints >= totalHints);
            }

            if (state === 'HINTING' && mission) {
                document.getElementById('hinting-description').textContent = mission.description;
                document.getElementById('hinting-question').textContent    = mission.socraticQuestion;
                document.getElementById('hinting-lang').textContent        = mission.language;
                document.getElementById('hinting-attempts').textContent    = attempts;

                // Build hints list
                const list = document.getElementById('hints-list');
                list.innerHTML = '';
                (mission.hints || []).forEach((hint, i) => {
                    const li = document.createElement('li');
                    li.className = 'hint-item';
                    li.innerHTML = '<span class="hint-number">' + (i + 1) + '</span><span>' + escapeHtml(hint) + '</span>';
                    list.appendChild(li);
                });

                const moreBtn = document.getElementById('btn-more-hint');
                const counter2 = document.getElementById('hint-counter-2');
                counter2.textContent = '(' + revealedHints + '/' + totalHints + ')';
                moreBtn.disabled = (revealedHints >= totalHints);
            }

            if (state === 'TESTING') {
                const el = document.getElementById('testing-attempts');
                if (el) {
                    el.textContent = attempts;
                }
                // Button is inherently hidden because it's only in the FAILED view,
                // but this satisfies the logic of disabling retry while testing.
            }

            if (state === 'PASSED') {
                document.getElementById('passed-attempts').textContent = attempts;
            }

            if (state === 'FAILED') {
                document.getElementById('failed-attempts').textContent = attempts;
                if (data.customFailedMessage) {
                    document.getElementById('failed-message').textContent = data.customFailedMessage;
                } else {
                    document.getElementById('failed-message').innerHTML = "The test didn't pass, but that's okay.<br>Re-read the question, check the hints, and try again.";
                }
            }

            console.log('[VERIFY]', document.getElementById('hints-list')?.innerHTML);
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ── Outbound messages to extension ──
        function requestHint() {
            console.log("[UI] Hint button clicked");
            console.log("[UI] Sending REQUEST_HINT");
            vscode.postMessage({ type: 'REQUEST_HINT' });
        }

        function retry() {
            vscode.postMessage({ type: 'RETRY' });
        }

        function abort() {
            vscode.postMessage({ type: 'ABORT' });
        }

        // Register event listeners immediately
        console.log('[DEBUG] document.readyState:', document.readyState);

        document.addEventListener('click', e => {
            console.log('[GLOBAL CLICK]', e.target);
        });

        document.body.addEventListener('click', e => {
            console.log('[BODY CLICK]', e.target);
        });

        const btnHint = document.getElementById('btn-hint');
        console.log('[DEBUG] btnHint found:', !!btnHint);
        if (btnHint) {
            const rect = btnHint.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(btnHint);
            console.log('[DEBUG] btnHint rect:', rect.width, rect.height, rect.top, rect.left);
            console.log('[DEBUG] btnHint pointer-events:', computedStyle.pointerEvents);
            console.log('[DEBUG] btnHint opacity:', computedStyle.opacity);
            console.log('[DEBUG] btnHint disabled:', btnHint.disabled);

            btnHint.addEventListener('mousedown', () => console.log('[DEBUG] btnHint mousedown'));
            btnHint.addEventListener('mouseup', () => console.log('[DEBUG] btnHint mouseup'));

            btnHint.addEventListener('click', () => {
                console.log('[DEBUG] Actual click handler fired for btnHint');
                requestHint();
            });
            console.log('[DEBUG] Listener attached to btn-hint');
        }

        const btnMoreHint = document.getElementById('btn-more-hint');
        if (btnMoreHint) {
            btnMoreHint.addEventListener('click', () => {
                console.log('[DEBUG] Actual click handler fired for btnMoreHint');
                requestHint();
            });
            console.log('[DEBUG] Listener attached to btn-more-hint');
        }

        const btnRetryFailed = document.getElementById('btn-retry-failed');
        if (btnRetryFailed) {
            btnRetryFailed.addEventListener('click', () => {
                console.log('[DEBUG] Actual click handler fired for btnRetryFailed');
                retry();
            });
            console.log('[DEBUG] Listener attached to btn-retry-failed');
        }

        const btnAborts = document.querySelectorAll('.btn-abort');
        btnAborts.forEach((btn, idx) => {
            btn.addEventListener('click', () => {
                console.log('[DEBUG] Actual click handler fired for btnAbort idx=' + idx);
                abort();
            });
            console.log('[DEBUG] Listener attached to btn-abort idx=' + idx);
        });

        // ── Inbound messages from extension ──
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'STATE_UPDATE') {
                console.log("[UI] State received", message.state);
            }

            if (message.type === 'STATE_UPDATE') {
                renderState(message);
            }

            // Support Phase 6 UNLOCK message (backwards compat with dashboard.ts)
            if (message.type === 'UNLOCK') {
                showView('PASSED');
                badgeText.textContent = 'Milestone Unlocked';
            }
        });

        // Ask extension for current state on first load
        vscode.postMessage({ type: 'REQUEST_STATE' });
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
