# Zero-Magic Deconstruction Agent

This is the full execution plan for the Zero-Magic Deconstruction Agent, a VS Code extension that intercepts broken code at save-time and replaces AI hand-holding with failing unit tests.

## User Review Required

Please review the build plan below. Once approved, I will begin **Phase 0** and generate the full project scaffold, including `package.json`, `tsconfig.json`, `extension.ts` entry point, and the folder structure.

## Open Questions

- We are adding a **FastAPI backend** based on your request. Should the backend just serve `missions.json` and generate missions (Codex API), or do you want the test execution (Runner) to happen on the backend as well instead of locally on the user's machine?
- Do you have `yo` (Yeoman) and `generator-code` installed globally to generate the extension skeleton, or should I generate the files manually or use `npx`?
- Will we use `npm` or `yarn` or `pnpm` for package management for the extension?

## Proposed Changes

The build plan is broken down into 10 phases over 14 days.

### Phase 0 — Project Scaffold (Day 1)
- Create the basic directory structure.
- Scaffold VS Code extension (TypeScript).
- Scaffold the **FastAPI backend** (Python).
- Setup `requirements.txt` and a basic `main.py` for the FastAPI service.

### Phase 1 — The Watcher & Quick Fix (Day 2)
- Implement `watcher.ts` to listen to `vscode.languages.onDidChangeDiagnostics`.
- Filter for `DiagnosticSeverity.Error` and provide a VS Code **Code Action (Quick Fix)** button on the error: `"💡 Help me think (Zero-Magic)"`.
- The user must explicitly click this button to trigger the Socratic assistant.

### Phase 2 — The Mission Matcher (Day 3)
- Implement `missions.ts` to fetch missions from the **FastAPI backend** or match diagnostic events to cached missions based on error code and language.

### Phase 3 — The On-Demand Interceptor (Day 4)
- Implement `interceptor.ts`. When the user clicks the "Help me think" button, it drops hidden test files into `.zero_magic/tests/` and opens the Socratic Dashboard.

### Phase 4 — The Runner (Day 5–6)
- Implement `runner.ts` to execute hidden tests via Node's `child_process.spawn`.
- Capture pass/fail signals.

### Phase 5 — The Socratic Dashboard (Day 7–8)
- Build a Webview sidebar panel to act as a Socratic teacher.
- **UX Update**: When triggered, it explains the actual problem concept, asks critical questions to make the user think, and provides hints (strictly NO direct code answers).
- Shows the current mission objectives and test status on-demand.
- Implement communication between extension and webview.

### Phase 6 — The Resolution Flow (Day 9)
- Implement full cleanup sequence when tests pass (delete hidden file, update manifest, notify UI with a success message, log history).

### Phase 7 — Backend Services & Mission Generation (Day 10)
- Expand the **FastAPI backend** to include an endpoint for auto-generating missions using the Codex API.
- Create endpoints to serve existing missions to the VS Code extension.

### Phase 8 — Integration & Hardening (Day 11–12)
- Wire everything together.
- Handle edge cases (missing Python, concurrent errors, user deletion of hidden files, etc.).

### Phase 9 — Demo Polish (Day 13)
- Add attempt counters, completion screen, and a `DEMO MODE` toggle for hackathon presentations.

### Phase 10 — Submission (Day 14)
- Package the extension into a `.vsix` file.
- Finalize README and submission assets.

## Verification Plan

### Automated Tests
- The extension itself will run hidden `pytest`/`jest` tests against user code.
- We will verify the runner logic by providing known passing/failing code snippets and asserting the extension state.

### Manual Verification
- We will install the extension locally in a test VS Code instance (Extension Development Host).
- We will trigger errors (e.g., Python `NameError`) and verify the sidebar UI updates, the hidden file is created, and fixing the code unlocks the UI.
