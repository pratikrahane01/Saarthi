/**
 * sandboxTypes.ts — Type definitions for the Tier 3 Sandbox system.
 *
 * ISOLATION RULE: This file does NOT import from missions.ts, watcher.ts,
 * sidebar.ts, or any other shared Tier 1/Tier 2 module.
 * It only imports from 'vscode' for URI types.
 *
 * The shared `Mission` type from missions.ts is accepted as a read-only
 * input but immediately converted to `SandboxMission` at the boundary.
 */

/** Sandbox-specific mission data extracted from the shared Mission type */
export interface SandboxMission {
    /** Original mission ID from the queue */
    id: string;
    /** Programming language */
    language: string;
    /** Error concept / description */
    description: string;
    /** Socratic question from the original mission */
    socraticQuestion: string;
    /** Original source code file path */
    targetFilename: string;
    /** Original source code file URI */
    targetUri: string;
    /** The source code at time of detection */
    sourceCode: string;
    /** Error context string */
    errorContext: string;
}

/** A single practice question within a sandbox session */
export interface SandboxQuestion {
    challenge: string;
    scaffoldCode: string;
    hints: string[];
    testCriteria: string;
}

/** Response from POST /v1/sandbox/generate */
export interface SandboxChallenge {
    sandboxId: string;
    questions: SandboxQuestion[];
}

/** Response from POST /v1/sandbox/evaluate */
export interface SandboxResult {
    passed: boolean;
    feedback: string;
    xpAwarded: number;
    conceptSummary: string;
}

/** State machine for the sandbox UI panel */
export type SandboxState =
    | 'LOADING'
    | 'ACTIVE'
    | 'EVALUATING'
    | 'PASSED'
    | 'FAILED'
    | 'ABORTED';
