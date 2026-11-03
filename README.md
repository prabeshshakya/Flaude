# Flaude — Claude Bridge for Figma

Chat with Claude from a panel inside Figma. Select layers to point at them, describe the change, and Claude edits the file through the Figma MCP server while you watch. No more copying links between apps.

```
Figma plugin (figma-plugin/)  ──localhost:4545──▶  Bridge (bridge/)  ──▶  Claude agent ──▶ Figma MCP ──▶ your file
  selection, context, chat                            token-protected       Claude Code login     use_figma etc.
```

Two modes in one panel:

- **Send**: Claude edits the file directly (needs the bridge running).
- **Copy prompt**: copies the layer links, your request and a layer snapshot, ready to paste into a claude.ai chat. Works with no bridge at all.

## What you need

| | |
|---|---|
| **Node.js 18 or newer** | `node -v` to check. [Download](https://nodejs.org) if you don't have it. Node 20+ recommended. |
| **Figma desktop app** | Development plugins only load in the desktop app, not the browser. [Download](https://www.figma.com/downloads/). |
| **A Claude account** | Any paid Claude plan (Pro, Max, Team) or an Anthropic API account. You sign in from the plugin in step 4 — no key to paste. |
| **git** | Only to clone. You can also download the repo as a ZIP instead. |

Works on macOS, Linux and Windows. Nothing else to install: the bridge carries its own copy of Claude Code.

## Install

Takes about 5 minutes, once.

### 1. Get the code

```sh
git clone https://github.com/prabeshshakya/Flaude.git
cd Flaude
```

### 2. Install and start the bridge

```sh
cd bridge
npm install
npm start
```

You should see:

```
Claude Bridge 0.x listening on http://localhost:4545
Token (paste into the plugin's settings once):

  <a long random string>

Leave this window open while you work. Ctrl+C to stop.
```

**Copy that token** — you need it in step 4. Leave this terminal window running; the plugin talks to it.

### 3. Import the plugin into Figma

In the Figma **desktop app**:

1. Open any design file.
2. Menu → **Plugins** → **Development** → **Import plugin from manifest…**
3. Pick `figma-plugin/manifest.json` from the folder you cloned.
4. Run it: **Plugins** → **Development** → **Flaude**.

The panel opens. The header dot will be red until you finish step 4.

### 4. Connect

In the panel, open **settings** (the slider icon, top right):

1. **Bridge** → paste the token from step 2 into **Bridge token** → **Save**. (Leave **Bridge address** at `http://localhost:4545` unless you changed the port.)
2. **Connections** → **Claude account** → **Sign in**. Your browser opens; approve, and if it shows a code, paste it into the box that appears.
3. **Connections** → **Figma** → **Connect**, approve in the browser. **Required** — this is what lets Claude edit the file.
4. *Optional:* **Jira and Confluence** → **Connect**, so Claude can read tickets and specs. Read-only.

Each row shows its status, and the header dot turns green when everything needed is connected.

### 5. Check it works

```sh
npm run doctor        # in the bridge/ folder
```

It starts the agent, sends one tiny prompt (a fraction of a cent) and reports on your sign-in and each MCP server, with the fix for anything broken. `All good. Run npm start.` means you're done.

### Your first edit

Select a frame in Figma, switch the panel to **Build** mode (Shift+Tab cycles modes), and type something like *"rename these buttons to sentence case"*. When it finishes you get **Select changed layers**, **Revert** and **Keep**.

## Daily use

```sh
cd bridge && npm start
```

…then open the plugin from **Plugins** → **Development** → **Flaude**. The token is remembered, so you only paste it once. A file also gets an **Ask Claude** button in the right panel when nothing is selected.

To stop the bridge: `Ctrl+C` in its terminal.

## Updating

```sh
git pull
cd bridge && npm install
```

Then in Figma: **Plugins** → **Development** → right-click **Flaude** → **Reload**, or just close and reopen the panel. Your token, settings and conversations survive an update.

## Using it

The panel is a Claude chat that can see and edit your file.

- **Modes** (Shift+Tab switches):
  - **Ask**: questions, critique, explanations. Read-only; nothing in the file changes.
  - **Plan**: Claude reads what it needs and replies with a plan card (goal, numbered changes with layer ids, components and tokens it will use, open questions). **Build this plan** runs it; **Revise** lets you push back first. Read-only until you approve.
  - **Build**: Claude edits the file right away. For big or vague requests it still sketches a short plan before building.

  Ask and Plan are enforced, not just suggested: the bridge blocks every write tool in those modes.
- **Target**: whatever you select shows under the header. Click a chip to jump to it. **Keep target** freezes it while you click around. With nothing selected, Claude looks at the current page.
- **Model and effort**: the button next to the copy icon opens the picker. It lists the models your account can use, with version, what each is for and its price, straight from Claude Code, so new models appear by themselves (**Refresh list** re-asks). **Other model ID** takes a full ID such as `claude-sonnet-5` for a specific older version. **Effort** sets how long Claude thinks before acting: **Auto** uses the model's default; **Low** suits questions and copy; **High** to **Max** help on multi-step builds and tricky layouts but are slower and use more tokens. Levels a model doesn't support are greyed out. The choice is remembered per conversation, and each reply's footer shows the model and effort it used.

  A sensible default: Sonnet on Auto for most work, Sonnet or Opus on High for big builds and Explore, Haiku on Low for quick questions, Fable for the hardest multi-screen work.
- **Images**: paste, drop or attach up to 4 references (inspiration, a screenshot from production, a whiteboard photo). They're downscaled to 1200px before sending.
- **Conversations**: each file keeps its last 30. Open the list from the title or the menu icon; the + starts a new one. Claude remembers everything within a conversation.
- **Jira and Confluence**: paste a ticket link or key (like `ABC-123`) and Claude reads it, plus any linked spec. Read-only.
- **After a build**: node ids in replies are clickable, and **Select N changed layers** selects everything Claude touched.
- **Copy prompt** (copy icon next to the model): copies links, your request and a layer snapshot for pasting into claude.ai. Needs no bridge.
- **Esc** stops a running request.

### Actions

The row above the input. Pick one, optionally type a note (“focus on the table”, “friendlier”), press Enter.

- **Explore options**: Claude makes 2 to 4 labelled copies of the target side by side, each a different direction. The option cards show a preview of each. **Use this** puts your pick exactly where the original was (same name, same position) and deletes the others; Cmd+Z undoes it. **Keep all** leaves them; **Remove all options** deletes them.
- **Review**: the plugin first runs exact checks on the target: contrast, raw colors not bound to variables or styles, text without a text style, off-scale or unbound spacing and radius, missing fonts, default layer names, hidden layers, empty frames. They appear instantly as a checklist with clickable layers. Claude then adds what checks can't see (hierarchy, missing states, design-system consistency, copy). **Fix safe issues** hands the mechanical ones (bindings, spacing, names) to Claude; contrast and missing fonts stay with you. Read-only until you click Fix.
- **Handoff spec**: a developer spec with layout, tokens, states, content rules, accessibility and edge cases, naming each design-system component with its variant and props. Read-only. **Place in file** adds it as a frame next to the target.
- **Copy pass**: rewrites the target's text in place, keeping styles and layout, and lists Before and After.
- **Realistic data**: fills tables, lists and forms with consistent, plausible content, including one long value and one edge case to stress the layout. Claude infers the domain from the design; type a note to set it yourself ("hospital scheduling", "freight invoices").

The spacing and radius scales the checks use are at the top of the design checks in `figma-plugin/code.js`.

### Reviewing a build

Every Build ends with **Select changed layers**, **Revert** and **Keep**.

- Before Claude edits, the plugin copies the target onto a page called “Claude Bridge snapshots”. **Revert** puts that copy back where the original was and removes layers Claude added. Revert is an ordinary edit, so Cmd+Z undoes a revert too.
- **Keep** deletes the snapshot. Only the last 10 builds keep snapshots; older ones are cleaned up automatically. Revert still works after closing and reopening the plugin.
- If Claude also changed something outside the target, the card names it: Revert can't undo that part.
- Main components and layers inside instances can't be snapshotted safely; the card says so and version history is the fallback.
- After a revert or a picked option, Claude's next message is told, so it doesn't assume its edits are still there.

### Memory

In Build mode Claude can save a short note for later conversations: a workaround that worked in this file, where a component lives, a convention you confirmed. Each save shows in the chat as **Saved to memory**. Settings has a **Memory** section to read, delete and add notes, either for this file or for all files. Notes are plain files in `bridge/workspace/memory/`.

### Tokens

Every reply shows its model, time, tokens in (and how many were cached), tokens out, and an estimated cost. The bridge keeps requests lean:

- The layer snapshot is capped at about 4k tokens and sent once per target per conversation. Follow-ups about the same layers send only ids, until a Build changes the file and a fresh snapshot goes with the next message.
- One 800px screenshot of the target goes with that first snapshot, not on every message. The camera button turns it off.
- Claude is told to work from the snapshot and only read deeper with tools when it needs to, and to verify edits with a single screenshot.
- Long conversations carry their history. Start a new conversation when you switch tasks.

On a Claude plan login, the cost figure is an estimate at API prices; actual usage counts toward your plan limits.

## Make it yours

- `bridge/workspace/CLAUDE.md` is loaded into every session. It ships design-system-agnostic: a short **Design system** template for you to fill in (libraries, token paths, text styles, fonts, conventions), followed by Figma Plugin API workarounds that apply to any file (text writes that silently fail, clone over instance, HUG after resize, slot swaps and height). Claude works without the template — it reads the file and infers the system — but filling it in makes it faster and stops it guessing. `bridge/workspace/examples/design-system-slds.md` is a filled-in example. Add rules as you find them; they take effect from the next new chat.
- The action buttons above the input are the `ACTIONS` map near the top of the script in `figma-plugin/ui.html`; their prompts are the matching `ACTIONS` entries in `bridge/agent.mjs`. Edit the prompt to change what an action asks for.

## Configuration

Environment variables for `npm start` / `npm run doctor`:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4545` | Bridge port. If you change it, also change `devAllowedDomains` in `manifest.json` and the address in plugin settings. |
| `CLAUDE_MODEL` | `sonnet` | Model used when the plugin doesn't pick one. The plugin's picker accepts listed models or a full `claude-…` ID; anything else is refused. |
| `MAX_TURNS` | `40` | Cap on agent steps per request. |
| `FIGMA_MCP_URL` | unset | Declare the Figma server here instead of via `claude mcp add`. |
| `FIGMA_MCP_MATCH` | `figma` | Regex for which MCP server counts as Figma (handles names like "claude.ai Figma"). |
| `ATLASSIAN` | on | Set to `off` to block Jira and Confluence entirely. |
| `ATLASSIAN_MCP_MATCH` | `atlassian\|jira\|rovo` | Regex for which MCP server counts as Atlassian. |
| `FIGMA_WRITE_TOOLS` | `use_figma` | Figma tools allowed to write in Build mode. |
| `AUDIT` | on | Set to `off` to stop writing `bridge/logs/audit.jsonl`. |
| `SETTING_SOURCES` | `user,project,local` | Claude Code setting sources to load. `user` is where your Figma and Atlassian servers live; `project` loads CLAUDE.md. |

## Security

The bridge is a server on your machine that can edit your Figma files and read your Jira using your logins, so it is built to be hard to misuse. What each protection stops:

**Someone reaching the bridge who shouldn't**
- It listens on localhost only. Nothing outside your computer can connect.
- Every request needs the token from `bridge/.bridge-token` (file permissions: owner only). Tokens are compared in constant time. After 10 wrong tokens in a minute the bridge refuses everything for a minute and logs it. `npm run rotate-token` issues a new one.
- Web pages are refused twice over: the browser's own origin check only admits the plugin's sandboxed iframe, and the bridge rejects any request that carries a website's origin even with a valid token.
- DNS rebinding (a site whose name secretly points at 127.0.0.1) is blocked: requests must arrive addressed to localhost.
- Requests have size limits: 20k characters of prompt, 5 images, 4 MB each.

**Claude being talked into doing something else** (prompt injection via layer text, a ticket, or a Confluence page)
- Ask and Plan modes are read-only. The bridge blocks every write tool in those modes regardless of what Claude decides.
- In Build mode, the only write tool is `use_figma`, and it is confined to the file you have open: a call naming any other file is refused. Creating files, importing code, running Weave models and the like are blocked outright. (`FIGMA_WRITE_TOOLS` can widen this if you ever need to.)
- Jira and Confluence are read-only in every mode. Nothing Claude reads can make it comment, edit or move a ticket.
- No shell, no file system, no web browsing, no other MCP servers. Those tools are removed from Claude's context entirely, and a hook checks every remaining call before it runs, even ones your personal Claude Code settings would auto-approve.
- Layer text, ticket text and screenshots are passed as data, and Claude is told not to treat them as instructions.

**Memory**
- Claude's only memory tool appends one cleaned line (no markup, no line breaks, 300 characters max) to one of two fixed files for the current Figma file, and only in Build mode. It can't read, edit or delete notes, and it must be the bridge's own built-in tool, not a configured server with the same name.
- Notes are loaded as facts, under a header telling Claude they can't change its instructions or tools. Every save is visible in the chat and the audit log, and you can delete any note in settings.
- Actions fix the mode on the bridge, so Review and Handoff stay read-only whatever the request says.

**The plugin panel itself**
- A content security policy allows it to talk only to a bridge on localhost. No remote scripts, styles, fonts or images can load, even if something managed to inject HTML.
- Everything Claude writes is escaped before rendering. Links open only if they are http(s).
- Connections can add only Figma and Atlassian. The bridge refuses any other server name or URL.

**Knowing what happened**
- `bridge/logs/audit.jsonl` records every request (mode, model, file key, image count), every tool decision with its reason when denied, every result, and every connector action. It never stores prompts, layer content or tokens. Set `AUDIT=off` to disable.

**What is deliberately not locked down**
- Reads of other Figma files you can open, because your component libraries live in separate files.
- Jira and Confluence search, which Claude uses to follow links from a ticket. Search terms go to Atlassian under your account.
- Claude's edits land in the file like a collaborator's, so Cmd+Z won't undo them directly. **Revert** is the undo; Plan mode is the way to agree first; version history is the backstop.

## Good to know

- Claude's edits arrive as remote changes, like a collaborator's, so Cmd+Z does not undo them. Ask Claude to revert, or use File → Show version history.
- Usage counts against the Claude account Claude Code is signed in with. The footer of each reply shows time and cost.
- The plugin reads the file key through `enablePrivatePluginApi`. If Figma ever withholds it, the panel asks for the file link once.
- This is a development plugin that runs from your machine. A teammate can use it by following [Install](#install) and running their own bridge — nothing is shared between you. A hosted version for the whole team is the later phase B.

## Troubleshooting

Whatever the symptom, `npm run doctor` in `bridge/` checks the whole chain and names the fix. Start there.

### Installing

| Problem | Fix |
|---|---|
| `npm install` fails on an engine or syntax error | Your Node is too old. `node -v` must be 18 or newer. |
| `command not found: npm` | Install Node.js from [nodejs.org](https://nodejs.org); npm comes with it. |
| `Could not listen on 127.0.0.1:4545: EADDRINUSE` | Another program (or an older bridge) already holds the port. Close it, or start on another port: `PORT=4546 npm start` — then change `devAllowedDomains` in `figma-plugin/manifest.json` and **Bridge address** in plugin settings to match. |
| **Import plugin from manifest…** isn't in the menu | You're in the browser. Development plugins only load in the Figma **desktop** app. |
| The plugin imported but shows nothing | Right-click it under Plugins → Development → **Reload**, or reopen the file. |
| I lost the token | It's in `bridge/.bridge-token`, or restart `npm start` and it prints again. |

### Running

| Panel says | Fix |
|---|---|
| Bridge offline | Run `npm start` in `bridge/`, and check **Bridge address** in settings matches the port it printed. |
| Token does not match | Copy it again from `bridge/.bridge-token` (or the `npm start` output) and re-save in settings. |
| Locked for a minute | Something sent the bridge 10 wrong tokens. Wait a minute; if it recurs, `npm run rotate-token` and check what else is running. |
| Connect Figma / Sign in to Claude (header) | Click it: settings opens on Connections. |
| A sign-in never finishes | Cancel and try again. Make sure you approved in the browser that opened, not an older tab. |
| "Couldn't open a sign-in terminal" | The bridge couldn't start the helper that sign-in needs. Run the command it shows in a terminal (for example `claude mcp login atlassian`); the plugin picks the result up. |
| Disconnect says it's still connected | The message names the connection that stayed on and why. If it's one you added by hand, `claude mcp remove <name>` removes it completely. |
| Mentions Jira but no Atlassian server | Settings, Connections, Jira and Confluence, Connect. |
| Claude can read the file but can't edit it | The Dev Mode desktop MCP server is read-only. Connect the hosted one: `https://mcp.figma.com/mcp`. Doctor flags this as "No use_figma write tool". |
| Doctor: an ANTHROPIC_API_KEY was rejected | `unset ANTHROPIC_API_KEY` (and remove it from `~/.zshrc` or `~/.bashrc`), so your Claude login is used. |
| Not logged in | Settings, Connections, Claude account, Sign in. |
| Prefer the terminal? | `claude mcp add --transport http --scope user figma https://mcp.figma.com/mcp`, then `claude` and `/mcp` to sign in. Same for Atlassian with `https://mcp.atlassian.com/v1/mcp`. The plugin picks these up too. |
