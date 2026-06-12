import * as vscode from 'vscode';
import { Mission } from '../missions';
import { evaluateHypothesis, getHypothesisSession, recordHintUsage } from '../hypothesisEngine';

export async function launchHypothesisMode(mission: Mission) {
    let success = false;

    while (!success) {
        const session = getHypothesisSession(mission.id);
        const hintsUsed = session?.hintsUsed || 0;

        const maxHints = mission.hints && mission.hints.length > 0 ? mission.hints.length : 3;
        
        let promptStr = `What do you think is causing this error? (Hint ${hintsUsed}/${maxHints} used)`;

        if (hintsUsed >= 3) {
            vscode.window.showWarningMessage("You've used 3 hints. Entering Explanation Mode...");
            await openExplanationMode(mission);
            return; // Exit hypothesis loop
        }

        const hypothesis = await vscode.window.showInputBox({
            prompt: promptStr,
            placeHolder: 'e.g. Variable was never defined.',
            ignoreFocusOut: true
        });

        if (hypothesis === undefined) {
            return; // User cancelled
        }

        if (hypothesis.trim() === '') {
            // Empty input, maybe they want a hint?
            const action = await vscode.window.showWarningMessage("Hypothesis cannot be empty. Do you need a hint?", "Use a Hint", "Try Again");
            if (action === "Use a Hint") {
                recordHintUsage(mission.id);
                const currentHints = getHypothesisSession(mission.id)?.hintsUsed || 1;
                const hintText = mission.hints && currentHints <= mission.hints.length ? mission.hints[currentHints - 1] : "Look at the error line closely.";
                vscode.window.showInformationMessage(`💡 Hint ${currentHints}: ${hintText}`);
            }
            continue;
        }

        // Evaluate hypothesis
        const actualError = mission.originalMessage;
        const codeSnippet = mission.runtimeSummary?.lastTerminalError || "Code snippet unavailable";

        const result = await evaluateHypothesis(mission.id, hypothesis, actualError, codeSnippet);

        if (result.success) {
            vscode.window.showInformationMessage(`+ XP! Correct. ${result.message}`);
            success = true;
            // Transition to dashboard or unlock
            vscode.commands.executeCommand('zeroMagic.renderSocraticDashboard', mission);
        } else if (result.partial) {
            const action = await vscode.window.showInformationMessage(`+ XP! Good observation. ${result.message}`, "Try Again", "Use a Hint");
            if (action === "Use a Hint") {
                recordHintUsage(mission.id);
                const currentHints = getHypothesisSession(mission.id)?.hintsUsed || 1;
                const hintText = mission.hints && currentHints <= mission.hints.length ? mission.hints[currentHints - 1] : "No more hints available.";
                vscode.window.showInformationMessage(`💡 Hint ${currentHints}: ${hintText}`);
            }
        } else {
            const action = await vscode.window.showErrorMessage(`Not quite. ${result.message}`, "Try Again", "Use a Hint");
            if (action === "Use a Hint") {
                recordHintUsage(mission.id);
                const currentHints = getHypothesisSession(mission.id)?.hintsUsed || 1;
                const hintText = mission.hints && currentHints <= mission.hints.length ? mission.hints[currentHints - 1] : "No more hints available.";
                vscode.window.showInformationMessage(`💡 Hint ${currentHints}: ${hintText}`);
            }
        }
    }
}

async function openExplanationMode(mission: Mission) {
    const rootCause = `Root Cause: ${mission.originalMessage}`;
    const why = `Why: Python raised this because of an invalid operation.`;
    const howToThink = `How to think about it: Trace the variables leading up to this point.`;
    const howToAvoid = `How to avoid next time: Always initialize variables.`;

    const explanation = `${rootCause}\n\n${why}\n\n${howToThink}\n\n${howToAvoid}`;
    
    const action = await vscode.window.showInformationMessage(explanation, { modal: true }, "Reveal Solution");
    if (action === "Reveal Solution") {
        vscode.commands.executeCommand('zeroMagic.renderSocraticDashboard', mission);
    }
}
