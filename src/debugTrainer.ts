import * as vscode from 'vscode';
import { awardXP, getProfile } from './xpEngine';

export interface ErrorLine {
    line: number;
    text: string;
}

export interface DebugRitualState {
    missionId: string;
    step: 0 | 1 | 2 | 3;
    step1Response: string;
    step2Response: string;
    hypothesis: string;
    startedAt: string;
    completedAt?: string;
    /** Groq-generated plain-English summary of the error (shown in Step 1) */
    errorSummary?: string;
    /** Suspect source lines shown in Step 2 */
    errorLines?: ErrorLine[];
    /** The tier of this error (1=syntax, 2=logic, 3=runtime) */
    tier?: number;
    /** Hash of the original diagnostic to prevent stale explanations */
    diagnosticHash?: string;
}

export function getRitualState(context: vscode.ExtensionContext, missionId: string): DebugRitualState | null {
    const rituals = context.workspaceState.get<{ [id: string]: DebugRitualState }>('zeroMagic.rituals') || {};
    return rituals[missionId] || null;
}

export function initRitual(context: vscode.ExtensionContext, missionId: string, diagnosticHash?: string): DebugRitualState {
    const rituals = context.workspaceState.get<{ [id: string]: DebugRitualState }>('zeroMagic.rituals') || {};
    
    // If it exists, check if the diagnostic hash matches
    if (rituals[missionId]) {
        if (!diagnosticHash || rituals[missionId].diagnosticHash === diagnosticHash) {
            return rituals[missionId];
        }
    }
    
    const newState: DebugRitualState = {
        missionId,
        diagnosticHash,
        step: 0,
        step1Response: '',
        step2Response: '',
        hypothesis: '',
        startedAt: new Date().toISOString()
    };
    
    rituals[missionId] = newState;
    context.workspaceState.update('zeroMagic.rituals', rituals);
    return newState;
}

export async function advanceStep(context: vscode.ExtensionContext, missionId: string, response: string): Promise<DebugRitualState | null> {
    const rituals = context.workspaceState.get<{ [id: string]: DebugRitualState }>('zeroMagic.rituals') || {};
    const state = rituals[missionId];
    
    if (!state) return null;
    
    if (state.step < 3) {
        state.hypothesis = response;
        state.step = 3;
        state.completedAt = new Date().toISOString();
        await awardXP(context, 'ritual_step1', 15);
        await awardXP(context, 'ritual_step2', 15);
        await awardXP(context, 'ritual_step3', 20);
    }
    
    rituals[missionId] = state;
    await context.workspaceState.update('zeroMagic.rituals', rituals);
    return state;
}

export function isRitualComplete(context: vscode.ExtensionContext, missionId: string): boolean {
    const state = getRitualState(context, missionId);
    return state?.step === 3;
}

export async function canSkipRitual(context: vscode.ExtensionContext): Promise<boolean> {
    const profile = await getProfile(context);
    return profile.currentRank >= 3;
}

export async function skipRitual(context: vscode.ExtensionContext, missionId: string): Promise<DebugRitualState | null> {
    const rituals = context.workspaceState.get<{ [id: string]: DebugRitualState }>('zeroMagic.rituals') || {};
    const state = rituals[missionId];
    if (!state) return null;
    state.step = 3;
    state.hypothesis = 'SKIPPED';
    state.completedAt = new Date().toISOString();
    rituals[missionId] = state;
    await context.workspaceState.update('zeroMagic.rituals', rituals);
    return state;
}
