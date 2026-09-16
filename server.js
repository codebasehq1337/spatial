/*
 * spatial — server
 *
 * Reads the local filesystem and streams folder contents to a browser
 * client over WebSocket. Also serves the client itself.
 *
 * Nothing leaves your machine. This is a local-only tool.
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 7331;
const ROOT = process.env.SPATIAL_ROOT || os.homedir();
const MAX_ENTRIES = 200;

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'c', 'cpp', 'cc', 'h', 'hpp', 'java', 'kt',
  'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'ini', 'conf',
  'html', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'sql', 'env',
  'log', 'gitignore', 'dockerfile', 'makefile',
]);

/* ---------- HTTP ---------- */

const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

const httpServer = createServer(app);

/* ---------- file system reader ---------- */

function safeResolve(inputPath) {
  const resolved = path.resolve(ROOT, inputPath || '.');
  const normalizedRoot = path.resolve(ROOT);
  if (!resolved.startsWith(normalizedRoot)) return normalizedRoot;
  return resolved;
}

async function readFolder(inputPath) {
  const dir = safeResolve(inputPath);

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read ${dir}: ${err.message}`);
  }

  const entries = [];

  for (const d of dirents) {
    if (entries.length >= MAX_ENTRIES) break;

    if (d.name.startsWith('.')) continue;
    if (d.name === 'node_modules') continue;
    if (d.name === '$Recycle.Bin') continue;
    if (d.name === 'System Volume Information') continue;

    const fullPath = path.join(dir, d.name);

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    const isDir = stat.isDirectory();

    let ext = '';
    if (!isDir) {
      ext = path.extname(d.name).toLowerCase().replace('.', '');
    }

    /* Read a preview snippet for small text files. */
    let preview = '';
    let previewLines = [];

    if (!isDir && stat.size < 200_000 && TEXT_EXTS.has(ext)) {
      try {
        const fd = await fs.open(fullPath, 'r');
        const buf = Buffer.alloc(400);
        const { bytesRead } = await fd.read(buf, 0, 400, 0);
        await fd.close();
        const chunk = buf.slice(0, bytesRead).toString('utf8');
        if (!/\x00/.test(chunk)) {
          previewLines = chunk.split(/\r?\n/).slice(0, 6);
          preview = previewLines.join('\n').slice(0, 400);
        }
      } catch {
        /* unreadable, skip preview */
      }
    }

    entries.push({
      name: d.name,
      path: fullPath,
      isDir,
      ext,
      size: isDir ? 0 : stat.size,
      mtime: stat.mtimeMs,
      preview,
      previewLines,
    });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    path: dir,
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    root: path.resolve(ROOT),
    entries,
    truncated: dirents.length > MAX_ENTRIES,
  };
}

async function readFileMeta(inputPath) {
  const filePath = safeResolve(inputPath);
  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');

  return {
    path: filePath,
    name: path.basename(filePath),
    ext,
    size: stat.size,
    mtime: stat.mtimeMs,
    isDir: stat.isDirectory(),
  };
}

async function readFileContent(inputPath) {
  const filePath = safeResolve(inputPath);
  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) throw new Error('Is a directory');
  if (stat.size > 2 * 1024 * 1024) throw new Error('File too large to preview (max 2 MB)');

  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const base = path.basename(filePath).toLowerCase();

  if (TEXT_EXTS.has(ext) || base === 'makefile' || base === 'dockerfile') {
    const text = await fs.readFile(filePath, 'utf8');
    return { kind: 'text', text, ext };
  }

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'].includes(ext)) {
    const buffer = await fs.readFile(filePath);
    const mime = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      ico: 'image/x-icon', avif: 'image/avif',
    }[ext];
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    return { kind: 'image', dataUrl, ext };
  }

  return { kind: 'unknown', ext };
}

/* ---------- WebSocket ---------- */

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  console.log('[spatial] client connected');

  const send = (msg) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
    }
  };

  readFolder(ROOT)
    .then((data) => send({ type: 'folder', data }))
    .catch((err) => send({ type: 'error', message: err.message }));

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ type: 'error', message: 'bad json' });
    }

    try {
      if (msg.type === 'list') {
        const data = await readFolder(msg.path);
        send({ type: 'folder', data });
      } else if (msg.type === 'open') {
        const data = await readFileContent(msg.path);
        const meta = await readFileMeta(msg.path);
        send({ type: 'file', meta, content: data });
      } else {
        send({ type: 'error', message: `unknown command: ${msg.type}` });
      }
    } catch (err) {
      send({ type: 'error', message: err.message, context: msg });
    }
  });

  socket.on('close', () => {
    console.log('[spatial] client disconnected');
  });
});

/* ---------- start ---------- */

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  spatial — a 3D file explorer');
  console.log('  ─────────────────────────────');
  console.log(`  server:  http://localhost:${PORT}`);
  console.log(`  root:    ${ROOT}`);
  console.log('');
  console.log('  Open the URL above in your browser.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
