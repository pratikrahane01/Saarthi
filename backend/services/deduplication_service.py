from typing import List
from backend.models.schemas import UnifiedFinding

def deduplicate_findings(findings: List[UnifiedFinding]) -> List[UnifiedFinding]:
    """
    Merge findings that target the same lineNumber.
    Prioritize findings with higher severity (Tier 3 > Tier 2 > Tier 1) and then higher confidence.
    """
    # Group by line number
    grouped: dict[int, List[UnifiedFinding]] = {}
    
    for finding in findings:
        line = finding.lineNumber
        # Line 0 means global or unknown, we don't deduplicate those heavily against each other, 
        # but let's just group them anyway for now, or keep them separate.
        if line == 0:
            # Fake a unique line number for globals so they don't deduplicate against each other
            line = -id(finding)
            
        if line not in grouped:
            grouped[line] = []
        grouped[line].append(finding)
        
    deduplicated = []
    
    severity_map = {
        "Tier 3": 3,
        "Tier 2": 2,
        "Tier 1": 1
    }
    
    for line, group in grouped.items():
        if len(group) == 1:
            deduplicated.append(group[0])
        else:
            # Sort by severity (descending), then confidence (descending)
            group.sort(key=lambda x: (severity_map.get(x.severity, 0), x.confidence), reverse=True)
            
            best_finding = group[0]
            
            # Merge hints from others if they are from different sources to enrich the best finding
            for other in group[1:]:
                # Only merge hints if they are reasonably high confidence and different source
                if other.confidence > 0.5 and other.source != best_finding.source:
                    for hint in other.hints:
                        if hint not in best_finding.hints:
                            best_finding.hints.append(hint)
                            
            deduplicated.append(best_finding)
            
    # Finally, sort deduplicated by line number
    deduplicated.sort(key=lambda x: x.lineNumber if x.lineNumber > 0 else 999999)
    return deduplicated
