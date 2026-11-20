/**
 * Hermetic unit tests for canonical agent instructions and agent specification (Task E-11).
 *
 * Verifies that:
 * 1. Both instruction files are strictly under 300 words.
 * 2. Neither file contains task-specific words (flask, config, cli, JSON).
 * 3. agent.spec.json has preload: true and require_approval_for_tools: ['proposeEdit', 'createFile'].
 * 4. The instructions mandate proposing edits for all affected files and running tests.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('Canonical Agent Instructions and Specification', () => {
  const forgeDir = path.resolve(__dirname, '../../forge');
  const mainInstructionsPath = path.resolve(forgeDir, 'agent-instructions.md');
  const inlineInstructionsPath = path.resolve(forgeDir, 'agent-instructions.inline.md');
  const specPath = path.resolve(forgeDir, 'agent.spec.json');

  it('keeps forge/agent-instructions.md under 300 words', () => {
    const content = fs.readFileSync(mainInstructionsPath, 'utf-8');
    const words = content.trim().split(/\s+/).filter(Boolean);
    expect(words.length).toBeLessThan(300);
    expect(words.length).toBeGreaterThan(50);
  });

  it('keeps forge/agent-instructions.inline.md under 300 words', () => {
    const content = fs.readFileSync(inlineInstructionsPath, 'utf-8');
    const words = content.trim().split(/\s+/).filter(Boolean);
    expect(words.length).toBeLessThan(300);
    expect(words.length).toBeGreaterThan(20);
  });

  it('contains no task-specific forbidden words in either instruction file', () => {
    const mainContent = fs.readFileSync(mainInstructionsPath, 'utf-8');
    const inlineContent = fs.readFileSync(inlineInstructionsPath, 'utf-8');
    const forbiddenPatterns = [/\bflask\b/i, /\bconfig\b/i, /\bcli\b/i, /\bjson\b/i];

    for (const pattern of forbiddenPatterns) {
      expect(mainContent).not.toMatch(pattern);
      expect(inlineContent).not.toMatch(pattern);
    }
  });

  it('mandates edits for all affected files (source, tests, docs) and running tests before finishing', () => {
    const content = fs.readFileSync(mainInstructionsPath, 'utf-8');
    expect(content).toMatch(/ALL affected files/i);
    expect(content).toMatch(/source/i);
    expect(content).toMatch(/tests/i);
    expect(content).toMatch(/documentation/i);
    expect(content).toMatch(/runCommand/);
    expect(content).toMatch(/test suite/i);
  });

  it('validates agent.spec.json structure and approval requirements', () => {
    const raw = fs.readFileSync(specPath, 'utf-8');
    const spec = JSON.parse(raw);

    expect(spec.name).toBe('forge-primary');
    expect(Array.isArray(spec.mcp_servers)).toBe(true);
    expect(spec.mcp_servers[0].preload).toBe(true);
    expect(spec.mcp_servers[0].require_approval_for_tools).toEqual(['proposeEdit', 'createFile']);

    const specWords = spec.instructions.trim().split(/\s+/).filter(Boolean);
    expect(specWords.length).toBeLessThan(300);
    expect(spec.instructions).not.toMatch(/\bflask\b/i);
    expect(spec.instructions).not.toMatch(/\bconfig\b/i);
    expect(spec.instructions).not.toMatch(/\bcli\b/i);
    expect(spec.instructions).not.toMatch(/\bjson\b/i);
  });

  it('guides the agent toward efficient exploration and batched independent tool calls', () => {
    const mainContent = fs.readFileSync(mainInstructionsPath, 'utf-8');
    const rawSpec = fs.readFileSync(specPath, 'utf-8');
    const spec = JSON.parse(rawSpec);

    expect(mainContent).toMatch(/Explore efficiently/i);
    expect(mainContent).toMatch(/six searches or reads/i);
    expect(spec.instructions).toMatch(/Explore efficiently/i);
    expect(spec.instructions).toMatch(/six searches or reads/i);

    expect(mainContent).toMatch(/independent.*together in one step/i);
    expect(spec.instructions).toMatch(/independent.*together in one step/i);
  });
});
