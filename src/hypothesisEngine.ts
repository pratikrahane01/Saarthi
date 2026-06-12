import { evaluateHypothesisAPI } from './missions';
import { globalContext } from './extension';
import { awardXP } from './xpEngine';

export interface HypothesisSession {
    missionId: string;
    hintsUsed: number;
    attempts: number;
}

const activeSessions = new Map<string, HypothesisSession>();

export function initHypothesisSession(missionId: string): HypothesisSession {
    const session = { missionId, hintsUsed: 0, attempts: 0 };
    activeSessions.set(missionId, session);
    return session;
}

export function getHypothesisSession(missionId: string): HypothesisSession | undefined {
    return activeSessions.get(missionId);
}

export function recordHintUsage(missionId: string) {
    const session = activeSessions.get(missionId);
    if (session) {
        session.hintsUsed += 1;
        
        // Deduct XP based on hint level
        const penalty = session.hintsUsed === 1 ? -5 : session.hintsUsed === 2 ? -10 : -15;
        awardXP(globalContext, `Used Hint ${session.hintsUsed}`, penalty);
    }
}

export async function evaluateHypothesis(
    missionId: string, 
    userHypothesis: string, 
    actualError: string, 
    codeSnippet: string
) {
    const session = activeSessions.get(missionId) || initHypothesisSession(missionId);
    session.attempts += 1;

    const evalResult = await evaluateHypothesisAPI(userHypothesis, actualError, codeSnippet);
    
    if (evalResult.status === 'PASS') {
        let xpReward = 30; // Base for correct hypothesis
        if (session.hintsUsed === 0) {
            xpReward += 100; // Solved without hints bonus
            awardXP(globalContext, 'Solved without hints', 100);
        }
        awardXP(globalContext, 'Correct Hypothesis', xpReward);
        
        return { success: true, message: evalResult.nudge || "Correct hypothesis!" };
    } else if (evalResult.status === 'CLOSE') {
        awardXP(globalContext, 'Partially Correct Hypothesis', 15);
        return { success: false, partial: true, message: evalResult.nudge || "You're close. Keep thinking." };
    } else {
        return { success: false, partial: false, message: evalResult.nudge || "Not quite. Try again." };
    }
}

export function shouldEnterExplanationMode(missionId: string): boolean {
    const session = activeSessions.get(missionId);
    return session ? session.hintsUsed >= 3 : false;
}
