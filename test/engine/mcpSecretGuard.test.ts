/**
 * Comprehensive tests for MCP secret guard and path security (Milestone E-04).
 *
 * Verifies path containment, directory traversal rejection, symlink escape,
 * secret file denylists, binary file detection, 1 MB size cap, and search preview redaction.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isSecretFile,
  validatePath,
  isBinaryBuffer,
  checkFileSecurity,
  redactSecrets,
} from '../../src/mcp/secretGuard.ts';

describe('mcp secretGuard and path security', () => {
  let tempDir: string;
  let workspaceRoot: string;
  let outsideDir: string;

  beforeAll(() => {
    // Create an isolated workspace directory and an outside directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-test-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    outsideDir = path.join(tempDir, 'outside');

    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Create safe files inside workspace
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'main.ts'), 'export const hello = "world";\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# Project\n', 'utf-8');

    // Create secret files inside workspace
    fs.writeFileSync(path.join(workspaceRoot, '.env'), 'DATABASE_URL=postgres://localhost\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, '.env.local'), 'SECRET_KEY=12345\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'cert.pem'), '-----BEGIN CERTIFICATE-----\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'private.key'), 'key_data\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'id_rsa'), 'ssh_private_key\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'id_rsa.pub'), 'ssh_public_key\n', 'utf-8');
    fs.writeFileSync(path.join(workspaceRoot, 'auth.p12'), 'p12_data\n', 'utf-8');

    // Create .git files
    fs.mkdirSync(path.join(workspaceRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.git', 'config'), '[core]\n', 'utf-8');

    // Create outside file
    fs.writeFileSync(path.join(outsideDir, 'secret_outside.txt'), 'confidential outside\n', 'utf-8');

    // Create symlink pointing outside (if supported by environment)
    try {
      fs.symlinkSync(
        path.join(outsideDir, 'secret_outside.txt'),
        path.join(workspaceRoot, 'symlink_outside.txt')
      );
    } catch {
      // Symlinks may require elevated privileges on some Windows setups; test checks existence conditionally
    }

    // Create symlink pointing inside workspace (safe symlink)
    try {
      fs.symlinkSync(
        path.join(workspaceRoot, 'src', 'main.ts'),
        path.join(workspaceRoot, 'symlink_inside.ts')
      );
    } catch {
      // Ignore if symlink not permitted
    }

    // Create binary file with null bytes
    const binBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x01, 0x00]);
    fs.writeFileSync(path.join(workspaceRoot, 'binary_data.bin'), binBuffer);
    fs.writeFileSync(path.join(workspaceRoot, 'binary_with_null.txt'), Buffer.from('hello\0world'));

    // Create a large file (> 1 MB)
    const largeBuffer = Buffer.alloc(1024 * 1024 + 100, 0x41); // 1 MB + 100 bytes of 'A'
    fs.writeFileSync(path.join(workspaceRoot, 'large_file.txt'), largeBuffer);
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe('isSecretFile', () => {
    it('identifies .env and variants as secret files', () => {
      expect(isSecretFile('.env')).toBe(true);
      expect(isSecretFile('.env.local')).toBe(true);
      expect(isSecretFile('.env.production')).toBe(true);
      expect(isSecretFile('.env.test')).toBe(true);
      expect(isSecretFile('.ENV')).toBe(true);
      expect(isSecretFile('.Env.Local')).toBe(true);
      expect(isSecretFile('config/.env')).toBe(true);
      expect(isSecretFile('nested/dir/.env.staging')).toBe(true);
    });

    it('identifies cryptographic certificate and key extensions as secrets', () => {
      expect(isSecretFile('server.pem')).toBe(true);
      expect(isSecretFile('SERVER.PEM')).toBe(true);
      expect(isSecretFile('app.key')).toBe(true);
      expect(isSecretFile('keystore.p12')).toBe(true);
      expect(isSecretFile('bundle.pfx')).toBe(true);
      expect(isSecretFile('certs/tls.pkcs12')).toBe(true);
      expect(isSecretFile('identity.keystore')).toBe(true);
      expect(isSecretFile('saml.jks')).toBe(true);
    });

    it('identifies SSH private keys as secrets', () => {
      expect(isSecretFile('id_rsa')).toBe(true);
      expect(isSecretFile('ID_RSA')).toBe(true);
      expect(isSecretFile('id_rsa.pub')).toBe(true);
      expect(isSecretFile('id_ed25519')).toBe(true);
      expect(isSecretFile('id_ed25519.pub')).toBe(true);
      expect(isSecretFile('id_dsa')).toBe(true);
      expect(isSecretFile('id_ecdsa')).toBe(true);
    });

    it('identifies .git/ directory contents as secrets', () => {
      expect(isSecretFile('.git/config')).toBe(true);
      expect(isSecretFile('.git/HEAD')).toBe(true);
      expect(isSecretFile('.git/hooks/pre-commit')).toBe(true);
      expect(isSecretFile('submodule/.git/config')).toBe(true);
    });

    it('identifies credentials and token files', () => {
      expect(isSecretFile('credentials')).toBe(true);
      expect(isSecretFile('credentials.json')).toBe(true);
      expect(isSecretFile('auth.json')).toBe(true);
      expect(isSecretFile('service-account.json')).toBe(true);
      expect(isSecretFile('secret.token')).toBe(true);
      expect(isSecretFile('api.secret')).toBe(true);
    });

    it('allows standard application and documentation files', () => {
      expect(isSecretFile('src/main.ts')).toBe(false);
      expect(isSecretFile('README.md')).toBe(false);
      expect(isSecretFile('package.json')).toBe(false);
      expect(isSecretFile('src/environment.ts')).toBe(false);
      expect(isSecretFile('test/dotenv.test.ts')).toBe(false);
      expect(isSecretFile('keyboard.ts')).toBe(false); // contains "key" but not .key extension
    });
  });

  describe('validatePath', () => {
    it('accepts safe relative paths inside workspace root', () => {
      const res = validatePath(workspaceRoot, 'src/main.ts');
      expect(res.ok).toBe(true);
      expect(res.relativePath).toBe('src/main.ts');
      expect(res.resolvedPath).toBe(path.join(workspaceRoot, 'src', 'main.ts'));
    });

    it('accepts safe absolute paths that are inside workspace root', () => {
      const absPath = path.join(workspaceRoot, 'README.md');
      const res = validatePath(workspaceRoot, absPath);
      expect(res.ok).toBe(true);
      expect(res.relativePath).toBe('README.md');
    });

    it('rejects directory traversal via .. escaping workspace root', () => {
      const res = validatePath(workspaceRoot, '../outside/secret_outside.txt');
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('resolves outside workspace root');
    });

    it('rejects complex directory traversal escaping workspace root', () => {
      const res = validatePath(workspaceRoot, 'src/../../outside/secret_outside.txt');
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('resolves outside workspace root');
    });

    it('rejects absolute paths outside workspace root', () => {
      const outsideFile = path.join(outsideDir, 'secret_outside.txt');
      const res = validatePath(workspaceRoot, outsideFile);
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('resolves outside workspace root');
    });

    it('rejects paths with null bytes immediately', () => {
      const res = validatePath(workspaceRoot, 'src/main.ts\0.secret');
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('null byte');
    });

    it('rejects empty or whitespace paths', () => {
      expect(validatePath(workspaceRoot, '').ok).toBe(false);
      expect(validatePath(workspaceRoot, '   ').ok).toBe(false);
    });

    it('rejects secret files inside workspace with truthful reason', () => {
      const res = validatePath(workspaceRoot, '.env');
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('Access to secret file');
      expect(res.reason).toContain('.env');
    });

    it('rejects symlinks pointing outside workspace root', () => {
      const symlinkPath = path.join(workspaceRoot, 'symlink_outside.txt');
      if (fs.existsSync(symlinkPath)) {
        const res = validatePath(workspaceRoot, 'symlink_outside.txt');
        expect(res.ok).toBe(false);
        expect(res.reason).toContain('resolves outside workspace root');
      }
    });

    it('accepts symlinks pointing inside workspace root to safe files', () => {
      const symlinkPath = path.join(workspaceRoot, 'symlink_inside.ts');
      if (fs.existsSync(symlinkPath)) {
        const res = validatePath(workspaceRoot, 'symlink_inside.ts');
        expect(res.ok).toBe(true);
      }
    });
  });

  describe('isBinaryBuffer', () => {
    it('returns false for plain text buffer', () => {
      const textBuf = Buffer.from('const answer = 42;\nconsole.log(answer);\n');
      expect(isBinaryBuffer(textBuf)).toBe(false);
    });

    it('returns false for empty buffer', () => {
      expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false);
    });

    it('returns true when buffer contains a null byte', () => {
      const nullBuf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f]);
      expect(isBinaryBuffer(nullBuf)).toBe(true);
    });

    it('returns true when buffer has high ratio of non-printable control characters', () => {
      const controlBuf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x41, 0x42]);
      expect(isBinaryBuffer(controlBuf)).toBe(true);
    });
  });

  describe('checkFileSecurity', () => {
    it('passes for valid text file inside workspace', () => {
      const res = checkFileSecurity(workspaceRoot, 'src/main.ts');
      expect(res.ok).toBe(true);
      expect(res.sizeBytes).toBeGreaterThan(0);
    });

    it('rejects non-existent file with File not found message', () => {
      const res = checkFileSecurity(workspaceRoot, 'src/does_not_exist.ts');
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('File not found');
    });

    it('rejects directory targets', () => {
      const res = checkFileSecurity(workspaceRoot, 'src');
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('is a directory');
    });

    it('rejects secret files (.env, .pem, etc.)', () => {
      const resEnv = checkFileSecurity(workspaceRoot, '.env');
      expect(resEnv.ok).toBe(false);
      expect(resEnv.isSecret).toBe(true);

      const resPem = checkFileSecurity(workspaceRoot, 'cert.pem');
      expect(resPem.ok).toBe(false);
      expect(resPem.isSecret).toBe(true);
    });

    it('rejects files exceeding 1 MB limit', () => {
      const res = checkFileSecurity(workspaceRoot, 'large_file.txt');
      expect(res.ok).toBe(false);
      expect(res.isTooLarge).toBe(true);
      expect(res.reason).toContain('exceeds maximum size limit');
      expect(res.sizeBytes).toBeGreaterThan(1024 * 1024);
    });

    it('rejects binary files by extension (.bin)', () => {
      const res = checkFileSecurity(workspaceRoot, 'binary_data.bin');
      expect(res.ok).toBe(false);
      expect(res.isBinary).toBe(true);
      expect(res.reason).toContain('binary extension');
    });

    it('rejects files containing null byte content even with .txt extension', () => {
      const res = checkFileSecurity(workspaceRoot, 'binary_with_null.txt');
      expect(res.ok).toBe(false);
      expect(res.isBinary).toBe(true);
      expect(res.reason).toContain('binary content');
    });

    it('rejects path traversal escaping workspace', () => {
      const res = checkFileSecurity(workspaceRoot, '../outside/secret_outside.txt');
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('outside workspace root');
    });
  });

  describe('redactSecrets', () => {
    it('returns empty string when input is empty', () => {
      expect(redactSecrets('')).toBe('');
    });

    it('leaves clean text untouched', () => {
      const text = 'function calculateTotal(items: Item[]): number { return 100; }';
      expect(redactSecrets(text)).toBe(text);
    });

    it('redacts OpenAI/Anthropic sk-... API key patterns', () => {
      const text = 'const key = "sk-1234567890abcdef1234567890abcdef";';
      const redacted = redactSecrets(text);
      expect(redacted).not.toContain('sk-1234567890abcdef1234567890abcdef');
      expect(redacted).toContain('[REDACTED_API_KEY]');
    });

    it('redacts Google AIza... API key patterns', () => {
      const text = 'const googleKey = "AIzaSyD-1234567890abcdef1234567890abc";';
      const redacted = redactSecrets(text);
      expect(redacted).not.toContain('AIzaSyD-1234567890abcdef1234567890abc');
      expect(redacted).toContain('[REDACTED_API_KEY]');
    });

    it('redacts AWS access key ID patterns', () => {
      const text = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE;';
      const redacted = redactSecrets(text);
      expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(redacted).toContain('[REDACTED_AWS_KEY]');
    });

    it('redacts Bearer authorization tokens', () => {
      const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz123';
      const redacted = redactSecrets(text);
      expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(redacted).toBe('Authorization: Bearer [REDACTED_TOKEN]');
    });

    it('redacts private key blocks', () => {
      const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      const redacted = redactSecrets(text);
      expect(redacted).not.toContain('MIIEowIBAAKCAQEA');
      expect(redacted).toBe('[REDACTED_PRIVATE_KEY]');
    });

    it('redacts password and token assignments in configuration syntax', () => {
      const jsonLine = '  "password": "super_secret_password_123",';
      const redacted = redactSecrets(jsonLine);
      expect(redacted).not.toContain('super_secret_password_123');
      expect(redacted).toContain('[REDACTED_SECRET]');
    });
  });
});
