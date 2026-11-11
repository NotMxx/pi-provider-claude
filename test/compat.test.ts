// pi 1.2.0 hands extensions its own copy of pi-ai, which lacks some later helpers (parseToolCallArguments among them),
// so a missing one fails only at the first tool call. The extension imports from pi-ai only the values checked
// present there, and parses tool arguments itself.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { toolArguments } from '../src/provider/provider.ts';

// Checked in pi 1.2.0's extension runtime on 2026-11-10.
const IN_PI_1_2 = ['calculateCost', 'createAssistantMessageEventStream', 'createProvider', 'getCurrentSystemPrompt', 'getCurrentTools', 'parseStreamingJson'];

test('the extension imports from pi-ai only values pi 1.2.0 gives extensions', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  const used = new Set<string>();
  for (const f of files) {
    const text = readFileSync(join(src, f), 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@earendil-works\/pi-ai'/g)) {
      for (const name of m[1]!.split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type '))) used.add(name);
    }
  }
  assert.deepEqual([...used].filter((n) => !IN_PI_1_2.includes(n)), []);
});

test('tool arguments: a JSON object is kept; empty is {}; anything else is {} with the reason', () => {
  assert.deepEqual(toolArguments('{"path":"a.txt"}'), { arguments: { path: 'a.txt' } });
  assert.deepEqual(toolArguments(''), { arguments: {} });
  assert.deepEqual(toolArguments('  '), { arguments: {} });
  const list = toolArguments('[1,2]');
  assert.deepEqual(list.arguments, {});
  assert.match(list.argumentsError!, /must be a JSON object/);
  const broken = toolArguments('{"path": ');
  assert.deepEqual(broken.arguments, {});
  assert.match(broken.argumentsError!, /JSON/);
});
