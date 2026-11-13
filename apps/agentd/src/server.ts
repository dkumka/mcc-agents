import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentKind, ClientMessage, ServerMessage } from '@mcc-agents/protocol';
import { config } from './config.ts';
import { HttpError, gitStatus, listDir, readFile, searchFiles, tailFile } from './fsapi.ts';
import type { Client, Hub } from './hub.ts';
import { logger } from './log.ts';
import { serveRaw } from './raw.ts';
import { handleUpload, uploadsStats } from './uploads.ts';
import { handleVoicePost, listVoice } from './voice.ts';

const log = logger('server');
let clientSeq = 0;

function json(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function api(hub: Hub, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams;
  try {
    if (req.method !== 'GET' && !(req.method === 'HEAD' && url.pathname === '/api/raw')) throw new HttpError(405, 'GET only');
    switch (url.pathname) {
      case '/api/health':
        return json(res, 200, { ok: true, version: config.version, ...hub.status() });
      case '/api/projects':
        return json(res, 200, hub.projects());
      case '/api/caps': {
        const agent = q.get('agent') as AgentKind;
        const a = hub.adapters[agent];
        if (!a) throw new HttpError(400, 'unknown agent');
        return json(res, 200, await a.capabilities(q.get('cwd') || config.home));
      }
      case '/api/files':
        return json(res, 200, await searchFiles(q.get('cwd') ?? '', q.get('q') ?? ''));
      case '/api/ls':
        return json(res, 200, listDir(q.get('path') ?? config.home));
      case '/api/file':
        return json(res, 200, readFile(q.get('path') ?? ''));
      case '/api/raw':
        return await serveRaw(req, res, q);
      case '/api/uploads':
        return json(res, 200, uploadsStats());
      case '/api/voice':
        return json(res, 200, listVoice());
      case '/api/git':
        return json(res, 200, await gitStatus(q.get('cwd') ?? ''));
      case '/api/output': {
        const chat = hub.peek(q.get('chatId') ?? '');
        const it = chat?.get(q.get('itemId') ?? '');
        if (!it || it.kind !== 'tool') throw new HttpError(404, 'not found');
        return json(res, 200, { output: it.output ?? '' });
      }
      case '/api/task-output': {
        const chat = hub.peek(q.get('chatId') ?? '');
        const t = chat?.state.tasks.find((x) => x.id === q.get('taskId'));
        if (!t) throw new HttpError(404, 'task not found');
        const file = t.outputFile ?? `/tmp/claude-${process.getuid?.() ?? 1000}/${chat!.cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${chat!.nativeId}/tasks/${t.id}.output`;
        let output = '';
        try {
          output = tailFile(file);
        } catch {
          output = '';
        }
        return json(res, 200, { output, file });
      }
      default:
        throw new HttpError(404, 'not found');
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
    if (status === 500) log.error(`api ${url.pathname}`, e);
    if (res.headersSent) return void res.destroy();
    json(res, status, { error: (e as Error).message });
  }
}

/** Plain HTTP + WS-upgrade proxy to Next (used by the local tunnel socket only). */
function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const target = new URL(config.nextUrl);
  const p = http.request(
    { host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  p.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Next.js не отвечает');
  });
  req.pipe(p);
}

function proxyUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  const target = new URL(config.nextUrl);
  const up = net.connect(Number(target.port), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function startServer(hub: Hub) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 60 * 1024 * 1024, perMessageDeflate: { threshold: 4096 } });

  wss.on('connection', (ws: WebSocket) => {
    const client: Client = {
      id: ++clientSeq,
      subs: new Set(),
      visible: null,
      send(msg: ServerMessage) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 25_000);
    hub.addClient(client);
    ws.on('message', async (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        await hub.handle(client, msg);
      } catch (e) {
        const m = msg as { chatId?: string; reqId?: string };
        client.send({ t: 'error', message: (e as Error).message, chatId: m.chatId, reqId: m.reqId });
      }
    });
    ws.on('close', () => {
      clearInterval(ping);
      hub.removeClient(client);
    });
  });

  const make = (local: boolean) => {
    const srv = http.createServer((req, res) => {
      const u = req.url ?? '/';
      if (u.startsWith('/api/upload') && req.method === 'POST') return handleUpload(req, res);
      if ((u.startsWith('/api/transcribe') || u.startsWith('/api/voice/')) && req.method === 'POST') return void handleVoicePost(req, res);
      if (u.startsWith('/api/')) return void api(hub, req, res);
      if (local) return proxyHttp(req, res);
      res.writeHead(404).end();
    });
    srv.on('upgrade', (req, socket, head) => {
      const u = req.url ?? '/';
      if (u === '/ws' || u.startsWith('/ws?')) {
        if (!originOk(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          return socket.destroy();
        }
        wss.handleUpgrade(req, socket as net.Socket, head, (ws) => wss.emit('connection', ws, req));
        return;
      }
      if (local) return proxyUpgrade(req, socket as net.Socket, head);
      socket.destroy();
    });
    return srv;
  };

  const listenSocket = (srv: http.Server, file: string, mode: number) => {
    try {
      fs.unlinkSync(file);
    } catch {}
    srv.listen(file, () => {
      fs.chmodSync(file, mode);
      log.info(`listening on ${file}`);
    });
  };

  if (config.socket) listenSocket(make(false), config.socket, 0o660);
  if (config.localSocket) listenSocket(make(true), config.localSocket, 0o600);
  if (config.tcp) {
    const [host, port] = config.tcp.split(':');
    make(true).listen(Number(port), host, () => log.info(`listening on ${config.tcp}`));
  }
}
