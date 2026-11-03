// Connectors: lets the plugin connect Figma, Jira/Confluence and your Claude
// account without a terminal. Runs the same Claude Code commands you would
// type (`claude mcp add`, `claude mcp login`, `claude auth login`) using the
// CLI that ships inside the Agent SDK, so nothing extra needs installing.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { WORKSPACE } from './agent.mjs';

const require = createRequire(import.meta.url);

// Only these can be added from the plugin. No arbitrary URLs.
export const CATALOG = [
  {
    id: 'figma',
    name: 'Figma',
    url: process.env.CONNECTOR_FIGMA_URL || 'https://mcp.figma.com/mcp',
    match: /figma/i,
    about: 'Read and edit your Figma files. Required.',
  },
  {
    id: 'atlassian',
    name: 'Jira and Confluence',
    url: process.env.CONNECTOR_ATLASSIAN_URL || 'https://mcp.atlassian.com/v1/mcp',
    match: /atlassian|jira|rovo/i,
    about: 'Read tickets and specs. Read-only.',
  },
];

// ---------- the CLI ----------

let cliPath = null;
export function claudeCli() {
  if (cliPath) return cliPath;
  if (process.env.CLAUDE_CLI) return (cliPath = process.env.CLAUDE_CLI);
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const pkg of [base, `${base}-musl`]) {
    try {
      return (cliPath = require.resolve(`${pkg}/${exe}`));
    } catch (e) {}
  }
  return (cliPath = 'claude'); // fall back to a global install
}

// Colour codes, cursor codes, and OSC sequences such as terminal hyperlinks.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const clean = (s) => s.replace(ANSI, '').replace(/\r/g, '');

function run(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(claudeCli(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, cwd: WORKSPACE });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: clean(out) });
    });
  });
}

// Sign-in commands refuse to run without a terminal, so give them one with
// `script`, which ships with macOS and Linux. Its input must be a named pipe:
// macOS `script` exits with "tcgetattr/ioctl: Operation not supported on
// socket" when handed the socket Node normally uses, but treats a pipe as
// "no terminal here" and carries on. The pipe stays open so codes can be
// typed into it later.
function spawnInTerminal(args) {
  const bin = claudeCli();
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-bridge-'));
  const fifo = path.join(dir, 'in');
  let fd = null;
  try {
    execFileSync('mkfifo', ['-m', '600', fifo]);
    fd = openSync(fifo, 'r+'); // read+write so opening never blocks and input never hits EOF
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Could not prepare a sign-in terminal: ${e.message}`);
  }
  let child;
  const opts = { stdio: [fd, 'pipe', 'pipe'], cwd: WORKSPACE };
  if (process.platform === 'darwin') child = spawn('script', ['-q', '/dev/null', bin, ...args], opts);
  else if (process.platform === 'linux') {
    const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
    child = spawn('script', ['-qec', [bin, ...args].map(q).join(' '), '/dev/null'], opts);
  } else child = spawn(bin, args, opts);
  child.write = (text) => writeSync(fd, text);
  child.on('close', () => {
    try { closeSync(fd); } catch (e) {}
    rmSync(dir, { recursive: true, force: true });
  });
  return child;
}

// claude.ai connectors arrive with names like "claude.ai Atlassian".
const CLAUDE_AI_NAME = /^claude[._ -]?ai\b/i;
const TERMINAL_FAIL = /tcgetattr|ioctl|openpty|not supported on socket|isn't a terminal|not a tty/i;

// ---------- can this computer sign in from the plugin? ----------

// A sign-in only starts if the CLI thinks it has a terminal, and the terminal
// we fake for it needs `mkfifo` and `script`. Windows has neither, and slim
// Linux images often drop `script`. Check once so the plugin can say "do this
// in Terminal" up front instead of offering a button that cannot work.
let signIn = null;

function has(bin) {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

export function signInSupport() {
  if (signIn) return signIn;
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    signIn = { supported: false, reason: `Signing in from the plugin needs a terminal, which this bridge cannot open on ${process.platform}.` };
  } else {
    const missing = ['mkfifo', 'script'].filter((b) => !has(b));
    signIn = missing.length
      ? { supported: false, reason: `Signing in from the plugin needs ${missing.join(' and ')}, which ${missing.length > 1 ? "aren't" : "isn't"} installed on this computer.` }
      : { supported: true, reason: null };
  }
  return signIn;
}

// Called when a sign-in dies on a terminal problem anyway: stop offering the
// button for the rest of this run.
function signInUnavailable(reason) {
  signIn = { supported: false, reason };
}

// The command to type by hand. Prefer a plain `claude` when it is on PATH;
// otherwise point at the copy inside the Agent SDK so the line still works.
let cliName = null;
function cliCommandName() {
  if (cliName) return cliName;
  const bin = has('claude') ? 'claude' : claudeCli();
  // A path with spaces still has to paste cleanly. cmd.exe has no single
  // quotes, so Windows gets double ones.
  if (/^[\w@%+=:,./-]+$/.test(bin)) cliName = bin;
  else if (process.platform === 'win32') cliName = `"${bin.replace(/"/g, '')}"`;
  else cliName = `'${bin.replace(/'/g, `'\\''`)}'`;
  return cliName;
}

// The exact lines to run in the terminal where the bridge lives.
export function manualSteps(key, status) {
  const cli = cliCommandName();
  if (key === 'claude') return [`${cli} auth login --claudeai`];
  const c = CATALOG.find((x) => x.id === key);
  if (!c) return [];
  const row = status && status.connectors.find((x) => x.id === key);
  const own = row && (row.servers || []).find((x) => !x.managedBy);
  const steps = [];
  if (!row || !row.added) steps.push(`${cli} mcp add --transport http --scope user ${c.id} ${c.url}`);
  steps.push(`${cli} mcp login ${own ? own.name : row && row.serverName ? row.serverName : c.id}`);
  return steps;
}

// ---------- status ----------

function parseStatus(text) {
  const t = text.toLowerCase();
  if (/needs? auth|authenticat|sign.?in|login required|unauthori[sz]ed|401/.test(t)) return 'needs-auth';
  if (/✓|\bconnected\b/.test(t) && !/not connected|failed|disconnected/.test(t)) return 'connected';
  if (/pending/.test(t)) return 'pending';
  if (/disabled/.test(t)) return 'disabled';
  return 'failed';
}

let cache = null;
let cacheAt = 0;

export async function getStatus(force = false) {
  if (!force && cache && Date.now() - cacheAt < 20000) return withJobs(cache);

  const [auth, list] = await Promise.all([run(['auth', 'status', '--json'], 15000), run(['mcp', 'list'], 45000)]);

  let account = { loggedIn: false };
  try {
    const j = JSON.parse(auth.out.slice(auth.out.indexOf('{')));
    account = {
      loggedIn: !!j.loggedIn,
      method: j.authMethod,
      email: j.email || j.account?.email || j.emailAddress || null,
      org: j.orgName || j.organization?.name || j.account?.organizationName || null,
    };
  } catch (e) {
    account = { loggedIn: false, error: auth.code === -1 ? `Could not run Claude Code: ${auth.out}` : undefined };
  }

  // Lines look like: "figma: https://mcp.figma.com/mcp (HTTP) - ✓ Connected"
  const servers = [];
  for (const line of list.out.split('\n')) {
    const m = line.match(/^(.+?): (\S+)(?: \(([^)]+)\))? - (.+)$/);
    if (m) servers.push({ name: m[1].trim(), url: m[2], status: parseStatus(m[4]), detail: m[4].trim() });
  }

  // A connector can be backed by several servers, e.g. one you added plus
  // one or two from your claude.ai connectors. All of them count.
  const RANK = { connected: 5, pending: 4, 'needs-auth': 3, failed: 2, disabled: 1 };
  // Each server belongs to exactly one row: exact name, then name pattern,
  // then URL. So one connector can never claim another's server.
  const owner = (x) =>
    CATALOG.find((c) => x.name === c.id) || CATALOG.find((c) => c.match.test(x.name)) || CATALOG.find((c) => x.url === c.url) || null;
  const connectors = CATALOG.map((c) => {
    const matches = servers
      .filter((x) => owner(x) === c)
      .map((x) => ({ ...x, managedBy: CLAUDE_AI_NAME.test(x.name) ? 'claude.ai' : null }))
      .sort((a, b) => (RANK[b.status] || 0) - (RANK[a.status] || 0));
    const best = matches[0];
    return {
      id: c.id,
      name: c.name,
      about: c.about,
      added: matches.length > 0,
      serverName: best?.name || null,
      servers: matches.map((x) => ({ name: x.name, status: x.status, managedBy: x.managedBy })),
      managedBy: matches.length && matches.every((x) => x.managedBy) ? 'claude.ai' : null,
      status: best ? best.status : 'not-added',
      detail: best ? best.detail.replace(/^[✓✔√✗✘×⚠⊘!\s]+/, '') : null,
    };
  });

  cache = { account, connectors };
  cacheAt = Date.now();
  return withJobs(cache);
}

// ---------- sign-in jobs ----------

const jobs = new Map(); // key: 'claude' | connector id

function withJobs(status) {
  const view = (key) => {
    const j = jobs.get(key);
    return j ? { state: j.state, url: j.url, needsCode: j.needsCode, message: j.message, manual: !!j.manual, commands: j.commands || null } : null;
  };
  const s = signInSupport();
  return {
    signIn: { supported: s.supported, reason: s.reason, cwd: WORKSPACE },
    account: { ...status.account, job: view('claude'), commands: manualSteps('claude', status) },
    connectors: status.connectors.map((c) => ({ ...c, job: view(c.id), commands: manualSteps(c.id, status) })),
  };
}

// Starts a sign-in, or hands back the terminal commands when this computer
// cannot run one. Either way the plugin gets something to show.
function login(key, args, commands) {
  const s = signInSupport();
  if (s.supported) return startJob(key, args, commands);
  const job = { state: 'manual', url: null, needsCode: false, manual: true, commands, message: s.reason };
  jobs.set(key, job);
  return job;
}

function startJob(key, args, commands) {
  const existing = jobs.get(key);
  if (existing && existing.state === 'running') return existing;

  const job = { id: randomBytes(6).toString('hex'), state: 'running', url: null, needsCode: false, manual: false, commands, message: 'Opening your browser…', out: '' };
  jobs.set(key, job);

  let child;
  try {
    child = spawnInTerminal(args);
  } catch (e) {
    signInUnavailable(e.message);
    Object.assign(job, { state: 'manual', manual: true, message: e.message });
    return job;
  }
  job.child = child;
  const timer = setTimeout(() => {
    job.message = 'Timed out waiting for the browser sign-in.';
    child.kill('SIGTERM');
  }, 5 * 60 * 1000);

  const onData = (d) => {
    job.out += clean(String(d));
    const url = job.out.match(/https:\/\/[^\s"'<>]+/);
    if (url && !job.url) job.url = url[0];
    if (/paste (the )?(code|redirect|url)/i.test(job.out)) job.needsCode = true;
    if (job.codeAt != null) {
      // After a code was pasted, surface what the CLI says about it.
      const after = job.out.slice(job.codeAt).split('\n').map((l) => l.trim()).filter(Boolean);
      const problem = after.reverse().find((l) => /invalid|error|expired|denied|fail/i.test(l));
      if (problem) {
        job.message = problem.replace(/^.*?>\s*/, '').slice(0, 200);
        job.codeAt = null; // ready for another try
      }
    } else if (job.url) {
      job.message = job.needsCode ? 'Approve in the browser, then paste the code it shows.' : 'Approve in the browser that just opened.';
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => Object.assign(job, { state: 'failed', message: e.message }));
  child.on('close', (code) => {
    clearTimeout(timer);
    const failed = code !== 0 || /couldn't complete|failed|error|denied|invalid/i.test(job.out.split('\n').slice(-6).join('\n'));
    if (job.state === 'cancelled') return;
    job.state = failed ? 'failed' : 'done';
    if (failed) {
      const last = job.out.trim().split('\n').filter(Boolean).pop() || '';
      if (TERMINAL_FAIL.test(job.out)) {
        job.manual = true;
        job.message = "This computer wouldn't give the sign-in a terminal. Run it yourself instead:";
        signInUnavailable("Sign-ins from the plugin can't get a terminal on this computer.");
      } else job.message = job.message.startsWith('Timed out') ? job.message : last.slice(0, 240) || 'Sign-in did not finish.';
    } else job.message = 'Connected.';
    job.child = null;
    cacheAt = 0; // refresh status on next read
  });
  return job;
}

// Turn a server on or off for the bridge's folder only. Claude Code records
// this per folder, so claude.ai and your other projects are unaffected.
async function setEnabled(serverName, enabled) {
  let release;
  const hold = new Promise((r) => (release = r));
  async function* input() { await hold; }
  const q = query({ prompt: input(), options: { cwd: WORKSPACE, settingSources: ['user', 'project', 'local'], tools: [] } });
  try {
    await Promise.race([q.initializationResult(), new Promise((_, rej) => setTimeout(() => rej(new Error('Claude Code did not start.')), 30000))]);
    await q.toggleMcpServer(serverName, enabled);
  } finally {
    release();
    try { q.close?.(); } catch (e) {}
  }
}

// "Scope: User config (...)" → user | local | project | claudeai | other
async function scopeOf(serverName) {
  const r = await run(['mcp', 'get', serverName], 30000);
  const line = (r.out.match(/^\s*Scope:\s*(.+)$/m) || [])[1] || '';
  if (/claude\.ai/i.test(line) || CLAUDE_AI_NAME.test(serverName)) return 'claudeai';
  if (/user/i.test(line)) return 'user';
  if (/local/i.test(line)) return 'local';
  if (/project/i.test(line)) return 'project';
  return 'other';
}

export async function connect(id) {
  if (id === 'claude') return login('claude', ['auth', 'login', '--claudeai'], manualSteps('claude', null));
  const c = CATALOG.find((x) => x.id === id);
  if (!c) throw new Error('Unknown connector');
  const status = await getStatus(true);
  const current = status.connectors.find((x) => x.id === id);
  let name = current.serverName || c.id;

  // Anything in this row turned off for the bridge comes back on first.
  const off = (current.servers || []).filter((x) => x.status === 'disabled');
  if (off.length) {
    for (const sv of off) await setEnabled(sv.name, true);
    const after = (await getStatus(true)).connectors.find((x) => x.id === id);
    const needs = after.servers.find((x) => x.status === 'needs-auth' && !x.managedBy) || after.servers.find((x) => x.status === 'needs-auth');
    if (!needs) return { state: 'done', url: null, message: `${c.name} is on again.` };
    name = needs.name;
  } else if (current.added) {
    // Prefer a server you can sign into here over a claude.ai one.
    const own = current.servers.find((x) => !x.managedBy);
    if (own) name = own.name;
  }
  if (!current.added) {
    const r = await run(['mcp', 'add', '--transport', 'http', '--scope', 'user', c.id, c.url]);
    if (r.code !== 0 && !/already exists/i.test(r.out)) throw new Error(r.out.trim() || 'Could not add the server.');
    name = c.id;
  }
  return login(id, ['mcp', 'login', name], [`${cliCommandName()} mcp login ${name}`]);
}

export async function disconnect(id) {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) throw new Error('Unknown connector');
  const current = (await getStatus(true)).connectors.find((x) => x.id === id);
  if (!current || !current.added) return { ok: true, message: `${c.name} isn't connected.` };
  cancel(id);

  const signedOut = [];
  const turnedOff = [];
  const errors = [];
  for (const sv of current.servers) {
    if (sv.status === 'disabled') continue;
    try {
      const scope = sv.managedBy ? 'claudeai' : await scopeOf(sv.name);
      if (scope === 'claudeai') {
        // Managed by your Claude account: switch it off here only.
        await setEnabled(sv.name, false);
        turnedOff.push(sv.name);
        continue;
      }
      const r = await run(['mcp', 'logout', sv.name]);
      if (r.code === 0) signedOut.push(sv.name);
      else if (/no (stored )?(oauth )?(credentials|tokens)|not (logged in|authenticated)|oauth/i.test(r.out)) {
        // Nothing to sign out of: turn it off for the bridge instead.
        await setEnabled(sv.name, false);
        turnedOff.push(sv.name);
      } else errors.push(`${sv.name}: ${r.out.trim().split('\n').pop() || 'logout failed'}`);
    } catch (e) {
      errors.push(`${sv.name}: ${e.message}`);
    }
  }

  // Check it actually took effect rather than trusting the commands.
  cacheAt = 0;
  const after = (await getStatus(true)).connectors.find((x) => x.id === id);
  const still = after ? after.servers.filter((x) => x.status === 'connected' || x.status === 'pending') : [];
  if (still.length || errors.length) {
    const names = still.map((x) => x.name).join(', ');
    throw new Error(`${c.name} is still connected${names ? ` through ${names}` : ''}.${errors.length ? ` ${errors.join('; ')}` : ''}`);
  }
  const parts = [];
  if (signedOut.length) parts.push(`signed out of ${signedOut.join(', ')}`);
  if (turnedOff.length) parts.push(`turned off ${turnedOff.join(', ')} for the bridge${turnedOff.some((n) => CLAUDE_AI_NAME.test(n)) ? ' (claude.ai is unaffected)' : ''}`);
  return { ok: true, message: `${c.name} disconnected: ${parts.join('; ') || 'nothing was active'}.`, status: after ? after.status : 'not-added' };
}

export function submitCode(key, code) {
  const job = jobs.get(key);
  if (!job || job.state !== 'running' || !job.child) throw new Error('No sign-in waiting for a code.');
  job.codeAt = job.out.length;
  const clean = String(code).replace(/[\r\n\u001b]/g, '').trim().slice(0, 512);
  if (!clean) throw new Error('Empty code.');
  job.child.write(clean + '\n');
  job.message = 'Checking the code…';
}

export function cancel(key) {
  const job = jobs.get(key);
  if (job && job.state === 'running' && job.child) {
    job.state = 'cancelled';
    job.message = 'Cancelled.';
    job.child.kill('SIGTERM');
  }
  jobs.delete(key);
}

