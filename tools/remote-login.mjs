#!/usr/bin/env node

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const AUTH_ORIGIN = 'https://commandcode.ai';
const MAX_BODY_BYTES = 64 * 1024;

export function browserLaunchSpec(url, platform = process.platform) {
  const target = String(url);
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] };
  if (platform === 'darwin') return { command: 'open', args: [target] };
  return { command: 'xdg-open', args: [target] };
}

export function openBrowser(url) {
  const { command, args } = browserLaunchSpec(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    return new Promise((resolve) => {
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    });
  } catch {
    return Promise.resolve(false);
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function parseArguments(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2);
    result[name] = args[index + 1] && !args[index + 1].startsWith('--') ? args[++index] : '';
  }
  return result;
}

function usage() {
  console.error('用法：node tools/remote-login.mjs --server <HTTPS地址> --state <状态> --ticket <一次性票据>');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.server || !options.state || !options.ticket) {
    usage();
    process.exitCode = 2;
  } else {
    let serverOrigin;
    try {
      serverOrigin = new URL(options.server);
      if (serverOrigin.protocol !== 'https:') throw new Error('远程控制台地址必须使用 HTTPS');
      serverOrigin.pathname = '/';
      serverOrigin.search = '';
      serverOrigin.hash = '';
    } catch (error) {
      console.error(`远程控制台地址无效：${error.message || error}`);
      process.exitCode = 2;
    }

    if (serverOrigin) {
      let callbackServer;
      let callbackHandled = false;

      const callbackHeaders = {
        'Access-Control-Allow-Origin': AUTH_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Cache-Control': 'no-store',
        Vary: 'Origin',
      };

      function sendPage(response, status, title, message) {
        const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center;padding:40px}h1{font-size:24px}p{color:#64748b;line-height:1.6}</style><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>`;
        response.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          ...callbackHeaders,
        });
        response.end(body);
      }

      async function readBody(request) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) throw new Error('授权回调数据过大');
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return {};
        const contentType = text(request.headers['content-type']).split(';', 1)[0].toLowerCase();
        if (contentType === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
        return JSON.parse(raw);
      }

      async function submitToRemote(payload) {
        const endpoint = new URL('/admin/api/auth/bridge/complete', serverOrigin);
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ state: options.state, ticket: options.ticket, ...payload }),
          signal: AbortSignal.timeout(30_000),
        });
        let result = {};
        try {
          result = await response.json();
        } catch {
          result = {};
        }
        if (!response.ok || result.ok === false) throw new Error(result.error || `远程控制台返回 HTTP ${response.status}`);
        return result;
      }

      async function handleCallback(request, response, url) {
        if (callbackHandled) {
          sendPage(response, 409, '授权助手已处理', '此授权回调已经处理，可以关闭此页面。');
          return;
        }
        callbackHandled = true;
        try {
          const payload = request.method === 'GET'
            ? Object.fromEntries(url.searchParams.entries())
            : await readBody(request);
          if (text(payload.state) !== options.state) throw new Error('授权状态不匹配，请重新从远程控制台发起添加账号。');
          if (payload.error) {
            await submitToRemote({
              error: text(payload.error),
              errorDescription: text(payload.error_description),
            });
            sendPage(response, 200, '授权未完成', '官方授权没有完成，可以关闭此页面并返回远程控制台。');
            return;
          }
          if (!text(payload.apiKey)) throw new Error('官方授权回调没有返回 API Key。');
          console.log('官方授权已完成，正在通过 HTTPS 提交到远程控制台……');
          await submitToRemote({ apiKey: text(payload.apiKey) });
          console.log('远程控制台已接收授权信息。此助手不会保存或显示 API Key。');
          sendPage(response, 200, '授权成功', '账号已自动发送到远程控制台，可以关闭此页面。');
        } catch (error) {
          console.error(`远程授权失败：${error.message || error}`);
          sendPage(response, 502, '授权失败', '授权信息未能提交到远程控制台，请返回控制台重新发起。');
        } finally {
          setTimeout(() => callbackServer?.close(), 300);
        }
      }

      callbackServer = createServer((request, response) => {
        let url;
        try {
          url = new URL(request.url || '/', 'http://127.0.0.1');
        } catch {
          sendPage(response, 400, '回调地址无效', '请重新发起远程添加账号。');
          return;
        }
        if (url.pathname === '/callback' && request.method === 'OPTIONS') {
          response.writeHead(204, callbackHeaders);
          response.end();
          return;
        }
        if (url.pathname !== '/callback' || !['GET', 'POST'].includes(request.method)) {
          sendPage(response, 404, '地址不存在', '请返回远程控制台重新发起授权。');
          return;
        }
        handleCallback(request, response, url).catch((error) => {
          console.error(`授权回调处理失败：${error.message || error}`);
          sendPage(response, 500, '授权失败', '授权回调处理失败，请重新发起。');
        });
      });

      callbackServer.once('error', (error) => {
        console.error(`本地授权回调无法启动：${error.message || error}`);
        process.exitCode = 1;
      });

      callbackServer.listen(0, '127.0.0.1', async () => {
        const address = callbackServer.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const loginUrl = new URL('/studio/auth/cli', AUTH_ORIGIN);
        loginUrl.searchParams.set('callback', `http://127.0.0.1:${port}/callback`);
        loginUrl.searchParams.set('state', options.state);
        loginUrl.searchParams.set('mode', 'redirect');
        loginUrl.searchParams.set('client', 'commandcode-proxy-bridge');
        loginUrl.searchParams.set('prompt', 'login');
        console.log('授权助手已启动，正在打开 Command Code 官方授权页。');
        if (!await openBrowser(loginUrl.toString())) {
          console.log(`请在本机浏览器打开：${loginUrl.toString()}`);
        }
      });
    }
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  main().catch((error) => {
    console.error(`远程授权助手启动失败：${error.message || error}`);
    process.exitCode = 1;
  });
}
