import * as vscode from 'vscode';
import { Mission } from '../missions';

export class SocraticDashboardPanel {
    public static currentPanel: SocraticDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(mission: Mission) {
        const column = vscode.ViewColumn.Beside;

        if (SocraticDashboardPanel.currentPanel) {
            SocraticDashboardPanel.currentPanel._panel.reveal(column);
            SocraticDashboardPanel.currentPanel.update(mission);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'socraticDashboard',
            'Zero-Magic Dashboard',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        SocraticDashboardPanel.currentPanel = new SocraticDashboardPanel(panel, mission);
    }

    private constructor(panel: vscode.WebviewPanel, mission: Mission) {
        this._panel = panel;
        this.update(mission);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public update(mission: Mission) {
        this._panel.webview.html = this._getHtmlForWebview(mission);
    }

    public postMessage(message: any) {
        this._panel.webview.postMessage(message);
    }

    public dispose() {
        SocraticDashboardPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getHtmlForWebview(mission: Mission): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zero-Magic Dashboard</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Fira+Code&display=swap');

        body {
            background-color: #0f172a;
            color: #f8fafc;
            font-family: 'Inter', sans-serif;
            margin: 0;
            padding: 24px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .container {
            max-width: 600px;
            width: 100%;
            animation: fadeUp 0.6s ease-out;
        }

        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .header {
            text-align: center;
            margin-bottom: 32px;
        }

        h1 {
            font-size: 2rem;
            font-weight: 800;
            margin: 0;
            background: linear-gradient(to right, #38bdf8, #818cf8);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: 0 0 20px rgba(56, 189, 248, 0.3);
        }

        .badge {
            display: inline-block;
            background: rgba(56, 189, 248, 0.1);
            color: #38bdf8;
            padding: 4px 12px;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 600;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            margin-top: 8px;
            border: 1px solid rgba(56, 189, 248, 0.2);
        }

        .card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            padding: 24px;
            margin-bottom: 24px;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1);
        }

        .card-title {
            font-size: 0.875rem;
            font-weight: 600;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .card-title::before {
            content: '';
            display: block;
            width: 8px;
            height: 8px;
            background: #38bdf8;
            border-radius: 50%;
            box-shadow: 0 0 10px #38bdf8;
        }

        .description {
            font-size: 1rem;
            line-height: 1.6;
            color: #cbd5e1;
            margin: 0;
        }

        .question-card {
            background: rgba(16, 185, 129, 0.05);
            border: 1px solid rgba(16, 185, 129, 0.2);
        }

        .question-card .card-title::before {
            background: #10b981;
            box-shadow: 0 0 10px #10b981;
        }

        .question {
            font-size: 1.125rem;
            font-weight: 600;
            color: #f8fafc;
            line-height: 1.5;
            margin: 0;
        }

        .status-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-top: 16px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            margin-top: 24px;
            font-size: 0.875rem;
            color: #64748b;
        }

        .status-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            background: #f59e0b;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4); }
            70% { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0); }
            100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
        }
        
        code {
            font-family: 'Fira Code', monospace;
            background: rgba(0, 0, 0, 0.3);
            padding: 2px 6px;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Zero-Magic</h1>
            <div class="badge">Socratic Mode Active</div>
        </div>

        <div class="card">
            <div class="card-title">Mission Context</div>
            <p class="description">${mission.description}</p>
        </div>

        <div class="card question-card">
            <div class="card-title">The Challenge</div>
            <p class="question">${mission.socraticQuestion}</p>
        </div>
        
        <div class="status-bar">
            <div>
                <span class="status-dot"></span>
                Awaiting test execution...
            </div>
            <div>
                Target: <code>${mission.language}</code>
            </div>
        </div>
    </div>
    <script>
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'UNLOCK') {
                const dot = document.querySelector('.status-dot');
                if (dot) {
                    dot.style.background = '#10b981';
                    dot.style.animation = 'none';
                    dot.style.boxShadow = '0 0 10px #10b981';
                }
                const statusBarFirstChild = document.querySelector('.status-bar div:first-child');
                if (statusBarFirstChild) {
                    statusBarFirstChild.innerHTML = '<span class="status-dot" style="background:#10b981; animation:none; box-shadow:0 0 10px #10b981;"></span> ✓ Milestone unlocked. Well done.';
                    statusBarFirstChild.style.color = '#10b981';
                    statusBarFirstChild.style.fontWeight = '600';
                }
            }
        });
    </script>
</body>
</html>`;
    }
}
