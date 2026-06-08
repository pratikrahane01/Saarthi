import * as vscode from 'vscode';
import { matchErrorToMission, executeMissionHandOff } from './missions';

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
            try {
                // Show immediate visual confirmation to the user
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: "Zero-Magic Engine",
                    cancellable: false
                }, async (progress) => {
                    progress.report({ message: "Analyzing error context..." });
                    
                    // Invoke your Phase 2 matching module
                    const matchedMission = await matchErrorToMission(event);
                    
                    if (matchedMission) {
                        progress.report({ message: "Socratic Mission Found! Handing off..." });
                        await executeMissionHandOff(matchedMission);
                    } else {
                        vscode.window.showInformationMessage("No guided lesson available for this specific error. Keep debugging!");
                    }
                });
            } finally {
                isMissionLoading = false;
            }
        }
    );

    context.subscriptions.push(diagnosticListener, codeActionProvider, commandHandler);
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
