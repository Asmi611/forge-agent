/**
 * Configuration loader, deep merge, and loopback security validator for Forge Agent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface SetupConfig {
  baseUrl: string;
  isLoopback: boolean;
  rejectedNonLoopback: boolean;
  loopbackWarning?: string;
  agents: {
    primary: string;
    fallback: string;
  };
  mcp: {
    name: string;
    perWorkspace: boolean;
    port: number;
    path: string;
  };
  budgets: {
    seedTokens: number;
    mentionsTokens: number;
    runToolBudgetTokens: number;
    maxToolCalls: number;
    maxRunSeconds: number;
  };
  retry: {
    max: number;
    baseDelayMs: number;
  };
}

export interface ModelProfile {
  agent: string;
  provider: string;
  modelId: string;
  kind: string;
  modelContextTokens: number;
  approxCostNote?: string;
}

export interface ModelsConfig {
  profiles: {
    primary: ModelProfile;
    fallback: ModelProfile;
  };
  drill?: {
    local?: {
      provider: string;
      modelId: string;
      modelContextTokens: number;
      note?: string;
    };
  };
}

export interface EngineConfig {
  setup: SetupConfig;
  models: ModelsConfig;
}

export interface CanonicalAgentConfig {
  instructions: string;
  spec: Record<string, unknown>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Computes deterministic 8-character hex SHA-256 suffix for workspace isolation. */
export function computeWorkspaceSuffix(workspaceRoot: string): string {
  const normalized = workspaceRoot.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

/** Validates baseUrl protocol (http/https only) and checks whether it points strictly to loopback. */
export function validateBaseUrl(urlStr: string): { isLoopback: boolean; rejected: boolean; warning?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new ConfigError(`Invalid baseUrl: '${urlStr}' is not a valid URL.`);
  }

  // Reject unsupported protocols: allow only http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`Invalid baseUrl: protocol '${parsed.protocol}' is unsupported. Only 'http:' and 'https:' are allowed.`);
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]';

  if (!isLoopback) {
    return {
      isLoopback: false,
      rejected: true,
      warning: `Base URL '${urlStr}' is not a loopback address. TrueForge in local mode has no authentication; exposing it to non-loopback hosts is insecure (docs/03 T10).`,
    };
  }

  return { isLoopback: true, rejected: false };
}

/** Pure type guard checking if value is a non-null, non-array object record. */
export function isPlainObject(item: unknown): item is Record<string, unknown> {
  return typeof item === 'object' && item !== null && !Array.isArray(item);
}

/** Pure recursive deep merge helper where source overwrites target. */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const output: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = output[key];
    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      output[key] = deepMerge(targetVal, sourceVal);
    } else if (sourceVal !== undefined) {
      output[key] = sourceVal;
    }
  }
  return output as T;
}

function readJsonFile(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new ConfigError(`Failed to parse JSON file '${filePath}': ${(err as Error).message}`);
  }
}

/** Validates all required nested fields of a setup configuration. */
export function validateSetupConfig(setup: Record<string, unknown>, sourcePath: string): SetupConfig {
  if (!setup.baseUrl || typeof setup.baseUrl !== 'string' || setup.baseUrl.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'baseUrl'`);
  }

  if (!isPlainObject(setup.agents)) {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing 'agents' object`);
  }
  const agents = setup.agents;
  if (!agents.primary || typeof agents.primary !== 'string' || agents.primary.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'agents.primary'`);
  }
  if (!agents.fallback || typeof agents.fallback !== 'string' || agents.fallback.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'agents.fallback'`);
  }

  if (!isPlainObject(setup.mcp)) {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing 'mcp' object`);
  }
  const mcp = setup.mcp;
  if (!mcp.name || typeof mcp.name !== 'string' || mcp.name.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'mcp.name'`);
  }
  if (!Number.isInteger(mcp.port) || (mcp.port as number) < 1024 || (mcp.port as number) > 65535) {
    throw new ConfigError(`Invalid config in '${sourcePath}': 'mcp.port' must be an integer between 1024 and 65535`);
  }
  if (!mcp.path || typeof mcp.path !== 'string' || mcp.path.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'mcp.path'`);
  }
  if (typeof mcp.perWorkspace !== 'boolean') {
    throw new ConfigError(`Invalid config in '${sourcePath}': 'mcp.perWorkspace' must be a boolean`);
  }

  if (!isPlainObject(setup.budgets)) {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing 'budgets' object`);
  }
  const budgets = setup.budgets;
  const budgetFields = ['seedTokens', 'mentionsTokens', 'runToolBudgetTokens', 'maxToolCalls', 'maxRunSeconds'] as const;
  for (const field of budgetFields) {
    if (typeof budgets[field] !== 'number' || (budgets[field] as number) <= 0) {
      throw new ConfigError(`Invalid config in '${sourcePath}': 'budgets.${field}' must be a positive number`);
    }
  }

  if (!isPlainObject(setup.retry)) {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing 'retry' object`);
  }
  const retry = setup.retry;
  if (typeof retry.max !== 'number' || (retry.max as number) < 0) {
    throw new ConfigError(`Invalid config in '${sourcePath}': 'retry.max' must be a non-negative number`);
  }
  if (typeof retry.baseDelayMs !== 'number' || (retry.baseDelayMs as number) <= 0) {
    throw new ConfigError(`Invalid config in '${sourcePath}': 'retry.baseDelayMs' must be a positive number`);
  }

  return setup as unknown as SetupConfig;
}

/** Validates a model profile. */
export function validateModelProfile(profile: unknown, profileName: string, sourcePath: string): ModelProfile {
  if (!isPlainObject(profile)) {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing 'profiles.${profileName}' object`);
  }
  const p = profile;
  if (!p.agent || typeof p.agent !== 'string' || p.agent.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'profiles.${profileName}.agent'`);
  }
  if (!p.provider || typeof p.provider !== 'string' || p.provider.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'profiles.${profileName}.provider'`);
  }
  if (!p.modelId || typeof p.modelId !== 'string' || p.modelId.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'profiles.${profileName}.modelId'`);
  }
  if (!p.kind || typeof p.kind !== 'string' || p.kind.trim() === '') {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing or empty 'profiles.${profileName}.kind'`);
  }
  if (typeof p.modelContextTokens !== 'number' || p.modelContextTokens <= 0) {
    throw new ConfigError(`Invalid config in '${sourcePath}': 'profiles.${profileName}.modelContextTokens' must be a positive number`);
  }

  return p as unknown as ModelProfile;
}

/** Validates all required fields in models configuration. */
export function validateModelsConfig(models: Record<string, unknown>, sourcePath: string): ModelsConfig {
  if (!isPlainObject(models.profiles)) {
    throw new ConfigError(`Invalid config in '${sourcePath}': missing 'profiles' object`);
  }
  const profiles = models.profiles;
  validateModelProfile(profiles.primary, 'primary', sourcePath);
  validateModelProfile(profiles.fallback, 'fallback', sourcePath);
  return models as unknown as ModelsConfig;
}

/** Loads canonical agent instructions and agent specification from forge/ directory. */
export function loadCanonicalAgentConfig(forgeDir: string): CanonicalAgentConfig {
  const instructionsPath = path.resolve(forgeDir, 'agent-instructions.md');
  if (!fs.existsSync(instructionsPath)) {
    throw new ConfigError(`Canonical agent instructions file missing: '${instructionsPath}'`);
  }
  const rawInstructions = fs.readFileSync(instructionsPath, 'utf-8');
  if (!rawInstructions || rawInstructions.trim().length === 0) {
    throw new ConfigError(`Canonical agent instructions file is empty: '${instructionsPath}'`);
  }

  const specPath = path.resolve(forgeDir, 'agent.spec.json');
  if (!fs.existsSync(specPath)) {
    throw new ConfigError(`Canonical agent spec file missing: '${specPath}'`);
  }
  const rawSpec = readJsonFile(specPath);
  if (!isPlainObject(rawSpec)) {
    throw new ConfigError(`Canonical agent spec file '${specPath}' must contain a valid JSON object`);
  }

  return {
    instructions: rawInstructions.trim(),
    spec: rawSpec,
  };
}

/** Loads and validates typed configuration from forge/ with overrides and loopback checks. */
export function loadConfig(options?: {
  workspaceRoot?: string;
  forgeDir?: string;
  allowNonLoopback?: boolean;
}): EngineConfig {
  const root = options?.workspaceRoot ?? process.cwd();
  const forgeDir = options?.forgeDir ?? path.resolve(root, 'forge');

  const setupExamplePath = path.resolve(forgeDir, 'setup.example.json');
  const setupLocalPath = path.resolve(forgeDir, 'setup.local.json');
  const modelsExamplePath = path.resolve(forgeDir, 'models.example.json');
  const modelsLocalPath = path.resolve(forgeDir, 'models.local.json');

  // Load and validate base setup example
  const setupExample = readJsonFile(setupExamplePath);
  if (!isPlainObject(setupExample)) {
    throw new ConfigError(`Missing or invalid base configuration file: '${setupExamplePath}'`);
  }
  validateSetupConfig(setupExample, setupExamplePath);

  let mergedSetup = { ...(setupExample as unknown as SetupConfig) };
  const setupLocal = readJsonFile(setupLocalPath);
  if (setupLocal !== null) {
    if (!isPlainObject(setupLocal)) {
      throw new ConfigError(`Invalid local setup file '${setupLocalPath}': root must be a JSON object`);
    }
    mergedSetup = deepMerge(mergedSetup as unknown as Record<string, unknown>, setupLocal) as unknown as SetupConfig;
  }

  // Validate merged setup
  validateSetupConfig(mergedSetup as unknown as Record<string, unknown>, setupLocal ? setupLocalPath : setupExamplePath);

  // Validate loopback security and protocol
  const loopbackResult = validateBaseUrl(mergedSetup.baseUrl);
  mergedSetup.isLoopback = loopbackResult.isLoopback;
  mergedSetup.rejectedNonLoopback = loopbackResult.rejected;
  mergedSetup.loopbackWarning = loopbackResult.warning;

  if (loopbackResult.rejected && !options?.allowNonLoopback) {
    throw new ConfigError(loopbackResult.warning ?? `Base URL '${mergedSetup.baseUrl}' rejected: non-loopback addresses are forbidden.`);
  }

  // Apply mcp.perWorkspace naming if enabled
  if (mergedSetup.mcp.perWorkspace && options?.workspaceRoot) {
    const suffix = computeWorkspaceSuffix(options.workspaceRoot);
    mergedSetup.mcp.name = `${mergedSetup.mcp.name}-${suffix}`;
    mergedSetup.agents.primary = `${mergedSetup.agents.primary}-${suffix}`;
    mergedSetup.agents.fallback = `${mergedSetup.agents.fallback}-${suffix}`;
  }

  // Load and validate base models example
  const modelsExample = readJsonFile(modelsExamplePath);
  if (!isPlainObject(modelsExample)) {
    throw new ConfigError(`Missing or invalid base models file: '${modelsExamplePath}'`);
  }
  validateModelsConfig(modelsExample, modelsExamplePath);

  let mergedModels = { ...(modelsExample as unknown as ModelsConfig) };
  const modelsLocal = readJsonFile(modelsLocalPath);
  if (modelsLocal !== null) {
    if (!isPlainObject(modelsLocal)) {
      throw new ConfigError(`Invalid local models file '${modelsLocalPath}': root must be a JSON object`);
    }
    mergedModels = deepMerge(mergedModels as unknown as Record<string, unknown>, modelsLocal) as unknown as ModelsConfig;
  }

  // Validate merged models
  validateModelsConfig(mergedModels as unknown as Record<string, unknown>, modelsLocal ? modelsLocalPath : modelsExamplePath);

  return {
    setup: mergedSetup,
    models: mergedModels,
  };
}
