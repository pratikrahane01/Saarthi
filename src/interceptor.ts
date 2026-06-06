import * as vscode from 'vscode';
import { Mission } from './missions';
import { SocraticDashboardPanel } from './ui/dashboard';

export async function trigger(mission: Mission) {
    console.log(`Zero-Magic: Interceptor triggered for mission ${mission.id}`);
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let rootUri: vscode.Uri;

    if (workspaceFolders && workspaceFolders.length > 0) {
        rootUri = workspaceFolders[0].uri;
    } else {
        // Fallback to the directory of the target file
        const targetUri = vscode.Uri.file(mission.targetFilename);
        rootUri = vscode.Uri.joinPath(targetUri, '..');
    }

    const testDirUri = vscode.Uri.joinPath(rootUri, '.zero_magic', 'tests');

    try {
        // Ensure directory exists
        await vscode.workspace.fs.createDirectory(testDirUri);

        // Determine extension based on language
        let ext = '.txt';
        if (mission.language === 'python') ext = '.py';
        else if (mission.language === 'javascript') ext = '.js';
        else if (mission.language === 'typescript') ext = '.ts';

        // Generic test file name based on mission language
        const testFileName = `test_current${ext}`;
        const testFileUri = vscode.Uri.joinPath(testDirUri, testFileName);

        // Write test payload
        const payloadData = Buffer.from(mission.testPayload, 'utf8');
        await vscode.workspace.fs.writeFile(testFileUri, payloadData);
        console.log(`Zero-Magic: Wrote test payload to ${testFileUri.fsPath}`);

        // Update .gitignore automatically
        await ensureGitIgnore(rootUri);

    } catch (err) {
        console.error('Zero-Magic: Failed to write test file or create directory', err);
    }
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
            console.log('Zero-Magic: Updated .gitignore');
        }
    } catch (err: any) {
        // File doesn't exist, create it
        // vscode.workspace.fs.readFile throws if file is not found
        await vscode.workspace.fs.writeFile(gitIgnoreUri, Buffer.from(ignoreEntry, 'utf8'));
        console.log('Zero-Magic: Created .gitignore');
    }
}

export async function unlockMission(missionId: string, language: string) {
    console.log(`Zero-Magic: Unlocking mission ${missionId}`);
    
    // 1. Delete hidden test file
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;
    
    const rootUri = workspaceFolders[0].uri;
    const testDirUri = vscode.Uri.joinPath(rootUri, '.zero_magic', 'tests');
    
    let ext = '.txt';
    if (language === 'python') ext = '.py';
    else if (language === 'javascript') ext = '.js';
    else if (language === 'typescript') ext = '.ts';
    
    const testFileName = `test_current${ext}`;
    const testFileUri = vscode.Uri.joinPath(testDirUri, testFileName);
    
    try {
        await vscode.workspace.fs.delete(testFileUri, { useTrash: false });
        console.log(`Zero-Magic: Deleted test file ${testFileUri.fsPath}`);
    } catch (err) {
        console.error('Zero-Magic: Failed to delete test file', err);
    }

    // 2. Post UNLOCK message to webview
    if (SocraticDashboardPanel.currentPanel) {
        SocraticDashboardPanel.currentPanel.postMessage({ type: 'UNLOCK', missionId });
    }

    // 3. Show information message
    vscode.window.showInformationMessage("✓ Milestone unlocked. Well done.");
}
