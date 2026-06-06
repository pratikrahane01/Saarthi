import * as vscode from 'vscode';
import { Mission } from '../missions';

/**
 * The five possible UI states for the Socratic Dashboard.
 * Each state maps to a distinct visual presentation in the webview.
 */
export type DashboardState = 'IDLE' | 'QUESTIONING' | 'HINTING' | 'PASSED' | 'FAILED';

export class SocraticSidebarProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'zeroMagic.socraticSidebar';

    /** Singleton reference so other modules can send messages to the sidebar */
    public static instance: SocraticSidebarProvider | undefined;

    private _view?: vscode.WebviewView;
    private _currentState: DashboardState = 'IDLE';
    private _currentMission?: Mission;
    private _attempts: number = 0;
    private _revealedHints: number = 0;

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
    public reportTestResult(passed: boolean) {
        this._attempts++;
        if (passed) {
            this._currentState = 'PASSED';
        } else {
            this._currentState = 'FAILED';
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
                this._onRequestHint();
                break;

            case 'RETRY':
                // User clicked "Try Again" from the FAILED screen
                this._currentState = 'QUESTIONING';
                this._postState();
                break;

            case 'REQUEST_STATE':
                // Webview is asking for the current state (e.g. on first load)
                this._postState();
                break;

            default:
                console.log('Zero-Magic Sidebar: Unknown message type', message.type);
        }
    }

    /**
     * Reveal the next hint in the Socratic sequence.
     */
    private _onRequestHint() {
        if (!this._currentMission) return;

        if (this._revealedHints < this._currentMission.hints.length) {
            this._revealedHints++;
        }

        this._currentState = 'HINTING';
        this._postState();
    }

    // ──────────────────────────────────────────────
    //  OUTBOUND — push state to the webview
    // ──────────────────────────────────────────────

    private _postState() {
        if (!this._view) return;

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
            z-index: 0;
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
            <div class="logo">Zero-Magic</div>
            <div class="badge badge-idle" id="state-badge">
                <span class="badge-dot"></span>
                <span id="badge-text">Idle</span>
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
            </div>

            <button class="btn btn-hint" id="btn-hint" onclick="requestHint()">
                💡 Reveal a Hint
                <span id="hint-counter" style="opacity:0.6; font-weight:400;"></span>
            </button>

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
            </div>

            <button class="btn btn-hint" id="btn-more-hint" onclick="requestHint()">
                💡 Reveal Another Hint
                <span id="hint-counter-2" style="opacity:0.6; font-weight:400;"></span>
            </button>

            <div class="attempts-bar">
                <div>Language: <code id="hinting-lang"></code></div>
                <div>Attempts: <span class="attempts-count" id="hinting-attempts">0</span></div>
            </div>
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
                <div class="failed-subtitle">
                    The test didn't pass, but that's okay.<br>
                    Re-read the question, check the hints, and try again.
                </div>
                <button class="btn btn-retry" onclick="retry()">↻ Try Again</button>
            </div>
            <div class="attempts-bar">
                <div>Keep going!</div>
                <div>Attempts: <span class="attempts-count" id="failed-attempts">0</span></div>
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
            PASSED:      document.getElementById('view-passed'),
            FAILED:      document.getElementById('view-failed'),
        };

        const badge       = document.getElementById('state-badge');
        const badgeText   = document.getElementById('badge-text');
        const badgeLabels = {
            IDLE:        'Idle',
            QUESTIONING: 'Socratic Mode Active',
            HINTING:     'Hints Revealed',
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

            if (state === 'PASSED') {
                document.getElementById('passed-attempts').textContent = attempts;
            }

            if (state === 'FAILED') {
                document.getElementById('failed-attempts').textContent = attempts;
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ── Outbound messages to extension ──
        function requestHint() {
            vscode.postMessage({ type: 'REQUEST_HINT' });
        }

        function retry() {
            vscode.postMessage({ type: 'RETRY' });
        }

        // ── Inbound messages from extension ──
        window.addEventListener('message', event => {
            const message = event.data;

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
