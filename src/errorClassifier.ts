import { BuiltContext } from './contextBuilder';

export enum ErrorTier {
    TIER_1_MICRO = 1,
    TIER_2_HYPOTHESIS = 2,
    TIER_3_MISSION = 3
}

export interface ClassificationResult {
    tier: ErrorTier;
    complexityScore: number;
    reason: string;
}

const TIER_1_KEYWORDS = [
    'syntax', 'indentation', 'token', 'colon', 'quote', 'bracket', 'parenthesis',
    'unexpected EOF', 'expected', 'invalid syntax'
];

export function classifyError(ctx: BuiltContext, diagnosticCount: number): ClassificationResult {
    let complexityScore = 1;
    let tier: ErrorTier = ErrorTier.TIER_2_HYPOTHESIS;
    let reason = "Standard runtime exception";

    const msgLower = ctx.diagnosticMessage.toLowerCase();
    const isSyntax = TIER_1_KEYWORDS.some(k => msgLower.includes(k));
    
    // Check for Tier 3 conditions
    const hasTraceback = ctx.terminalOutput.toLowerCase().includes('traceback');
    const hasMultipleErrors = diagnosticCount >= 3;
    
    if (hasTraceback) complexityScore += 1;
    if (hasMultipleErrors) complexityScore += 1;
    // We can add more complexity factors based on the AST or source code length here
    if (ctx.sourceCode.length > 2000) complexityScore += 1;

    if (hasMultipleErrors || hasTraceback || complexityScore >= 3) {
        tier = ErrorTier.TIER_3_MISSION;
        reason = "Complex error or multiple bugs detected.";
    } else if (isSyntax) {
        tier = ErrorTier.TIER_1_MICRO;
        reason = "Simple syntax error.";
    }

    return {
        tier,
        complexityScore,
        reason
    };
}
