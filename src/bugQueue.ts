import * as vscode from 'vscode';
import { Mission, matchErrorToMission } from './missions';
import { showInlineFixCoach } from './watcher';

export interface UnifiedFinding {
    source: string;
    category: string;
    confidence: number;
    severity: string;
    lineNumber: number;
    concept: string;
    socraticQuestion: string;
    hints: string[];
    solutionBefore?: string;
    solutionAfter?: string;
    solutionExplanation?: string;
}

export interface BugQueueState {
    isActive: boolean;
    bugs: Mission[];
    currentIndex: number;
    totalBugs: number;
    totalBugsFrozen: boolean;
    solvedBugsCount: number;
    totalXP: number;
    hintsUsed: number;
    documentUri: vscode.Uri | null;
    skippedBugs: Set<string>;
    stats: { syntax: number, runtime: number, logic: number | string };
    fixedStats: { syntax: number, runtime: number, logic: number };
}

let queueState: BugQueueState = {
    isActive: false,
    bugs: [],
    currentIndex: 0,
    totalBugs: 0,
    totalBugsFrozen: false,
    solvedBugsCount: 0,
    totalXP: 0,
    hintsUsed: 0,
    documentUri: null,
    skippedBugs: new Set(),
    stats: { syntax: 0, runtime: 0, logic: 0 },
    fixedStats: { syntax: 0, runtime: 0, logic: 0 }
};

export function getQueueState(): BugQueueState {
    return queueState;
}

export function deduplicateDiagnostics(errors: vscode.Diagnostic[]): vscode.Diagnostic[] {
    const deduplicated: vscode.Diagnostic[] = [];
    const seenLines = new Set<number>();
    const seenMessages = new Set<string>();

    for (const err of errors) {
        const line = err.range.start.line;
        const msg = err.message;
        
        if (seenLines.has(line)) continue;
        if (seenMessages.has(msg)) continue;

        seenLines.add(line);
        seenMessages.add(msg);
        deduplicated.push(err);
    }
    return deduplicated;
}

export async function analyzeAllAPI(
    document: vscode.TextDocument,
    diagnostics: vscode.Diagnostic[]
): Promise<UnifiedFinding[]> {
    const url = 'http://127.0.0.1:8000/v1/missions/analyze-all';
    
    const diagInputs = diagnostics.map(d => ({
        lineNumber: d.range.start.line + 1,
        message: d.message,
        errorCode: (d.code as any)?.value || (d.code as string) || "Unknown",
        severity: d.severity === vscode.DiagnosticSeverity.Error ? "Error" : "Warning"
    }));

    const payload = {
        language: document.languageId,
        fullCode: document.getText(),
        diagnostics: diagInputs
    };
    
    console.log(`[AUDIT] Payload sent into analyzeAllAPI(): ${JSON.stringify(payload).substring(0, 500)}...`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            const rawResponseText = await response.text();
            console.log(`[AUDIT] Backend raw response before mapping: ${rawResponseText.substring(0, 500)}...`);
            const data = JSON.parse(rawResponseText) as { missions: UnifiedFinding[] };
            return data.missions || [];
        } else {
            console.log(`[AUDIT] Backend responded with non-OK status: ${response.status}`);
        }
    } catch (e) {
        console.error("Failed to call analyze-all", e);
    }
    return [];
}

export function mapUnifiedToMission(uf: UnifiedFinding, document: vscode.TextDocument): Mission {
    return {
        id: `uf_${uf.source}_${uf.lineNumber}_${Date.now()}`,
        title: uf.source === 'diagnostic' ? `Syntax Mastery` : `Logic & Reasoning Check`,
        language: document.languageId,
        description: uf.concept,
        socraticQuestion: uf.socraticQuestion,
        hints: uf.hints || [],
        testPayload: `def test_placeholder():\n    assert True, 'Logic tests passed'`,
        targetFilename: document.uri.fsPath,
        targetUri: document.uri.toString(),
        originalErrorCode: uf.source === 'diagnostic' ? "SyntaxError" : "LogicBug",
        originalMessage: uf.concept,
        tier: uf.severity === 'Tier 1' ? 1 : (uf.severity === 'Tier 3' ? 3 : 2),
        errorLineNumber: uf.lineNumber,
        validationMode: uf.source === 'diagnostic' ? 'diagnostic' : 'logic',
        solutionBefore: uf.solutionBefore,
        solutionAfter: uf.solutionAfter,
        solutionExplanation: uf.solutionExplanation
    };
}

export async function startBugQueue(editor: vscode.TextEditor) {
    const document = editor.document;
    
    // TEMPORARY LOGGING FOR AUDIT
    const activeUri = document.uri;
    let logStr = `Active editor URI: ${activeUri.toString()}\nActive editor fsPath: ${activeUri.fsPath}\n\n`;

    const allDiagnostics = vscode.languages.getDiagnostics();
    let exactMatchExists = false;
    let pathCasingDiffers = false;
    let mismatchUriStr = '';

    for (const [uri, diags] of allDiagnostics) {
        if (diags.length === 0) continue;
        logStr += `Diagnostic URI: ${uri.toString()}\n`;
        logStr += `Diagnostic fsPath: ${uri.fsPath}\n`;
        logStr += `Diagnostics length: ${diags.length}\n\n`;

        if (uri.toString() === activeUri.toString()) {
            exactMatchExists = true;
        } else if (uri.fsPath.toLowerCase() === activeUri.fsPath.toLowerCase()) {
            pathCasingDiffers = true;
            mismatchUriStr = uri.toString();
        }
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const isOutsideWorkspace = !workspaceFolders?.some(f => activeUri.fsPath.toLowerCase().startsWith(f.uri.fsPath.toLowerCase()));

    logStr += `Exact match exists: ${exactMatchExists}\n`;
    logStr += `Path casing differs: ${pathCasingDiffers}\n`;
    logStr += `Outside current workspace: ${isOutsideWorkspace}\n`;

    if (!exactMatchExists && pathCasingDiffers) {
        logStr += `\nExact URI mismatch causing failure:\nExpected (Active): ${activeUri.toString()}\nFound (Diagnostics): ${mismatchUriStr}\n`;
    }
    let diagnostics: vscode.Diagnostic[] = [];
    let localMissions: Mission[] = [];
    let backendFailureDetected = false;
    
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Zero-Magic",
        cancellable: false
    }, async (progress) => {
        progress.report({ message: "Analyzing File..." });

        // Diagnostics Retry Window to handle asynchronous language servers (e.g., Pylance)
        for (let attempt = 1; attempt <= 4; attempt++) {
            diagnostics = [];
            for (const [uri, diags] of vscode.languages.getDiagnostics()) {
                if (uri.fsPath.toLowerCase() === document.uri.fsPath.toLowerCase()) {
                    diagnostics.push(...diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error));
                }
            }
            
            if (diagnostics.length > 0) {
                break;
            }
            
            if (attempt < 4) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        console.log(`Diagnostics found after ${diagnostics.length > 0 ? 'stabilization' : 'max attempts'}:`, diagnostics.length);

        if (diagnostics.length > 0) {
            // Deduplicate diagnostics by line number + message
            const uniqueDiags = new Map<string, vscode.Diagnostic>();
            for (const d of diagnostics) {
                const key = `${d.range.start.line}:${d.message}`;
                if (!uniqueDiags.has(key)) {
                    uniqueDiags.set(key, d);
                }
            }
            diagnostics = Array.from(uniqueDiags.values());

            // Reuse exact same mission generation pipeline used by the Lightbulb flow
            const promises = diagnostics.map(d => matchErrorToMission({
                filePath: document.uri.fsPath,
                languageId: document.languageId,
                errorMessage: d.message,
                lineText: document.lineAt(d.range.start.line).text,
                lineNumber: d.range.start.line
            }));
            
            try {
                const results = await Promise.all(promises);
                localMissions = results.filter((m): m is Mission => m !== null);
                
                // Filter out skipped bugs
                localMissions = localMissions.filter(m => m.tier === 1 || !queueState.skippedBugs.has(m.description));
            } catch (err: any) {
                if (err.message === "BACKEND_UNREACHABLE") {
                    vscode.window.showErrorMessage("Backend Unavailable: Please ensure the Zero-Magic server is running.");
                    backendFailureDetected = true;
                    return;
                }
                console.error("Error generating missions:", err);
            }
        }
        console.log(`[AUDIT] diagnostics.length: ${diagnostics.length}`);
        console.log(`[AUDIT] localMissions.length: ${localMissions.length}`);
    });

    if (backendFailureDetected) {
        queueState.isActive = false;
        return;
    }

    // Count Tiers
    let syntaxCount = localMissions.filter(m => m.tier === 1).length;
    let runtimeCount = localMissions.filter(m => m.tier !== 1).length;

    // Build initial immutable queue
    localMissions.sort((a, b) => (a.tier || 3) - (b.tier || 3) || (a.errorLineNumber || 0) - (b.errorLineNumber || 0));
    queueState.bugs = localMissions;
    queueState.currentIndex = 0;
    queueState.totalBugs = localMissions.length;
    queueState.totalBugsFrozen = false;
    queueState.solvedBugsCount = 0;
    queueState.totalXP = 0;
    queueState.hintsUsed = 0;
    queueState.stats = { syntax: syntaxCount, runtime: runtimeCount, logic: 'Scanning...' };
    queueState.fixedStats = { syntax: 0, runtime: 0, logic: 0 };
    queueState.isActive = true;
    queueState.documentUri = document.uri;

    console.log("[AUDIT] queueState.isActive", queueState.isActive);
    console.log("[AUDIT] queueState.bugs.length", queueState.bugs.length);
    console.log("[AUDIT] summary popup reached");
    // Show Summary Popup
    const action = await vscode.window.showInformationMessage(
        `🔍 FULL FILE ANALYSIS COMPLETE\n\nTotal Bugs Found: ${queueState.totalBugs}\n\nSyntax: ${queueState.stats.syntax}\nRuntime: ${queueState.stats.runtime}\nLogic: ${queueState.stats.logic}\n\nReady to begin?`,
        { modal: true },
        "Start Fixing"
    );
    
    if (action !== "Start Fixing") {
        queueState.isActive = false;
        return;
    }

    processCurrentBug();

    // Run backend asynchronously
    analyzeAllAPI(document, diagnostics).then(backendFindings => {
        if (!queueState.isActive) return;

        let newFindings = backendFindings ? backendFindings.filter(f => f.severity === 'Tier 1' || !queueState.skippedBugs.has(f.concept)) : [];
        const logicFindings = newFindings.filter(f => f.severity === 'Tier 3');
        queueState.stats.logic = logicFindings.length; // update stats
        
        const existingConcepts = new Set(queueState.bugs.map(b => b.description));
        const uniqueNew = newFindings.filter(f => !existingConcepts.has(f.concept));
        
        if (uniqueNew.length > 0) {
            queueState.bugs.push(...uniqueNew.map(f => mapUnifiedToMission(f, document)));
        }

        if (!queueState.totalBugsFrozen) {
            queueState.totalBugs = queueState.bugs.length;
            queueState.totalBugsFrozen = true;
            queueState.stats.syntax = queueState.bugs.filter(m => m.tier === 1).length;
            queueState.stats.runtime = queueState.bugs.filter(m => m.tier === 2).length;
            
            // Refresh active coach popup UI so it reflects the new totalBugs
            vscode.commands.executeCommand('zeroMagic.inlineCoach.refreshUI');
        }
    }).catch(e => {
        console.error("Backend analysis failed in background", e);
        if (!queueState.totalBugsFrozen) {
            queueState.totalBugsFrozen = true;
            queueState.stats.logic = 0;
            vscode.commands.executeCommand('zeroMagic.inlineCoach.refreshUI');
        }
    });
}

export async function processCurrentBug() {
    console.log("[AUDIT] processCurrentBug reached");
    if (!queueState.isActive) {
        return;
    }

    if (queueState.currentIndex >= queueState.bugs.length) {
        // Show completion modal
        const action = await vscode.window.showInformationMessage(
            `🎉 CONGRATULATIONS!\n\nYou solved all bugs in this file.\n\nSummary:\nSyntax Bugs Fixed: ${queueState.fixedStats.syntax}\nRuntime Bugs Fixed: ${queueState.fixedStats.runtime}\nLogic Bugs Fixed: ${queueState.fixedStats.logic}\n\nExcellent work.`,
            { modal: true },
            "Analyze Again",
            "Close"
        );
        if (action === "Analyze Again") {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await startBugQueue(editor);
            }
        } else {
            queueState.isActive = false;
        }
        return;
    }

    const mission = queueState.bugs[queueState.currentIndex];
    
    if (mission.tier === 3) {
        // Tier 3: Open Sandbox (isolated controller — dynamic import to avoid T1/T2 bundle impact)
        const { SandboxController } = await import('./tier3/sandboxController.js');
        SandboxController.start(mission);
        return;
    }

    // Tier 1, 2, or offline fallback (undefined): Open Inline Fix Coach
    await showInlineFixCoach(mission, 0);
    return;
}

export async function advanceBugQueue(xpEarned: number, hintsUsed: number, skippedMessage?: string) {
    if (!queueState.isActive || !queueState.documentUri) return;

    queueState.totalXP += xpEarned;
    queueState.hintsUsed += hintsUsed;

    const currentBug = queueState.bugs[queueState.currentIndex];

    if (!skippedMessage && xpEarned > 0) {
        queueState.solvedBugsCount++;
        if (currentBug) {
            if (currentBug.tier === 1) queueState.fixedStats.syntax++;
            else if (currentBug.tier === 2) queueState.fixedStats.runtime++;
            else queueState.fixedStats.logic++;
        }
    }
    
    // If we are skipping, add the concept to skipped list so the AST/LLM doesn't just re-serve it
    if (skippedMessage) {
        // Find current mission to skip its concept
        if (currentBug) {
            queueState.skippedBugs.add(currentBug.description);
        }
    }

    try {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.toString() === queueState.documentUri.toString()) {
            // Re-scan diagnostics
            const activeDiags = vscode.languages.getDiagnostics(queueState.documentUri);
            const activeDiagMessages = new Set(activeDiags.map(d => d.message));
            
            queueState.currentIndex++;

            // Skip any dependent Tier 1 findings that were auto-resolved by the user's fix
            while (queueState.currentIndex < queueState.bugs.length) {
                const nextBug = queueState.bugs[queueState.currentIndex];
                if (nextBug.tier === 1 && !activeDiagMessages.has(nextBug.originalMessage)) {
                    queueState.currentIndex++;
                } else {
                    break;
                }
            }

            console.log(`[AUDIT] queueState.bugs.length: ${queueState.bugs.length}`);
            console.log(`[AUDIT] queueState.initialTotalBugs: ${queueState.totalBugs}`);
            console.log(`[AUDIT] queueState.currentIndex: ${queueState.currentIndex}`);

            await processCurrentBug();
        } else {
            queueState.isActive = false;
        }
    } catch (e) {
        console.error("Failed to advance bug queue", e);
        await finishBugQueue();
    }
}

export async function abortBugQueue() {
    queueState.isActive = false;
    queueState.bugs = [];
}

async function finishBugQueue() {
    queueState.isActive = false;
    
    // Dashboard Activation Rule: Dashboard may only activate when mission.tier === 3
    const hasTier3 = queueState.bugs.some(b => b.tier === 3);
    if (hasTier3) {
        vscode.commands.executeCommand('zeroMagic.renderSocraticDashboard', 'MISSION_COMPLETE', {
            totalXP: queueState.totalXP,
            totalBugs: queueState.totalBugs,
            hintsUsed: queueState.hintsUsed
        });
    }
}
