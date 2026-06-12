# Socrates — Updated Full Implementation Plan
### Goal: Build a tool that makes programmers stronger, not more dependent

---

## What We Are Building & Why

The current flow:
> Error → LLM gives hints → Student fixes code → **Same mistake happens next week**

The new flow:
> Error → Student thinks it through step-by-step → Student solves it → **Brain records the pattern** → Same mistake never happens again

Every feature below is designed to **burn the debugging pattern into long-term memory** rather than outsource the thinking to an AI. The XP system is the motivational engine that keeps students coming back to do the hard thinking work.

---

## Open Questions (Need Your Decision Before Execution)

> [!IMPORTANT]
> **Q1: XP Persistence** — Where should XP and rank data live?
> - Option A: `vscode.ExtensionContext.globalState` — simple, automatic, resets on extension reinstall
> - Option B: `.socrates_profile.json` in workspace root — visible file, portable, user can see their own data
> - **Recommendation**: Option B — students should be able to see and keep their progress file

> [!IMPORTANT]
> **Q2: Challenge Exercises** — Should Phase 3 challenge files be:
> - Option A: **Static pre-written** — curated, perfect quality, ships fast, limited variety
> - Option B: **Groq-generated dynamically** — infinite variety, needs API, occasional quality variance
> - **Recommendation**: Hybrid — static exercises for the 10 most common errors, Groq fallback for everything else

> [!IMPORTANT]
> **Q3: Debug Ritual Gate** — Phase 2 forces 3 steps before hints unlock. Should this be:
> - Option A: **Always mandatory** — maximum learning, can feel slow when you're in a hurry
> - Option B: **Skippable after Rank 3** — rewarded for proving you've built the habit already
> - **Recommendation**: Option B — makes the rank system feel meaningful

---

## Phase 1 — Smart Error Memory
**The idea in one line:** *Make the student feel the weight of repeating the same mistake.*

### What it does
The system silently keeps a personal record of every error you hit. When you hit `NameError` for the 3rd time this week, the sidebar shows a red banner:

> ⚠️ **You've hit NameError 3 times this week.**
> Your last hit was 2 days ago. What's the pattern?

The Groq prompt also changes. On a first-time error it's gentle and exploratory. On the 3rd+ repeat, it becomes more direct:
> *"You've seen this before. Without looking at hints — what always needs to exist before Python can use a name?"*

### Files to Create / Modify

#### [NEW] `src/errorMemory.ts`
Manages the error history stored in `vscode.ExtensionContext.globalState`.

**Data structure stored:**
```typescript
interface ErrorRecord {
  count: number;
  firstSeen: string;       // ISO timestamp
  lastSeen: string;        // ISO timestamp
  exampleMessages: string[]; // Last 3 raw error messages, for context
}

// Stored as: errorMemory[languageId][errorCode] = ErrorRecord
```

**Exports:**
- `recordError(context, languageId, errorCode, message)` — called every time watcher.ts catches an error
- `getErrorRecord(context, languageId, errorCode)` — returns the full record for one error type
- `getTopRepeatOffenders(context, languageId, limit)` — returns the N most repeated errors, sorted by count

#### [MODIFY] `src/watcher.ts`
- Inside `processDiagnostics()`, after extracting the primary error, call `recordError()`.
- Also call `xpEngine.awardXP(context, 'error_encountered', 5)` (see Phase 6).

#### [MODIFY] `src/ui/sidebar.ts`
- Add a **"Your Patterns"** tab to the sidebar.
- On every mission load, check if `errorRecord.count >= 2`. If yes, show the red repeat banner at the very top of the mission card.
- The Patterns tab shows a ranked list of all repeat errors with counts and dates.

#### [MODIFY] `backend/models/schemas.py`
- Add to `TierClassifyRequest`:
  ```python
  repeatCount: int = Field(default=0, description="How many times this error code has been seen before by this student.")
  pastExampleMessages: list[str] = Field(default=[], description="Up to 3 previous raw error messages of the same type.")
  ```

#### [MODIFY] `backend/services/groq_service.py`
- In `generate_dynamic_mission()`, accept `repeat_count: int` parameter.
- When `repeat_count >= 3`, prepend this to the system prompt:
  ```
  IMPORTANT: This student has hit this exact error type {repeat_count} times before.
  Do NOT be gentle. Ask questions that force them to articulate the root cause from memory.
  Your first question MUST reference their pattern: "You've seen this before. What is always true right before this error fires?"
  ```

### XP Events in Phase 1
| Action | XP Earned |
|--------|-----------|
| Error caught by watcher (any) | +5 XP |
| Hit the same error 3+ times and still complete the mission | +50 XP "Persistence Bonus" |

---

## Phase 2 — Progressive Debug Training Mode
**The idea in one line:** *Force the student to think like a detective before they see any answers.*

### What "hypothesis" means in plain English
Before you get to see any hints, Socrates asks you three questions. Each question forces you to look at the error yourself and write something down. There is no right or wrong answer — just the act of writing forces your brain to engage.

**The 3 Steps:**

**Step 1 — Read the Error (plain English only)**
> *"In your own words, what is the error message telling you? Don't use technical terms. Pretend you're explaining it to a friend."*
> Example good answer: *"Python is saying it can't find something called 'result' and doesn't know what it is"*

**Step 2 — Find the Evidence**
> *"Go to the line number shown in the error. What code is on that line? What did you EXPECT to be there, and what IS actually there?"*
> Example: *"Line 5 has print(result). I expected result to already have a value, but I never actually gave it one."*

**Step 3 — Make Your Best Guess (this is the hypothesis)**
> *"Before looking at any hints, what do you think is the root cause? Write your best guess, even if you're not sure."*
> Example: *"I think I used the variable before I created it. Maybe it's a spelling mistake too."*

Only after all 3 steps are completed does the full Socratic mission (questions + hints + challenge file) appear.

**The key rule:** None of these are graded by an LLM. There is no API call. We just need the student to physically write something down. The research behind this is called the **Generation Effect** — your brain remembers information far better when it generates an answer first, even a wrong one.

### Files to Create / Modify

#### [NEW] `src/debugTrainer.ts`
A state machine managing the 3-step ritual.

**State structure:**
```typescript
interface DebugRitualState {
  missionId: string;
  step: 0 | 1 | 2 | 3; // 0 = not started, 3 = all complete
  step1Response: string;
  step2Response: string;
  step3Response: string; // This is the "hypothesis"
  completedAt?: string;
}
```

**Exports:**
- `getRitualState(context, missionId)` — get current progress for a mission
- `advanceStep(context, missionId, response)` — save the answer and move to next step
- `isRitualComplete(context, missionId)` — returns true if step === 3
- `getRitualResponses(context, missionId)` — returns all 3 answers for the journal

**Minimum character rule:** Each step requires at least 20 characters. The "Next Step" button is disabled until this is met. This prevents students from typing "idk" to skip.

#### [MODIFY] `src/ui/sidebar.ts`
- Before rendering the mission card, check `isRitualComplete()`.
- If not complete, render the ritual UI instead:
  - Show which step is active (Step 1 of 3).
  - Show the question text for that step.
  - Show a textarea with a character counter (e.g., "12 / 20 min").
  - Show a disabled "Next →" button that enables at 20 chars.
  - Show completed steps above as collapsed, greyed-out summaries.
- After step 3 is submitted, animate a transition to the full mission card.

#### [MODIFY] `src/missions.ts`
- In `executeMissionHandOff()`, save the ritual state for the new mission's ID before rendering the sidebar.

### XP Events in Phase 2
| Action | XP Earned |
|--------|-----------|
| Complete Step 1 (Read the error) | +15 XP |
| Complete Step 2 (Find evidence) | +15 XP |
| Complete Step 3 (Write hypothesis) | +20 XP |
| Hypothesis matched the actual root cause (checked post-completion) | +30 XP "Sharp Eye Bonus" |
| Complete the ritual without skipping (all 3 done) | +10 XP "Full Thinker Bonus" |

---

## Phase 3 — Socratic Challenge Arena (Refined)
**The idea in one line:** *Make the challenge file teach, not just test.*

### What Phase 3 does (plain English)
Right now the challenge file (e.g., `socratic_challenge.py`) has broken code and you fix it. That's good, but it's passive. After Phase 3, every challenge file will have:

1. **A comment at the top explaining WHY this specific test exists** — not just "fix the code", but "here's what concept your brain needs to lock in."

2. **A deliberately WRONG fix shown as a comment** — showing you one common wrong answer and why it doesn't work. This is critical — recognizing wrong patterns is as important as knowing right ones.

3. **A fill-in-the-blank "Checkpoint" at the bottom** — a one-line sentence with a blank you fill in as a comment. No code checks it. Just for your brain.
   ```python
   # CHECKPOINT: A NameError fires when Python tries to use a name that __________.
   ```

4. **After tests pass** — the sidebar immediately shows a Post-Challenge Reflection prompt:
   > *"In one sentence: what was the root cause of your original error?"*
   Your typed answer (which you wrote yourself, not the LLM) gets saved to your Debug Journal.

### Files to Create / Modify

#### [MODIFY] `backend/services/hidden_test_service.py`
- Add a new helper `_build_challenge_header(error_code, concept_explanation, wrong_fix_example)`.
- Prepend this header comment block to every generated challenge file:
  ```python
  # =====================================================================
  # ZERO-MAGIC SOCRATIC CHALLENGE
  # =====================================================================
  # WHY THIS MATTERS:
  # {concept_explanation}
  #
  # COMMON WRONG FIX (and why it doesn't work):
  # {wrong_fix_example}
  #
  # YOUR MISSION: Fix the code below so all tests pass.
  # =====================================================================
  ```
- Add the checkpoint comment at the bottom of every challenge file after the test functions.

#### [MODIFY] `backend/services/groq_service.py`
- Add `generate_challenge_metadata(language, error_code, message)` function that returns:
  - `concept_explanation` — 2 sentences max, plain English, what concept this tests
  - `wrong_fix_example` — a code comment showing a plausible but wrong approach
  - `checkpoint_blank` — the fill-in-the-blank sentence

#### [MODIFY] `src/interceptor.ts`
- After `result.passed === true`, instead of immediately calling `unlockMission()`, first fire a `zeroMagic.showReflection` command.
- This command opens the Post-Challenge Reflection input in the sidebar.
- Only after the reflection is submitted (min 15 chars) does `unlockMission()` fire and XP get awarded.

#### [MODIFY] `src/ui/sidebar.ts`
- Add the Post-Challenge Reflection UI panel. It appears as a slide-up card over the mission panel when `zeroMagic.showReflection` fires.
- Has a textarea ("Write your root cause summary"), a "Submit & Unlock" button.
- Reflection text is passed to `debugJournal.addEntry()` (Phase 4).

### XP Events in Phase 3
| Action | XP Earned |
|--------|-----------|
| Challenge test passes on first attempt | +75 XP |
| Challenge test passes on 2nd attempt | +50 XP |
| Challenge test passes on 3rd+ attempt | +30 XP |
| Post-challenge reflection submitted | +25 XP |
| Solved in under 5 minutes | +20 XP "Speed Bonus" |

---

## Phase 4 — Debug Journal
**The idea in one line:** *Turn every bug you fix into a permanent asset.*

### What it does
A `.socrates_journal.json` file lives in your workspace root. Every time you complete a mission, one entry is added. Over months, this becomes a personal, searchable record of every bug pattern you've ever mastered.

The sidebar's "My Journal" tab lets you browse this. Over time it shows you things like:
- "You've fixed 23 bugs total"
- "Your fastest NameError fix was 1m 42s"
- "You used to need 3 hints on TypeErrors. Now you need 0."

That visible improvement curve is what keeps people going.

### Journal Entry Structure
```json
{
  "id": "entry_001",
  "timestamp": "2026-06-11T16:13:00+05:30",
  "language": "python",
  "errorCode": "NameError",
  "errorFlag": "Line 5: NameError: name 'result' is not defined",
  "repeatNumber": 2,
  "step1Response": "Python is saying it can't find something called result",
  "step2Response": "Line 5 has print(result). I expected result to exist.",
  "hypothesis": "I think I used the variable before creating it",
  "rootCauseSummary": "Used result before assigning it any value",
  "hintsUsed": 1,
  "timeToSolveMs": 142000,
  "testPassedOnAttempt": 2,
  "xpEarned": 165
}
```

### Files to Create / Modify

#### [NEW] `src/debugJournal.ts`
- `addEntry(context, entryData)` — appends a new entry to `.socrates_journal.json`
- `getAllEntries(context)` — returns full array of entries
- `getSummaryStats(context)` — returns aggregate stats object:
  ```typescript
  interface JournalStats {
    totalBugsFixed: number;
    totalXpEarned: number;
    mostCommonError: string;
    averageTimeToSolveMs: number;
    fastestFixMs: number;
    hintsUsedAllTime: number;
    longestStreakDays: number;
  }
  ```

#### [NEW] `backend/routers/journal.py`
New FastAPI router at `/v1/journal`:
- `POST /v1/journal/entry` — accepts a journal entry from the extension and stores/returns it
- `GET /v1/journal/summary` — returns aggregate stats computed from all entries

#### [MODIFY] `backend/main.py`
- Register the new journal router.

#### [MODIFY] `src/ui/sidebar.ts`
- Add **"My Journal"** panel tab with:
  - **Stats bar** at top: total bugs fixed, current XP, current rank
  - **Milestone badges** (10 bugs fixed 🏅, 25 bugs 🥈, 50 bugs 🥇, 100 bugs 🏆)
  - **Scrollable feed** of past journal entries showing: error code, timestamp, root cause summary, time taken, hints used, XP earned
  - **"Most Improved" card**: an error type where your average time-to-solve has dropped significantly

### XP Events in Phase 4
| Action | XP Earned |
|--------|-----------|
| 10th bug fixed milestone | +200 XP bonus |
| 25th bug fixed milestone | +500 XP bonus |
| 50th bug fixed milestone | +1000 XP bonus |
| 3-day debug streak | +100 XP |
| 7-day debug streak | +300 XP |
| First time fixing a new error type | +50 XP "Explorer Bonus" |

---

## Phase 5 — Concept Web
**The idea in one line:** *Show the student that 3 different errors are actually the same knowledge gap.*

### What it does
A student who keeps hitting `NameError`, `UnboundLocalError`, and `AttributeError` is actually struggling with the **same root concept** — variable scope and object existence. But they don't see that because they look like three different problems.

The Concept Web makes the invisible, visible.

### The Concept Map (static, no LLM needed, no hallucinations)
```python
CONCEPT_MAP = {
    "NameError":          "Variable Scope",
    "UnboundLocalError":  "Variable Scope",
    "AttributeError":     "Variable Scope",
    "TypeError":          "Type System",
    "ValueError":         "Type System",
    "KeyError":           "Data Structures",
    "IndexError":         "Data Structures",
    "SyntaxError":        "Language Syntax",
    "IndentationError":   "Language Syntax",
    "RecursionError":     "Algorithm Design",
    "MemoryError":        "Algorithm Design",
    "ImportError":        "Module System",
    "ModuleNotFoundError":"Module System",
    "ZeroDivisionError":  "Math & Logic",
    "OverflowError":      "Math & Logic",
}
```

Each concept also has one pre-approved, hand-curated learning resource link (no LLM — these are hardcoded, always valid):
```python
CONCEPT_RESOURCES = {
    "Variable Scope": "https://realpython.com/python-scope-legb-rule/",
    "Type System": "https://realpython.com/python-type-checking/",
    "Data Structures": "https://realpython.com/python-data-structures/",
    # etc.
}
```

### Files to Create / Modify

#### [NEW] `backend/services/concept_graph_service.py`
- Contains the `CONCEPT_MAP` and `CONCEPT_RESOURCES` dictionaries.
- `get_concept(error_code)` — returns the root concept name.
- `get_resource(concept)` — returns the learning resource URL.

#### [NEW] `backend/routers/concepts.py`
- `GET /v1/concepts/web` — accepts a list of error codes, returns a graph payload:
  ```json
  {
    "nodes": [
      { "concept": "Variable Scope", "count": 7, "errors": ["NameError", "AttributeError"] },
      { "concept": "Type System", "count": 3, "errors": ["TypeError"] }
    ],
    "dominantConcept": "Variable Scope",
    "resourceUrl": "https://realpython.com/python-scope-legb-rule/"
  }
  ```

#### [MODIFY] `src/ui/sidebar.ts`
- Add **"Concept Web"** panel tab.
- Render concept nodes as simple visual bubbles. Bubble size = proportional to count.
- Below the web, show: *"Your biggest knowledge gap right now is: Variable Scope (7 hits)"*
- Show the curated resource link as a button: **"📖 Read: Python LEGB Scope Rule →"**
- Clicking a bubble expands it to show the list of specific errors under that concept.

---

## Phase 6 — XP & Gamification Engine
**The idea in one line:** *Make doing the hard thinking work feel rewarding.*

### The XP System Design

The XP system is woven into every phase so that **every action that makes you a better programmer earns more XP than actions that shortcut the thinking**.

#### Rank Progression
| Rank | Name | XP Required | Perks |
|------|------|-------------|-------|
| 🌱 Rank 1 | Bug Rookie | 0 XP | All features locked behind debug ritual |
| ⚡ Rank 2 | Syntax Warrior | 500 XP | Concept Web unlocked |
| 🔍 Rank 3 | Logic Hunter | 1500 XP | Debug ritual becomes skippable |
| 🧠 Rank 4 | Stack Tracer | 3500 XP | Journal stats + improvement graphs unlocked |
| 🏹 Rank 5 | Debug Archer | 7500 XP | Custom XP multiplier challenges unlocked |
| 🔥 Rank 6 | Error Slayer | 15000 XP | "Mentor Mode" — get prompted to explain bugs to others |
| 🌟 Rank 7 | Debug Master | 30000 XP | Permanent profile badge, all ranks displayed |

#### XP Multipliers
| Condition | Multiplier |
|-----------|-----------|
| 3-day active streak | 1.5x |
| 7-day active streak | 2.0x |
| First-attempt challenge pass | 1.25x |
| Zero hints used | 1.5x |
| Hypothesis matched root cause | 1.3x |
| Repeat error (you've seen it before) | 0.8x — **penalty for repetition, incentive to learn** |

#### Full XP Table (All Phases Combined)
| Action | Base XP |
|--------|---------|
| Error caught by watcher | +5 XP |
| Debug ritual Step 1 complete | +15 XP |
| Debug ritual Step 2 complete | +15 XP |
| Debug ritual Step 3 (hypothesis) complete | +20 XP |
| Challenge passed — 1st attempt | +75 XP |
| Challenge passed — 2nd attempt | +50 XP |
| Challenge passed — 3rd+ attempt | +30 XP |
| Post-challenge reflection submitted | +25 XP |
| Solved in under 5 minutes | +20 XP |
| Zero hints used for whole mission | +40 XP |
| First time fixing a new error type | +50 XP |
| 10th bug milestone | +200 XP |
| 25th bug milestone | +500 XP |
| 50th bug milestone | +1000 XP |
| 3-day streak | +100 XP |
| 7-day streak | +300 XP |
| Hit same error 3+ times and still complete | +50 XP "Persistence Bonus" |

### Files to Create / Modify

#### [NEW] `src/xpEngine.ts`
The central XP and rank manager.

```typescript
interface PlayerProfile {
  totalXp: number;
  currentRank: number;
  rankName: string;
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string;
  activeMultiplier: number;
  badges: string[];
}

interface XpEvent {
  type: string;      // e.g., 'ritual_step1', 'challenge_pass_first'
  baseXp: number;
  multiplier: number;
  finalXp: number;
  timestamp: string;
}
```

**Exports:**
- `awardXP(context, eventType, baseXp)` — calculates multiplier, awards XP, checks for rank-up, returns `XpEvent`
- `getProfile(context)` — returns full `PlayerProfile`
- `getRankForXp(totalXp)` — returns rank number and name
- `checkAndUpdateStreak(context)` — call on extension activate; updates streak state

**Rank-up logic:** When `awardXP()` causes a rank-up, it fires `zeroMagic.rankUp` command which triggers the rank-up celebration UI.

#### [NEW] Profile Storage: `.socrates_profile.json` in workspace root
```json
{
  "totalXp": 2340,
  "currentRank": 3,
  "rankName": "Logic Hunter",
  "currentStreak": 5,
  "longestStreak": 12,
  "lastActiveDate": "2026-06-11",
  "badges": ["First Bug Fixed", "3-Day Streak", "10 Bugs Milestone"],
  "xpHistory": [
    { "type": "ritual_step1", "baseXp": 15, "multiplier": 1.5, "finalXp": 22, "timestamp": "..." }
  ]
}
```

#### [MODIFY] `src/ui/sidebar.ts`
**XP Panel (always visible at top of sidebar):**
- A slim progress bar showing XP progress to next rank.
- Current rank name + icon (emoji).
- "+X XP" floating toast notification that animates up and fades every time XP is earned.
- Current streak counter (e.g., 🔥 5-day streak).

**Rank-Up Celebration:**
- When `zeroMagic.rankUp` fires, the entire sidebar briefly shows a full-panel rank-up animation.
- Large rank icon in center, new rank name, confetti burst (CSS animation, no external library).
- Shows: "You are now a **Logic Hunter**. The debug ritual is now skippable."
- Auto-dismisses after 4 seconds.

**Badges Panel** (inside "My Journal" tab):
- Grid of earned and locked badges.
- Locked badges show as greyed-out with a "?" and hint of what's needed.
- Example badges:
  - 🐛 "First Bug Fixed"
  - 🔥 "3-Day Streak"
  - 🧊 "Ice Cold" — passed a challenge on the first attempt with no hints
  - 🎯 "Sharpshooter" — hypothesis matched root cause 3 times in a row
  - 🔄 "Broke the Pattern" — hit the same error 5 times then never hit it again for 30 days
  - 📖 "Bookworm" — clicked a Concept Web resource link 10 times
  - 💨 "Speed Demon" — solved a mission in under 2 minutes
  - 🧠 "No Hints Needed" — completed 5 missions without using any hints

#### [MODIFY] `src/extension.ts`
- On extension activate, call `checkAndUpdateStreak(context)`.
- Register `zeroMagic.rankUp` command handler (shows rank-up UI).

---

## How All Phases Connect (Data Flow Diagram)

```
Student saves file with error
        │
        ▼
watcher.ts catches diagnostic
        │
        ├── recordError() → errorMemory.ts
        ├── awardXP(+5) → xpEngine.ts
        │
        ▼
Student clicks 💡 Help me think
        │
        ▼
debugTrainer.ts shows 3-step ritual
        │
        ├── Step 1 done → awardXP(+15)
        ├── Step 2 done → awardXP(+15)
        ├── Step 3 done → awardXP(+20) [hypothesis saved]
        │
        ▼
Mission card renders (questions + hints)
        │
        ├── hint clicked → hintsUsed++
        │
        ▼
Challenge file written (interceptor.ts)
    [with concept header, wrong fix, checkpoint blank]
        │
        ▼
Student fixes challenge, tests pass
        │
        ├── awardXP(+75/50/30 by attempt)
        ├── awardXP(+20 speed bonus if <5 min)
        ├── awardXP(+40 if zero hints used)
        │
        ▼
Post-challenge reflection input shows (sidebar.ts)
        │
        ├── Student submits root cause summary
        ├── awardXP(+25)
        │
        ▼
Journal entry written (debugJournal.ts → .socrates_journal.json)
        │
        ├── Milestone check → bonus XP if 10/25/50th bug
        ├── Streak update → bonus XP if streak continued
        ├── Rank-up check → zeroMagic.rankUp if threshold crossed
        │
        ▼
unlockMission() fires → ✓ Mission complete
```

---

## Verification Plan

### Phase 1 — Error Memory
- [ ] Hit the same error code 3 times. Confirm the red repeat banner appears in sidebar.
- [ ] Confirm Groq receives `repeatCount: 3` in the API payload (check backend logs).
- [ ] Confirm generated Socratic questions are more confrontational on repeat 3+.
- [ ] Confirm `errorMemory.ts` persists data after VS Code restart.

### Phase 2 — Debug Training
- [ ] Confirm mission card is hidden until all 3 ritual steps are complete.
- [ ] Confirm "Next →" button stays disabled below 20 characters.
- [ ] Confirm ritual progress survives a VS Code window reload mid-way through.
- [ ] Confirm at Rank 3+, a "Skip Ritual" button appears.

### Phase 3 — Challenge Arena
- [ ] Open a generated challenge file and confirm the "WHY THIS MATTERS" comment block is at the top.
- [ ] Confirm the "COMMON WRONG FIX" comment is present.
- [ ] Confirm the "CHECKPOINT" blank is at the bottom.
- [ ] Confirm the Post-Challenge Reflection prompt appears in the sidebar after test-pass.
- [ ] Confirm the typed reflection is stored in `.socrates_journal.json`.

### Phase 4 — Debug Journal
- [ ] Complete a mission. Confirm `.socrates_journal.json` is created in workspace root.
- [ ] Complete 5 more missions. Confirm 6 entries exist in the file.
- [ ] Confirm the "My Journal" sidebar tab shows correct total bug count and XP.
- [ ] Confirm the `GET /v1/journal/summary` endpoint returns valid stats.

### Phase 5 — Concept Web
- [ ] Hit NameError and AttributeError. Confirm both appear under "Variable Scope" in the Concept Web.
- [ ] Confirm the curated resource link for "Variable Scope" is correct.
- [ ] Confirm the bubble for "Variable Scope" is visually larger than a concept hit only once.

### Phase 6 — XP Engine
- [ ] Complete the debug ritual. Confirm XP toast (+15, +15, +20) appears for each step.
- [ ] Confirm XP is written to `.socrates_profile.json` after each event.
- [ ] Confirm the streak multiplier activates correctly after 3 consecutive days.
- [ ] Earn enough XP to cross the Rank 2 threshold. Confirm the rank-up animation plays.
- [ ] Confirm the progress bar in the sidebar updates live during a session.
- [ ] Confirm locked badges show as greyed-out until their condition is met.

---

## Build Order (Recommended Execution Sequence)

1. **Phase 6 first** — Build `xpEngine.ts` and the profile JSON structure first, because every other phase plugs into it. Start with the XP bar in the sidebar (even if it shows fake data initially).
2. **Phase 1** — Error memory is simple to build and immediately demonstrates value.
3. **Phase 2** — Debug training ritual, the pedagogical core of the whole system.
4. **Phase 3** — Challenge arena refinements (modifies existing pipeline, lower risk).
5. **Phase 4** — Debug journal (depends on data from phases 1-3 being wired up).
6. **Phase 5** — Concept web last (depends on journal data existing to visualize).
