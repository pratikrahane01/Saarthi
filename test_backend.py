import sys
import os
sys.path.insert(0, os.path.abspath('.'))
from backend.services.groq_service import generate_dynamic_mission
from backend.services.context_service import resolve_primary_context

res = generate_dynamic_mission(
    language='python',
    error_code='SyntaxError',
    message='SyntaxError: invalid syntax',
    source_code='def greet(\n    \"\"\n)\n',
    terminal_output='File "test.py", line 2\n    ""\n   ^\nSyntaxError: invalid syntax\n',
    exit_code=1
)
print(res)
