# Team Assignment — Socrates Implementation Plan
### 3-Person Division of Work

---

## The Split Logic

| Person | Role | Languages | Owns |
|--------|------|-----------|------|
| **Person 1** | Backend Architect | Python / FastAPI | All backend API, schemas, Groq prompts, journal, concept graph |
| **Person 2** | Extension Architect | TypeScript | Core extension logic — XP engine, error memory, debug trainer, journal writer, watcher wiring |
| **Person 3** | UI / Frontend | TypeScript + CSS (Webview) | All sidebar visual panels, animations, XP bar, badges, concept web rendering |

---

## Person 1 — Backend Architect
**"You own everything that runs on the FastAPI server"**

You are responsible for all Python files. Your job is to build the APIs that Persons 2 and 3 will call. Build them in order — Person 2 is waiting on you for journal and concept endpoints.

### Your Files

#### Phase 1 — Error Memory Backend
- **[MODIFY]** `backend/models/schemas.py`
  - Add `repeatCount: int` field to `TierClassifyRequest`
  - Add `pastExampleMessages: list[str]` field to `TierClassifyRequest`

- **[MODIFY]** `backend/services/groq_service.py`
  - Update `generate_dynamic_mission()` to accept `repeat_count: int`
  - When `repeat_count >= 3`, inject confrontational tone into the system prompt
  - The prompt addition:
    ```
    IMPORTANT: This student has hit this error {repeat_count} times before.
    Your first question MUST force them to recall the pattern from memory.
    Be more direct. Less hand-holding.
    ```

#### Phase 3 — Challenge Arena Refinements
- **[MODIFY]** `backend/services/hidden_test_service.py`
  - Add `_build_challenge_header(concept_explanation, wrong_fix_example)` helper
  - Prepend the WHY THIS MATTERS + COMMON WRONG FIX comment block to every generated file
  - Append the CHECKPOINT fill-in-the-blank comment at the bottom of every challenge file

- **[MODIFY]** `backend/services/groq_service.py`
  - Add `generate_challenge_metadata(language, error_code, message)` function
  - Returns: `concept_explanation`, `wrong_fix_example`, `checkpoint_blank`
  - Call this from `hidden_test_service.py` when building challenge files

#### Phase 4 — Debug Journal API
- **[NEW]** `backend/routers/journal.py`
  - `POST /v1/journal/entry` — accepts a journal entry JSON payload, validates it, returns it with a server-generated `id`
  - `GET /v1/journal/summary` — accepts a list of entries (or reads from a body), returns aggregate stats:
    ```python
    {
        "totalBugsFixed": 23,
        "totalXpEarned": 3450,
        "mostCommonError": "NameError",
        "averageTimeToSolveMs": 187000,
        "fastestFixMs": 42000,
        "hintsUsedAllTime": 14
    }
    ```

- **[MODIFY]** `backend/main.py`
  - Import and register the new journal router under `/v1/journal`

#### Phase 5 — Concept Graph API
- **[NEW]** `backend/services/concept_graph_service.py`
  - Contains the full static `CONCEPT_MAP` dictionary (errorCode → concept name)
  - Contains the `CONCEPT_RESOURCES` dictionary (concept name → curated URL)
  - `get_concept(error_code: str) -> str`
  - `get_resource(concept: str) -> str`
  - `build_web_payload(error_codes: list[str]) -> dict` — aggregates counts and builds the graph JSON

- **[NEW]** `backend/routers/concepts.py`
  - `POST /v1/concepts/web` — accepts `{ "errorCodes": ["NameError", "TypeError", ...] }`, returns:
    ```json
    {
      "nodes": [
        { "concept": "Variable Scope", "count": 7, "errors": ["NameError", "AttributeError"], "resourceUrl": "..." }
      ],
      "dominantConcept": "Variable Scope"
    }
    ```

- **[MODIFY]** `backend/main.py`
  - Import and register the new concepts router under `/v1/concepts`

---

### Your Build Order
```
1. schemas.py changes (Phase 1) — unblocks groq changes
2. groq_service.py changes (Phase 1 + 3) — confrontational mode + challenge metadata
3. hidden_test_service.py (Phase 3) — challenge file headers
4. journal.py + main.py (Phase 4) — Person 2 is waiting on this
5. concept_graph_service.py + concepts.py + main.py (Phase 5)
```

### Your API Contract (share with Person 2)
Person 2 will call these endpoints from TypeScript. Make sure responses match exactly:

| Endpoint | Method | Called by |
|----------|--------|-----------|
| `/v1/missions/classify-tier` | POST | Person 2 (watcher.ts) — now with `repeatCount` field |
| `/v1/journal/entry` | POST | Person 2 (debugJournal.ts) |
| `/v1/journal/summary` | GET | Person 2 (debugJournal.ts) |
| `/v1/concepts/web` | POST | Person 2 (calls on journal tab open) |

---

## Person 2 — Extension Architect
**"You own the TypeScript brain of the extension — all logic, no visuals"**

You build all the state management, storage, XP math, and wiring. Person 3 will call your exported functions to display data. Person 1 is building the APIs you'll call. Build your modules with mock data first so Person 3 can start working in parallel.

### Your Files

#### Phase 6 — XP Engine (Build This FIRST)
- **[NEW]** `src/xpEngine.ts`

  **Storage:** Reads/writes `.socrates_profile.json` in the workspace root via `vscode.workspace.fs`.

  ```typescript
  // Key interfaces you must export:

  interface PlayerProfile {
    totalXp: number;
    currentRank: number;         // 1–7
    rankName: string;
    currentStreak: number;
    longestStreak: number;
    lastActiveDate: string;      // "YYYY-MM-DD"
    activeMultiplier: number;
    badges: string[];
    xpHistory: XpEvent[];
  }

  interface XpEvent {
    type: string;
    baseXp: number;
    multiplier: number;
    finalXp: number;
    timestamp: string;
  }

  // Multiplier rules (apply in awardXP):
  // 3-day streak:  1.5x
  // 7-day streak:  2.0x
  // first attempt: 1.25x
  // zero hints:    1.5x
  // repeat error:  0.8x (penalty)
  ```

  **Exports:**
  - `awardXP(context, eventType, baseXp, options?)` → returns `XpEvent`, fires `zeroMagic.rankUp` on rank-up
  - `getProfile(context)` → returns `PlayerProfile`
  - `checkAndUpdateStreak(context)` → call on extension activate, updates streak
  - `checkBadgeUnlocks(context, profile)` → checks all badge conditions, awards new ones
  - `getRankForXp(totalXp)` → pure function, returns `{ rank, rankName, xpToNext }`

  **Rank thresholds:**
  ```typescript
  const RANKS = [
    { rank: 1, name: "Bug Rookie",     minXp: 0 },
    { rank: 2, name: "Syntax Warrior", minXp: 500 },
    { rank: 3, name: "Logic Hunter",   minXp: 1500 },
    { rank: 4, name: "Stack Tracer",   minXp: 3500 },
    { rank: 5, name: "Debug Archer",   minXp: 7500 },
    { rank: 6, name: "Error Slayer",   minXp: 15000 },
    { rank: 7, name: "Debug Master",   minXp: 30000 },
  ];
  ```

#### Phase 1 — Error Memory
- **[NEW]** `src/errorMemory.ts`

  **Storage:** `vscode.ExtensionContext.globalState` under key `"zeroMagic.errorMemory"`.

  ```typescript
  interface ErrorRecord {
    count: number;
    firstSeen: string;
    lastSeen: string;
    exampleMessages: string[]; // Max 3, rotate out old ones
  }
  // Stored as: { [languageId]: { [errorCode]: ErrorRecord } }
  ```

  **Exports:**
  - `recordError(context, languageId, errorCode, message)` → updates storage, returns updated `ErrorRecord`
  - `getErrorRecord(context, languageId, errorCode)` → returns `ErrorRecord | null`
  - `getTopRepeatOffenders(context, languageId, limit)` → returns sorted array

- **[MODIFY]** `src/watcher.ts`
  - In `processDiagnostics()`, after extracting the primary error:
    1. Call `recordError(context, languageId, errorCode, message)`
    2. Call `awardXP(context, 'error_encountered', 5)`
  - Pass `repeatCount` from `getErrorRecord()` into the `DiagnosticEvent` payload (add field to the interface)

#### Phase 2 — Debug Trainer
- **[NEW]** `src/debugTrainer.ts`

  **Storage:** `vscode.ExtensionContext.workspaceState` under key `"zeroMagic.rituals"`.

  ```typescript
  interface DebugRitualState {
    missionId: string;
    step: 0 | 1 | 2 | 3;      // 3 = complete
    step1Response: string;
    step2Response: string;
    hypothesis: string;         // step3Response
    startedAt: string;
    completedAt?: string;
  }
  ```

  **Exports:**
  - `getRitualState(context, missionId)` → `DebugRitualState | null`
  - `initRitual(context, missionId)` → creates fresh state for a new mission
  - `advanceStep(context, missionId, response)` → saves response, increments step, awards XP
  - `isRitualComplete(context, missionId)` → `boolean`
  - `canSkipRitual(context)` → `boolean` — returns true if player rank >= 3

- **[MODIFY]** `src/missions.ts`
  - In `executeMissionHandOff()`, call `initRitual(context, mission.id)` before rendering sidebar
  - Pass `canSkipRitual()` result to the sidebar render command

#### Phase 4 — Debug Journal
- **[NEW]** `src/debugJournal.ts`

  **Storage:** `.socrates_journal.json` in workspace root via `vscode.workspace.fs`. Append-only.

  ```typescript
  interface JournalEntry {
    id: string;               // "entry_001", incrementing
    timestamp: string;
    language: string;
    errorCode: string;
    errorFlag: string;
    repeatNumber: number;
    step1Response: string;
    step2Response: string;
    hypothesis: string;
    rootCauseSummary: string; // from post-challenge reflection
    hintsUsed: number;
    timeToSolveMs: number;
    testPassedOnAttempt: number;
    xpEarned: number;
  }
  ```

  **Exports:**
  - `addEntry(context, entryData)` → writes to JSON file, also POSTs to `/v1/journal/entry`
  - `getAllEntries(context)` → reads file, returns array
  - `getStats(context)` → calls `GET /v1/journal/summary`, returns stats

#### Phase 5 — Concept Web Data Fetching
- **[NEW]** `src/conceptWeb.ts`
  - `fetchConceptWeb(context)` → reads all error codes from journal, POSTs to `/v1/concepts/web`, returns the graph payload
  - Person 3 calls this function to get the data needed to render the visualization

---

### Your Build Order
```
1. xpEngine.ts — everything else plugs into this
2. errorMemory.ts — then wire it into watcher.ts
3. debugTrainer.ts — then wire it into missions.ts
4. debugJournal.ts — depends on Phase 3 being done (needs reflection response)
5. conceptWeb.ts — depends on journal having data
```

### Your Export Contract (share with Person 3)
Person 3 will import and call these from the sidebar. Make sure they are exported cleanly:

| Module | Function | What Person 3 uses it for |
|--------|----------|--------------------------|
| `xpEngine.ts` | `getProfile()` | XP bar, rank display, streak counter |
| `xpEngine.ts` | `awardXP()` | Called after each UI action |
| `errorMemory.ts` | `getTopRepeatOffenders()` | "Your Patterns" panel |
| `errorMemory.ts` | `getErrorRecord()` | Repeat banner on mission card |
| `debugTrainer.ts` | `getRitualState()` | Render which ritual step is active |
| `debugTrainer.ts` | `advanceStep()` | Called when user clicks "Next →" |
| `debugTrainer.ts` | `canSkipRitual()` | Show/hide skip button |
| `debugJournal.ts` | `getAllEntries()` | Journal feed in sidebar |
| `debugJournal.ts` | `getStats()` | Stats bar, milestone badges |
| `conceptWeb.ts` | `fetchConceptWeb()` | Concept web visualization data |

---

## Person 3 — UI / Frontend
**"You own everything the user sees and touches in the sidebar"**

You work entirely inside `src/ui/sidebar.ts`. You don't build any logic — you call the functions Person 2 exports and display what they return. You make it look amazing.

> **Start day 1** by rendering fake hardcoded data for the XP bar and journal feed so you can build and polish the UI without waiting on Person 2. Swap real data in later.

### Your Files

#### Phase 6 — XP Panel (Top of Sidebar, always visible)
- **[MODIFY]** `src/ui/sidebar.ts`

  **XP Progress Bar** (slim bar at top, always rendered):
  - Shows: `[Rank Icon] Logic Hunter  ████████░░░░  1340 / 1500 XP`
  - On every XP award, a **"+X XP" toast** floats up and fades out over 1.5 seconds (pure CSS animation, no library needed)
  - Current streak badge: `🔥 5-day streak`

  **Rank-Up Celebration** (full-panel overlay, triggered by `zeroMagic.rankUp` command):
  - Center of sidebar fills with large rank icon + new rank name
  - CSS confetti animation (colored dots falling)
  - Text: `"You are now a Logic Hunter 🔍"` + one-line perk description
  - Auto-dismisses after 4 seconds with a fade-out

#### Phase 2 — Debug Ritual UI
- **[MODIFY]** `src/ui/sidebar.ts`

  When `isRitualComplete()` is false, render the ritual UI **instead of** the mission card:

  ```
  ┌────────────────────────────────────┐
  │  Step 2 of 3 — Find the Evidence   │
  │  ──────────────────────────────   │
  │  Go to the line in the error.      │
  │  What code is there? What did      │
  │  you expect vs what IS there?      │
  │                                    │
  │  [  textarea                    ]  │
  │  [  12 / 20 minimum characters  ]  │
  │                                    │
  │  ✓ Step 1 complete                 │
  │                                    │
  │  [← Back]          [Next Step →]   │
  └────────────────────────────────────┘
  ```

  - Character counter updates live as user types (JS `input` event listener)
  - "Next Step →" button is `disabled` and greyed until `input.length >= 20`
  - Completed steps show as collapsed green checkmarks above the active step
  - Call `advanceStep(context, missionId, response)` on button click
  - If `canSkipRitual()` is true, show a dim `Skip (Rank 3+)` link below the buttons

#### Phase 1 — Repeat Error Banner + Patterns Tab
- **[MODIFY]** `src/ui/sidebar.ts`

  **Repeat banner** (shown at top of mission card when `errorRecord.count >= 2`):
  ```
  ⚠️  You've hit NameError 3 times before.
      Last time: 2 days ago. What's the pattern?
  ```
  Styled with an amber/orange left-border, muted background.

  **"Your Patterns" tab** in sidebar navigation:
  - Table of repeat errors: Error Code | Count | Last Hit | First Hit
  - Sorted by count descending
  - Each row clickable — expands to show the 3 stored example messages

#### Phase 3 — Post-Challenge Reflection Panel
- **[MODIFY]** `src/ui/sidebar.ts`

  After test-pass, slide up a reflection card over the mission panel:

  ```
  ┌────────────────────────────────────┐
  │  🎉 Tests Passed!                   │
  │  ──────────────────────────────   │
  │  Before we unlock — one question:  │
  │                                    │
  │  In one sentence, what was the     │
  │  root cause of your original       │
  │  error?                            │
  │                                    │
  │  [  textarea                    ]  │
  │  [  8 / 15 minimum characters   ]  │
  │                                    │
  │  [Submit & Unlock ✓]               │
  └────────────────────────────────────┘
  ```

  - "Submit & Unlock" button disabled until 15 chars minimum
  - On submit: call `addEntry()` with all session data, then call `unlockMission()`
  - After unlock: slide-out animation, show the success state

#### Phase 4 — Journal Tab
- **[MODIFY]** `src/ui/sidebar.ts`

  **"My Journal"** tab content:

  **Stats bar** at top:
  ```
  🐛 23 Bugs Fixed   ⚡ 3,450 XP   ⏱ Avg 3m 07s
  ```

  **Milestones row** (progress toward next badge):
  ```
  [🏅 10 ✓] [🥈 25 ✓] [🥇 50 ░░░░░] [🏆 100 ░░░]
  ```

  **Badges grid** (2 columns):
  - Earned badges: full color icon + name + date earned
  - Locked badges: greyed icon + "?" + hint text (e.g., "Pass a challenge on first attempt")
  - Badges to implement:
    - 🐛 First Bug Fixed
    - 🔥 3-Day Streak
    - 🧊 Ice Cold (first attempt, zero hints)
    - 🎯 Sharpshooter (hypothesis matched root cause 3 times)
    - 💨 Speed Demon (solved in under 2 minutes)
    - 🔄 Broke the Pattern (hit same error 5x, then 30 days clean)
    - 📖 Bookworm (clicked 10 resource links)
    - 🧠 No Hints Needed (5 missions, zero hints total)

  **Feed** (scrollable, newest first):
  ```
  NameError — Jun 11, 2026 — 2m 34s — 1 hint — +165 XP
  > "Used result before assigning it any value"
  ───────────────────────────────────────────
  TypeError — Jun 10, 2026 — 5m 12s — 3 hints — +55 XP
  > "Added a string to an int without converting"
  ```

#### Phase 5 — Concept Web Visualization
- **[MODIFY]** `src/ui/sidebar.ts`

  **"Concept Web"** tab content:

  Call `fetchConceptWeb()` from `conceptWeb.ts` on tab open.

  Render concept nodes as HTML `div` elements styled as circular bubbles:
  - Size: `width = 60px + (count * 8px)`, capped at `140px`
  - Color: each concept gets a fixed color (hardcode a palette of 8 colors)
  - Layout: CSS flexbox wrapping, centered

  Below the bubbles:
  ```
  📍 Your biggest knowledge gap: Variable Scope (7 hits)

  [📖 Read: Python LEGB Scope Rule →]
  ```
  The button opens the URL in the system browser via `vscode.env.openExternal()`.

  Clicking a bubble:
  - Expands inline to show the list of specific errors under that concept
  - Shows individual counts: `NameError (4)`, `AttributeError (3)`

---

### Your Build Order
```
1. XP bar + fake data first — get the visual scaffolding working
2. Ritual UI (Phase 2) — most complex UI, needs the most polish
3. Repeat banner + Patterns tab (Phase 1)
4. Post-challenge reflection panel (Phase 3)
5. Journal tab — stats, milestones, badges, feed (Phase 4)
6. Concept web (Phase 5) — last, depends on journal data
```

### What to Ask Person 2 For
- The TypeScript interfaces for `PlayerProfile`, `DebugRitualState`, `JournalEntry` — ask for these on Day 1 so you can build against them with mock data.
- Let Person 2 know which sidebar functions you need so they can export them correctly.

---

## Integration Checkpoints (All 3 Meet Here)

| Checkpoint | When | What to verify |
|-----------|------|----------------|
| **CP1** | After Person 1 finishes schemas + Person 2 finishes watcher.ts | `repeatCount` is flowing from watcher → API → Groq prompt |
| **CP2** | After Person 2 finishes xpEngine + Person 3 finishes XP bar | XP award in `awardXP()` causes bar to update live in sidebar |
| **CP3** | After Person 1 finishes journal API + Person 2 finishes debugJournal.ts | POST to `/v1/journal/entry` succeeds, JSON file updated |
| **CP4** | After Person 3 finishes ritual UI + Person 2 finishes debugTrainer.ts | Step 1 → 2 → 3 flow works end-to-end, mission card unlocks |
| **CP5** | After all 3 finish Phase 5 | Concept web renders with real data from journal |
