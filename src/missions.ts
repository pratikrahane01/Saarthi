import * as vscode from 'vscode';
import { DiagnosticEvent } from './watcher';
import { ContextBuilder, BuiltContext, RuntimeSummary } from './contextBuilder';
import * as interceptor from './interceptor';

// ── Output channel for structured, persistent logging ────────────────────────
// Using an output channel (vs. console.log) means logs are visible in the
// VS Code "Output" panel under "Zero-Magic" during normal use.
const LOG = vscode.window.createOutputChannel('Zero-Magic');

// ── API contract ─────────────────────────────────────────────────────────────

/**
 * Extended request body sent to POST /v1/missions/generate-mission.
 * Includes runtime terminal context on top of diagnostic fields.
 * Backend priority: terminalOutput > diagnosticMessage > errorCode
 */
interface MissionRequest {
    /** Programming language of the error file (e.g. 'python', 'typescript'). */
    language: string;
    /** Short error-type identifier extracted from the message (e.g. 'NameError'). */
    errorCode: string;
    /** Full human-readable error message from the IDE diagnostic. */
    message: string;
    /** Explicit diagnostic text — alias for message for new context-aware flows. */
    diagnosticMessage: string;
    /** Complete source code of the active file at time of error. */
    sourceCode: string;
    /** Combined stdout + stderr from the last terminal run (empty string if none). */
    terminalOutput: string;
    /** Exit code of the last terminal process (-1 = no process run this session). */
    exitCode: number;
}

/**
 * Raw response body returned by the FastAPI backend.
 * Field names match backend/models/schemas.py → MissionResponse.
 */
interface MissionResponse {
    missionId: string;
    title: string;
    concept: string;
    questions: string[];
    hints: string[];
    framework: string;
    hiddenTest: string;
}

// ── Public extension-facing interface ────────────────────────────────────────

/** Mission interface contract agreed upon with Teammate 4 */
export interface Mission {
    id: string;
    title: string;
    language: string;
    description: string;
    socraticQuestion: string;
    hints: string[];
    /** The test payload that Teammate 1 drops into .zero_magic/tests/ */
    testPayload: string;
    targetFilename: string;
    targetUri: string;
    originalErrorCode: string;
    originalMessage: string;
    /** Runtime context summary — populated when terminal output was available. */
    runtimeSummary?: RuntimeSummary;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const BACKEND_URL = 'http://127.0.0.1:8000/v1/missions/generate-mission';
const FETCH_TIMEOUT_MS = 8_000;

// ── Fallback mock (backend unreachable only) ──────────────────────────────────

/**
 * Returns a safe fallback mission when the backend cannot be reached.
 * This is intentionally generic — it is only shown when the server is down,
 * never as a replacement for real content.
 */
function buildFallbackMission(ctx: BuiltContext, errorCode: string): Mission {
    return {
        id: 'fallback_offline',
        title: 'Debug Mode (Backend Offline)',
        language: ctx.language,
        description: 'The Zero-Magic backend is currently unreachable. This is a generic offline mission. Start the backend server with: uvicorn backend.main:app --reload --port 8000',
        socraticQuestion: 'Before you can fix an error, what information do you need to gather about it?',
        hints: [
            'Read the full error message carefully — what type of error is it?',
            'Locate the exact line number mentioned in the error.',
            'Start the Zero-Magic backend server so you can get a tailored mission.',
        ],
        testPayload: 'def test_backend_connection():\n    import urllib.request\n    try:\n        urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2)\n        assert True\n    except Exception:\n        assert False, "Backend server is not running on port 8000"',
        targetFilename: ctx.activeFilePath,
        targetUri: vscode.Uri.file(ctx.activeFilePath).toString(),
        originalErrorCode: errorCode,
        originalMessage: ctx.diagnosticMessage,
        runtimeSummary: ContextBuilder.instance.getRuntimeSummary(),
    };
}

// ── Mapping helper ────────────────────────────────────────────────────────────

/**
 * Maps a MissionResponse (backend schema) to the Mission interface
 * (extension-internal contract agreed with Teammate 4).
 *
 * Field mapping:
 *   missionId  → id
 *   concept    → description
 *   questions[0] → socraticQuestion  (first question drives the initial prompt)
 *   hints      → hints
 *   hiddenTest → testPayload
 */
function mapResponseToMission(response: MissionResponse, ctx: BuiltContext, errorCode: string): Mission {
    return {
        id: response.missionId,
        title: response.title,
        language: ctx.language,
        description: response.concept,
        socraticQuestion: response.questions[0] ?? 'What do you think is causing this error?',
        hints: response.hints,
        testPayload: response.hiddenTest,
        targetFilename: ctx.activeFilePath,
        targetUri: vscode.Uri.file(ctx.activeFilePath).toString(),
        originalErrorCode: errorCode,
        originalMessage: ctx.diagnosticMessage,
        runtimeSummary: ContextBuilder.instance.getRuntimeSummary(),
    };
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validates that a raw JSON value from the backend conforms to MissionResponse.
 * Returns the typed value or throws a descriptive error.
 */
function validateMissionResponse(raw: unknown): MissionResponse {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Response is not a JSON object.');
    }
    const r = raw as Record<string, unknown>;

    const requiredStrings = ['missionId', 'title', 'concept', 'framework', 'hiddenTest'] as const;
    for (const field of requiredStrings) {
        if (typeof r[field] !== 'string' || (r[field] as string).trim() === '') {
            throw new Error(`Missing or empty required field: "${field}"`);
        }
    }

    if (!Array.isArray(r.questions) || r.questions.length < 1) {
        throw new Error('Field "questions" must be a non-empty array.');
    }
    if (!Array.isArray(r.hints) || r.hints.length < 1) {
        throw new Error('Field "hints" must be a non-empty array.');
    }

    return raw as MissionResponse;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Communicates with the local FastAPI micro-service to find an educational
 * mission matching the user's current code error context.
 *
 * Flow:
 *  1. Use ContextBuilder to gather full context (language, errorCode, sourceCode,
 *     terminalOutput, exitCode) from the DiagnosticEvent.
 *  2. POST to /v1/missions/generate-mission with an 8-second timeout.
 *  3. Map the MissionResponse fields to the Mission interface.
 *  4. Return null if the backend returns 404 (no mission for this error).
 *  5. Fall back to a generic offline mission if the server is unreachable.
 *
 * @param event The structured diagnostic data gathered from the IDE watcher
 * @returns A promise resolving to the matched Mission or null if unavailable
 */
export async function matchErrorToMission(event: DiagnosticEvent): Promise<Mission | null> {

    // ── Build full context via ContextBuilder ─────────────────────────────────
    // ContextBuilder gathers: errorCode from message, source code from disk,
    // terminalOutput from the rolling buffer, exitCode from shell integration.
    const ctx = await ContextBuilder.instance.build(event);

    const requestBody: MissionRequest = {
        language:          ctx.language,
        errorCode:         ctx.errorCode,
        message:           ctx.diagnosticMessage,
        diagnosticMessage: ctx.diagnosticMessage,
        sourceCode:        ctx.sourceCode,
        terminalOutput:    ctx.terminalOutput,
        exitCode:          ctx.exitCode,
    };

    LOG.appendLine(`[matchErrorToMission] POST ${BACKEND_URL}`);
    LOG.appendLine(`  → language       : ${requestBody.language}`);
    LOG.appendLine(`  → errorCode      : ${requestBody.errorCode}`);
    LOG.appendLine(`  → message        : ${requestBody.message.substring(0, 80)}${requestBody.message.length > 80 ? '…' : ''}`);
    LOG.appendLine(`  → sourceCodeLen  : ${requestBody.sourceCode.length} chars`);
    LOG.appendLine(`  → terminalOutput : ${requestBody.terminalOutput.length} chars (exitCode=${requestBody.exitCode})`);
    if (requestBody.terminalOutput) {
        LOG.appendLine(`  → [RUNTIME] Terminal output present — backend will prioritize over diagnostics`);
    }

    // ── Fetch with timeout ────────────────────────────────────────────────────
    let response: Response;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        response = await fetch(BACKEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
    } catch (networkError: unknown) {
        // ECONNREFUSED, AbortError (timeout), DNS failure, etc.
        const msg = networkError instanceof Error ? networkError.message : String(networkError);
        LOG.appendLine(`[matchErrorToMission] ⚠ Network error — backend unreachable: ${msg}`);
        LOG.appendLine('[matchErrorToMission] Falling back to offline mission.');
        vscode.window.setStatusBarMessage('⚠️ Zero-Magic: Backend server unreachable — using offline mission.', 6000);
        return buildFallbackMission(ctx, ctx.errorCode);
    }

    // ── Handle HTTP error responses ───────────────────────────────────────────
    if (!response.ok) {
        if (response.status === 404) {
            LOG.appendLine(`[matchErrorToMission] 404 — no mission found for language="${requestBody.language}" errorCode="${requestBody.errorCode}".`);
            return null;  // Caller shows "No guided lesson available"
        }

        // Any other non-2xx is an unexpected server error
        const bodyText = await response.text().catch(() => '(unreadable)');
        LOG.appendLine(`[matchErrorToMission] ✗ HTTP ${response.status} from backend: ${bodyText.substring(0, 200)}`);
        vscode.window.setStatusBarMessage(`⚠️ Zero-Magic: Backend error (HTTP ${response.status}).`, 5000);
        return null;
    }

    // ── Parse and validate response ───────────────────────────────────────────
    let rawJson: unknown;
    try {
        rawJson = await response.json();
    } catch (parseError) {
        LOG.appendLine(`[matchErrorToMission] ✗ Failed to parse JSON response: ${parseError}`);
        return null;
    }

    let validated: MissionResponse;
    try {
        validated = validateMissionResponse(rawJson);
    } catch (validationError: unknown) {
        const msg = validationError instanceof Error ? validationError.message : String(validationError);
        LOG.appendLine(`[matchErrorToMission] ✗ Response validation failed: ${msg}`);
        LOG.appendLine(`  raw response: ${JSON.stringify(rawJson).substring(0, 300)}`);
        return null;
    }

    // ── Map and return ────────────────────────────────────────────────────────
    const mission = mapResponseToMission(validated, ctx, ctx.errorCode);
    LOG.appendLine(`[matchErrorToMission] ✓ Mission matched: id="${mission.id}" title="${mission.title}"`);
    if (mission.runtimeSummary?.hasRuntimeData) {
        LOG.appendLine(`[matchErrorToMission] ✓ Runtime context included: exitCode=${mission.runtimeSummary.exitCode}`);
    }
    return mission;
}

/**
 * The Orchestration Hand-off: Takes a verified mission and triggers the rest of the ecosystem.
 *
 * Flow:
 *  1. interceptor.trigger() — writes the hidden test file AND runs it.
 *  2. SocraticSidebarProvider.reportTestResult() — drives the sidebar to PASSED or FAILED.
 *  3. If tests passed — interceptor.unlockMission() cleans up and fires the UNLOCK message.
 *  4. renderSocraticDashboard command — populates both the legacy panel and new sidebar with
 *     mission content (already registered in extension.ts).
 */
export async function executeMissionHandOff(mission: Mission) {
    try {
        LOG.appendLine(`[executeMissionHandOff] === HAND-OFF ===`);
        LOG.appendLine(`  Mission : ${mission.title} (${mission.id})`);
        LOG.appendLine(`  Target  : ${mission.targetFilename}`);

        // ── Step 1: Render the Socratic UI immediately (don't wait for tests) ───────
        // The student sees the question + hints while the test runner works in
        // the background. This keeps the UX responsive.
        await vscode.commands.executeCommand('zeroMagic.socraticSidebar.focus');
        await vscode.commands.executeCommand('zeroMagic.renderSocraticDashboard', mission);

        // ── Phase 9: Clean up any old tests from previous missions
        await Promise.all([
            interceptor.cleanUpAllTests(),
            interceptor.invalidateAllExecutions()
        ]);
        
        // The student must read the hints
        // and manually click "Try Again" to trigger the interceptor.
        LOG.appendLine(`[executeMissionHandOff] UI hydrated. Halting execution to wait for student input.`);
        console.log("[ZERO-MAGIC] Mission loaded");

    } catch (err) {
        LOG.appendLine(`[executeMissionHandOff] ✗ Hand-off pipeline failed: ${err}`);
        console.error('Zero-Magic Hand-off pipeline failed:', err);
    }
}

export interface SolutionRequest {
    language: string;
    errorCode: string;
    sourceCode: string;
    diagnosticMessage: string;
}

export interface SolutionResponse {
    fixedCode: string;
    explanation: string;
    conceptSummary: string;
}

/**
 * Fetches an expert solution from the backend using Groq.
 */
export async function fetchExpertSolution(requestBody: SolutionRequest): Promise<SolutionResponse | null> {
    const url = 'http://127.0.0.1:8000/v1/missions/reveal-solution';
    LOG.appendLine(`[fetchExpertSolution] POST ${url}`);
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for LLM

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            LOG.appendLine(`[fetchExpertSolution] Backend returned ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data as SolutionResponse;

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        LOG.appendLine(`[fetchExpertSolution] Error: ${msg}`);
        return null;
    }
}

/**
 * Sends the entire active file content to the backend for Socratic analysis.
 */
export async function matchWholeFileToMission(fullCode: string, languageId: string, filePath: string): Promise<Mission | null> {
    const url = 'http://127.0.0.1:8000/v1/missions/analyze-file';
    
    LOG.appendLine(`[matchWholeFileToMission] POST ${url}`);
    LOG.appendLine(`  → language : ${languageId}`);
    LOG.appendLine(`  → fullCode length : ${fullCode.length}`);

    let response: Response;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for full file LLM

        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language: languageId, fullCode }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
    } catch (networkError: unknown) {
        const msg = networkError instanceof Error ? networkError.message : String(networkError);
        LOG.appendLine(`[matchWholeFileToMission] ⚠ Network error — backend unreachable: ${msg}`);
        vscode.window.setStatusBarMessage('⚠️ Zero-Magic: Backend server unreachable.', 6000);
        return null;
    }

    if (!response.ok) {
        const bodyText = await response.text().catch(() => '(unreadable)');
        LOG.appendLine(`[matchWholeFileToMission] ✗ HTTP ${response.status} from backend: ${bodyText.substring(0, 200)}`);
        vscode.window.setStatusBarMessage(`⚠️ Zero-Magic: Backend error (HTTP ${response.status}).`, 5000);
        return null;
    }

    let rawJson: unknown;
    try {
        rawJson = await response.json();
    } catch (parseError) {
        LOG.appendLine(`[matchWholeFileToMission] ✗ Failed to parse JSON response: ${parseError}`);
        return null;
    }

    let validated: MissionResponse;
    try {
        validated = validateMissionResponse(rawJson);
    } catch (validationError: unknown) {
        const msg = validationError instanceof Error ? validationError.message : String(validationError);
        LOG.appendLine(`[matchWholeFileToMission] ✗ Response validation failed: ${msg}`);
        return null;
    }

    // Mock a context for mapping
    const mockContext: BuiltContext = {
        language: languageId,
        errorCode: "FILE_ANALYSIS",
        diagnosticMessage: "Full File Analysis",
        activeFilePath: filePath,
        sourceCode: fullCode,
        terminalOutput: "",
        exitCode: -1
    };

    const mission = mapResponseToMission(validated, mockContext, "FILE_ANALYSIS");
    LOG.appendLine(`[matchWholeFileToMission] ✓ File Mission matched: id="${mission.id}" title="${mission.title}"`);
    return mission;
}
