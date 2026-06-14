import * as vscode from 'vscode';
import { Mission } from './missions';
import { runTests, TestResult } from './runner';


// ── Shared output channel (reuse the one created in missions.ts if present) ───
// We use a separate named channel so interceptor logs appear alongside the
// mission-matcher logs in the same "Zero-Magic" Output panel.
const LOG = vscode.window.createOutputChannel('Zero-Magic');

/** Global tracker to prevent race conditions during concurrent test runs */
let globalExecutionId: number = 0;

export function isLatestExecution(id: number): boolean {
    return globalExecutionId === id;
}

/** Instantly makes any currently running tests stale */
export function invalidateAllExecutions() {
    globalExecutionId++;
    LOG.appendLine(`[interceptor] All active executions invalidated (epoch bumped to ${globalExecutionId}).`);
}

/**
 * Write the mission's hidden test file to disk, then immediately execute it.
 *
 * @returns A TestResult extended with executionId to allow the caller to discard stale results.
 */
export async function trigger(mission: Mission): Promise<TestResult & { executionId: number }> {
    globalExecutionId++;
    const myExecutionId = globalExecutionId;

    LOG.appendLine(`[interceptor.trigger] Mission: "${mission.title}" (${mission.id}) [execId=${myExecutionId}]`);
    LOG.appendLine(`  Language : ${mission.language}`);

    const targetUri = vscode.Uri.file(mission.targetFilename);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
    let rootUri: vscode.Uri;

    if (workspaceFolder) {
        rootUri = workspaceFolder.uri;
    } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        // Fallback to first workspace if target file is outside all workspaces somehow
        rootUri = vscode.workspace.workspaceFolders[0].uri;
    } else {
        // Fallback to the directory of the target file
        rootUri = vscode.Uri.joinPath(targetUri, '..');
    }

    const testDirUri = vscode.Uri.joinPath(rootUri, '.zero_magic', 'tests');

    // ── Determine test file path ──────────────────────────────────────────────
    let ext = '.txt';
    if (mission.language === 'python') { ext = '.py'; }
    else if (mission.language === 'javascript') { ext = '.js'; }
    else if (mission.language === 'typescript') { ext = '.ts'; }

    const testFileName = `test_current${ext}`;
    const testFileUri = vscode.Uri.joinPath(testDirUri, testFileName);

    // ── Step 1: Write the test file ───────────────────────────────────────────
    try {
        await vscode.workspace.fs.createDirectory(testDirUri);
        const payloadData = Buffer.from(mission.testPayload, 'utf8');
        await vscode.workspace.fs.writeFile(testFileUri, payloadData);
        LOG.appendLine(`  ✓ Test file written: ${testFileUri.fsPath}`);

        await ensureGitIgnore(rootUri);
    } catch (writeErr) {
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        LOG.appendLine(`  ✗ Failed to write test file: ${msg}`);
        console.error('Zero-Magic: Failed to write test file or create directory', writeErr);
        // Cannot run tests if the file wasn't written — return a clean failure.
        return { passed: false, duration: 0, executionId: myExecutionId };
    }

    // ── Step 2: Execute the test file via runner.ts ───────────────────────────
    // Map the mission language to the two runner modes runner.ts understands.
    const runnerLanguage: 'python' | 'node' =
        mission.language === 'python' ? 'python' : 'node';

    LOG.appendLine(`  → Running tests | runner: ${runnerLanguage} | file: ${testFileUri.fsPath}`);

    let result: TestResult;
    try {
        result = await runTests(testFileUri.fsPath, runnerLanguage);
    } catch (runErr) {
        // runTests() only rejects on a child-process spawn error (e.g. Python not
        // installed). It resolves with passed=false for all other failures.
        const msg = runErr instanceof Error ? runErr.message : String(runErr);
        LOG.appendLine(`  ✗ Runner threw an error: ${msg}`);
        vscode.window.setStatusBarMessage(
            '⚠️ Zero-Magic: Could not run tests — is Python/Node installed?',
            7000
        );
        return { passed: false, duration: 0, executionId: myExecutionId };
    }

    // ── Step 3: Log the outcome ───────────────────────────────────────────────
    if (result.passed) {
        LOG.appendLine(`  ✓ Tests PASSED in ${result.duration}ms`);
    } else {
        LOG.appendLine(`  ✗ Tests FAILED in ${result.duration}ms (exit code ≠ 0 or timeout)`);
    }

    return { ...result, executionId: myExecutionId };
}

async function ensureGitIgnore(rootUri: vscode.Uri) {
    const gitIgnoreUri = vscode.Uri.joinPath(rootUri, '.gitignore');
    const ignoreEntry = '\n# Zero-Magic Temp Directory\n.zero_magic/\n';
    
    try {
        const fileData = await vscode.workspace.fs.readFile(gitIgnoreUri);
        const content = Buffer.from(fileData).toString('utf8');
        
        if (!content.includes('.zero_magic/')) {
            const newContent = content + ignoreEntry;
            await vscode.workspace.fs.writeFile(gitIgnoreUri, Buffer.from(newContent, 'utf8'));
            LOG.appendLine('  ✓ .gitignore updated');
        }
    } catch (err: any) {
        // File doesn't exist — create it from scratch.
        await vscode.workspace.fs.writeFile(gitIgnoreUri, Buffer.from(ignoreEntry, 'utf8'));
        LOG.appendLine('  ✓ .gitignore created');
    }
}

export async function unlockMission(missionId: string, language: string) {
    LOG.appendLine(`[interceptor.unlockMission] Unlocking mission: ${missionId}`);
    console.log("[ZERO-MAGIC] Mission unlocked");

    // 1. Delete hidden test file
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        LOG.appendLine('  ⚠ No workspace folder — cannot delete test file.');
        return;
    }

    let ext = '.txt';
    if (language === 'python') { ext = '.py'; }
    else if (language === 'javascript') { ext = '.js'; }
    else if (language === 'typescript') { ext = '.ts'; }

    const testFileName = `test_current${ext}`;

    for (const folder of workspaceFolders) {
        const testDirUri = vscode.Uri.joinPath(folder.uri, '.zero_magic', 'tests');
        const testFileUri = vscode.Uri.joinPath(testDirUri, testFileName);

        try {
            await vscode.workspace.fs.delete(testFileUri, { useTrash: false });
            LOG.appendLine(`  ✓ Deleted test file: ${testFileUri.fsPath}`);
        } catch (err: any) {
            // It's normal for the file to not exist in other workspace folders
            if (err.code !== 'FileNotFound') {
                LOG.appendLine(`  ⚠ Could not delete test file in ${folder.name}: ${err.message}`);
            }
        }
    }

    // Sidebar state is already driven to PASSED via
    // missions.ts → SocraticSidebarProvider.reportTestResult(true).
    // No additional postMessage needed here.

    // Show VS Code information message
    vscode.window.showInformationMessage('✓ Milestone unlocked. Well done.');
    LOG.appendLine(`  ✓ Unlock complete for mission: ${missionId}`);
}

/**
 * Force deletes all .zero_magic/tests directories across all workspace folders.
 * Used during startup, shutdown, abort, and mission replacement to prevent orphans.
 */
export async function cleanUpAllTests() {
    LOG.appendLine('[interceptor.cleanUpAllTests] Wiping hidden test directories...');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;

    for (const folder of workspaceFolders) {
        const testDirUri = vscode.Uri.joinPath(folder.uri, '.zero_magic', 'tests');
        try {
            await vscode.workspace.fs.delete(testDirUri, { recursive: true, useTrash: false });
            LOG.appendLine(`  ✓ Cleaned up test directory: ${testDirUri.fsPath}`);
        } catch (err: any) {
            if (err.code !== 'FileNotFound') {
                LOG.appendLine(`  ⚠ Cleanup skipped for ${testDirUri.fsPath}: ${err.message}`);
            }
        }
    }
}
