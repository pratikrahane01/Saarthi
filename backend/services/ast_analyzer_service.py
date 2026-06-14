import ast
import re
from typing import List
from backend.models.schemas import UnifiedFinding

CONFIDENCE_THRESHOLD = 0.75
BOUNDARY_VAR_NAMES = {"age", "score", "marks", "percentage", "rank", "level"}

class LogicBugVisitor(ast.NodeVisitor):
    def __init__(self):
        self.findings: List[UnifiedFinding] = []
        # Keep track of variable assignments outside loops for check 6
        self.assigned_vars = set()
        self.in_loop = False

    def visit_Assign(self, node):
        if not self.in_loop:
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self.assigned_vars.add(target.id)
        else:
            # Check 6: Accumulator Overwrite Detection
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in self.assigned_vars:
                    self.findings.append(UnifiedFinding(
                        source="ast",
                        category="Logic",
                        confidence=0.9,
                        severity="Tier 3",
                        lineNumber=node.lineno,
                        concept="Variable reassignment inside a loop overwrites previous values instead of accumulating them.",
                        socraticQuestion=f"What happens to the previous value of `{target.id}` during each iteration?",
                        hints=[
                            f"Look at how `{target.id}` is updated.",
                            "Are you adding to the existing value or replacing it entirely?",
                            "Consider using the `+=` operator instead of `=`."
                        ]
                    ))
        self.generic_visit(node)

    def visit_For(self, node):
        # Check 3: Off-by-One Loops
        if isinstance(node.iter, ast.Call):
            if getattr(node.iter.func, "id", None) == "range":
                args = node.iter.args
                if args and isinstance(args[0], ast.BinOp) and isinstance(args[0].op, ast.Sub):
                    right = args[0].right
                    if isinstance(right, ast.Constant) and right.value == 1:
                        if isinstance(args[0].left, ast.Call) and getattr(args[0].left.func, "id", None) == "len":
                            self.findings.append(UnifiedFinding(
                                source="ast",
                                category="Logic",
                                confidence=0.85,
                                severity="Tier 3",
                                lineNumber=node.lineno,
                                concept="Looping up to `len(collection) - 1` with `range()` skips the final element.",
                                socraticQuestion="Will every element in the array be processed by this loop?",
                                hints=[
                                    "Remember that `range(N)` already stops at `N - 1`.",
                                    "What is the maximum index this loop will reach compared to the length of the array?"
                                ]
                            ))
        
        old_in_loop = self.in_loop
        self.in_loop = True
        self.generic_visit(node)
        self.in_loop = old_in_loop

    def visit_While(self, node):
        old_in_loop = self.in_loop
        self.in_loop = True
        self.generic_visit(node)
        self.in_loop = old_in_loop

    def visit_BinOp(self, node):
        # Check 1: Division by Zero Risk
        if isinstance(node.op, ast.Div):
            # If denominator is potentially variable or length of something
            if isinstance(node.right, ast.Call) or isinstance(node.right, ast.Name):
                self.findings.append(UnifiedFinding(
                    source="ast",
                    category="Logic",
                    confidence=0.8,
                    severity="Tier 3",
                    lineNumber=node.lineno,
                    concept="Division operations fail if the denominator evaluates to zero.",
                    socraticQuestion="What happens if the denominator is empty or evaluates to 0?",
                    hints=[
                        "Consider checking the value of the denominator before performing the division."
                    ]
                ))
        self.generic_visit(node)

    def visit_Subscript(self, node):
        # Check 2: Empty Collection Risk
        # For Python >= 3.9, the slice is simply the constant. For older it's Index(Constant)
        slice_val = getattr(node.slice, "value", node.slice)
        if isinstance(slice_val, ast.Constant) and slice_val.value == 0:
            if isinstance(node.value, ast.Name):
                self.findings.append(UnifiedFinding(
                    source="ast",
                    category="Logic",
                    confidence=0.8,
                    severity="Tier 3",
                    lineNumber=node.lineno,
                    concept="Accessing elements from an empty collection raises an IndexError.",
                    socraticQuestion=f"What happens when `{node.value.id}` contains no elements?",
                    hints=[
                        "Does your code guarantee that the collection is not empty before accessing index 0?",
                        "Consider checking the length of the collection first."
                    ]
                ))
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        # Check 4: Missing Return Paths
        has_conditional_return = False
        has_terminal_return = False

        for stmt in node.body:
            if isinstance(stmt, ast.If):
                # Deep check for return inside If
                for sub_stmt in ast.walk(stmt):
                    if isinstance(sub_stmt, ast.Return):
                        has_conditional_return = True
            elif isinstance(stmt, ast.Return):
                has_terminal_return = True

        if has_conditional_return and not has_terminal_return:
            # Also check if the very last statement is a Return, just to be sure
            last_stmt = node.body[-1]
            if not isinstance(last_stmt, ast.Return) and not isinstance(last_stmt, ast.Raise):
                self.findings.append(UnifiedFinding(
                    source="ast",
                    category="Logic",
                    confidence=0.85,
                    severity="Tier 3",
                    lineNumber=node.lineno,  # point to the function definition
                    concept="Functions should return a predictable value along all execution paths.",
                    socraticQuestion="What value is returned when the conditional is false?",
                    hints=[
                        "You return a value inside an `if` block, but what happens if that condition isn't met?",
                        "In Python, a function without an explicit return statement returns `None`."
                    ]
                ))
        self.generic_visit(node)

    def visit_Compare(self, node):
        # Check 5: Comparison Boundary Bugs (High Confidence Only)
        ops = node.ops
        if len(ops) == 1 and isinstance(ops[0], (ast.Gt, ast.Lt, ast.GtE, ast.LtE)):
            # Check if left or right is a Name matching our heuristics
            left = getattr(node.left, "id", "") if isinstance(node.left, ast.Name) else ""
            right = getattr(node.comparators[0], "id", "") if isinstance(node.comparators[0], ast.Name) else ""
            
            if any(bn in left.lower() for bn in BOUNDARY_VAR_NAMES) or any(bn in right.lower() for bn in BOUNDARY_VAR_NAMES):
                self.findings.append(UnifiedFinding(
                    source="ast",
                    category="Logic",
                    confidence=0.9, # High confidence because of semantic filtering
                    severity="Tier 3",
                    lineNumber=node.lineno,
                    concept="Off-by-one errors often occur when boundary conditions are incorrectly excluded or included.",
                    socraticQuestion="Should the boundary condition be included in this comparison?",
                    hints=[
                        "Does the logic require greater-than or greater-than-or-equal-to?",
                        "Check the exact boundary value requirements."
                    ]
                ))
        self.generic_visit(node)


def analyze_ast(source_code: str) -> List[UnifiedFinding]:
    try:
        tree = ast.parse(source_code)
    except SyntaxError as e:
        # If the file has a syntax error, we must report it as a Tier 1 issue.
        # This acts as a reliable fallback when VS Code diagnostics are empty
        # (e.g., untracked files outside the workspace).
        return [UnifiedFinding(
            source="ast",
            category="Syntax",
            confidence=1.0,
            severity="Tier 1",
            lineNumber=e.lineno or 1,
            concept=f"SyntaxError: {e.msg}" if hasattr(e, "msg") else "SyntaxError: Invalid syntax",
            socraticQuestion="What is causing the Python parser to fail on this line?",
            hints=[
                "Check for missing colons, parenthesis, or typos.",
                "Syntax errors prevent the code from compiling."
            ]
        )]
    
    visitor = LogicBugVisitor()
    visitor.visit(tree)

    # Filter out findings below confidence threshold
    valid_findings = [f for f in visitor.findings if f.confidence >= CONFIDENCE_THRESHOLD]
    
    return valid_findings
