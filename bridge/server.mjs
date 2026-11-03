// Claude Bridge: local server between the Figma plugin and a Claude agent.
// Listens on localhost only. Every request needs the token in .bridge-token.
import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ACTIONS,
  EFFORTS,
  MODES,
  buildOptions,
  buildUserMessage,
  isAtlassianServer,
  isFigmaServer,
  isFigmaTool,
  summarizeToolInput,
  validModel,
} from './agent.mjs';
import { effortsFor, getModels } from './models.mjs';
import { cancel, connect, disconnect, getStatus, submitCode } from './connectors.mjs';
import { addNote, deleteNote, readNotes } from './memory.mjs';

const VERSION = '0.5.0';
const PORT = Number(process.env.PORT || 4545);
const MAX_BODY = 20 * 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));

const tokenFile = path.join(here, '.bridge-token');
let TOKEN;
if (existsSync(tokenFile)) {
  TOKEN = readFileSync(tokenFile, 'utf8').trim();
} else {
  TOKEN = randomBytes(18).toString('base64url');
  writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
}

// Limits on what one request may carry.
const LIMITS = { prompt: 20000, context: 120000, images: 5, imageBytes: 4 * 1024 * 1024 };
const LOCKOUT = { failures: 10, windowMs: 60000, holdMs: 60000 };

let lastStatus = null; // what the most recent session reported at startup
let active = null; // { abort } for the run in progress

// ---------- audit log ----------
// Every request and every tool decision, one JSON line each, in bridge/logs/.
// No prompts, no layer content, no tokens; just what happened.
const logDir = path.join(here, 'logs');
const AUDIT = process.env.AUDIT !== 'off';
function audit(event) {
  if (!AUDIT) return;
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(logDir, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  } catch (e) {}
}

// ---------- request checks ----------
function setHeaders(res) {
  // The plugin UI is a sandboxed iframe whose origin is literally "null".
  // Allowing only that origin means a normal web page fails the CORS
  // preflight and never gets to send the Authorization header.
  res.setHeader('Access-Control-Allow-Origin', 'null');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Blocks DNS-rebinding: a page on attacker.com resolving to 127.0.0.1 would
// arrive with Host: attacker.com.
function hostOk(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const name = host.replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]'].includes(name) && (!/:\d+$/.test(host) || host.endsWith(`:${PORT}`));
}

function tokenOk(header) {
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

// After repeated bad tokens, refuse everything for a while.
const failures = [];
let lockedUntil = 0;
const isLocked = () => Date.now() < lockedUntil;
function authorized(req) {
  if (isLocked()) return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return false;
  if (tokenOk(req.headers.authorization)) return true;
  const now = Date.now();
  failures.push(now);
  while (failures.length && failures[0] < now - LOCKOUT.windowMs) failures.shift();
  if (failures.length >= LOCKOUT.failures) {
    lockedUntil = now + LOCKOUT.holdMs;
    failures.length = 0;
    audit({ event: 'lockout', holdMs: LOCKOUT.holdMs });
    console.warn('Too many bad tokens; refusing all requests for 60s.');
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleChat(req, res) {
  if (active) return json(res, 409, { error: 'A request is already running. Stop it first.' });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { error: `Bad request: ${e.message}` });
  }
  if (!body.prompt || typeof body.prompt !== 'string') {
    return json(res, 400, { error: 'prompt is required' });
  }
  // An action from the plugin's action row fixes the mode: a review or a
  // spec is always read-only, whatever the request says.
  const action = typeof body.action === 'string' && ACTIONS[body.action] ? body.action : null;
  const mode = action ? ACTIONS[action].mode : MODES.includes(body.mode) ? body.mode : 'build';
  body.mode = mode;
  body.action = action;
  const count = Math.max(2, Math.min(4, parseInt(body.actionOptions?.count, 10) || 3));
  body.actionOptions = { count };
  if (body.model != null && !validModel(body.model)) return json(res, 400, { error: 'That model name isn’t valid. Use one from the list or a full ID like claude-sonnet-5-5.' });
  let effort = EFFORTS.includes(body.effort) ? body.effort : undefined;
  const allowed = effortsFor(body.model);
  if (effort && allowed && !allowed.includes(effort)) effort = undefined; // model doesn't take it: use its default
  if (body.prompt.length > LIMITS.prompt) return json(res, 400, { error: `Prompt is over ${LIMITS.prompt} characters.` });
  if (body.context && JSON.stringify(body.context).length > LIMITS.context) return json(res, 400, { error: 'Context is too large.' });
  if (!Array.isArray(body.images)) body.images = [];
  if (body.images.length > LIMITS.images) return json(res, 400, { error: `Up to ${LIMITS.images} images per message.` });
  for (const img of body.images) {
    const data = typeof img === 'string' ? img : img?.data;
    if (typeof data !== 'string' || data.length > LIMITS.imageBytes * 1.4) return json(res, 400, { error: 'An image is too large.' });
  }
  // The file the plugin has open. Writes are confined to it.
  const fileKey = typeof body.context?.file?.key === 'string' && /^[0-9A-Za-z]{10,128}$/.test(body.context.file.key) ? body.context.file.key : null;
  const requestId = randomBytes(4).toString('hex');
  audit({ event: 'chat', requestId, mode, action, model: body.model, effort, fileKey, images: body.images.length, resumed: !!body.sessionId });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
  };

  const abortController = new AbortController();
  active = { abort: () => abortController.abort() };
  res.on('close', () => {
    if (!res.writableFinished) abortController.abort();
  });

  // Streaming-input mode lets us attach screenshots as image blocks.
  // Keep the input open until the turn's result arrives.
  let finish;
  const finished = new Promise((r) => (finish = r));
  async function* input() {
    yield buildUserMessage(body);
    await finished;
  }

  const started = Date.now();
  let streamedThisMessage = false;
  let gotResult = false;

  try {
    const q = query({
      prompt: input(),
      options: buildOptions({
        sessionId: body.sessionId,
        abortController,
        mode,
        model: body.model,
        effort,
        fileKey,
        audit: (d) => audit({ event: 'tool', requestId, mode, fileKey, ...d }),
        onRemember: (n) => {
          audit({ event: 'memory', requestId, scope: n.scope });
          send({ t: 'memory', scope: n.scope, note: n.note });
        },
      }),
    });

    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        const figmaTools = (m.tools || []).filter(isFigmaTool);
        lastStatus = {
          at: new Date().toISOString(),
          model: m.model,
          apiKeySource: m.apiKeySource,
          mcp: (m.mcp_servers || []).map((s) => ({ name: s.name, status: s.status })),
          figmaToolCount: figmaTools.length,
        };
        send({ t: 'session', id: m.session_id, ...lastStatus });
        const figmaServers = lastStatus.mcp.filter((s) => isFigmaServer(s.name));
        if (!figmaServers.length) {
          send({ t: 'warn', message: 'No Figma MCP server found. Run `npm run doctor` in the bridge folder.' });
        } else if (!figmaServers.some((s) => s.status === 'connected' || s.status === 'pending')) {
          const s = figmaServers[0];
          send({ t: 'warn', message: `Figma MCP server "${s.name}" is ${s.status}. Open \`claude\`, run /mcp and sign in.` });
        }
        if (/atlassian\.net|\bjira\b|\/wiki\/|\b[A-Z][A-Z0-9]+-\d+\b/.test(body.prompt)) {
          const atl = lastStatus.mcp.filter((s) => isAtlassianServer(s.name));
          if (!atl.length) {
            send({ t: 'warn', message: 'This mentions Jira or Confluence, but no Atlassian MCP server is set up. Run `npm run doctor` for the command.' });
          } else if (!atl.some((s) => s.status === 'connected' || s.status === 'pending')) {
            send({ t: 'warn', message: `Atlassian server "${atl[0].name}" is ${atl[0].status}. Open \`claude\`, run /mcp and sign in.` });
          }
        }
        continue;
      }

      if (m.type === 'stream_event' && !m.parent_tool_use_id) {
        const ev = m.event;
        if (ev?.type === 'message_start') streamedThisMessage = false;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          streamedThisMessage = true;
          send({ t: 'text', d: ev.delta.text });
        }
        continue;
      }

      if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const block of m.message?.content || []) {
          if (block.type === 'text' && !streamedThisMessage && block.text) {
            send({ t: 'text', d: block.text });
          } else if (block.type === 'tool_use') {
            send({
              t: 'tool',
              id: block.id,
              name: block.name,
              summary: summarizeToolInput(block.input),
            });
          }
        }
        continue;
      }

      if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const block of m.message.content) {
          if (block.type !== 'tool_result') continue;
          let preview = '';
          if (typeof block.content === 'string') preview = block.content;
          else if (Array.isArray(block.content)) {
            preview = block.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
          }
          send({
            t: 'tool_done',
            id: block.tool_use_id,
            ok: !block.is_error,
            preview: preview.slice(0, 300),
          });
        }
        continue;
      }

      if (m.type === 'result') {
        gotResult = true;
        const ok = m.subtype === 'success' && !m.is_error;
        const u = m.usage || {};
        const cached = u.cache_read_input_tokens || 0;
        audit({ event: 'done', requestId, ok, turns: m.num_turns, ms: m.duration_ms, cost: m.total_cost_usd, denied: (m.permission_denials || []).length });
        send({
          t: 'done',
          ok,
          mode,
          sessionId: m.session_id,
          ms: m.duration_ms,
          turns: m.num_turns,
          cost: m.total_cost_usd,
          tokens: {
            input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + cached,
            cached,
            output: u.output_tokens || 0,
          },
          error: ok ? undefined : (m.errors || []).join('; ') || (m.is_error && m.result) || m.subtype,
        });
        finish();
      }
    }
  } catch (e) {
    const stopped = abortController.signal.aborted;
    // The SDK also throws after an error result; that result was already sent.
    if (!gotResult) send({
      t: 'done',
      ok: false,
      stopped,
      ms: Date.now() - started,
      error: stopped ? 'Stopped' : e?.message || String(e),
    });
    gotResult = true;
  } finally {
    finish();
    if (!gotResult) send({ t: 'done', ok: false, ms: Date.now() - started, error: 'The agent ended without a result.' });
    active = null;
    res.end();
  }
}

const server = (host) =>
  http.createServer(async (req, res) => {
    setHeaders(res);
    if (!hostOk(req)) {
      res.writeHead(421);
      return res.end();
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (!authorized(req)) {
      if (isLocked()) return json(res, 429, { error: 'Too many wrong tokens. Try again in a minute.' });
      return json(res, 401, { error: 'Missing or wrong bridge token.' });
    }
    try {
      // Only the path matters; a fixed base avoids IPv6 hosts like ::1 needing brackets.
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, version: VERSION, busy: !!active, status: lastStatus });
      }
      if (req.method === 'POST' && url.pathname === '/chat') return await handleChat(req, res);
      if (url.pathname === '/memory' || url.pathname.startsWith('/memory/')) {
        const key = url.searchParams.get('fileKey') || '';
        if (req.method === 'GET' && url.pathname === '/memory') {
          return json(res, 200, { everywhere: readNotes('everywhere'), file: key ? readNotes('file', key) : [] });
        }
        if (req.method === 'POST') {
          let b = {};
          try {
            b = JSON.parse((await readBody(req)) || '{}');
          } catch (e) {}
          const scope = b.scope === 'everywhere' ? 'everywhere' : 'file';
          try {
            if (url.pathname === '/memory/add') addNote(scope, b.fileKey, b.note, 'you');
            else if (url.pathname === '/memory/delete') deleteNote(scope, b.fileKey, Number(b.index));
            else return json(res, 404, { error: 'Not found' });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
          audit({ event: 'memory-edit', action: url.pathname.slice(8), scope });
          return json(res, 200, { ok: true });
        }
      }
      if (req.method === 'GET' && url.pathname === '/models') {
        try {
          return json(res, 200, { models: await getModels(url.searchParams.get('refresh') === '1') });
        } catch (e) {
          return json(res, 502, { error: e.message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/connectors') {
        return json(res, 200, await getStatus(url.searchParams.get('refresh') === '1'));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/connectors/')) {
        let body = {};
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (e) {}
        const id = String(body.id || '').slice(0, 40);
        const action = url.pathname.slice('/connectors/'.length);
        audit({ event: 'connector', action, id });
        try {
          if (action === 'connect') {
            const job = await connect(id);
            return json(res, 200, { ok: true, state: job.state, url: job.url, message: job.message });
          }
          if (action === 'code') {
            submitCode(id, body.code || '');
            return json(res, 200, { ok: true });
          }
          if (action === 'cancel') {
            cancel(id);
            return json(res, 200, { ok: true });
          }
          if (action === 'disconnect') {
            return json(res, 200, await disconnect(id));
          }
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (req.method === 'POST' && url.pathname === '/stop') {
        active?.abort();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    }
  });

// Listen on IPv4 and IPv6 loopback so "localhost" works whichever way it resolves.
let listening = 0;
for (const host of ['127.0.0.1', '::1']) {
  const s = server(host);
  s.on('error', (e) => {
    if (host === '::1') return; // no IPv6 loopback on this machine: fine
    console.error(`Could not listen on ${host}:${PORT}: ${e.message}`);
    process.exit(1);
  });
  s.listen(PORT, host, () => {
    if (++listening === 1) {
      console.log(`\nClaude Bridge ${VERSION} listening on http://localhost:${PORT}`);
      console.log(`Token (paste into the plugin's settings once):\n\n  ${TOKEN}\n`);
      console.log('Leave this window open while you work. Ctrl+C to stop.\n');
    }
  });
}
