/**
 * sandboxController.ts — Single entry point for the Tier 3 Sandbox system.
 *
 * This is the ONLY file that bridges the shared pipeline (bugQueue.ts)
 * with the isolated Tier 3 module. It:
 *
 *   1. Accepts a Mission object (shared type, read-only)
 *   2. Reads the source code from the target file
 *   3. Calls the sandbox API to generate a challenge
 *   4. Opens the SandboxPanel UI
 *   5. Handles completion/abort callbacks
 *
 * ISOLATION RULE: This file imports the shared Mission type as read-only
 * input. It does NOT modify any shared state. The only shared function
 * it calls is advanceBugQueue() through sandboxSubmit.ts — same contract
 * as Tier 1/2.
 */

import * as vscode from 'vscode';
import { Mission } from '../missions';
import { generateSandboxChallenge } from './sandboxApi';
import { SandboxPanel } from './sandboxProvider';
import { advanceBugQueue, getQueueState } from '../bugQueue';

export class SandboxController {
    /**
     * Start a Tier 3 sandbox session for the given mission.
     *
     * This is the single integration point called from processCurrentBug()
     * in bugQueue.ts when mission.tier === 3.
     */
    public static async start(mission: Mission): Promise<void> {
        console.log(`[SandboxController] Starting sandbox for mission: ${mission.id}`);

        // Step 1: Read the current source code
        let sourceCode = '';
        try {
            const doc = await vscode.workspace.openTextDocument(
                vscode.Uri.parse(mission.targetUri)
            );
            sourceCode = doc.getText();
        } catch (err) {
            console.error('[SandboxController] Failed to read source file:', err);
            vscode.window.showErrorMessage(
                'Sandbox: Could not read the source file. Skipping Tier 3 mission.'
            );
            // Skip this mission in the queue
            if (getQueueState().isActive) {
                await advanceBugQueue(0, 0, 'Could not read source file');
            }
            return;
        }

        // Step 2: Generate the sandbox challenge
        const errorContext = mission.description || mission.originalMessage || 'Logic bug detected';

        const challenge = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Sandbox",
            cancellable: false,
        }, async (progress) => {
            progress.report({ message: "Generating Tier 3 challenge..." });
            return await generateSandboxChallenge(
                mission.language,
                sourceCode,
                errorContext,
            );
        });

        if (!challenge) {
            vscode.window.showErrorMessage(
                'Sandbox: Backend could not generate a challenge. Please check the server.'
            );
            if (getQueueState().isActive) {
                await advanceBugQueue(0, 0, 'Backend challenge generation failed');
            }
            return;
        }

        console.log(`[SandboxController] Challenge generated: ${challenge.sandboxId}`);

        // Step 3: Determine extensionUri for panel resource roots
        const extensionUri = vscode.extensions.getExtension('zero-magic-team.zero-magic')?.extensionUri
            ?? vscode.Uri.file('.');

        // Step 4: Open the Sandbox Panel
        SandboxPanel.createOrShow(
            extensionUri,
            challenge,
            mission.language,
            sourceCode,
            // onComplete callback
            async (xpEarned: number, hintsUsed: number) => {
                console.log(`[SandboxController] Sandbox completed: xp=${xpEarned}, hints=${hintsUsed}`);
                // Note: advanceBugQueue is already called inside executeSandboxSubmit
                // when the evaluation passes. We don't call it again here.
            },
            // onAbort callback
            async () => {
                console.log('[SandboxController] Sandbox aborted by user');
                if (getQueueState().isActive) {
                    await advanceBugQueue(0, 0, 'Sandbox aborted by user');
                }
            },
        );
    }
}
