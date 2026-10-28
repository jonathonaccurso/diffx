# diffx

A local code review tool designed for the coding agent workflow. Review AI-generated changes in a GitHub PR-like web UI, leave inline comments, then hand them back to your coding agent to fix.

![screenshot](https://raw.githubusercontent.com/wong2/diffx/main/screenshot.png)

## Install

```bash
npm install -g diffx-cli
```

## Usage

Run in any git repository:

```bash
diffx
```

This starts a local server and opens your browser with a diff review UI.

### Options

```
diffx [options] [-- <git-diff-args>]

Options:
  -p, --port <port>   Server port (default: 3433)
  --no-open           Don't auto-open browser

Examples:
  diffx                          # Review working tree changes
  diffx -p 8080                  # Use custom port
  diffx -- HEAD~3                # Diff against 3 commits ago
  diffx -- main..HEAD            # Diff between branches
  diffx -- --cached -- src/      # Staged changes in src/
```

## Features

- **Split / Unified view** — Toggle between side-by-side and inline diff
- **Syntax highlighting** — Powered by Shiki with GitHub themes
- **File tree** — Hierarchical file browser with search filter and file change-type icons
- **Inline comments** — Click the `+` button on any line to add a review comment
- **Comment replies** — AI agents can reply to comments via API, displayed with bot avatar in the UI
- **Comment status tracker** — Sidebar widget showing open, replied, and resolved comment counts with click-to-navigate links
- **Submit review**: send the review to a waiting agent with one click; the agent blocks on a wait endpoint until you submit
- **Copy comments** — One-click copy all comments as structured XML for AI coding agents
- **Image preview** — Side-by-side comparison for added, modified, and deleted images
- **Viewed tracking** — Mark files as reviewed to track progress
- **Staged / Untracked toggles** — Choose which changes to include
- **Custom diff commands** — Pass any `git diff` arguments after `--`
- **EditorConfig support** — Respects `.editorconfig` for per-file tab size
- **Persistent settings** — Your preferences are saved across sessions

## Comment Output Format

When you click "Copy comments", the output is structured XML optimized for AI agents:

```xml
<code-review-comments>
<file path="src/utils/parser.ts">
<comment line="42">
<code>+ const parsedToken = tokenize(input)</code>
Rename `x` to `parsedToken` for clarity.
</comment>
<comment line="15">
<code>- if (input != null) {</code>
This null check removal may cause a bug when `input` is undefined.
</comment>
</file>
</code-review-comments>
```

Each comment includes the commented code line with a `+`/`-` prefix indicating whether it's an added or removed line.

## Review rounds

The toolbar has a **Submit review** button. Each click starts a new round and wakes any agent waiting on the server. The toolbar shows where the round stands: `Not submitted`, `Round N submitted, waiting for the agent`, or `Round N addressed`.

The state is `{ round, submittedAt, addressedRound, addressedAt }` and starts at `{ 0, null, 0, null }`. With `--persist` it is saved in the review file next to the comments and survives a restart; without it, it lives in memory.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/rounds` | Returns the state. |
| `POST /api/rounds/submit` | Increments `round`, sets `submittedAt`, releases every pending wait, returns the state. |
| `GET /api/rounds/wait?after=N&timeout=S` | Holds the request until `round > N` or `S` seconds pass, then returns the state with status 200 either way. Returns at once when `round` is already above `N`. `timeout` defaults to 30 seconds, is capped at 300, and falls back to the default when it is not a plain non-negative number. `after` defaults to 0. |
| `POST /api/rounds/addressed` | Body `{ "round": N }`. Sets `addressedRound` and `addressedAt`. Status 400 when `N` is above `round` or is not a non-negative integer. |

An agent waits for the next submit with a loop like this, running in the background so it can keep working:

```bash
round=0
while true; do
  state=$(curl -s "http://localhost:<port>/api/rounds/wait?after=$round&timeout=300")
  new=$(echo "$state" | jq .round)
  if [ "$new" -gt "$round" ]; then
    round=$new
    # read /api/comments, address them, then report the round as handled
    curl -s -X POST http://localhost:<port>/api/rounds/addressed \
      -H "Content-Type: application/json" -d "{\"round\": $round}"
  fi
done
```

A wait that times out returns the unchanged state, so the loop asks again. If the returned `round` is lower than `after`, diffx restarted without `--persist` and the round count began again.

## Agent Skills

Install the diffx skills to use diffx directly from your AI coding agent:

```bash
npx skills add wong2/diffx
```

The review workflow uses two commands:

1. **`/diffx-start-review`** — Launches the diffx server and opens the browser. Review your changes and leave inline comments.
2. **`/diffx-finish-review`** — The agent fetches all comments from the running diffx server via API, applies the requested changes, and marks each comment as resolved. The browser UI updates in real time as comments are resolved.

## License

MIT
