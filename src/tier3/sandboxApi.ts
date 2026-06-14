/**
 * sandboxApi.ts — API client for Tier 3 Sandbox endpoints.
 *
 * ISOLATION RULE: This file only communicates with the /v1/sandbox/
 * endpoints. It does NOT call /v1/missions/ endpoints or import from
 * missions.ts.
 */

import { SandboxChallenge, SandboxResult } from './sandboxTypes';

const SANDBOX_GENERATE_URL = 'http://127.0.0.1:8000/v1/sandbox/generate';
const SANDBOX_EVALUATE_URL = 'http://127.0.0.1:8000/v1/sandbox/evaluate';
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Request a sandbox challenge from the backend for a Tier 3 logic bug.
 *
 * @param language - Programming language of the file
 * @param sourceCode - Full source code of the buggy file
 * @param errorContext - Description of the logic bug
 * @returns The sandbox challenge, or null if the request fails
 */
export async function generateSandboxChallenge(
    language: string,
    sourceCode: string,
    errorContext: string,
): Promise<SandboxChallenge | null> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(SANDBOX_GENERATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                language,
                sourceCode,
                errorContext,
                tier: 3,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[sandboxApi] generate failed: HTTP ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data as SandboxChallenge;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sandboxApi] generate network error: ${msg}`);
        return null;
    }
}

/**
 * Submit the student's code for evaluation against the sandbox challenge.
 *
 * @param sandboxId - The sandbox session ID
 * @param language - Programming language
 * @param studentCode - The student's modified code
 * @param originalCode - The original buggy code
 * @param challenge - The challenge description for context
 * @returns The evaluation result, or null if the request fails
 */
export async function evaluateSandboxSubmission(
    sandboxId: string,
    language: string,
    studentCode: string,
    originalCode: string,
    challenge: string,
): Promise<SandboxResult | null> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const response = await fetch(SANDBOX_EVALUATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sandboxId,
                language,
                studentCode,
                originalCode,
                challenge,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[sandboxApi] evaluate failed: HTTP ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data as SandboxResult;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sandboxApi] evaluate network error: ${msg}`);
        return null;
    }
}
