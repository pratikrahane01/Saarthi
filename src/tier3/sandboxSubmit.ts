/**
 * sandboxSubmit.ts — Dedicated submit flow for Tier 3 Sandbox.
 *
 * ISOLATION RULE: This file does NOT import from watcher.ts (cmdSubmit),
 * sidebar.ts (_retrigger), or interceptor.ts. It has its own submit
 * pipeline that calls the /v1/sandbox/evaluate endpoint.
 *
 * Why this exists instead of reusing cmdSubmit:
 *   1. cmdSubmit assumes activeCoach (CommentThread) is non-null — Tier 3 uses a panel
 *   2. cmdSubmit uses diagnostic-based validation — Tier 3 bugs have no diagnostics
 *   3. cmdSubmit awards 50 XP — Tier 3 should award 100 XP
 *   4. cmdSubmit disposes activeCoach.thread — Tier 3 disposes SandboxPanel
 */

import * as vscode from 'vscode';
import { evaluateSandboxSubmission } from './sandboxApi';
import { SandboxResult } from './sandboxTypes';
import { awardXP } from '../xpEngine';
import { globalContext } from '../extension';
import { getQueueState, advanceBugQueue } from '../bugQueue';

/**
 * Execute the Tier 3 sandbox submission flow.
 *
 * @param sandboxId - The current sandbox session ID
 * @param language - Programming language
 * @param studentCode - The student's modified code
 * @param originalCode - The original buggy code
 * @param challenge - The challenge description
 * @param hintsUsed - Number of hints the student consumed
 * @returns The evaluation result, or null on failure
 */
export async function executeSandboxSubmit(
    sandboxId: string,
    language: string,
    studentCode: string,
    originalCode: string,
    challenge: string,
    hintsUsed: number,
): Promise<SandboxResult | null> {
    // Step 1: Call the backend for evaluation
    const result = await evaluateSandboxSubmission(
        sandboxId,
        language,
        studentCode,
        originalCode,
        challenge,
    );

    if (!result) {
        vscode.window.showWarningMessage(
            '⚠️ Sandbox evaluation failed. Please check the backend server.'
        );
        return null;
    }

    // Step 2: Award XP if passed
    if (result.passed) {
        await awardXP(globalContext, 'Tier 3 Sandbox Fix', result.xpAwarded);
        vscode.window.showInformationMessage(
            `🎉 Sandbox challenge passed! +${result.xpAwarded} XP`
        );
    }

    // Step 3: Advance the bug queue if active
    if (result.passed && getQueueState().isActive) {
        await advanceBugQueue(result.xpAwarded, hintsUsed);
    }

    return result;
}
