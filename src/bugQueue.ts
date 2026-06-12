import * as vscode from 'vscode';
import { DiagnosticEvent } from './watcher';
import { matchErrorToMission, executeMissionHandOff } from './missions';
import { showTier1Popup } from './watcher';

export interface BugQueueState {
    isActive: boolean;
    bugs: DiagnosticEvent[];
    currentIndex: number;
    initialTotalBugs: number;
    solvedBugsCount: number;
    totalXP: number;
    hintsUsed: number;
    documentUri: vscode.Uri | null;
    skippedBugs: Set<string>;
}

let queueState: BugQueueState = {
    isActive: false,
    bugs: [],
    currentIndex: 0,
    initialTotalBugs: 0,
    solvedBugsCount: 0,
    totalXP: 0,
    hintsUsed: 0,
    documentUri: null,
    skippedBugs: new Set()
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

export async function startBugQueue(editor: vscode.TextEditor) {
    const document = editor.document;
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    
    // 1. Collect all errors
    let errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    if (errors.length === 0) {
        vscode.window.showInformationMessage("Zero-Magic: No errors found in the current file!");
        return;
    }

    // 2. Deduplicate
    errors = deduplicateDiagnostics(errors);

    // 3. Sort diagnostics: Tier 1 first, then by line number
    const TIER_1_KEYWORDS = [
        'syntax', 'indentation', 'token', 'colon', 'quote', 'bracket', 'parenthesis',
        'unexpected EOF', 'expected', 'invalid syntax'
    ];
    const isTier1 = (msg: string) => TIER_1_KEYWORDS.some(k => msg.toLowerCase().includes(k));

    errors.sort((a, b) => {
        const aIsTier1 = isTier1(a.message) ? 0 : 1;
        const bIsTier1 = isTier1(b.message) ? 0 : 1;
        if (aIsTier1 !== bIsTier1) return aIsTier1 - bIsTier1;
        return a.range.start.line - b.range.start.line;
    });

    // 4. Create a bug queue
    const queue: DiagnosticEvent[] = errors.map(err => ({
        filePath: document.uri.fsPath,
        languageId: document.languageId,
        errorMessage: err.message,
        lineText: document.lineAt(err.range.start.line).text,
        lineNumber: err.range.start.line
    }));

    queueState = {
        isActive: true,
        bugs: queue,
        currentIndex: 0,
        initialTotalBugs: queue.length,
        solvedBugsCount: 0,
        totalXP: 0,
        hintsUsed: 0,
        documentUri: document.uri,
        skippedBugs: new Set()
    };

    // 4. Trigger processing of the first bug
    await processCurrentBug();
}

export async function processCurrentBug() {
    if (!queueState.isActive || queueState.bugs.length === 0) {
        await finishBugQueue();
        return;
    }

    const currentBug = queueState.bugs[0];
    
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Zero-Magic: Analyzing Bug ${queueState.initialTotalBugs - queueState.bugs.length + 1}/${queueState.initialTotalBugs}`,
        cancellable: false
    }, async () => {
        // matchErrorToMission handles Tier 1, 2, 3 classification natively
        const mission = await matchErrorToMission(currentBug);
        
        if (mission) {
            if (mission.tier === 1) {
                // Tier 1: Open Inline Fix Coach only
                await showTier1Popup(mission, 0);
            } else {
                // Tier 2/3: Open Dashboard
                await executeMissionHandOff(mission);
            }
        } else {
            // Failed to match, try skipping
            vscode.window.showInformationMessage("Failed to match this bug. Moving to next.");
            await advanceBugQueue(0, 0, currentBug.errorMessage);
        }
    });
}

export async function advanceBugQueue(xpEarned: number, hintsUsed: number, skippedMessage?: string) {
    if (!queueState.isActive || !queueState.documentUri) return;

    queueState.totalXP += xpEarned;
    queueState.hintsUsed += hintsUsed;
    if (!skippedMessage && xpEarned > 0) {
        queueState.solvedBugsCount++;
    }
    if (skippedMessage) {
        queueState.skippedBugs.add(skippedMessage);
    }

    const diagnostics = vscode.languages.getDiagnostics(queueState.documentUri);
    let rawErrors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    rawErrors = rawErrors.filter(e => !queueState.skippedBugs.has(e.message));

    let errors = deduplicateDiagnostics(rawErrors);

    const TIER_1_KEYWORDS = [
        'syntax', 'indentation', 'token', 'colon', 'quote', 'bracket', 'parenthesis',
        'unexpected EOF', 'expected', 'invalid syntax'
    ];
    const isTier1 = (msg: string) => TIER_1_KEYWORDS.some(k => msg.toLowerCase().includes(k));

    errors.sort((a, b) => {
        const aIsTier1 = isTier1(a.message) ? 0 : 1;
        const bIsTier1 = isTier1(b.message) ? 0 : 1;
        if (aIsTier1 !== bIsTier1) return aIsTier1 - bIsTier1;
        return a.range.start.line - b.range.start.line;
    });

    try {
        const document = await vscode.workspace.openTextDocument(queueState.documentUri);
        queueState.bugs = errors.map(err => ({
            filePath: document.uri.fsPath,
            languageId: document.languageId,
            errorMessage: err.message,
            lineText: document.lineAt(err.range.start.line).text,
            lineNumber: err.range.start.line
        }));
    } catch (e) {
        console.error("Failed to read document in advanceBugQueue");
        queueState.bugs = [];
    }

    queueState.currentIndex = 0;

    if (queueState.bugs.length > 0) {
        await processCurrentBug();
    } else {
        await finishBugQueue();
    }
}

export async function abortBugQueue() {
    queueState.isActive = false;
    queueState.bugs = [];
}

async function finishBugQueue() {
    queueState.isActive = false;
    vscode.commands.executeCommand('zeroMagic.renderSocraticDashboard', 'MISSION_COMPLETE', {
        totalXP: queueState.totalXP,
        totalBugs: queueState.initialTotalBugs,
        hintsUsed: queueState.hintsUsed
    });
}
