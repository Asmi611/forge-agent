/**
 * Security and secret guard for MCP tools (Milestone E-04).
 *
 * Enforces path containment inside workspaceRoot, denies secret files
 * (.env*, *.pem, *.key, id_rsa*, *.p12, .git/**, binaries, >1MB),
 * and redacts credentials in search previews per docs/03-SECURITY.md (T7, T8).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_FILE_BYTES } from './limits.ts';

/** Result of path validation against workspace containment and secret patterns. */
export interface PathValidationResult {
  ok: boolean;
  resolvedPath?: string;
  relativePath?: string;
  reason?: string;
}

/** Result of full file security inspection (path, size, binary, secret). */
export interface FileSecurityResult {
  ok: boolean;
  reason?: string;
  isSecret?: boolean;
  isBinary?: boolean;
  isTooLarge?: boolean;
  sizeBytes?: number;
}

/** Common binary file extensions to reject immediately. */
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.tiff', '.webp',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.wasm', '.pyc', '.pyo', '.pyd', '.class', '.jar',
  '.iso', '.dmg', '.ttf', '.otf', '.woff', '.woff2',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv',
]);

/**
 * Checks whether a given filename or workspace-relative path matches secret file patterns.
 *
 * @param relativePath - Workspace-relative path with forward or native slashes
 * @returns True if path points to a forbidden secret file
 */
export function isSecretFile(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }

  // Normalize slashes to forward slashes and lowercase for case-insensitive matching
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);

  // Check if inside .git/ directory
  if (segments.some((seg) => seg === '.git')) {
    return true;
  }

  const baseName = segments.length > 0 ? segments[segments.length - 1] : normalized;

  // 1. .env* files (e.g. .env, .env.local, .env.production, .env.example)
  if (baseName.startsWith('.env')) {
    return true;
  }

  // 2. SSL/TLS and crypto key files
  if (
    baseName.endsWith('.pem') ||
    baseName.endsWith('.key') ||
    baseName.endsWith('.p12') ||
    baseName.endsWith('.pfx') ||
    baseName.endsWith('.pkcs12') ||
    baseName.endsWith('.keystore') ||
    baseName.endsWith('.jks')
  ) {
    return true;
  }

  // 3. SSH private keys (id_rsa, id_ed25519, id_dsa, id_ecdsa, and public pairs)
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(baseName)) {
    return true;
  }

  // 4. Common credentials and secrets filenames
  if (
    baseName === 'credentials' ||
    baseName === 'credentials.json' ||
    baseName === 'auth.json' ||
    baseName === 'secret.json' ||
    baseName === 'secrets.json' ||
    baseName === 'service-account.json' ||
    baseName.endsWith('.secret') ||
    baseName.endsWith('.token')
  ) {
    return true;
  }

  return false;
}

/**
 * Normalizes and resolves a canonical real path, safely falling back if the target does not exist.
 *
 * @param targetPath - Absolute or relative path to resolve
 * @returns Canonical real path or fully resolved path if non-existent
 */
export function getCanonicalPath(targetPath: string): string {
  try {
    if (fs.existsSync(targetPath)) {
      return fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
    }
  } catch {
    // If realpath fails (e.g. broken permission), fall back to path.resolve
  }

  // If path does not exist, walk up to the nearest existing ancestor to resolve symlinks
  let current = path.resolve(targetPath);
  const unverifiedParts: string[] = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    unverifiedParts.unshift(path.basename(current));
    current = parent;
  }

  try {
    if (fs.existsSync(current)) {
      const canonicalParent = fs.realpathSync.native
        ? fs.realpathSync.native(current)
        : fs.realpathSync(current);
      return path.join(canonicalParent, ...unverifiedParts);
    }
  } catch {
    // Fall back to resolved path
  }

  return path.resolve(targetPath);
}

/**
 * Checks whether targetPath is contained strictly within workspaceRoot (with directory boundary).
 *
 * @param workspaceRoot - Root directory of the workspace
 * @param targetPath - Target path to test
 * @returns True if target is within or equal to workspaceRoot
 */
function isContainedInRoot(workspaceRoot: string, targetPath: string): boolean {
  const isWindows = process.platform === 'win32';
  const normRoot = isWindows ? workspaceRoot.toLowerCase() : workspaceRoot;
  const normTarget = isWindows ? targetPath.toLowerCase() : targetPath;

  if (normTarget === normRoot) {
    return true;
  }

  const rootPrefix = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`;
  return normTarget.startsWith(rootPrefix);
}

/**
 * Validates that a requested path stays inside workspaceRoot and is not a secret file.
 * Guards against directory traversal (..), absolute path escape, and symlink escapes.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param targetPath - Relative or absolute path requested by agent
 * @returns PathValidationResult indicating success or reason for refusal
 */
export function validatePath(
  workspaceRoot: string,
  targetPath: string
): PathValidationResult {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return { ok: false, reason: 'Invalid or missing workspace root' };
  }
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, reason: 'Path argument must be a non-empty string' };
  }

  // Reject paths with null bytes immediately
  if (targetPath.includes('\0')) {
    return { ok: false, reason: 'Path contains illegal null byte character' };
  }

  // Clean raw string
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Path argument cannot be empty' };
  }

  const canonicalRoot = getCanonicalPath(workspaceRoot);

  // If path is absolute, it must resolve inside workspaceRoot
  let resolvedTarget: string;
  if (path.isAbsolute(trimmed)) {
    resolvedTarget = path.resolve(trimmed);
  } else {
    resolvedTarget = path.resolve(canonicalRoot, trimmed);
  }

  const canonicalTarget = getCanonicalPath(resolvedTarget);

  // Verify workspace containment after realpath resolution
  if (!isContainedInRoot(canonicalRoot, canonicalTarget)) {
    return {
      ok: false,
      reason: `Path '${targetPath}' resolves outside workspace root ('${workspaceRoot}')`,
    };
  }

  // Compute workspace-relative path with forward slashes
  const relPath = path.relative(canonicalRoot, canonicalTarget).replace(/\\/g, '/');

  // Verify against secret file patterns
  if (isSecretFile(relPath)) {
    return {
      ok: false,
      reason: `Access to secret file '${relPath}' is denied (docs/03-SECURITY.md T8)`,
    };
  }

  return {
    ok: true,
    resolvedPath: canonicalTarget,
    relativePath: relPath || '.',
  };
}

/**
 * Inspects a buffer to determine if it represents binary data rather than plain text.
 * Checks for null bytes and excessive non-printable control characters.
 *
 * @param buffer - Buffer content to inspect (first chunk or full file)
 * @returns True if buffer contains binary data
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length === 0) {
    return false;
  }

  // Null byte is the universal binary indicator (Git heuristic)
  if (buffer.includes(0)) {
    return true;
  }

  // Count non-whitespace control characters (ASCII < 32 except \t, \n, \r, \f, \b)
  const sampleLength = Math.min(buffer.length, 1024);
  let controlChars = 0;

  for (let i = 0; i < sampleLength; i++) {
    const byte = buffer[i];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12 && byte !== 8) {
      controlChars++;
    }
  }

  // If > 20% control characters, treat as binary
  return controlChars / sampleLength > 0.2;
}

/**
 * Checks a file's security posture: path safety, secret patterns, size (<1MB), and binary content.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param targetPath - Path to target file
 * @param options - Optional override for max size limit
 * @returns FileSecurityResult indicating if file is safe to read
 */
export function checkFileSecurity(
  workspaceRoot: string,
  targetPath: string,
  options?: { maxSizeBytes?: number }
): FileSecurityResult {
  const pathValidation = validatePath(workspaceRoot, targetPath);
  if (!pathValidation.ok || !pathValidation.resolvedPath) {
    return {
      ok: false,
      reason: pathValidation.reason,
      isSecret: pathValidation.reason?.includes('secret file'),
    };
  }

  const resolved = pathValidation.resolvedPath;

  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      reason: `File not found: '${pathValidation.relativePath}'`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `Failed to inspect file '${pathValidation.relativePath}': ${(err as Error).message}`,
    };
  }

  if (stat.isDirectory()) {
    return {
      ok: false,
      reason: `Path '${pathValidation.relativePath}' is a directory, not a file`,
    };
  }

  // 1 MB size limit check
  const maxBytes = options?.maxSizeBytes ?? MAX_FILE_BYTES;
  if (stat.size > maxBytes) {
    return {
      ok: false,
      isTooLarge: true,
      sizeBytes: stat.size,
      reason: `File '${pathValidation.relativePath}' (${stat.size} bytes) exceeds maximum size limit of ${maxBytes} bytes (1 MB)`,
    };
  }

  // Extension binary check
  const ext = path.extname(resolved).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      isBinary: true,
      sizeBytes: stat.size,
      reason: `File '${pathValidation.relativePath}' has binary extension '${ext}'`,
    };
  }

  // Content inspection (first 1024 bytes)
  if (stat.size > 0) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(resolved, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, 1024));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const slice = buffer.subarray(0, bytesRead);

      if (isBinaryBuffer(slice)) {
        return {
          ok: false,
          isBinary: true,
          sizeBytes: stat.size,
          reason: `File '${pathValidation.relativePath}' contains binary content`,
        };
      }
    } catch (err: unknown) {
      return {
        ok: false,
        reason: `Failed to read file sample '${pathValidation.relativePath}': ${(err as Error).message}`,
      };
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close error
        }
      }
    }
  }

  return {
    ok: true,
    sizeBytes: stat.size,
  };
}

/**
 * Redacts secret and credential patterns from text lines or search result previews.
 * Guards against leaking API keys, tokens, or credentials to the model.
 *
 * @param line - Raw text line from file or search preview
 * @returns Redacted string safe for model context
 */
export function redactSecrets(line: string): string {
  if (!line) {
    return '';
  }

  let result = line;

  // 1. OpenAI / Anthropic / Generic API keys: sk-...
  result = result.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]');

  // 2. Google API keys: AIza...
  result = result.replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_API_KEY]');

  // 3. AWS access key IDs: AKIA...
  result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');

  // 4. Bearer tokens: Bearer <token>
  result = result.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED_TOKEN]');

  // 5. Private key headers / blocks
  result = result.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,
    '[REDACTED_PRIVATE_KEY]'
  );

  // 6. Generic password / secret / token assignments: token = "xyz...", "password": 'abc...'
  result = result.replace(
    /(["']?(?:password|passwd|api[_-]?key|apikey|secret|token|auth_token)["']?\s*[:=]\s*["'])(?!\[REDACTED_)([^"'\r\n\s]{6,})(["'])/gi,
    '$1[REDACTED_SECRET]$3'
  );

  return result;
}
