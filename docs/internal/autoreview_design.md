# Implementation Specification: OctoDeck Auto-Reviewer

**Status:** Not Implemented
**Version:** 1.2.0 (Persistence Update)
**Target Architecture:** Local Companion Server (Go) + Chrome Extension (React)
**Model:** Gemini 3.0 Pro (via `google-generative-ai-go`)

## 1. System Architecture & API Contract

The system consists of a "dumb" frontend (Extension) and a "smart" backend (Local Server).

### 1.1 Communication Flow

1. **Extension** detects user click on "Auto-Review".

2. **Extension** POSTs the PR details to `localhost:10000`.

3. **Server** validates the request and immediately returns `200 OK`.

4. **Server** starts an **SSE (Server-Sent Events)** stream.
   - **Crucial:** The first event MUST be a `metadata` event containing the `head_sha` of the commit being reviewed. This allows the frontend to lock the review to a specific version.

### 1.2 OpenAPI Specification (Snippet)

```yaml
openapi: 3.0.0
paths:
  /api/v1/review:
    post:
      summary: Start an Auto-Review session
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                owner: { type: string, example: "kubernetes" }
                repo: { type: string, example: "kubernetes" }
                pull_number: { type: integer, example: 12345 }
                focus_files: { type: array, items: { type: string } }
      responses:
        200:
          description: Session started successfully. Connect to /stream for results.
  
  /api/v1/stream:
    get:
      summary: SSE Endpoint for live agent feedback
      description: Returns a stream of events.
      responses:
        200:
          content:
            text/event-stream:
              schema:
                type: string
                example: |
                  event: metadata
                  data: {"head_sha": "a1b2c3d4...", "model": "gemini-3.0-pro"}
                  
                  event: tool_use
                  data: "Reading pkg/kubelet/kubelet.go..."
                  
                  event: review_complete
                  data: { "reviews": [...] }
```

### 1.3 Data Storage Schema (Chrome Extension)

We use `chrome.storage.local` to persist reviews. This allows the user to close the tab and return later without re-running the costly AI inference.

**Key Format:** `review_cache_{owner}_{repo}_{pr_number}`

**Schema:**
```json
{
  "head_sha": "7f8a9b0c...",       // The commit hash this review is based on
  "timestamp": 1698421200000,      // When the review was generated
  "model_version": "1.2.0",        // Schema version
  "data": {                        // The raw JSON output from the LLM
    "reviews": [
      {
        "type": "LINE",
        "path": "pkg/kubelet/kubelet.go",
        "line": 42,
        "severity": "BLOCKER",
        "message": "Potential nil pointer dereference."
      }
    ]
  }
}
```

## 2. Go Backend Implementation

### 2.1 Dependency Selection

* **LLM Client:** `github.com/google/generative-ai-go/genai` (Official SDK)
* **GitHub Client:** `github.com/google/go-github/v50/github`
* **Git Operations:** `os/exec` (Prefer raw git commands for `git diff` performance over `go-git`).
* **Server:** `net/http` (Standard lib is sufficient).

### 2.2 The Agent Loop (`agent.go`)

This is the core logic. It manages the conversation state and tool execution.

```go
type OctoAgent struct {
    client    *genai.Client
    model     *genai.GenerativeModel
    history   []*genai.Content
    tools     map[string]func(map[string]any) (string, error)
}

func (a *OctoAgent) RunReview(ctx context.Context, prDiff string, headSHA string, stream chan<- Event) {
    // 0. Send Metadata Event immediately
    stream <- Event{Type: "metadata", Payload: map[string]string{"head_sha": headSHA}}

    // 1. Initialize Session
    session := a.model.StartChat()
    
    // 2. Send Initial Prompt (System + Diff)
    resp, err := session.SendMessage(ctx, genai.Text(BuildSystemPrompt() + "\n\n" + prDiff))
    
    // 3. The "Tool Loop"
    for {
        if err != nil {
            stream <- Event{Type: "error", Payload: err.Error()}
            return
        }

        // Check for Tool Calls
        if len(resp.Candidates[0].Content.Parts) > 0 {
             part := resp.Candidates[0].Content.Parts[0]
             if funcCall, ok := part.(genai.FunctionCall); ok {
                 stream <- Event{Type: "tool_use", Payload: fmt.Sprintf("Executing %s...", funcCall.Name)}
                 result, _ := a.executeTool(funcCall)
                 resp, err = session.SendMessage(ctx, genai.FunctionResponse{
                     Name: funcCall.Name,
                     Response: map[string]any{"content": result},
                 })
                 continue 
             }
        }
        
        stream <- Event{Type: "review_complete", Payload: resp.Candidates[0].Content.Parts[0].(genai.Text)}
        break
    }
}
```

## 3. Prompt Engineering & Persona

This section configures the model to act as a **force multiplier** for the human reviewer. We enforce **JSON Mode** to ensure the frontend can parse comments and display them contextually.

### 3.1 The System Prompt

TODO: System prompt needs more tuning.

```text
ROLE:
You are a "Paranoid Co-Pilot" for a Open Source Maintainer.
Your goal is NOT to replace the human reviewer or understand the entire system architecture.
Your goal is to ACCELERATE the review by finding "low-hanging fruit," suspicious logic, and missing tests.

ANTI-PATTERNS (DO NOT DO):
- Do not lecture on high-level system design.
- Do not offer generic praise ("Great job!").
- Do not hallucinate external dependencies you cannot see.

PRIMARY DIRECTIVES:
1. THE "TEST AUDIT" (HIGHEST PRIORITY):
   - For every logic change, check the corresponding `_test.go`.
   - Flag MISSING cases: "You handled the 'nil' case in code, but there is no test case for it."
   - Flag WEAK assertions: "Test checks `err != nil` but doesn't verify the error message."

2. TACTICAL RISK SCAN:
   - Scan for "Code Smells": swallowed errors, loop variable capture, modifying collections while iterating.
   - Flag new concurrency (`go func`) without WaitGroups/Context.

3. OUTPUT FORMAT (STRICT JSON):
You must output a single valid JSON object containing a "reviews" array.
Do not wrap it in Markdown code blocks.

Schema Definition:
- type: "LINE" (attached to specific line), "FILE" (attached to file), or "GENERAL" (PR-wide).
- path: The file path (Required for LINE/FILE).
- line: The specific line number in the new file (Required for LINE).
- severity: "BLOCKER" (Bugs/Breaks), "WARNING" (Risks/Tests), "NIT" (Style).
- message: The review comment. Markdown is allowed within the string.
```

### 3.2 Strategic Tool Triggers

* **If `_test.go` files are modified:** *"Hint: A test file was modified. Use `read_local_file` to read the WHOLE test file."*
* **If `go.mod` is modified:** *"Hint: Dependency change detected. This is high risk."*

## 4. Tool Definitions (Implementation Notes)

### 4.1 `read_local_file`
* **Security:** Must strictly sanitize `path`. Allow read only within `~/.cache/octodeck/repo`.
* **Optimization:** If file > 50KB, return truncated content.

### 4.2 `search_codebase` (Grep)
* **Command:** `git grep -n "pattern" -- "path/spec"`
* **Limit:** Hard limit to 50 results.

### 4.3 `get_git_blame`
* **Command:** `git blame -L start,end -- file.go`

### 4.4 `list_directory`
* **Purpose:** Discovery. Returns `ls -F`.

## 5. Implementation Plan

This plan breaks the development into 5 iterative steps. Each step results in a verifiable milestone.

### Step 1: The Walking Skeleton (Connectivity)
*Goal: Prove the Extension can talk to the Local Server.*
- [ ] **Backend:** Initialize a Go HTTP server on port 10000.
- [ ] **Backend:** Create a dummy endpoint `POST /api/v1/review` that returns `200 OK`.
- [ ] **Backend:** Implement SSE handler at `/api/v1/stream`.
- [ ] **Frontend:** Update Chrome Extension manifest to allow `http://localhost:10000`.
- [ ] **Verification:** Open Extension -> Click "Connect" -> See "Hello World" stream logs in UI.

### Step 2: The Local Reader (Git Integration)
*Goal: The Backend can actually read the target code.*
- [ ] **Backend:** Implement `git clone` logic to cache the repo.
- [ ] **Backend:** Implement `fetchPR` to get PR head/base refs and **head SHA**.
- [ ] **Backend:** Implement `getDiff`.
- [ ] **Verification:** `curl -X POST /review` -> Server logs show diff text and correct SHA.

### Step 3: The Brain (Gemini Baseline)
*Goal: Get a basic JSON response from the LLM.*
- [ ] **Backend:** Integrate `google-generative-ai-go`.
- [ ] **Backend:** Wire `RunReview` loop.
- [ ] **Backend:** Update SSE to stream `metadata` (SHA) and `review_complete` (JSON).
- [ ] **Verification:** Send a PR with a known bug. Confirm Gemini replies with valid JSON.

### Step 4: The Hands (Tool Execution)
*Goal: Enable the agent to look outside the diff.*
- [ ] **Backend:** Implement `Tool` interface in Go (`read_local_file`, `grep`).
- [ ] **Backend:** Update Gemini Client config to include tools.
- [ ] **Verification:** Prompt model "Check callers". Confirm server logs `git grep` execution.

### Step 5: The Interface (UX Polish & Persistence)
*Goal: Make it usable for the maintainer.*
- [ ] **Frontend:** Create "Auto-Review" React component.
- [ ] **Frontend (Persistence):** On load, check `chrome.storage.local` for `review_cache_{pr_id}`.
- [ ] **Frontend (Staleness):** Compare `cached_review.head_sha` vs. `current_pr.head_sha`.
    - If mismatch, show "⚠️ Review Outdated (Commit mismatch)" banner.
- [ ] **Frontend (Save):** When `review_complete` event arrives, save payload + SHA to storage.
- [ ] **Frontend (Render):** Parse JSON and render "BLOCKER" cards.
- [ ] **Verification:** Run review -> Reload Page -> Review loads instantly from cache. Push new commit -> Reload Page -> "Outdated" warning appears.
