import * as vscode from 'vscode';

export interface PlayerProfile {
    totalXp: number;
    currentRank: number;
    rankName: string;
    currentStreak: number;
    longestStreak: number;
    lastActiveDate: string;
    activeMultiplier: number;
    badges: string[];
    xpHistory: XpEvent[];
}

export interface XpEvent {
    type: string;
    baseXp: number;
    multiplier: number;
    finalXp: number;
    timestamp: string;
}

const RANKS = [
    { rank: 1, name: "Bug Rookie",     minXp: 0 },
    { rank: 2, name: "Syntax Warrior", minXp: 500 },
    { rank: 3, name: "Logic Hunter",   minXp: 1500 },
    { rank: 4, name: "Stack Tracer",   minXp: 3500 },
    { rank: 5, name: "Debug Archer",   minXp: 7500 },
    { rank: 6, name: "Error Slayer",   minXp: 15000 },
    { rank: 7, name: "Debug Master",   minXp: 30000 },
];

export function getRankForXp(totalXp: number) {
    let current = RANKS[0];
    let next = RANKS[1];
    for (let i = 0; i < RANKS.length; i++) {
        if (totalXp >= RANKS[i].minXp) {
            current = RANKS[i];
            next = RANKS[i + 1] || current;
        }
    }
    return {
        rank: current.rank,
        rankName: current.name,
        xpToNext: next === current ? 0 : next.minXp - totalXp
    };
}

async function getProfileUri(): Promise<vscode.Uri | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return vscode.Uri.joinPath(folders[0].uri, '.socrates_profile.json');
}

export async function getProfile(_context: vscode.ExtensionContext): Promise<PlayerProfile> {
    const uri = await getProfileUri();
    if (!uri) return getDefaultProfile();
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
        return getDefaultProfile();
    }
}

async function saveProfile(profile: PlayerProfile) {
    const uri = await getProfileUri();
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(profile, null, 2), 'utf8'));
}

function getDefaultProfile(): PlayerProfile {
    return {
        totalXp: 0,
        currentRank: 1,
        rankName: "Bug Rookie",
        currentStreak: 0,
        longestStreak: 0,
        lastActiveDate: new Date().toISOString().split('T')[0],
        activeMultiplier: 1.0,
        badges: [],
        xpHistory: []
    };
}

export async function awardXP(context: vscode.ExtensionContext, eventType: string, baseXp: number, _options?: any): Promise<XpEvent> {
    const profile = await getProfile(context);
    
    let multiplier = profile.activeMultiplier || 1.0;
    // Add specific multiplier logic here if needed
    
    const finalXp = Math.round(baseXp * multiplier);
    
    const xpEvent: XpEvent = {
        type: eventType,
        baseXp,
        multiplier,
        finalXp,
        timestamp: new Date().toISOString()
    };
    
    const oldRank = profile.currentRank;
    
    profile.totalXp += finalXp;
    profile.xpHistory.push(xpEvent);
    
    const newRankInfo = getRankForXp(profile.totalXp);
    profile.currentRank = newRankInfo.rank;
    profile.rankName = newRankInfo.rankName;
    
    await saveProfile(profile);
    
    if (profile.currentRank > oldRank) {
        vscode.commands.executeCommand('zeroMagic.rankUp', profile);
    }
    
    return xpEvent;
}

export async function checkAndUpdateStreak(_context: vscode.ExtensionContext) {
    // Stub
}

export async function checkBadgeUnlocks(_context: vscode.ExtensionContext, _profile: PlayerProfile) {
    // Stub
}
