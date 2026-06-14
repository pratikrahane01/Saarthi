import * as vscode from 'vscode';

export async function showAnalysisSummary(stats: { total: number, syntax: number, runtime: number, logic: number | string }): Promise<boolean> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'analysisSummary',
            'Zero-Magic: Analysis Complete',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: false }
        );

        panel.webview.html = getAnalysisHtml(stats);

        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'start') {
                resolve(true);
                panel.dispose();
            } else if (message.command === 'cancel') {
                resolve(false);
                panel.dispose();
            }
        });

        panel.onDidDispose(() => {
            resolve(false); // Default to cancel on close
        });
    });
}

export async function showCompletionSummary(stats: { syntax: number, runtime: number, logic: number }): Promise<'Analyze Again' | 'Close'> {
    return new Promise((resolve) => {
        const panel = vscode.window.createWebviewPanel(
            'completionSummary',
            'Zero-Magic: Mission Accomplished',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: false }
        );

        panel.webview.html = getCompletionHtml(stats);

        panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'analyze') {
                resolve('Analyze Again');
                panel.dispose();
            } else if (message.command === 'close') {
                resolve('Close');
                panel.dispose();
            }
        });

        panel.onDidDispose(() => {
            resolve('Close'); // Default to close
        });
    });
}

const commonStyles = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

    :root {
        --bg-color: #0f172a;
        --card-bg: rgba(30, 41, 59, 0.7);
        --card-border: rgba(255, 255, 255, 0.1);
        --text-main: #f8fafc;
        --text-muted: #94a3b8;
        
        --color-syntax: #38bdf8;
        --color-runtime: #fb923c;
        --color-logic: #c084fc;
        --color-success: #10b981;
    }

    body {
        margin: 0;
        padding: 0;
        min-height: 100vh;
        background-color: var(--bg-color);
        background-image: 
            radial-gradient(circle at 15% 50%, rgba(56, 189, 248, 0.08) 0%, transparent 50%),
            radial-gradient(circle at 85% 30%, rgba(192, 132, 252, 0.08) 0%, transparent 50%);
        font-family: 'Inter', sans-serif;
        color: var(--text-main);
        display: flex;
        justify-content: center;
        align-items: center;
    }

    .container {
        width: 100%;
        max-width: 560px;
        padding: 2rem;
        animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        opacity: 0;
        transform: translateY(20px);
    }

    @keyframes fadeUp {
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    .glass-card {
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 24px;
        padding: 3rem 2.5rem;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        text-align: center;
    }

    .icon-wrapper {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 2.5rem;
        margin: 0 auto 1.5rem;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 0 30px rgba(0, 0, 0, 0.2) inset;
    }

    h1 {
        font-size: 1.75rem;
        font-weight: 800;
        margin: 0 0 0.5rem;
        letter-spacing: -0.025em;
    }

    .subtitle {
        color: var(--text-muted);
        font-size: 1.125rem;
        margin: 0 0 2.5rem;
    }

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 1rem;
        margin-bottom: 2.5rem;
    }

    .stat-box {
        background: rgba(0, 0, 0, 0.2);
        border: 1px solid var(--card-border);
        border-radius: 16px;
        padding: 1.25rem 1rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .stat-box:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 20px -10px rgba(0, 0, 0, 0.5);
    }

    .stat-value {
        font-size: 2.5rem;
        font-weight: 700;
        line-height: 1;
        margin-bottom: 0.5rem;
    }

    .stat-label {
        font-size: 0.875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
    }

    /* Stat Box Variants */
    .stat-box.syntax .stat-value { color: var(--color-syntax); text-shadow: 0 0 20px rgba(56, 189, 248, 0.3); }
    .stat-box.runtime .stat-value { color: var(--color-runtime); text-shadow: 0 0 20px rgba(251, 146, 60, 0.3); }
    .stat-box.logic .stat-value { color: var(--color-logic); text-shadow: 0 0 20px rgba(192, 132, 252, 0.3); }
    .stat-box.success .stat-value { color: var(--color-success); text-shadow: 0 0 20px rgba(16, 185, 129, 0.3); }

    .actions {
        display: flex;
        gap: 1rem;
        justify-content: center;
        margin-top: 1rem;
    }

    button {
        font-family: inherit;
        font-size: 1rem;
        font-weight: 600;
        padding: 0.875rem 2rem;
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.2s ease;
        border: none;
    }

    .btn-primary {
        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
        color: white;
        box-shadow: 0 4px 14px 0 rgba(37, 99, 235, 0.39);
    }

    .btn-primary:hover {
        background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
        box-shadow: 0 6px 20px rgba(37, 99, 235, 0.23);
        transform: translateY(-1px);
    }

    .btn-secondary {
        background: rgba(255, 255, 255, 0.1);
        color: var(--text-main);
        border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .btn-secondary:hover {
        background: rgba(255, 255, 255, 0.15);
        transform: translateY(-1px);
    }
`;

function getAnalysisHtml(stats: { total: number, syntax: number, runtime: number, logic: number | string }): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Analysis Complete</title>
    <style>${commonStyles}</style>
</head>
<body>
    <div class="container">
        <div class="glass-card">
            <div class="icon-wrapper">
                🔍
            </div>
            <h1>Full File Analysis Complete</h1>
            <p class="subtitle">Total Bugs Found: <strong style="color: white; font-weight: 700;">${stats.total}</strong></p>
            
            <div class="stats-grid">
                <div class="stat-box syntax">
                    <div class="stat-value">${stats.syntax}</div>
                    <div class="stat-label">Syntax</div>
                </div>
                <div class="stat-box runtime">
                    <div class="stat-value">${stats.runtime}</div>
                    <div class="stat-label">Runtime</div>
                </div>
                <div class="stat-box logic">
                    <div class="stat-value">${stats.logic}</div>
                    <div class="stat-label">Logic</div>
                </div>
            </div>

            <p style="margin-bottom: 2rem; color: var(--text-muted); font-size: 1.125rem;">Ready to begin the fixing process?</p>

            <div class="actions">
                <button class="btn-secondary" onclick="postMessage('cancel')">Cancel</button>
                <button class="btn-primary" onclick="postMessage('start')">Start Fixing</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function postMessage(command) {
            vscode.postMessage({ command });
        }
    </script>
</body>
</html>`;
}

function getCompletionHtml(stats: { syntax: number, runtime: number, logic: number }): string {
    const totalFixed = stats.syntax + stats.runtime + stats.logic;
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Congratulations</title>
    <style>
        ${commonStyles}
        .icon-wrapper {
            background: rgba(16, 185, 129, 0.1);
            border-color: rgba(16, 185, 129, 0.2);
            box-shadow: 0 0 30px rgba(16, 185, 129, 0.2) inset;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="glass-card">
            <div class="icon-wrapper">
                🎉
            </div>
            <h1>Congratulations!</h1>
            <p class="subtitle">You successfully solved <strong>${totalFixed}</strong> bugs in this file.</p>
            
            <div class="stats-grid">
                <div class="stat-box success">
                    <div class="stat-value">${stats.syntax}</div>
                    <div class="stat-label">Syntax Fixed</div>
                </div>
                <div class="stat-box success">
                    <div class="stat-value">${stats.runtime}</div>
                    <div class="stat-label">Runtime Fixed</div>
                </div>
                <div class="stat-box success">
                    <div class="stat-value">${stats.logic}</div>
                    <div class="stat-label">Logic Fixed</div>
                </div>
            </div>

            <p style="margin-bottom: 2rem; color: var(--text-muted); font-size: 1.125rem;">Excellent work. Your code is now fully functioning.</p>

            <div class="actions">
                <button class="btn-secondary" onclick="postMessage('close')">Close</button>
                <button class="btn-primary" onclick="postMessage('analyze')">Analyze Again</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function postMessage(command) {
            vscode.postMessage({ command });
        }
    </script>
</body>
</html>`;
}
