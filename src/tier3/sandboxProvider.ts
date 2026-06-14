/**
 * sandboxProvider.ts — Isolated WebviewPanel for Tier 3 Sandbox UI.
 *
 * ISOLATION RULE: This file does NOT import from sidebar.ts, watcher.ts,
 * or any Tier 1/Tier 2 UI module. It renders its own HTML in a separate
 * WebviewPanel (not the sidebar).
 *
 * The panel is created when SandboxController.start() is called and
 * disposed when the session ends (pass/fail/abort).
 */

import * as vscode from 'vscode';
import { SandboxChallenge, SandboxResult, SandboxState } from './sandboxTypes';
import { executeSandboxSubmit } from './sandboxSubmit';

export class SandboxPanel {
    public static currentPanel: SandboxPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private _state: SandboxState = 'LOADING';
    private _challenge: SandboxChallenge | null = null;
    private _language: string = 'python';
    private _originalCode: string = '';
    private _hintsRevealed: number = 0;
    private _hearts: number = 3;
    private _result: SandboxResult | null = null;
    private _onComplete: ((xpEarned: number, hintsUsed: number) => void) | null = null;
    private _onAbort: (() => void) | null = null;

    public static createOrShow(
        extensionUri: vscode.Uri,
        challenge: SandboxChallenge,
        language: string,
        originalCode: string,
        onComplete: (xpEarned: number, hintsUsed: number) => void,
        onAbort: () => void,
    ): SandboxPanel {
        // Close any existing panel first
        if (SandboxPanel.currentPanel) {
            SandboxPanel.currentPanel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'zeroMagicSandbox',
            '🧪 Sandbox — Tier 3',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        const sandboxPanel = new SandboxPanel(panel, challenge, language, originalCode, onComplete, onAbort);
        SandboxPanel.currentPanel = sandboxPanel;
        return sandboxPanel;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        challenge: SandboxChallenge,
        language: string,
        originalCode: string,
        onComplete: (xpEarned: number, hintsUsed: number) => void,
        onAbort: () => void,
    ) {
        this._panel = panel;
        this._challenge = challenge;
        this._language = language;
        this._originalCode = originalCode;
        this._onComplete = onComplete;
        this._onAbort = onAbort;
        this._state = 'ACTIVE';

        // Set HTML
        this._panel.webview.html = this._getHtml();

        // Send initial state
        this._postState();

        // Listen for messages from webview
        this._panel.webview.onDidReceiveMessage(
            (message) => this._handleMessage(message),
            null,
            this._disposables
        );

        // Handle panel disposal
        this._panel.onDidDispose(
            () => {
                if (this._state !== 'PASSED' && this._state !== 'ABORTED') {
                    this._onAbort?.();
                }
                this.dispose();
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        SandboxPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    private async _handleMessage(message: any) {
        switch (message.type) {
            case 'SUBMIT':
                await this._onSubmit(message.code);
                break;

            case 'HINT':
                this._onHint();
                break;

            case 'ABORT':
                this._state = 'ABORTED';
                this._onAbort?.();
                this.dispose();
                break;

            case 'REQUEST_STATE':
                this._postState();
                break;

            case 'RETRY':
                this._state = 'ACTIVE';
                this._postState();
                break;
        }
    }

    private async _onSubmit(studentCode: string) {
        if (!this._challenge || this._state === 'EVALUATING') { return; }

        this._state = 'EVALUATING';
        this._postState();

        const result = await executeSandboxSubmit(
            this._challenge.sandboxId,
            this._language,
            studentCode,
            this._originalCode,
            this._challenge.challenge,
            this._hintsRevealed,
        );

        this._result = result;

        if (result && result.passed) {
            this._state = 'PASSED';
            this._postState();
            this._onComplete?.(result.xpAwarded, this._hintsRevealed);
        } else if (result) {
            this._hearts--;
            if (this._hearts <= 0) {
                this._state = 'FAILED';
            } else {
                this._state = 'ACTIVE';
            }
            this._postState();
        } else {
            // Network error — stay active so student can retry
            this._state = 'ACTIVE';
            this._postState();
        }
    }

    private _onHint() {
        if (!this._challenge) { return; }
        if (this._hintsRevealed < this._challenge.hints.length) {
            this._hintsRevealed++;
            this._postState();
        }
    }

    private _postState() {
        this._panel.webview.postMessage({
            type: 'STATE_UPDATE',
            state: this._state,
            challenge: this._challenge,
            hintsRevealed: this._hintsRevealed,
            hearts: this._hearts,
            result: this._result,
            scaffoldCode: this._challenge?.scaffoldCode ?? '',
        });
    }

    private _getHtml(): string {
        const nonce = getNonce();
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <title>Sandbox — Tier 3</title>
    <style nonce="${nonce}">
        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --accent: var(--vscode-button-background);
            --accent-hover: var(--vscode-button-hoverBackground);
            --border: var(--vscode-panel-border);
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --input-border: var(--vscode-input-border);
            --badge-bg: var(--vscode-badge-background);
            --badge-fg: var(--vscode-badge-foreground);
            --success: #4caf50;
            --error: #f44336;
            --warning: #ff9800;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg);
            background: var(--bg);
            padding: 16px;
            line-height: 1.6;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border);
        }
        .header h1 {
            font-size: 1.3em;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .hearts {
            display: flex;
            gap: 4px;
            font-size: 1.2em;
        }

        .section {
            margin-bottom: 16px;
            padding: 12px;
            border: 1px solid var(--border);
            border-radius: 6px;
        }
        .section h2 {
            font-size: 1em;
            margin-bottom: 8px;
            opacity: 0.85;
        }

        .challenge-text {
            padding: 8px 12px;
            background: color-mix(in srgb, var(--accent) 10%, transparent);
            border-left: 3px solid var(--accent);
            border-radius: 4px;
            margin-bottom: 8px;
        }

        .criteria {
            padding: 8px 12px;
            background: color-mix(in srgb, var(--success) 10%, transparent);
            border-left: 3px solid var(--success);
            border-radius: 4px;
            font-size: 0.9em;
        }

        .hint {
            padding: 6px 10px;
            margin-top: 6px;
            background: color-mix(in srgb, var(--warning) 10%, transparent);
            border-left: 3px solid var(--warning);
            border-radius: 4px;
            font-size: 0.9em;
        }

        textarea {
            width: 100%;
            min-height: 200px;
            padding: 10px;
            font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
            font-size: var(--vscode-editor-font-size, 13px);
            background: var(--input-bg);
            color: var(--input-fg);
            border: 1px solid var(--input-border);
            border-radius: 4px;
            resize: vertical;
            tab-size: 4;
        }
        textarea:focus {
            outline: 1px solid var(--accent);
        }

        .actions {
            display: flex;
            gap: 8px;
            margin-top: 12px;
            flex-wrap: wrap;
        }
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.95em;
            font-family: inherit;
        }
        .btn-primary {
            background: var(--accent);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover { background: var(--accent-hover); }
        .btn-secondary {
            background: transparent;
            color: var(--fg);
            border: 1px solid var(--border);
        }
        .btn-secondary:hover { background: color-mix(in srgb, var(--fg) 10%, transparent); }
        .btn-danger {
            background: color-mix(in srgb, var(--error) 20%, transparent);
            color: var(--error);
            border: 1px solid var(--error);
        }

        .feedback {
            padding: 12px;
            border-radius: 6px;
            margin-top: 12px;
        }
        .feedback.pass {
            background: color-mix(in srgb, var(--success) 15%, transparent);
            border: 1px solid var(--success);
        }
        .feedback.fail {
            background: color-mix(in srgb, var(--error) 15%, transparent);
            border: 1px solid var(--error);
        }

        .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-right: 8px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .status-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.8em;
            font-weight: bold;
        }
        .status-badge.active { background: var(--accent); color: var(--vscode-button-foreground); }
        .status-badge.passed { background: var(--success); color: white; }
        .status-badge.failed { background: var(--error); color: white; }

        .hidden { display: none !important; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🧪 Tier 3 Sandbox</h1>
        <div class="hearts" id="hearts"></div>
    </div>

    <div id="loading" class="section">
        <span class="spinner"></span> Loading sandbox challenge...
    </div>

    <div id="challenge-section" class="section hidden">
        <h2>🎯 Challenge</h2>
        <div class="challenge-text" id="challenge-text"></div>
        <div class="criteria" id="criteria-text"></div>
    </div>

    <div id="hints-section" class="section hidden">
        <h2>💡 Hints</h2>
        <div id="hints-container"></div>
        <button class="btn-secondary" id="btn-hint" style="margin-top: 8px;">
            Request Hint
        </button>
    </div>

    <div id="editor-section" class="section hidden">
        <h2>📝 Your Code</h2>
        <textarea id="code-editor" spellcheck="false"></textarea>
    </div>

    <div id="feedback-section" class="hidden"></div>

    <div class="actions" id="actions">
        <button class="btn-primary" id="btn-submit">Submit Fix</button>
        <button class="btn-danger" id="btn-abort">Abort</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let currentState = 'LOADING';
        let challengeData = null;

        // Elements
        const loadingEl = document.getElementById('loading');
        const challengeSection = document.getElementById('challenge-section');
        const challengeText = document.getElementById('challenge-text');
        const criteriaText = document.getElementById('criteria-text');
        const hintsSection = document.getElementById('hints-section');
        const hintsContainer = document.getElementById('hints-container');
        const editorSection = document.getElementById('editor-section');
        const codeEditor = document.getElementById('code-editor');
        const feedbackSection = document.getElementById('feedback-section');
        const heartsEl = document.getElementById('hearts');
        const btnSubmit = document.getElementById('btn-submit');
        const btnHint = document.getElementById('btn-hint');
        const btnAbort = document.getElementById('btn-abort');

        // Button handlers
        btnSubmit.addEventListener('click', () => {
            if (currentState === 'EVALUATING') return;
            vscode.postMessage({ type: 'SUBMIT', code: codeEditor.value });
        });

        btnHint.addEventListener('click', () => {
            vscode.postMessage({ type: 'HINT' });
        });

        btnAbort.addEventListener('click', () => {
            vscode.postMessage({ type: 'ABORT' });
        });

        // Handle Tab key in textarea
        codeEditor.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = codeEditor.selectionStart;
                const end = codeEditor.selectionEnd;
                codeEditor.value = codeEditor.value.substring(0, start) + '    ' + codeEditor.value.substring(end);
                codeEditor.selectionStart = codeEditor.selectionEnd = start + 4;
            }
        });

        // State update handler
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type !== 'STATE_UPDATE') return;

            currentState = msg.state;
            challengeData = msg.challenge;

            // Hearts
            heartsEl.innerHTML = '';
            for (let i = 0; i < 3; i++) {
                heartsEl.innerHTML += i < msg.hearts ? '❤️' : '🖤';
            }

            // Loading
            loadingEl.classList.toggle('hidden', currentState !== 'LOADING');

            // Challenge
            const showChallenge = ['ACTIVE', 'EVALUATING', 'PASSED', 'FAILED'].includes(currentState);
            challengeSection.classList.toggle('hidden', !showChallenge);
            if (challengeData) {
                challengeText.textContent = challengeData.challenge;
                criteriaText.textContent = '✅ Success Criteria: ' + challengeData.testCriteria;
            }

            // Hints
            hintsSection.classList.toggle('hidden', !showChallenge);
            if (challengeData) {
                hintsContainer.innerHTML = '';
                for (let i = 0; i < msg.hintsRevealed; i++) {
                    const div = document.createElement('div');
                    div.className = 'hint';
                    div.textContent = '💡 Hint ' + (i + 1) + ': ' + challengeData.hints[i];
                    hintsContainer.appendChild(div);
                }
                const maxHints = challengeData.hints ? challengeData.hints.length : 0;
                btnHint.textContent = msg.hintsRevealed >= maxHints
                    ? '💡 (' + maxHints + '/' + maxHints + ')'
                    : 'Request Hint (' + msg.hintsRevealed + '/' + maxHints + ')';
                btnHint.disabled = msg.hintsRevealed >= maxHints;
            }

            // Editor
            const showEditor = ['ACTIVE', 'EVALUATING'].includes(currentState);
            editorSection.classList.toggle('hidden', !showEditor);
            if (currentState === 'ACTIVE' && codeEditor.value === '' && msg.scaffoldCode) {
                codeEditor.value = msg.scaffoldCode;
            }

            // Feedback
            feedbackSection.classList.remove('hidden');
            feedbackSection.innerHTML = '';
            if (currentState === 'EVALUATING') {
                feedbackSection.innerHTML = '<div class="section"><span class="spinner"></span> Evaluating your fix...</div>';
            } else if (currentState === 'PASSED' && msg.result) {
                feedbackSection.innerHTML =
                    '<div class="feedback pass">' +
                    '<strong>🎉 Challenge Passed! +' + msg.result.xpAwarded + ' XP</strong><br>' +
                    msg.result.feedback + '<br><br>' +
                    '<strong>📚 Concept:</strong> ' + msg.result.conceptSummary +
                    '</div>';
            } else if (currentState === 'FAILED' && msg.result) {
                feedbackSection.innerHTML =
                    '<div class="feedback fail">' +
                    '<strong>❌ Not quite right</strong><br>' +
                    msg.result.feedback +
                    (msg.hearts <= 0 ? '<br><br>No hearts remaining. Try a different approach.' : '') +
                    '</div>';
                if (msg.hearts > 0) {
                    const retryBtn = document.createElement('button');
                    retryBtn.className = 'btn-primary';
                    retryBtn.textContent = 'Try Again';
                    retryBtn.style.marginTop = '8px';
                    retryBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'RETRY' });
                    });
                    feedbackSection.appendChild(retryBtn);
                }
            } else if (currentState === 'ACTIVE' && msg.result && !msg.result.passed) {
                // Show previous feedback when retrying
                feedbackSection.innerHTML =
                    '<div class="feedback fail">' +
                    '<strong>Previous attempt:</strong> ' + msg.result.feedback +
                    '</div>';
            } else {
                feedbackSection.classList.add('hidden');
            }

            // Actions visibility
            btnSubmit.classList.toggle('hidden', currentState !== 'ACTIVE');
            btnAbort.classList.toggle('hidden', currentState === 'PASSED' || currentState === 'ABORTED');
            btnSubmit.disabled = currentState === 'EVALUATING';
        });

        // Request initial state
        vscode.postMessage({ type: 'REQUEST_STATE' });
    </script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
