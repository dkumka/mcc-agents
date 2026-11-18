import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { config } from './config.ts';
import { logger } from './log.ts';

const log = logger('projects');

/** Folder names safe for shells, URLs, Docker and devstack: latin letters, digits, «-», «_», «.». */
export const PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

function readJson(req: http.IncomingMessage, max = 16 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('слишком большой запрос'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
      } catch {
        reject(new Error('неверный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 20_000 }, (err) => (err ? reject(err) : resolve())));
}

/** POST /api/projects/create {name, git} → {path}: a new folder in ~/dev (optionally `git init`) to start chats in. */
export async function handleCreateProject(req: http.IncomingMessage, res: http.ServerResponse) {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) return reply(403, { error: 'bad origin' });
  } catch {
    return reply(403, { error: 'bad origin' });
  }
  try {
    const body = await readJson(req);
    const name = String(body.name ?? '').trim();
    if (!PROJECT_NAME.test(name)) return reply(400, { error: 'Название: латиница, цифры, «-», «_», «.»; начинается с буквы или цифры, до 63 символов' });
    const root = config.projectRoots[0];
    const dir = path.join(root, name);
    if (path.dirname(dir) !== path.resolve(root)) return reply(400, { error: 'неверное название' });
    try {
      fs.mkdirSync(dir); // not recursive: an existing folder is an error, never reused or overwritten
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return reply(409, { error: `Папка ${name} уже есть в ${root.replace(config.home, '~')}` });
      throw e;
    }
    let gitError: string | undefined;
    if (body.git) {
      try {
        await git(['init', '-q', '-b', 'main'], dir);
      } catch (e) {
        gitError = (e as Error).message;
        log.warn(`git init ${dir}`, e);
      }
    }
    log.info(`created project ${dir}${body.git ? ' (git)' : ''}`);
    reply(200, { path: dir, gitError });
  } catch (e) {
    log.error('create project', e);
    reply(500, { error: (e as Error).message });
  }
}
