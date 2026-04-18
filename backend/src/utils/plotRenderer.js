import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PYTHON_RENDERER = path.join(__dirname, 'pythonPlotRenderer.py');

const ALLOWED_STYLES = new Set(['matplotlib', 'seaborn', 'pandas']);

function resolvePythonBinary() {
  const fromEnv = process.env.PYTHON_BIN;
  if (fromEnv) {
    const resolvedEnv = path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv);
    if (existsSync(resolvedEnv)) return resolvedEnv;
    return fromEnv;
  }

  const candidates = process.platform === 'win32'
    ? [
        path.resolve(__dirname, '..', '..', '..', '.venv', 'Scripts', 'python.exe'),
        path.resolve(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.resolve(__dirname, '..', '..', '..', '.venv', 'bin', 'python'),
        path.resolve(__dirname, '..', '..', '.venv', 'bin', 'python'),
      ];

  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) return existing;

  return process.platform === 'win32' ? 'python' : 'python3';
}

export async function renderAnalyticsGraphImage(graph, style = 'seaborn') {
  if (!existsSync(PYTHON_RENDERER)) {
    throw new Error(`Python renderer script not found at ${PYTHON_RENDERER}`);
  }

  const safeStyle = ALLOWED_STYLES.has(style) ? style : 'seaborn';
  const pythonBin = resolvePythonBinary();

  return await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [PYTHON_RENDERER, '--style', safeStyle], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const output = [];
    let stderr = '';

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Python plot render timed out after 20s'));
    }, 20000);

    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start Python process: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = stderr.trim() || `renderer exited with code ${code}`;
        reject(new Error(detail));
        return;
      }

      const pngBuffer = Buffer.concat(output);
      if (!pngBuffer.length) {
        reject(new Error('Renderer produced empty output'));
        return;
      }

      resolve(pngBuffer);
    });

    child.stdin.write(JSON.stringify(graph || {}));
    child.stdin.end();
  });
}
