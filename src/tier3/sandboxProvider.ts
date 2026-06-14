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
    private _currentQuestionIndex: number = 0;
    private _hintsRevealedPerQuestion: number[] = [0, 0, 0];
    private _hearts: number = 3;
    private _result: SandboxResult | null = null;
    private _questionResults: (boolean | null)[] = [null, null, null];
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
        this._currentQuestionIndex = 0;
        this._hintsRevealedPerQuestion = new Array(challenge.questions.length).fill(0);
        this._questionResults = new Array(challenge.questions.length).fill(null);

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

            case 'NEXT_QUESTION':
                this._currentQuestionIndex++;
                this._state = 'ACTIVE';
                this._result = null;
                this._postState();
                break;
        }
    }

    private async _onSubmit(studentCode: string) {
        if (!this._challenge || this._state === 'EVALUATING') { return; }

        const currentQ = this._challenge.questions[this._currentQuestionIndex];
        if (!currentQ) { return; }

        this._state = 'EVALUATING';
        this._postState();

        const result = await executeSandboxSubmit(
            this._challenge.sandboxId,
            this._language,
            studentCode,
            currentQ.scaffoldCode,
            currentQ.challenge,
            this._getTotalHintsUsed(),
        );

        this._result = result;

        if (result && result.passed) {
            this._questionResults[this._currentQuestionIndex] = true;

            // Check if all questions are done
            const allDone = this._questionResults.every(r => r === true);
            if (allDone) {
                this._state = 'PASSED';
                this._postState();
                const totalXp = result.xpAwarded;
                this._onComplete?.(totalXp, this._getTotalHintsUsed());
            } else {
                // Question passed, but more to go — show success for this question
                this._state = 'PASSED';
                this._postState();
            }
        } else if (result) {
            this._hearts--;
            this._questionResults[this._currentQuestionIndex] = false;
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

    private _getTotalHintsUsed(): number {
        return this._hintsRevealedPerQuestion.reduce((sum, h) => sum + h, 0);
    }

    private _onHint() {
        if (!this._challenge) { return; }
        const currentQ = this._challenge.questions[this._currentQuestionIndex];
        if (!currentQ) { return; }
        if (this._hintsRevealedPerQuestion[this._currentQuestionIndex] < currentQ.hints.length) {
            this._hintsRevealedPerQuestion[this._currentQuestionIndex]++;
            this._postState();
        }
    }

    private _postState() {
        const currentQ = this._challenge?.questions[this._currentQuestionIndex] ?? null;
        this._panel.webview.postMessage({
            type: 'STATE_UPDATE',
            state: this._state,
            challenge: this._challenge,
            currentQuestion: currentQ,
            currentQuestionIndex: this._currentQuestionIndex,
            totalQuestions: this._challenge?.questions.length ?? 0,
            hintsRevealed: this._hintsRevealedPerQuestion[this._currentQuestionIndex] ?? 0,
            hearts: this._hearts,
            result: this._result,
            scaffoldCode: currentQ?.scaffoldCode ?? '',
            originalCode: this._originalCode,
            questionResults: this._questionResults,
            allDone: this._questionResults.every(r => r === true),
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
          content="default-src 'none'; style-src 'nonce-${nonce}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'nonce-${nonce}';">
    <title>Sandbox — Tier 3</title>
    <style nonce="${nonce}">
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Fira+Code&display=swap');

        :root {
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --accent: #8b5cf6; /* Vibrant purple */
            --accent-hover: #7c3aed;
            --border: rgba(255, 255, 255, 0.1);
            --glass-bg: rgba(255, 255, 255, 0.03);
            --glass-border: rgba(255, 255, 255, 0.05);
            --input-bg: rgba(0, 0, 0, 0.2);
            --success: #10b981;
            --error: #ef4444;
            --warning: #f59e0b;
        }

        /* Light theme overrides */
        .vscode-light {
            --border: rgba(0, 0, 0, 0.1);
            --glass-bg: rgba(0, 0, 0, 0.02);
            --glass-border: rgba(0, 0, 0, 0.05);
            --input-bg: rgba(255, 255, 255, 0.5);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: 'Inter', var(--vscode-font-family), sans-serif;
            font-size: 14px;
            color: var(--fg);
            background: var(--bg);
            /* Subtle animated gradient background */
            background-image: radial-gradient(circle at 15% 50%, rgba(139, 92, 246, 0.08), transparent 25%),
                              radial-gradient(circle at 85% 30%, rgba(16, 185, 129, 0.08), transparent 25%);
            background-attachment: fixed;
            padding: 24px;
            line-height: 1.6;
        }

        .glass-panel {
            background: var(--glass-bg);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--glass-border);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 4px 24px -1px rgba(0, 0, 0, 0.1);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .glass-panel:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 32px -2px rgba(0, 0, 0, 0.15);
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border);
        }

        .header h1 {
            font-size: 1.5em;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 12px;
            background: linear-gradient(135deg, #a78bfa, #8b5cf6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .hearts {
            display: flex;
            gap: 6px;
            font-size: 1.3em;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));
        }

        /* Question progress indicator */
        .progress-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 20px;
            padding: 14px 16px;
            background: var(--glass-bg);
            border: 1px solid var(--glass-border);
            border-radius: 10px;
        }

        .progress-step {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            font-size: 0.85em;
            font-weight: 600;
            border: 2px solid var(--border);
            background: transparent;
            transition: all 0.3s ease;
            position: relative;
        }

        .progress-step.active {
            border-color: var(--accent);
            background: color-mix(in srgb, var(--accent) 20%, transparent);
            color: var(--accent);
            box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 30%, transparent);
        }

        .progress-step.completed {
            border-color: var(--success);
            background: color-mix(in srgb, var(--success) 20%, transparent);
            color: var(--success);
        }

        .progress-step.failed {
            border-color: var(--error);
            background: color-mix(in srgb, var(--error) 15%, transparent);
            color: var(--error);
        }

        .progress-connector {
            flex: 1;
            height: 2px;
            background: var(--border);
            transition: background 0.3s ease;
        }

        .progress-connector.completed {
            background: var(--success);
        }

        .progress-label {
            font-size: 0.85em;
            opacity: 0.7;
            margin-left: 8px;
        }

        h2 {
            font-size: 1.1em;
            font-weight: 500;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
            opacity: 0.9;
        }

        .challenge-text {
            font-size: 1.05em;
            margin-bottom: 16px;
        }

        .criteria {
            padding: 12px 16px;
            background: color-mix(in srgb, var(--success) 10%, transparent);
            border-left: 4px solid var(--success);
            border-radius: 0 8px 8px 0;
            font-size: 0.95em;
            font-weight: 500;
        }

        .hint {
            padding: 10px 14px;
            margin-top: 10px;
            background: color-mix(in srgb, var(--warning) 10%, transparent);
            border-left: 4px solid var(--warning);
            border-radius: 0 8px 8px 0;
            font-size: 0.95em;
            animation: slideIn 0.3s ease-out forwards;
        }

        @keyframes slideIn {
            from { opacity: 0; transform: translateX(-10px); }
            to { opacity: 1; transform: translateX(0); }
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .code-container {
            position: relative;
            margin-top: 8px;
        }

        .code-label {
            position: absolute;
            top: -10px;
            left: 12px;
            background: var(--bg);
            padding: 0 8px;
            font-size: 0.8em;
            font-weight: 600;
            color: var(--accent);
            border-radius: 4px;
            border: 1px solid var(--glass-border);
            z-index: 10;
        }

        pre, textarea {
            width: 100%;
            font-family: 'Fira Code', var(--vscode-editor-font-family), monospace;
            font-size: 13px;
            border-radius: 8px;
            padding: 16px;
            background: var(--input-bg);
            border: 1px solid var(--border);
            color: var(--fg);
            line-height: 1.5;
        }

        pre {
            overflow-x: auto;
            margin-bottom: 16px;
            opacity: 0.8;
        }

        textarea {
            min-height: 250px;
            resize: vertical;
            tab-size: 4;
            transition: border-color 0.2s, box-shadow 0.2s;
        }

        textarea:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
        }

        .actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
            flex-wrap: wrap;
        }

        button {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 0.95em;
            font-weight: 500;
            font-family: inherit;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--accent), var(--accent-hover));
            color: white;
            box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 40%, transparent);
        }

        .btn-primary:hover:not(:disabled) { 
            transform: translateY(-1px);
            box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 50%, transparent);
        }

        .btn-primary:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .btn-success {
            background: linear-gradient(135deg, var(--success), #059669);
            color: white;
            box-shadow: 0 4px 12px color-mix(in srgb, var(--success) 40%, transparent);
        }

        .btn-success:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 6px 16px color-mix(in srgb, var(--success) 50%, transparent);
        }

        .btn-secondary {
            background: var(--glass-bg);
            color: var(--fg);
            border: 1px solid var(--border);
        }

        .btn-secondary:hover:not(:disabled) { 
            background: color-mix(in srgb, var(--fg) 10%, transparent); 
        }

        .btn-danger {
            background: color-mix(in srgb, var(--error) 15%, transparent);
            color: var(--error);
            border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
        }

        .btn-danger:hover {
            background: color-mix(in srgb, var(--error) 25%, transparent);
        }

        .feedback {
            padding: 16px;
            border-radius: 8px;
            margin-top: 16px;
            animation: slideIn 0.3s ease-out forwards;
        }

        .feedback.pass {
            background: color-mix(in srgb, var(--success) 15%, transparent);
            border: 1px solid color-mix(in srgb, var(--success) 40%, transparent);
        }

        .feedback.fail {
            background: color-mix(in srgb, var(--error) 15%, transparent);
            border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
        }

        .spinner {
            display: inline-block;
            width: 18px;
            height: 18px;
            border: 2px solid var(--border);
            border-top-color: currentColor;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        .hidden { display: none !important; }

        .question-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 12px;
        }

        .question-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8em;
            font-weight: 600;
            background: linear-gradient(135deg, var(--accent), var(--accent-hover));
            color: white;
        }

        .all-done-banner {
            text-align: center;
            padding: 32px 24px;
            animation: fadeIn 0.4s ease-out;
        }

        .all-done-banner .trophy {
            font-size: 3em;
            margin-bottom: 12px;
            display: block;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1><span>✨</span> Logic Practice Sandbox</h1>
        <div class="hearts" id="hearts"></div>
    </div>

    <div id="loading" class="glass-panel">
        <div style="display: flex; align-items: center; gap: 12px;">
            <span class="spinner" style="color: var(--accent); width: 24px; height: 24px;"></span> 
            <span style="font-size: 1.1em; font-weight: 500;">Generating 3 similar practice questions...</span>
        </div>
    </div>

    <div id="progress-section" class="hidden">
        <div class="progress-bar" id="progress-bar"></div>
    </div>

    <div id="question-section" class="glass-panel hidden" style="animation: fadeIn 0.3s ease-out;">
        <div class="question-header">
            <span class="question-badge" id="question-badge">Q1</span>
            <h2 style="margin-bottom: 0;" id="question-title">📝 Fix the Code</h2>
        </div>
        <div class="challenge-text" id="challenge-text"></div>
        <div class="criteria" id="criteria-text"></div>
    </div>

    <div id="hints-section" class="glass-panel hidden">
        <h2>💡 Hints</h2>
        <div id="hints-container"></div>
        <button class="btn-secondary" id="btn-hint" style="margin-top: 12px;">
            Request Hint
        </button>
    </div>

    <div id="editor-section" class="glass-panel hidden">
        <h2>📝 Your Solution</h2>
        <p style="margin-bottom: 12px; opacity: 0.8; font-size: 0.95em;">Find and fix the logic bug in the code below.</p>
        <div class="code-container">
            <span class="code-label">Code</span>
            <textarea id="code-editor" spellcheck="false"></textarea>
        </div>
    </div>

    <div id="feedback-section" class="hidden"></div>

    <div class="actions" id="actions">
        <button class="btn-primary" id="btn-submit">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            Submit Fix
        </button>
        <button class="btn-success hidden" id="btn-next">
            Next Question →
        </button>
        <button class="btn-danger" id="btn-abort">Abort</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let currentState = 'LOADING';
        let challengeData = null;
        let editorValues = {}; // Store code per question index

        // Elements
        const loadingEl = document.getElementById('loading');
        const progressSection = document.getElementById('progress-section');
        const progressBar = document.getElementById('progress-bar');
        const questionSection = document.getElementById('question-section');
        const questionBadge = document.getElementById('question-badge');
        const questionTitle = document.getElementById('question-title');
        const challengeText = document.getElementById('challenge-text');
        const criteriaText = document.getElementById('criteria-text');
        const hintsSection = document.getElementById('hints-section');
        const hintsContainer = document.getElementById('hints-container');
        const editorSection = document.getElementById('editor-section');
        const codeEditor = document.getElementById('code-editor');
        const feedbackSection = document.getElementById('feedback-section');
        const heartsEl = document.getElementById('hearts');
        const btnSubmit = document.getElementById('btn-submit');
        const btnNext = document.getElementById('btn-next');
        const btnHint = document.getElementById('btn-hint');
        const btnAbort = document.getElementById('btn-abort');

        // Button handlers
        btnSubmit.addEventListener('click', () => {
            if (currentState === 'EVALUATING') return;
            vscode.postMessage({ type: 'SUBMIT', code: codeEditor.value });
        });

        btnNext.addEventListener('click', () => {
            // Save current editor value before moving
            vscode.postMessage({ type: 'NEXT_QUESTION' });
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
            const qIdx = msg.currentQuestionIndex;
            const totalQ = msg.totalQuestions;
            const currentQ = msg.currentQuestion;
            const questionResults = msg.questionResults || [];
            const allDone = msg.allDone;

            // Hearts
            heartsEl.innerHTML = '';
            for (let i = 0; i < 3; i++) {
                heartsEl.innerHTML += i < msg.hearts ? '❤️' : '<span style="opacity:0.3">🤍</span>';
            }

            // Loading
            loadingEl.classList.toggle('hidden', currentState !== 'LOADING');

            const showContent = ['ACTIVE', 'EVALUATING', 'PASSED', 'FAILED'].includes(currentState);

            // Progress bar
            progressSection.classList.toggle('hidden', !showContent);
            if (showContent) {
                progressBar.innerHTML = '';
                for (let i = 0; i < totalQ; i++) {
                    if (i > 0) {
                        const conn = document.createElement('div');
                        conn.className = 'progress-connector' + (questionResults[i - 1] === true ? ' completed' : '');
                        progressBar.appendChild(conn);
                    }
                    const step = document.createElement('div');
                    step.className = 'progress-step';
                    if (i === qIdx && !allDone) {
                        step.classList.add('active');
                    }
                    if (questionResults[i] === true) {
                        step.classList.add('completed');
                        step.innerHTML = '✓';
                    } else if (questionResults[i] === false && i !== qIdx) {
                        step.innerHTML = (i + 1).toString();
                    } else {
                        step.innerHTML = (i + 1).toString();
                    }
                    progressBar.appendChild(step);
                }
                const label = document.createElement('span');
                label.className = 'progress-label';
                label.textContent = allDone ? 'All complete!' : 'Question ' + (qIdx + 1) + ' of ' + totalQ;
                progressBar.appendChild(label);
            }

            // All-done banner
            if (allDone && currentState === 'PASSED') {
                questionSection.classList.remove('hidden');
                questionSection.innerHTML =
                    '<div class="all-done-banner">' +
                    '<span class="trophy">🏆</span>' +
                    '<h2 style="font-size:1.3em; margin-bottom:8px;">All Questions Completed!</h2>' +
                    '<p style="opacity:0.8;">Great job — you\'ve mastered this concept.</p>' +
                    '</div>';
                hintsSection.classList.add('hidden');
                editorSection.classList.add('hidden');
                btnSubmit.classList.add('hidden');
                btnNext.classList.add('hidden');
                btnAbort.classList.add('hidden');

                feedbackSection.classList.remove('hidden');
                feedbackSection.innerHTML = '';
                if (msg.result) {
                    feedbackSection.innerHTML =
                        '<div class="feedback pass glass-panel">' +
                        '<strong style="font-size:1.1em;">🎉 All 3 Questions Passed! +' + msg.result.xpAwarded + ' XP</strong><br><br>' +
                        msg.result.feedback + '<br><br>' +
                        '<div style="background:rgba(0,0,0,0.1);padding:12px;border-radius:6px;margin-top:8px;">' +
                        '<strong>📚 Concept:</strong> ' + msg.result.conceptSummary +
                        '</div></div>';
                }
                return;
            }

            // Question section (shows challenge + criteria for current question)
            questionSection.classList.toggle('hidden', !showContent);
            if (currentQ && showContent) {
                // Restore inner HTML structure since all-done may have replaced it
                if (!document.getElementById('question-badge')) {
                    questionSection.innerHTML =
                        '<div class="question-header">' +
                        '<span class="question-badge" id="question-badge">Q1</span>' +
                        '<h2 style="margin-bottom: 0;" id="question-title">📝 Fix the Code</h2>' +
                        '</div>' +
                        '<div class="challenge-text" id="challenge-text"></div>' +
                        '<div class="criteria" id="criteria-text"></div>';
                }
                const qb = document.getElementById('question-badge');
                const qt = document.getElementById('question-title');
                const ct = document.getElementById('challenge-text');
                const crt = document.getElementById('criteria-text');
                if (qb) qb.textContent = 'Q' + (qIdx + 1);
                if (qt) qt.textContent = '📝 Question ' + (qIdx + 1) + ' of ' + totalQ;
                if (ct) ct.textContent = currentQ.challenge;
                if (crt) crt.textContent = '✅ Success Criteria: ' + currentQ.testCriteria;
            }

            // Hints
            hintsSection.classList.toggle('hidden', !showContent);
            if (currentQ) {
                hintsContainer.innerHTML = '';
                for (let i = 0; i < msg.hintsRevealed; i++) {
                    const div = document.createElement('div');
                    div.className = 'hint';
                    div.innerHTML = '<strong>💡 Hint ' + (i + 1) + ':</strong> ' + currentQ.hints[i];
                    hintsContainer.appendChild(div);
                }
                const maxHints = currentQ.hints ? currentQ.hints.length : 0;
                btnHint.innerHTML = msg.hintsRevealed >= maxHints
                    ? '💡 (' + maxHints + '/' + maxHints + ')'
                    : 'Request Hint (' + msg.hintsRevealed + '/' + maxHints + ')';
                btnHint.disabled = msg.hintsRevealed >= maxHints;
            }

            // Editor
            const showEditor = ['ACTIVE', 'EVALUATING'].includes(currentState);
            editorSection.classList.toggle('hidden', !showEditor);
            if (currentState === 'ACTIVE' && msg.scaffoldCode) {
                // Only load scaffold if editor is empty for this question
                if (!editorValues[qIdx]) {
                    codeEditor.value = msg.scaffoldCode;
                    editorValues[qIdx] = msg.scaffoldCode;
                } else {
                    codeEditor.value = editorValues[qIdx];
                }
            }

            // Save editor value on input
            codeEditor.oninput = () => { editorValues[qIdx] = codeEditor.value; };

            // Feedback
            feedbackSection.classList.remove('hidden');
            feedbackSection.innerHTML = '';
            if (currentState === 'EVALUATING') {
                feedbackSection.innerHTML = '<div class="glass-panel" style="display:flex;align-items:center;gap:10px;"><span class="spinner" style="color:var(--accent);"></span> Evaluating your fix...</div>';
            } else if (currentState === 'PASSED' && msg.result && !allDone) {
                // Passed this question but more to go
                const hasMore = qIdx < totalQ - 1;
                feedbackSection.innerHTML =
                    '<div class="feedback pass glass-panel">' +
                    '<strong style="font-size:1.1em;">✅ Question ' + (qIdx + 1) + ' Passed!</strong><br><br>' +
                    msg.result.feedback +
                    (hasMore ? '<br><br><em>Click "Next Question" to continue.</em>' : '') +
                    '</div>';
            } else if (currentState === 'FAILED' && msg.result) {
                feedbackSection.innerHTML =
                    '<div class="feedback fail glass-panel">' +
                    '<strong style="font-size:1.1em;">❌ Not quite right</strong><br><br>' +
                    msg.result.feedback +
                    (msg.hearts <= 0 ? '<br><br><strong>No hearts remaining. Try a different approach next time.</strong>' : '') +
                    '</div>';
                if (msg.hearts > 0) {
                    const retryBtn = document.createElement('button');
                    retryBtn.className = 'btn-primary';
                    retryBtn.textContent = 'Try Again';
                    retryBtn.style.marginTop = '12px';
                    retryBtn.addEventListener('click', () => {
                        editorValues[qIdx] = ''; // Reset editor for retry
                        vscode.postMessage({ type: 'RETRY' });
                    });
                    feedbackSection.appendChild(retryBtn);
                }
            } else if (currentState === 'ACTIVE' && msg.result && !msg.result.passed) {
                // Show previous feedback when retrying
                feedbackSection.innerHTML =
                    '<div class="feedback fail glass-panel">' +
                    '<strong>Previous attempt:</strong> ' + msg.result.feedback +
                    '</div>';
            } else {
                feedbackSection.classList.add('hidden');
            }

            // Actions visibility
            btnSubmit.classList.toggle('hidden', currentState !== 'ACTIVE');
            btnAbort.classList.toggle('hidden', currentState === 'PASSED' || currentState === 'ABORTED');
            
            // Next button — only show when this question passed and there are more
            const showNext = currentState === 'PASSED' && !allDone && qIdx < totalQ - 1;
            btnNext.classList.toggle('hidden', !showNext);

            if (currentState === 'EVALUATING') {
                btnSubmit.disabled = true;
                btnSubmit.innerHTML = '<span class="spinner" style="border-top-color:white;"></span> Evaluating...';
            } else {
                btnSubmit.disabled = false;
                btnSubmit.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg> Submit Fix';
            }
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
