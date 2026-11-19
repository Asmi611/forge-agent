/**
 * Pure terminal policy evaluation engine for Forge Agent (Milestone E-10a).
 *
 * Classifies command requests into 'auto', 'confirm', or 'deny' tiers
 * based strictly on argv security rules and argument allowlists without I/O.
 */

/** Permission tier assigned to an evaluated command. */
export type CommandTier = 'auto' | 'confirm' | 'deny';

/** Input parameters for terminal policy evaluation. */
export interface CommandEvaluationInput {
  /** Bare executable name (e.g. 'git', 'pytest'). Must not contain slashes. */
  file: string;
  /** Command argument list. */
  args: string[];
  /** Optional working directory. Only workspace root is permitted. */
  cwd?: string;
}

/** Result of terminal policy evaluation. */
export interface CommandEvaluation {
  /** Assigned permission tier ('auto', 'confirm', or 'deny'). */
  tier: CommandTier;
  /** Human-readable rationale for the tier assignment, listing permitted commands if denied. */
  reason: string;
  /** Normalized, safe string representation suitable for UI display. */
  normalizedDisplay: string;
}

/** Canonical list of permitted command categories and flags included in deny rationales. */
export const ALLOWED_COMMANDS_HELP =
  "Permitted commands are: 'git status', 'git diff' (read-only flags), " +
  "'pytest' / 'python -m pytest' (with allowed flags: -q, -v, -x, -s, " +
  "--tb=short|line|no|native, -k <expr>, -m <expr>, --maxfail=<n>, --no-header, " +
  "-p no:cacheprovider), 'npm test', 'npx vitest run'.";

/** Allowed flags for git status. */
const ALLOWED_GIT_STATUS_FLAGS = new Set([
  '-s',
  '--short',
  '-b',
  '--branch',
  '-sb',
  '-bs',
  '--porcelain',
  '--ignored',
  '-u',
  '--untracked-files',
]);

/** Allowed flags for git diff. */
const ALLOWED_GIT_DIFF_FLAGS = new Set([
  '--stat',
  '--shortstat',
  '--name-only',
  '--name-status',
  '--no-color',
  '--color=never',
  '-p',
  '-u',
  '--patch',
  '--unified',
  '--staged',
  '--cached',
]);

/** Allowed boolean flags for pytest. */
const ALLOWED_PYTEST_BOOLEAN_FLAGS = new Set([
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '-x',
  '--exitfirst',
  '-s',
  '--capture=no',
  '--no-header',
]);

/** Allowed values for pytest --tb flag. */
const ALLOWED_PYTEST_TB_VALUES = new Set([
  'short',
  'line',
  'no',
  'native',
  'auto',
]);

/** Formats a command and arguments into a safe normalized display string. */
function formatDisplay(file: string, args: string[]): string {
  if (args.length === 0) {
    return file;
  }
  const formattedArgs = args.map((arg) => {
    if (/[\s"']/.test(arg)) {
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    return arg;
  });
  return `${file} ${formattedArgs.join(' ')}`;
}

/** Validates that a positional path argument is a safe workspace-relative path or path::node. */
function validatePositionalPath(arg: string): string | undefined {
  if (arg.trim() === '') {
    return 'Positional path argument cannot be empty.';
  }

  // Shell injection metacharacters check
  if (/[\n\r;&|<>`$]/.test(arg)) {
    return `Argument '${arg}' contains forbidden shell characters.`;
  }

  // Extract path portion before any pytest node specifier (e.g. tests/test.py::test_func)
  const pathPart = arg.split('::')[0];
  const normalized = pathPart.replace(/\\/g, '/');

  // Reject Windows drive letters (e.g. C:\x or C:/x)
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `Absolute path with drive letter in '${arg}' is forbidden. Positional paths must be workspace-relative.`;
  }

  // Reject root / absolute paths
  if (normalized.startsWith('/')) {
    return `Absolute path in '${arg}' is forbidden. Positional paths must be workspace-relative.`;
  }

  // Reject path traversal
  const segments = normalized.split('/');
  if (segments.includes('..')) {
    return `Path traversal '..' in '${arg}' is forbidden.`;
  }

  // If node specifiers exist, ensure no empty segments
  const parts = arg.split('::');
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].trim() === '') {
      return `Invalid pytest node identifier in '${arg}'.`;
    }
  }

  return undefined;
}

/** Evaluates pytest arguments against the strict argument allowlist. */
function evaluatePytestArgs(args: string[], display: string): CommandEvaluation {
  const deny = (msg: string): CommandEvaluation => ({
    tier: 'deny',
    reason: `${msg} ${ALLOWED_COMMANDS_HELP}`,
    normalizedDisplay: display,
  });

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Check shell metacharacters
    if (/[\n\r;&|<>`$]/.test(arg)) {
      return deny(`Argument '${arg}' contains forbidden shell characters.`);
    }

    if (arg.startsWith('-')) {
      // 1. Boolean flags
      if (ALLOWED_PYTEST_BOOLEAN_FLAGS.has(arg)) {
        continue;
      }

      // 2. --tb flag
      if (arg.startsWith('--tb=')) {
        const val = arg.slice('--tb='.length);
        if (ALLOWED_PYTEST_TB_VALUES.has(val)) {
          continue;
        }
        return deny(`Invalid --tb value '${val}'. Allowed values: short, line, no, native.`);
      }
      if (arg === '--tb') {
        if (i + 1 >= args.length) {
          return deny("Missing value for '--tb' flag.");
        }
        const val = args[++i];
        if (ALLOWED_PYTEST_TB_VALUES.has(val)) {
          continue;
        }
        return deny(`Invalid --tb value '${val}'. Allowed values: short, line, no, native.`);
      }

      // 3. -k filter flag
      if (arg.startsWith('-k=')) {
        const expr = arg.slice('-k='.length);
        if (expr.trim()) {
          continue;
        }
        return deny("Missing expression for '-k' flag.");
      }
      if (arg === '-k') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return deny("Missing expression for '-k' flag.");
        }
        i++;
        continue;
      }

      // 4. -m marker flag
      if (arg.startsWith('-m=')) {
        const expr = arg.slice('-m='.length);
        if (expr.trim()) {
          continue;
        }
        return deny("Missing expression for '-m' flag.");
      }
      if (arg === '-m') {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          return deny("Missing expression for '-m' flag.");
        }
        i++;
        continue;
      }

      // 5. --maxfail flag
      if (arg.startsWith('--maxfail=')) {
        const count = arg.slice('--maxfail='.length);
        if (/^\d+$/.test(count) && Number(count) > 0) {
          continue;
        }
        return deny(`Invalid --maxfail value '${count}'. Must be a positive integer.`);
      }
      if (arg === '--maxfail') {
        if (i + 1 >= args.length) {
          return deny("Missing value for '--maxfail' flag.");
        }
        const count = args[++i];
        if (/^\d+$/.test(count) && Number(count) > 0) {
          continue;
        }
        return deny(`Invalid --maxfail value '${count}'. Must be a positive integer.`);
      }

      // 6. -p flag (only 'no:cacheprovider' is allowed)
      if (arg === '-p') {
        if (i + 1 >= args.length) {
          return deny("Missing plugin name for '-p' flag.");
        }
        const plugin = args[++i];
        if (plugin === 'no:cacheprovider') {
          continue;
        }
        return deny(`Pytest plugin '-p ${plugin}' is forbidden. Only '-p no:cacheprovider' is permitted.`);
      }
      if (arg.startsWith('-p=')) {
        const plugin = arg.slice('-p='.length);
        if (plugin === 'no:cacheprovider') {
          continue;
        }
        return deny(`Pytest plugin '-p ${plugin}' is forbidden. Only '-p no:cacheprovider' is permitted.`);
      }
      if (arg.startsWith('-p') && arg !== '-p') {
        const plugin = arg.slice(2);
        if (plugin === 'no:cacheprovider') {
          continue;
        }
        return deny(`Pytest plugin '-p ${plugin}' is forbidden. Only '-p no:cacheprovider' is permitted.`);
      }

      // Any other flag starting with '-' is denied
      return deny(`Pytest flag '${arg}' is forbidden.`);
    }

    // Positional target argument
    const posError = validatePositionalPath(arg);
    if (posError) {
      return deny(posError);
    }
  }

  return {
    tier: 'confirm',
    reason: 'Test execution requires human confirmation.',
    normalizedDisplay: display,
  };
}

/**
 * Pure terminal policy evaluator enforcing command security tiers and argument allowlists.
 *
 * @param input - Command execution parameters (file, args, cwd)
 * @returns CommandEvaluation assigning 'auto', 'confirm', or 'deny' tier with reason
 */
export function evaluate(input: CommandEvaluationInput): CommandEvaluation {
  const display = formatDisplay(input.file, input.args);

  const deny = (msg: string): CommandEvaluation => ({
    tier: 'deny',
    reason: `${msg} ${ALLOWED_COMMANDS_HELP}`,
    normalizedDisplay: display,
  });

  const auto = (reason: string): CommandEvaluation => ({
    tier: 'auto',
    reason,
    normalizedDisplay: display,
  });

  const confirm = (reason: string): CommandEvaluation => ({
    tier: 'confirm',
    reason,
    normalizedDisplay: display,
  });

  // 1. Validate file (executable name)
  if (!input.file || input.file.trim() === '') {
    return deny('Command executable name cannot be empty.');
  }

  if (/[\\/]/.test(input.file)) {
    return deny(`Executable '${input.file}' must be a bare name without path separators.`);
  }

  if (/[\s"'`&|;<>^%$]/.test(input.file)) {
    return deny(`Executable '${input.file}' contains forbidden shell characters or whitespace.`);
  }

  // 2. Validate cwd if specified
  if (input.cwd !== undefined && input.cwd !== '' && input.cwd !== '.') {
    if (
      input.cwd.includes('..') ||
      /^[a-zA-Z]:/.test(input.cwd) ||
      input.cwd.startsWith('/') ||
      input.cwd.startsWith('\\')
    ) {
      return deny('Working directory must be the workspace root; custom or parent directories are forbidden.');
    }
  }

  const exe = input.file.toLowerCase().replace(/\.exe$/, '');
  const args = input.args ?? [];

  // 3. Evaluate git commands ('auto' tier if strictly read-only)
  if (exe === 'git') {
    if (args.length === 0) {
      return deny('Git command missing subcommand.');
    }

    const sub = args[0];
    if (sub.startsWith('-')) {
      return deny(`Global git flag '${sub}' is forbidden.`);
    }

    const subArgs = args.slice(1);

    if (sub === 'status') {
      for (const a of subArgs) {
        if (/[\n\r;&|<>`$]/.test(a)) {
          return deny(`Argument '${a}' contains forbidden shell characters.`);
        }
        if (a.startsWith('-')) {
          if (!ALLOWED_GIT_STATUS_FLAGS.has(a)) {
            return deny(`Git status flag '${a}' is forbidden.`);
          }
        } else {
          const pathError = validatePositionalPath(a);
          if (pathError) {
            return deny(pathError);
          }
        }
      }
      return auto('Safe read-only git status command.');
    }

    if (sub === 'diff') {
      for (const a of subArgs) {
        if (/[\n\r;&|<>`$]/.test(a)) {
          return deny(`Argument '${a}' contains forbidden shell characters.`);
        }
        if (a.startsWith('-')) {
          if (a.startsWith('--output') || a.startsWith('-o')) {
            return deny(`Git diff output redirection flag '${a}' is forbidden.`);
          }
          if (a.startsWith('-U') || a.startsWith('--unified=')) {
            continue;
          }
          if (!ALLOWED_GIT_DIFF_FLAGS.has(a)) {
            return deny(`Git diff flag '${a}' is forbidden.`);
          }
        } else {
          const pathError = validatePositionalPath(a);
          if (pathError) {
            return deny(pathError);
          }
        }
      }
      return auto('Safe read-only git diff command.');
    }

    return deny(`Git subcommand '${sub}' is forbidden.`);
  }

  // 4. Evaluate pytest commands ('confirm' tier)
  if (exe === 'pytest') {
    return evaluatePytestArgs(args, display);
  }

  // 5. Evaluate python / python3 commands
  if (exe === 'python' || exe === 'python3') {
    if (args.length >= 2 && args[0] === '-m' && args[1] === 'pytest') {
      return evaluatePytestArgs(args.slice(2), display);
    }
    return deny(`Python command '${display}' is forbidden. Only 'python -m pytest' is permitted.`);
  }

  // 6. Evaluate npm commands
  if (exe === 'npm') {
    if (args.length > 0 && (args[0] === 'test' || args[0] === 't')) {
      for (let i = 1; i < args.length; i++) {
        if (/[\n\r;&|<>`$]/.test(args[i])) {
          return deny(`Argument '${args[i]}' contains forbidden shell characters.`);
        }
      }
      return confirm('NPM test suite execution requires human confirmation.');
    }
    return deny(`NPM subcommand '${args[0] ?? ''}' is forbidden. Only 'npm test' is permitted.`);
  }

  // 7. Evaluate npx commands
  if (exe === 'npx') {
    if (args.length >= 2 && args[0] === 'vitest' && args[1] === 'run') {
      for (let i = 2; i < args.length; i++) {
        if (/[\n\r;&|<>`$]/.test(args[i])) {
          return deny(`Argument '${args[i]}' contains forbidden shell characters.`);
        }
      }
      return confirm('Vitest test suite execution requires human confirmation.');
    }
    if (args.length >= 1 && args[0] === 'pytest') {
      return evaluatePytestArgs(args.slice(1), display);
    }
    return deny(`Npx command '${display}' is forbidden. Only 'npx vitest run' is permitted.`);
  }

  // 8. Deny everything else
  return deny(`Command executable '${input.file}' is not permitted.`);
}
