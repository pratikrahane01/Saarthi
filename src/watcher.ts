import * as vscode from 'vscode';
import { matchErrorToMission, executeMissionHandOff, Mission } from './missions';
import { getQueueState, startBugQueue, advanceBugQueue } from './bugQueue';
import { awardXP } from './xpEngine';
import { globalContext } from './extension';

// Define the strict contract we agreed upon for Teammate 2
export interface DiagnosticEvent {
    filePath: string;
    languageId: string;
    errorMessage: string;
    lineText: string;
    lineNumber: number;
}

// Global debounce map to prevent concurrent error spamming (Phase 8 preparation)
const debounceMap = new Map<string, NodeJS.Timeout>();

export const inlineCoachController = vscode.comments.createCommentController('zeroMagic.fixCoach', '💡 FIX COACH');

export let activeCoach: { thread: vscode.CommentThread, mission: Mission, hintIndex: number, solutionVisible: boolean } | null = null;

export function activateWatcher(context: vscode.ExtensionContext) {
    console.log('Zero-Magic: Watcher Module Activated.');

    // 1. The Watcher: Listen to real-time compiler/linter diagnostics
    const diagnosticListener = vscode.languages.onDidChangeDiagnostics((e: vscode.DiagnosticChangeEvent) => {
        e.uris.forEach(uri => processDiagnostics(uri));
    });

    // 2. The Injector: Register the Quick Fix Provider for all programming languages
    const codeActionProvider = vscode.languages.registerCodeActionsProvider(
        { scheme: 'file' }, // Applies to all local files
        new ZeroMagicActionProvider(),
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    );

    let isMissionLoading = false;

    // 3. The Command Hook: What happens when the user clicks the Quick Fix
    const commandHandler = vscode.commands.registerCommand(
        'zeroMagic.triggerSocraticHelp', 
        async (event: DiagnosticEvent) => {
            if (isMissionLoading) {
                console.log('Zero-Magic: Ignored duplicate mission request.');
                return;
            }

            isMissionLoading = true;
            let matchedMission: Mission | null = null;
            try {
                // Show immediate visual confirmation to the user
                matchedMission = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Zero-Magic Engine",
                    cancellable: false
                }, async (progress) => {
                    progress.report({ message: "Analyzing error context..." });
                    
                    // Invoke your Phase 2 matching module
                    return await matchErrorToMission(event);
                });
            } finally {
                isMissionLoading = false;
            }

            if (matchedMission) {
                if (matchedMission.tier === 1 || matchedMission.tier === 2) {
                    await showInlineFixCoach(matchedMission, 0);
                } else {
                    await executeMissionHandOff(matchedMission);
                }
            } else {
                vscode.window.showInformationMessage("No guided lesson available for this specific error. Keep debugging!");
            }
        }
    );

    // 4. The Whole File Analysis Hook: What happens when the user presses Ctrl+Alt+Z
    const analyzeWholeFileHandler = vscode.commands.registerCommand(
        'zeroMagic.analyzeWholeFile',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showInformationMessage("No active editor found to analyze.");
                return;
            }
            
            // Start the Bug Queue via bugQueue manager
            await startBugQueue(editor);
        }
    );

    // 5. Register Inline Coach Commands
    const cmdHint = vscode.commands.registerCommand('zeroMagic.inlineCoach.hint', () => {
        if (activeCoach) {
            const maxHints = Math.min(activeCoach.mission.hints?.length || 0, 3);
            if (activeCoach.hintIndex < maxHints) {
                activeCoach.hintIndex++;
                updateCoachComment();
            }
        }
    });

    const cmdClose = vscode.commands.registerCommand('zeroMagic.inlineCoach.close', () => {
        if (activeCoach) {
            activeCoach.thread.dispose();
            activeCoach = null;
        }
    });

    // `cmdDashboard` was intentionally removed to isolate Tier 1 popups.

    const cmdSubmit = vscode.commands.registerCommand('zeroMagic.inlineCoach.submit', async () => {
        if (!activeCoach) return;
        const mission = activeCoach.mission;
        const targetUri = vscode.Uri.parse(mission.targetUri);
        
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await doc.save();

        let originalErrorResolved = false;
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Validating Fix...",
            cancellable: false
        }, async () => {
            for (let attempt = 1; attempt <= 6; attempt++) {
                let diagnostics: vscode.Diagnostic[] = [];
                for (const [uri, diags] of vscode.languages.getDiagnostics()) {
                    if (uri.fsPath.toLowerCase() === targetUri.fsPath.toLowerCase()) {
                        diagnostics.push(...diags);
                    }
                }
                
                originalErrorResolved = !diagnostics.some(d => d.message === mission.originalMessage);
                
                if (originalErrorResolved) {
                    break;
                }
                
                if (attempt < 6) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        });

        if (originalErrorResolved) {
            await awardXP(globalContext, 'Tier 1 Fix', 50);
            vscode.window.showInformationMessage("Great job! Error resolved. +50 XP");
            const usedHints = activeCoach.hintIndex;
            activeCoach.thread.dispose();
            activeCoach = null;

            // Advance the bug queue if active
            if (getQueueState().isActive) {
                await advanceBugQueue(50, usedHints);
            }
        } else {
            console.log(`[AUDIT] inline submit failed: keeping in popup flow`);
            vscode.window.showWarningMessage("❌ This bug still exists. Keep trying.");
            // Do not dispose activeCoach. Allow the user to keep trying.
        }
    });

    const cmdRefreshUI = vscode.commands.registerCommand('zeroMagic.inlineCoach.refreshUI', () => {
        updateCoachComment();
    });

    const cmdShowSolution = vscode.commands.registerCommand('zeroMagic.inlineCoach.showSolution', () => {
        if (activeCoach) {
            activeCoach.solutionVisible = true;
            updateCoachComment();
        }
    });

    context.subscriptions.push(
        diagnosticListener, 
        codeActionProvider, 
        commandHandler, 
        analyzeWholeFileHandler, 
        inlineCoachController, 
        cmdHint, 
        cmdClose, 
        cmdSubmit, 
        cmdRefreshUI,
        cmdShowSolution
    );
}

export async function showInlineFixCoach(mission: Mission, hintIndex: number = 0) {
    if (hintIndex === 0) {
        console.log(`[AUDIT] inline coach creation: message=${mission.originalMessage}, code=${mission.originalErrorCode}, line=${mission.errorLineNumber}`);
    }

    if (activeCoach) {
        activeCoach.thread.dispose();
        activeCoach = null;
    }

    const targetUri = vscode.Uri.parse(mission.targetUri);
    const line = Math.max(0, (mission.errorLineNumber ?? 1) - 1);
    const range = new vscode.Range(line, 0, line, 0);

    const thread = inlineCoachController.createCommentThread(targetUri, range, []);
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

    activeCoach = { thread, mission, hintIndex, solutionVisible: false };
    updateCoachComment();
}

export function updateCoachComment() {
    if (!activeCoach) return;
    const { thread, mission, hintIndex, solutionVisible } = activeCoach;
    
    const question = mission.socraticQuestion || mission.description;
    const hints = mission.hints || [];
    const maxHints = Math.min(hints.length, 3);

    let md = new vscode.MarkdownString();
    md.isTrusted = { 
        enabledCommands: [
            'zeroMagic.inlineCoach.hint', 
            'zeroMagic.inlineCoach.showSolution', 
            'zeroMagic.inlineCoach.submit', 
            'zeroMagic.inlineCoach.close'
        ] 
    };
    
    md.appendMarkdown(`**🤔 Question:** ${question}\n\n`);
    
    if (hintIndex > 0) {
        for (let i = 0; i < hintIndex; i++) {
            md.appendMarkdown(`**💡 Hint ${i + 1}:** ${hints[i]}\n\n`);
        }
    } else {
        md.appendMarkdown(`*Inspect the line carefully. Click 💡 for a hint or Submit when fixed.*\n\n`);
    }

    if (solutionVisible && mission.solutionBefore && mission.solutionAfter && mission.solutionExplanation) {
        md.appendMarkdown(`────────────────────\n\n`);
        md.appendMarkdown(`📖 **Solution**\n\n`);
        md.appendMarkdown(`**Before:**\n\n`);
        md.appendMarkdown(`\`\`\`${mission.language}\n${mission.solutionBefore}\n\`\`\`\n\n`);
        md.appendMarkdown(`**After:**\n\n`);
        md.appendMarkdown(`\`\`\`${mission.language}\n${mission.solutionAfter}\n\`\`\`\n\n`);
        md.appendMarkdown(`────────────────────\n\n`);
        md.appendMarkdown(`🧠 **Why This Works**\n\n`);
        md.appendMarkdown(`${mission.solutionExplanation}\n\n`);
        md.appendMarkdown(`────────────────────\n\n`);
    } else if (hintIndex >= maxHints && !solutionVisible && mission.solutionBefore) {
        md.appendMarkdown(`[Show Solution](command:zeroMagic.inlineCoach.showSolution)\n\n`);
        md.appendMarkdown(`---\n\n`);
    } else {
        md.appendMarkdown(`---\n\n`);
    }
    
    const hintBtn = hintIndex < maxHints ? `[💡 (${hintIndex}/3)](command:zeroMagic.inlineCoach.hint)` : `💡 (3/3)`;
    md.appendMarkdown(`${hintBtn} \\| [Submit](command:zeroMagic.inlineCoach.submit) \\| [Close](command:zeroMagic.inlineCoach.close)`);

    let authorName = '💡 FIX COACH';
    const qState = getQueueState();
    if (qState.isActive) {
        authorName = `💡 FIX COACH (Bug ${qState.currentIndex + 1} of ${qState.totalBugs})`;
    }

    const comment: vscode.Comment = {
        author: { name: authorName },
        body: md,
        mode: vscode.CommentMode.Preview
    };

    thread.comments = [comment];
}

// --- Internal Logic ---

async function processDiagnostics(uri: vscode.Uri) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    
    // Filter strictly for hard errors, ignore warnings/hints
    const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    if (errors.length === 0) return;

    // Debounce logic: Prevent multiple triggers if a user saves a file with 10 errors
    const uriString = uri.toString();
    if (debounceMap.has(uriString)) {
        clearTimeout(debounceMap.get(uriString)!);
    }

    debounceMap.set(uriString, setTimeout(async () => {
        // Just grab the first primary error to avoid overwhelming the student
        const primaryError = errors[0];
        
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const lineWithContents = document.lineAt(primaryError.range.start.line).text;

            const eventPayload: DiagnosticEvent = {
                filePath: uri.fsPath,
                languageId: document.languageId,
                errorMessage: primaryError.message,
                lineText: lineWithContents,
                lineNumber: primaryError.range.start.line
            };

            // Quietly log the capture; the UI interaction happens via the CodeActionProvider
            console.log('Zero-Magic caught an error:', eventPayload);
            
        } catch (err) {
            console.error("Zero-Magic Failed to read document context:", err);
        }
    }, 1500)); // 1.5 second debounce window
}

// The native VS Code Lightbulb Provider
class ZeroMagicActionProvider implements vscode.CodeActionProvider {
    public provideCodeActions(
        document: vscode.TextDocument, 
        _range: vscode.Range | vscode.Selection, 
        context: vscode.CodeActionContext, 
        _token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        
        // Only provide the button if there are actual errors on this line
        const errors = context.diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        if (errors.length === 0) return [];

        const primaryError = errors[0];
        const lineText = document.lineAt(primaryError.range.start.line).text;

        const eventPayload: DiagnosticEvent = {
            filePath: document.uri.fsPath,
            languageId: document.languageId,
            errorMessage: primaryError.message,
            lineText: lineText,
            lineNumber: primaryError.range.start.line
        };

        // Create the native "Quick Fix" action
        const action = new vscode.CodeAction('💡 Help me think (Zero-Magic)', vscode.CodeActionKind.QuickFix);
        
        // Bind the payload to our custom command
        action.command = {
            command: 'zeroMagic.triggerSocraticHelp',
            title: 'Trigger Socratic Help',
            arguments: [eventPayload]
        };
        
        // Highly recommended: Flag it as a preferred fix so it floats to the top of the IDE menu
        action.isPreferred = true;

        return [action];
    }
}
