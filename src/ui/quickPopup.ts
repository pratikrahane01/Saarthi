import * as vscode from 'vscode';
import { Mission } from '../missions';

export async function showQuickPopup(mission: Mission) {
    let hintIndex = 0;
    const maxHints = mission.hints && mission.hints.length > 0 ? mission.hints.length : 1;

    const showNextHint = async () => {
        if (hintIndex < maxHints) {
            const hint = mission.hints && mission.hints.length > 0 ? mission.hints[hintIndex] : mission.description;
            const message = `💡 Quick Thought: ${hint}`;
            
            const options: string[] = [];
            if (hintIndex < maxHints - 1) {
                options.push("Next Hint");
            } else {
                options.push("Show Answer");
            }
            options.push("Open Dashboard", "Dismiss");

            const selection = await vscode.window.showInformationMessage(message, ...options);
            
            if (selection === "Next Hint") {
                hintIndex++;
                await showNextHint();
            } else if (selection === "Show Answer") {
                // For tier 1, answer is usually implied or we can just say to fix the syntax.
                vscode.window.showInformationMessage(`Fix: Carefully check the syntax around line ${mission.errorLineNumber || 'unknown'}.`);
            } else if (selection === "Open Dashboard") {
                vscode.commands.executeCommand('zeroMagic.renderSocraticDashboard', mission);
            }
        }
    };

    await showNextHint();
}
