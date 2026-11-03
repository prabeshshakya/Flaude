// The model list the plugin shows: asked from Claude Code, so it matches
// your account and stays current as new models ship. Cached for an hour.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { WORKSPACE } from './agent.mjs';

let cache = null;
let cacheAt = 0;
let inflight = null;

async function fetchModels() {
  let release;
  const hold = new Promise((r) => (release = r));
  async function* input() { await hold; } // never sends a prompt
  const q = query({ prompt: input(), options: { cwd: WORKSPACE, settingSources: [], tools: [] } });
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out asking Claude Code for models.')), 30000));
  try {
    const list = await Promise.race([q.supportedModels(), timer]);
    return list.map((m) => ({
      value: m.value,
      model: m.resolvedModel || null,
      name: m.displayName,
      description: m.description || '',
      efforts: m.supportsEffort ? m.supportedEffortLevels || [] : [],
    }));
  } finally {
    release();
    try { q.close?.(); } catch (e) {}
  }
}

export async function getModels(force = false) {
  if (!force && cache && Date.now() - cacheAt < 3600000) return cache;
  if (!inflight) {
    inflight = fetchModels()
      .then((models) => { cache = models; cacheAt = Date.now(); return models; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Effort levels a given model accepts, when known.
export function effortsFor(value) {
  const m = cache && cache.find((x) => x.value === value || x.model === value);
  return m ? m.efforts : null;
}
