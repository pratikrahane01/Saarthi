# Team Assignments & TODOs

Here is the 14-day build plan divided logically across 4 teammates. The division ensures everyone can work somewhat independently while combining their work smoothly during integration.

---

## 🛠️ Teammate 1: Infrastructure & Core Logic (The Plumber)
**Focus:** Project setup, file system operations, and full cycle cleanup.

- [ ] **Phase 0: Project Scaffold (Day 1)**
  - [ ] Initialize VS Code extension structure (`package.json`, `tsconfig.json`).
  - [ ] Setup `extension.ts` as the entry point.
  - [ ] Scaffold FastAPI backend (`main.py`, `requirements.txt`).
  - [ ] Create placeholder directories/files (`src/`, `missions/`).
- [ ] **Phase 3: The On-Demand Interceptor (Day 4)**
  - [ ] Implement `interceptor.ts` triggered by the Quick Fix Code Action.
  - [ ] Use `vscode.workspace.fs` to safely write hidden test files to `.zero_magic/tests/`.
  - [ ] Ensure `.gitignore` is updated automatically.
- [x] **Phase 6: The Unlock Flow (Day 9)**
  - [x] Build the cleanup sequence when tests pass.
  - [x] Delete the hidden test file.
  - [x] Post `{ type: 'UNLOCK', missionId }` to the webview to show a success state.
  - [x] Show VS Code `information message` ("✓ Milestone unlocked. Well done.").
- [ ] **Phase 10: Submission Lead (Day 14)**
  - [ ] Package the extension using `vsce package` into a `.vsix` file.
  - [ ] Finalize the README and architecture diagrams.

---

## 👁️ Teammate 2: VS Code Events & Matching (The Observer)
**Focus:** Listening to user actions, capturing errors, and finding the right mission.

- [ ] **Phase 1: The Watcher & Quick Fix (Day 2)**
  - [ ] Implement `watcher.ts`.
  - [ ] Listen to `vscode.languages.onDidChangeDiagnostics` and filter for errors.
  - [ ] Register a `CodeActionProvider` to provide the "💡 Help me think (Zero-Magic)" Quick Fix button on those errors.
  - [ ] Emit clean `DiagnosticEvent` object when the Quick Fix is clicked.
- [ ] **Phase 2: The Mission Matcher (Day 3)**
  - [ ] Implement `missions.ts`.
  - [ ] Fetch mission data/tests from the **FastAPI backend**.
  - [ ] Create logic to take a `DiagnosticEvent` and find the matching mission using `errorCode` and `language`.
  - [ ] Return the `Mission` object or `null` if no match.
- [ ] **Phase 8: Integration & Edge Cases (Day 11-12)**
  - [ ] Handle concurrent error queues (what if multiple errors fire?).
  - [ ] Handle missing missions ("No mission for this error").

---

## 🏃 Teammate 3: Execution Engine (The Runner)
**Focus:** Spawning child processes and parsing test results securely.

- [ ] **Phase 4: The Runner (Day 5-6)**
  - [ ] Implement `runner.ts`.
  - [ ] Detect Python/Node paths correctly on Mac/Windows/Linux (e.g., `python` vs `python3`).
  - [ ] Spawn tests using Node's `child_process.spawn({ detached: false })`.
  - [ ] Implement a 15-second timeout safeguard.
  - [ ] Parse pytest/jest output (e.g., exit code `0` = pass, anything else = fail).
  - [ ] Return `{ passed: boolean, duration: number }` securely without exposing raw logs.
- [ ] **Phase 8: Integration & Edge Cases (Day 11-12)**
  - [ ] Graceful failures if Python/Node is not installed (show user setup error).
  - [ ] Extension deactivation cleanup (kill running subprocesses).

---

## 🎨 Teammate 4: UI, Content & Demo (The Face)
**Focus:** The webview sidebar, mission content generation, and presentation polish.

- [ ] **Phase 5: The Socratic Dashboard (Day 7-8)**
  - [ ] Create the Webview sidebar (`ui/sidebar.ts` & `webview/index.html`).
  - [ ] Implement UI states: IDLE, QUESTIONING, HINTING, PASSED, FAILED.
  - [ ] Implement Socratic dialogue: explain concepts, ask questions, provide hints (no direct code).
  - [ ] Implement 2-way message passing (`postMessage`) between VS Code and the Webview.
- [ ] **Phase 7: Backend Mission Generation (Day 10)**
  - [ ] Write FastAPI endpoints to handle mission generation via Codex/LLM API.
  - [ ] Generate distinct missions (Python: NameError, TypeError, etc. / JS: undefined is not a function).
  - [ ] Ensure each mission has Socratic questions, hints, and a valid test payload.
- [ ] **Phase 9: Demo Polish (Day 13)**
  - [ ] Add real-time "Attempts: N" counter to the sidebar.
  - [ ] Add a `DEMO MODE` flag to force a scripted sequence of missions for the pitch.
  - [ ] Record the 90-second Loom demo video.

---

## 🚀 How to collaborate effectively
- **Day 1-4:** Teammate 1 and 2 can work in parallel. Teammate 1 builds the skeleton, while Teammate 2 starts writing the logic for the watcher and matcher locally. Teammate 3 and 4 can start researching their respective APIs (child_process, VS Code Webview).
- **Day 5-8:** Teammate 3 focuses fully on the runner, while Teammate 4 builds the UI. Teammate 1 and 2 support integration points.
- **Day 11+:** The whole team focuses on Phase 8 (Integration) to squash bugs and ensure the "Zero-Magic" loop feels flawless.
