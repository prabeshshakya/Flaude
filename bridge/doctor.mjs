// npm run doctor: checks that the agent can start, that it is signed in,
// and that the Figma (and optionally Atlassian) MCP servers are reachable.
// Sends one tiny prompt, so it costs a fraction of a cent.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildOptions, isAtlassianServer, isFigmaServer, isFigmaTool } from './agent.mjs';

const ok = (s) => console.log(`  ok    ${s}`);
const bad = (s) => console.log(`  fix   ${s}`);
const note = (s) => console.log(`  note  ${s}`);
const cmd = (s) => console.log(`          ${s}`);
const live = (s) => s === 'connected' || s === 'pending';

console.log('\nClaude Bridge doctor\n');
let problems = 0;
let init = null;
let result = null;
let thrown = null;

try {
  for await (const m of query({ prompt: 'Reply with the single word OK.', options: buildOptions({ maxTurns: 1 }) })) {
    if (m.type === 'system' && m.subtype === 'init') init = m;
    if (m.type === 'result') result = m;
  }
} catch (e) {
  thrown = e;
}

// ---- 1. Claude login: judged by whether the test prompt actually went through
if (!init && thrown) {
  bad(`The agent did not start: ${thrown.message}`);
  problems++;
} else {
  ok(`Claude Code ${init.claude_code_version}, model ${init.model}`);
  const text = String((result && (result.result || (result.errors || []).join('; '))) || thrown?.message || '');
  const passed = result && result.subtype === 'success' && !result.is_error;
  const usingEnvKey = init.apiKeySource === 'ANTHROPIC_API_KEY';

  if (passed) {
    ok(`Signed in${usingEnvKey ? ' with ANTHROPIC_API_KEY from your environment' : ''}, test prompt answered`);
  } else if (/not logged in|\/login/i.test(text)) {
    bad('Not signed in to Claude. In the plugin: settings, Connections, Sign in.');
    cmd('or in a terminal: claude, then /login');
    problems++;
  } else if (/401|authenticat|invalid.*(key|token)|expired/i.test(text)) {
    if (usingEnvKey) {
      bad('An ANTHROPIC_API_KEY in your shell is being used instead of your Claude login, and it was rejected.');
      cmd('unset ANTHROPIC_API_KEY      (and remove it from ~/.zshrc if it is set there)');
    } else {
      bad('Your Claude login was rejected or has expired. Run `claude`, then /logout and /login.');
    }
    problems++;
  } else {
    bad(`Test prompt failed: ${text || 'unknown error'}`);
    problems++;
  }

  // ---- 2. Figma MCP
  const servers = init.mcp_servers || [];
  const figma = servers.filter((s) => isFigmaServer(s.name));
  if (!figma.length) {
    bad('Figma is not connected. In the plugin: settings, Connections, Figma, Connect.');
    problems++;
  }
  for (const s of figma) {
    if (live(s.status)) ok(`Figma MCP "${s.name}" is ${s.status} (from ${s.source || 'config'})`);
    else if (s.status === 'needs-auth') {
      bad(`Figma ("${s.name}") needs sign-in. In the plugin: settings, Connections, Reconnect.`);
      problems++;
    } else {
      bad(`Figma ("${s.name}") is ${s.status}. In the plugin: settings, Connections, Reconnect.`);
      problems++;
    }
  }
  const figmaTools = (init.tools || []).filter(isFigmaTool);
  if (figmaTools.length) {
    ok(`${figmaTools.length} Figma tools visible`);
    if (!figmaTools.some((t) => t.endsWith('__use_figma'))) {
      bad('No use_figma write tool. This Figma server can read but not edit (the Dev Mode desktop server is read-only; use https://mcp.figma.com/mcp).');
      problems++;
    }
  } else if (figma.some((s) => live(s.status))) {
    note('Figma tools load on demand, so they are not listed yet. That is normal.');
  }

  // ---- 3. Atlassian (optional)
  const atl = servers.filter((s) => isAtlassianServer(s.name));
  if (process.env.ATLASSIAN === 'off') note('Jira/Confluence reading is turned off (ATLASSIAN=off).');
  else if (!atl.length) {
    note('Optional: Jira and Confluence are not connected. In the plugin: settings, Connections.');
  }
  for (const s of atl) {
    if (live(s.status)) ok(`Atlassian "${s.name}" is ${s.status} (read-only through the bridge)`);
    else {
      bad(`Jira and Confluence ("${s.name}") is ${s.status}. In the plugin: settings, Connections, Reconnect.`);
      problems++;
    }
  }

  const other = servers.filter((s) => !isFigmaServer(s.name) && !isAtlassianServer(s.name));
  if (other.length) note(`Other MCP servers found but blocked by the bridge: ${other.map((s) => s.name).join(', ')}`);
}

console.log(problems ? `\n${problems} thing(s) to fix. Re-run \`npm run doctor\` after each fix.\n` : '\nAll good. Run `npm start`.\n');
process.exit(problems ? 1 : 0);
