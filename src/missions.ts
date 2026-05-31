import * as vscode from 'vscode';
import { DiagnosticEvent } from './watcher';

// Define the Mission interface contract agreed upon with Teammate 4
export interface Mission {
    id: string;
    title: string;
    language: string;
    description: string;
    socraticQuestion: string;
    hints: string[];
    // The test template code that Teammate 1 will drop into .zero_magic/tests/
    testPayload: string; 
    targetFilename: string;
}

/**
 * Communicates with the local FastAPI micro-server to find an educational
 * mission matching the user's current code error context.
 * 
 * @param event The structured diagnostic data gathered from the IDE watcher
 * @returns A promise resolving to the matched Mission or null if unavailable
 */
export async function matchErrorToMission(event: DiagnosticEvent): Promise<Mission | null> {
    // Add this at the very top of matchErrorToMission for offline testing:
    return {
        id: "py_name_error_01",
        title: "Variable Initialization Mastery",
        language: "python",
        description: "You used a variable name before assigning a value to it.",
        socraticQuestion: "Before a computer can read what is inside a box, what must you do to that box first?",
        hints: ["Look at the left-hand side of your code.", "Did you spell the variable name exactly the same way?"],
        testPayload: "def test_variable_exists():\n    assert 'my_variable' in globals()",
        targetFilename: event.filePath
    };

    const BACKEND_URL = 'http://127.0.0.1:8000/v1/missions/match';
    
    console.log(`Zero-Magic: Attempting database match for [${event.languageId}] error: "${event.errorMessage.substring(0, 30)}..."`);

    try {
        // Native fetch request to the local backend micro-service
        const response = await fetch(BACKEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(event)
        });

        if (!response.ok) {
            if (response.status === 404) {
                console.warn(`Zero-Magic: No educational mission mapped for this error type yet.`);
                return null;
            }
            throw new Error(`Server responded with status code: ${response.status}`);
        }

        const missionData = await response.json() as Mission;
        console.log(`Zero-Magic: Successfully matched error to Mission ID: ${missionData.id}`);
        return missionData;

    } catch (error) {
        // Phase 8 Resilience: Network failure must NEVER crash the extension or block normal typing
        console.error('Zero-Magic Matcher Error (Backend might be offline):', error);
        
        // Gracefully notify the developer via the status bar or output channel rather than a jarring error box
        vscode.window.setStatusBarMessage('⚠️ Zero-Magic: Local backend server unreachable.', 5000);
        return null;
    }
}

/**
 * The Orchestration Hand-off: Takes a verified mission and triggers the rest of the ecosystem.
 */
export async function executeMissionHandOff(mission: Mission) {
    try {
        // Mocking Teammate 1's interceptor system hook for now
        // In full integration, this imports and calls: interceptor.trigger(mission);
        console.log(`=== HAND-OFF TO TEAMMATE 1 ===`);
        console.log(`Injecting test files for: ${mission.title}`);
        console.log(`Targeting file environment: ${mission.targetFilename}`);
        
        // Broadcast an internal custom event or command that Teammate 4's UI Webview can listen to
        await vscode.commands.executeCommand('zeroMagic.renderSocraticDashboard', mission);
        
    } catch (err) {
        console.error('Zero-Magic Hand-off pipeline failed:', err);
    }
}
