#!/usr/bin/env python3
"""Count the Feishu HTTP requests this machine actually makes, at the network layer.

Every lark-cli process is pointed here with `HTTPS_PROXY` (see the wrapper scripts under `~/.local/bin`), so the
counter sees requests no application-level counter can: paging folded inside one CLI call, the tenant-token POST,
tickets' own sessions, and a person typing `lark-cli` in a terminal.

How one request is counted:

    lark-cli --CONNECT--> this proxy (answers 200, then terminates TLS with a CA-signed cert for that host)
        -> parse the request line, forward it upstream over a fresh TLS connection
        -> relay the response, write ONE row (day, host, method, path, status, pid, role, kind)

Attribution comes from `SO_PEERCRED` (the calling pid) and `/proc/<pid>/cmdline`, walked up a few parents to tell the
orchestrator's polling apart from a ticket's session and from a human in a shell.

What is deliberately not counted as an API call: the event stream's WebSocket upgrade (one row, `kind='stream'`), and
anything the proxy fails to terminate — that request is tunneled through untouched, so a cert problem degrades to
"not measured" rather than "lark-cli down".

Run `counter.py --selftest` to exercise the parsers without touching Feishu.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import socket
import socketserver
import sqlite3
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_STATE = os.path.expanduser('~/.dsh/feishu-counter')

SCHEMA = """
create table if not exists request (
  id integer primary key autoincrement,
  at text not null,
  day text not null,
  hour integer not null,
  host text not null,
  method text not null,
  path text not null,
  status integer,
  ms integer,
  req_bytes integer not null default 0,
  resp_bytes integer not null default 0,
  pid integer,
  ppid integer,
  role text not null,
  cmd text,
  kind text not null
);
create index if not exists request_day on request(day);
create index if not exists request_kind on request(kind);
"""


def local_day(at: float) -> tuple[str, int]:
    stamp = time.localtime(at)
    return time.strftime('%Y-%m-%d', stamp), stamp.tm_hour


class Store:
    """One writer thread, so the proxy never blocks on SQLite and rows never interleave."""

    def __init__(self, path: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.path = path
        self.queue: queue.Queue[dict | None] = queue.Queue(maxsize=10000)
        self.thread = threading.Thread(target=self._run, name='counter-store', daemon=True)

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        con = sqlite3.connect(self.path, timeout=30)
        con.execute('pragma journal_mode=wal')
        con.executescript(SCHEMA)
        con.commit()
        while True:
            row = self.queue.get()
            if row is None:
                break
            try:
                con.execute(
                    'insert into request (at, day, hour, host, method, path, status, ms, req_bytes, resp_bytes, pid, ppid, role, cmd, kind)'
                    ' values (:at, :day, :hour, :host, :method, :path, :status, :ms, :req_bytes, :resp_bytes, :pid, :ppid, :role, :cmd, :kind)',
                    row)
                con.commit()
            except Exception as error:  # noqa: BLE001 - a lost row must not kill the writer
                print(f'counter: write failed: {error}', file=sys.stderr, flush=True)
        con.close()

    def put(self, row: dict) -> None:
        try:
            self.queue.put_nowait(row)
        except queue.Full:
            pass

    def stop(self) -> None:
        self.queue.put(None)
        self.thread.join(timeout=5)


# --------------------------------------------------------------------------------------------------------------
# Attribution: pid -> cmdline -> a role. The calling process is a `lark-cli`, always; its ancestors say who asked.
# --------------------------------------------------------------------------------------------------------------

def read_cmdline(pid: int) -> str:
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as handle:
            return handle.read().replace(b'\x00', b' ').decode('utf-8', 'ignore').strip()[:400]
    except OSError:
        return ''


def read_ppid(pid: int) -> int | None:
    try:
        with open(f'/proc/{pid}/status', encoding='utf-8', errors='ignore') as handle:
            for line in handle:
                if line.startswith('PPid:'):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def role_of(pid: int | None) -> tuple[str, int | None, str]:
    """Classify the caller by walking up to four ancestors. Returns (role, ppid, cmdline)."""
    if isinstance(pid, str):
        return 'unknown', None, pid
    if not pid:
        return 'unknown', None, ''
    cmd = read_cmdline(pid)
    parent = read_ppid(pid)
    chain = [(pid, cmd, parent)]
    walker, seen = parent, {pid}
    for _ in range(4):
        if not walker or walker in seen:
            break
        seen.add(walker)
        line = read_cmdline(walker)
        chain.append((walker, line, read_ppid(walker)))
        walker = chain[-1][2]
    text = ' | '.join(entry[1] for entry in chain)
    if 'dsh-superagent' in text or '--profile superagent' in text:
        role = 'worker' if re.search(r'(?:^|/)dsh\b.*(?:exec|worker)|worker-', text) else 'orchestrator'
    elif 'teamagent-dreaming' in text or 'dream' in text.lower():
        role = 'dreaming'
    elif 'dsh' in text:
        role = 'session'
    elif 'lark-cli' in text or 'lark-bot' in text or 'lark-user' in text:
        role = 'cli'
    else:
        role = 'cli'
    return role, parent, cmd


# --------------------------------------------------------------------------------------------------------------
# TLS: sign a leaf per host on first use, so a tunnel to any Feishu host can be terminated without a wildcard that
# has to name every domain lark-cli might touch.
# --------------------------------------------------------------------------------------------------------------

class Certificates:
    def __init__(self, ca_cert: str, ca_key: str, cache: str) -> None:
        self.ca_cert, self.ca_key, self.cache = ca_cert, ca_key, cache
        os.makedirs(cache, exist_ok=True)
        self.lock = threading.Lock()
        self.contexts: dict[str, ssl.SSLContext] = {}

    def context(self, host: str) -> ssl.SSLContext | None:
        host = host.strip('[]')
        with self.lock:
            if host in self.contexts:
                return self.contexts[host]
            cert, key = self._mint(host)
            if not cert:
                return None
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            self.contexts[host] = context
            return context

    def _mint(self, host: str) -> tuple[str, str] | tuple[None, None]:
        safe = re.sub(r'[^a-zA-Z0-9.-]', '_', host)
        cert = os.path.join(self.cache, f'{safe}.crt')
        key = os.path.join(self.cache, f'{safe}.key')
        if os.path.exists(cert) and os.path.exists(key):
            try:
                if ssl._ssl._test_decode_cert(cert).get('subjectAltName'):  # type: ignore[attr-defined]
                    return cert, key
            except Exception:  # noqa: BLE001 - a corrupt cache entry is simply re-minted
                pass
        try:
            with tempfile.TemporaryDirectory() as tmp:
                csr = os.path.join(tmp, 'leaf.csr')
                ext = os.path.join(tmp, 'ext.cnf')
                kind = 'IP' if re.fullmatch(r'[0-9.]+', host) or ':' in host else 'DNS'
                with open(ext, 'w', encoding='utf-8') as handle:
                    handle.write(f'subjectAltName={kind}:{host}\nextendedKeyUsage=serverAuth\n')
                subprocess.run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr,
                                '-subj', f'/CN={host}'], check=True, capture_output=True)
                subprocess.run(['openssl', 'x509', '-req', '-in', csr, '-CA', self.ca_cert, '-CAkey', self.ca_key,
                                '-CAcreateserial', '-out', cert, '-days', '365', '-extfile', ext],
                               check=True, capture_output=True)
            os.chmod(key, 0o600)
            return cert, key
        except Exception as error:  # noqa: BLE001 - falling back to a raw tunnel beats failing the call
            print(f'counter: cannot sign {host}: {error}', file=sys.stderr, flush=True)
            return None, None


# --------------------------------------------------------------------------------------------------------------
# HTTP/1.1 parsing: just enough for what lark-cli and the Feishu API actually speak.
# --------------------------------------------------------------------------------------------------------------

class Reader:
    """Buffered reader over a socket, so a request and the start of its body can be read without over-reading."""

    def __init__(self, sock: ssl.SSLSocket | socket.socket) -> None:
        self.sock, self.buf = sock, b''

    def _fill(self) -> bool:
        chunk = self.sock.recv(65536)
        if not chunk:
            return False
        self.buf += chunk
        return True

    def read_until(self, marker: bytes, limit: int = 1 << 20) -> bytes | None:
        while marker not in self.buf:
            if len(self.buf) > limit or not self._fill():
                return None
        head, _, self.buf = self.buf.partition(marker)
        return head

    def read_exactly(self, count: int) -> bytes:
        while len(self.buf) < count:
            if not self._fill():
                break
        data, self.buf = self.buf[:count], self.buf[count:]
        return data

    def read_chunked(self) -> bytes:
        out = b''
        while True:
            line = self.read_until(b'\r\n')
            if line is None:
                return out
            try:
                size = int(line.split(b';')[0].strip(), 16)
            except ValueError:
                return out
            if size == 0:
                self.read_until(b'\r\n')
                return out
            out += self.read_exactly(size)
            self.read_until(b'\r\n')
        return out


def parse_head(head: bytes) -> tuple[str, str, str, dict[str, str]] | None:
    text = head.decode('latin-1', 'ignore')
    lines = text.split('\r\n')
    if not lines or len(lines[0].split(' ')) < 3:
        return None
    method, target, version = lines[0].split(' ', 2)
    headers: dict[str, str] = {}
    for line in lines[1:]:
        name, _, value = line.partition(':')
        headers[name.strip().lower()] = value.strip()
    return method, target, version, headers


def body_of(reader: Reader, headers: dict[str, str]) -> bytes:
    if headers.get('transfer-encoding', '').lower() == 'chunked':
        return reader.read_chunked()
    try:
        length = int(headers.get('content-length') or 0)
    except ValueError:
        length = 0
    return reader.read_exactly(length) if length else b''


def relay_response(reader: Reader, client: ssl.SSLSocket) -> tuple[int | None, int]:
    """Copy one response to the client, honouring Content-Length, chunked, or close-delimited bodies."""
    head = reader.read_until(b'\r\n\r\n')
    if head is None:
        return None, 0
    parsed = parse_head(head)
    if parsed is None:
        return None, 0
    _, _, _, headers = parsed
    status_match = re.match(rb'HTTP/\d\.\d\s+(\d{3})', head)
    status = int(status_match.group(1)) if status_match else None
    sent = len(head) + 4
    client.sendall(head + b'\r\n\r\n')
    upgrade = headers.get('upgrade', '').lower() in ('websocket', 'h2c') or status == 101
    if upgrade:
        return status, sent
    if headers.get('transfer-encoding', '').lower() == 'chunked':
        while True:
            line = reader.read_until(b'\r\n')
            if line is None:
                return status, sent
            client.sendall(line + b'\r\n')
            sent += len(line) + 2
            try:
                size = int(line.split(b';')[0].strip(), 16)
            except ValueError:
                return status, sent
            if size == 0:
                tail = reader.read_until(b'\r\n')
                if tail is not None:
                    client.sendall(tail + b'\r\n')
                    sent += len(tail) + 2
                return status, sent
            data = reader.read_exactly(size + 2)
            client.sendall(data)
            sent += len(data)
    try:
        length = int(headers.get('content-length') or -1)
    except ValueError:
        length = -1
    if length >= 0:
        data = reader.read_exactly(length)
        client.sendall(data)
        return status, sent + len(data)
    while True:
        chunk = reader.sock.recv(65536)
        if not chunk:
            return status, sent
        client.sendall(chunk)
        sent += len(chunk)


def relay_raw(a: ssl.SSLSocket | socket.socket, b: ssl.SSLSocket | socket.socket) -> None:
    """Byte pump for a connection that stopped being request/response (a WebSocket, say)."""

    def pump(src, dst) -> None:
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    up = threading.Thread(target=pump, args=(a, b), daemon=True)
    up.start()
    pump(b, a)
    up.join(timeout=30)


def classify(host: str, path: str, status: int | None, upgrade: bool) -> str:
    if upgrade or status == 101:
        return 'stream'
    if host.startswith('accounts.') or path.startswith('/oauth/'):
        return 'token'
    return 'api'


class Handler(socketserver.BaseRequestHandler):
    server: 'ProxyServer'

    def handle(self) -> None:  # noqa: C901 - one connection, one linear story
        start = time.time()
        client: socket.socket = self.request
        client.settimeout(120)
        pid = peer_pid(client)
        reader = Reader(client)
        head = reader.read_until(b'\r\n\r\n')
        if head is None:
            return
        parsed = parse_head(head)
        if parsed is None or parsed[0].upper() != 'CONNECT':
            client.sendall(b'HTTP/1.1 405 Only CONNECT\r\nConnection: close\r\n\r\n')
            return
        target = parsed[1]
        host, _, port_text = target.rpartition(':')
        host = host or target
        port = int(port_text or 443)
        role, ppid, cmd = role_of(pid)
        if self.server.role != 'unknown':
            # 端口即身份（包装脚本按自己的位置选端口）。会话各有各的 PID 命名空间，服务端看不到它们的进程树，
            # 而客户端报的标签又要客户端配合，只有端口这条路两端都不依赖。
            role, cmd = self.server.role, f'{self.server.role} via :{self.server.server_address[1]}'
        tag = proxy_tag(parsed[3].get('proxy-authorization', ''))
        if tag:
            role, cmd = tag, tag
        context = self.server.certs.context(host)
        client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        if context is None:
            self.server.raw_tunnel(client, host, port)
            return
        try:
            tls = context.wrap_socket(client, server_side=True)
        except (ssl.SSLError, OSError):
            return
        tls.settimeout(120)
        stream = Reader(tls)
        while True:
            head = stream.read_until(b'\r\n\r\n')
            if head is None:
                return
            parsed = parse_head(head)
            if parsed is None:
                return
            method, path, version, headers = parsed
            body = body_of(stream, headers)
            upstream = socket.create_connection((host, port), timeout=30)
            try:
                upstream_tls = self.server.upstream_ctx.wrap_socket(upstream, server_hostname=host)
            except (ssl.SSLError, OSError) as error:
                print(f'counter: upstream {host}: {error}', file=sys.stderr, flush=True)
                return
            upstream_tls.settimeout(120)
            forwarded = {k: v for k, v in headers.items() if k not in ('proxy-connection', 'connection')}
            forwarded['connection'] = 'close'
            request = f'{method} {path} {version}\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in forwarded.items()) + '\r\n'
            upstream_tls.sendall(request.encode('latin-1') + body)
            up_reader = Reader(upstream_tls)
            try:
                status, resp_bytes = relay_response(up_reader, tls)
                kind = classify(host, path, status, False)
                if status == 101:
                    self._record(host, method, path, status, start, len(head) + len(body), resp_bytes, pid, ppid, role, cmd,
                                 'stream')
                    relay_raw(upstream_tls, tls)
                    return
                self._record(host, method, path, status, start, len(head) + len(body), resp_bytes, pid, ppid, role, cmd, kind)
            except (OSError, ssl.SSLError):
                return
            finally:
                try:
                    upstream_tls.close()
                except OSError:
                    pass

    def _record(self, host, method, path, status, start, req_bytes, resp_bytes, pid, ppid, role, cmd, kind) -> None:
        now = time.time()
        day, hour = local_day(now)
        self.server.store.put({
            'at': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(now)), 'day': day, 'hour': hour,
            'host': host, 'method': method, 'path': (path or '/').split('?')[0][:300], 'status': status,
            'ms': int((now - start) * 1000), 'req_bytes': req_bytes, 'resp_bytes': resp_bytes,
            'pid': pid, 'ppid': ppid, 'role': role, 'cmd': (cmd or '')[:300], 'kind': kind,
        })


def proxy_tag(header: str) -> str:
    """The identity a wrapper put in the proxy URL's userinfo: `http://<tag>@127.0.0.1:18080`."""
    if not header.lower().startswith('basic '):
        return ''
    import base64
    try:
        decoded = base64.b64decode(header.split(' ', 1)[1].strip()).decode('utf-8', 'ignore')
    except (ValueError, IndexError):
        return ''
    user = decoded.split(':', 1)[0]
    try:
        user = base64.urlsafe_b64decode(user + '=' * (-len(user) % 4)).decode('utf-8', 'ignore')
    except (ValueError, IndexError):
        pass
    return user.strip()[:300]


def peer_pid(sock: socket.socket) -> int | None:
    """Which process opened this connection.

    `SO_PEERCRED` answers for a Unix socket; over TCP the kernel has no peer pid (it comes back 0), so fall back to
    matching the client's source port to a socket inode in `/proc/net/tcp` and then to the fd that holds it. The scan
    only looks at processes whose cmdline mentions `lark-cli`, which keeps it cheap: one lookup per tunnel, not per
    request, and the agent makes a handful of tunnels a minute.
    """
    try:
        creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
        pid = struct.unpack('3i', creds)[0]
        if pid:
            return pid
    except OSError:
        pass
    try:
        client_port = sock.getpeername()[1]
    except OSError:
        return None
    inode = inode_of(client_port)
    if not inode:
        return f'no-inode:{client_port}'  # type: ignore[return-value]
    found = pid_holding(inode)
    return found if found else f'no-pid:{inode}'  # type: ignore[return-value]


def inode_of(client_port: int) -> str | None:
    """The inode of the client end of our connection, from the kernel's TCP tables."""
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        try:
            with open(table, encoding='utf-8') as handle:
                next(handle, None)
                for line in handle:
                    parts = line.split()
                    if len(parts) < 10:
                        continue
                    local, remote, state = parts[1], parts[2], parts[3]
                    if state != '01':
                        continue
                    if int(local.rsplit(':', 1)[1], 16) == client_port:
                        return parts[9]
        except OSError:
            continue
    return None


def pid_holding(inode: str) -> int | None:
    """The process whose fd table holds `socket:[inode]`.

    Two passes: the processes that are obviously lark-cli first (a handful of fd links), then everything else, because
    the caller is not always what it looks like — a wrapper that exec'd, a test harness, a future non-CLI client. The
    full pass costs a few tens of milliseconds and happens once per tunnel, not once per request.
    """
    target = f'socket:[{inode}]'
    entries = [entry for entry in os.listdir('/proc') if entry.isdigit()]

    def holds(entry: str) -> bool:
        try:
            for fd in os.listdir(f'/proc/{entry}/fd'):
                try:
                    if os.readlink(f'/proc/{entry}/fd/{fd}') == target:
                        return True
                except OSError:
                    continue
        except OSError:
            pass
        return False

    likely = [entry for entry in entries
              if any(name in read_cmdline(int(entry)) for name in ('lark-cli', 'lark-bot', 'lark-user'))]
    for entry in likely:
        if holds(entry):
            return int(entry)
    for entry in entries:
        if entry not in likely and holds(entry):
            return int(entry)
    return None


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, store: Store, certs: Certificates, upstream: ssl.SSLContext | None = None,
                 role: str = 'unknown') -> None:
        self.store, self.certs, self.role = store, certs, role
        self.upstream_ctx = upstream or ssl.create_default_context()
        super().__init__(address, Handler)

    def raw_tunnel(self, client: socket.socket, host: str, port: int) -> None:
        """No cert for this host: pass bytes through, so the call still works but is not counted."""
        try:
            upstream = socket.create_connection((host, port), timeout=30)
        except OSError:
            return
        relay_raw(upstream, client)
        try:
            upstream.close()
        except OSError:
            pass


# --------------------------------------------------------------------------------------------------------------
# Self-test: a local TLS upstream, the proxy in front of it, and a client that speaks what lark-cli speaks.
# --------------------------------------------------------------------------------------------------------------

def selftest() -> int:
    import http.server

    class Upstream(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def do_GET(self) -> None:  # noqa: N802 - stdlib naming
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args) -> None:
            pass

    with tempfile.TemporaryDirectory() as tmp:
        cert, key = os.path.join(tmp, 'up.crt'), os.path.join(tmp, 'up.key')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
                        '-days', '2', '-subj', '/CN=127.0.0.1',
                        '-addext', 'subjectAltName=IP:127.0.0.1'], check=True, capture_output=True)
        upstream = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        up_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        up_context.load_cert_chain(cert, key)
        upstream.socket = up_context.wrap_socket(upstream.socket, server_side=True)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        up_port = upstream.server_address[1]

        ca_cert, ca_key = os.path.join(tmp, 'ca.crt'), os.path.join(tmp, 'ca.key')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', ca_key,
                        '-out', ca_cert, '-days', '2', '-subj', '/CN=counter selftest CA',
                        '-addext', 'basicConstraints=critical,CA:TRUE',
                        '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], check=True, capture_output=True)
        store = Store(os.path.join(tmp, 'counter.sqlite'))
        store.start()
        trust_anything = ssl.create_default_context()
        trust_anything.check_hostname = False
        trust_anything.verify_mode = ssl.CERT_NONE
        proxy = ProxyServer(('127.0.0.1', 0), store, Certificates(ca_cert, ca_key, os.path.join(tmp, 'certs')),
                            trust_anything)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        port = proxy.server_address[1]

        # Two requests on one tunnel, the way a keep-alive client pages through a list.
        client = socket.create_connection(('127.0.0.1', port))
        client.sendall(f'CONNECT 127.0.0.1:{up_port} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'.encode())
        assert client.recv(4096).startswith(b'HTTP/1.1 200'), 'CONNECT was not accepted'
        context = ssl.create_default_context(cafile=ca_cert)
        tls = context.wrap_socket(client, server_hostname='127.0.0.1')
        for _ in range(2):
            tls.sendall(b'GET /open-apis/im/v1/chats?page=1 HTTP/1.1\r\nHost: upstream.test\r\n\r\n')
            answer = b''
            while b'{"ok":true}' not in answer:
                answer += tls.recv(4096)
        tls.close()
        time.sleep(0.4)
        store.stop()
        con = sqlite3.connect(os.path.join(tmp, 'counter.sqlite'))
        rows = con.execute('select method, path, status, kind, role from request order by id').fetchall()
        con.close()
        proxy.shutdown()
        upstream.shutdown()
        print(json.dumps(rows, ensure_ascii=False))
        assert len(rows) == 2, f'expected 2 counted requests, got {len(rows)}'
        assert rows[0][1] == '/open-apis/im/v1/chats', 'path was not parsed'
        assert rows[0][2] == 200, 'status was not read'
        assert rows[0][3] == 'api', 'kind should be api'
        print('selftest ok: two requests on one tunnel counted separately')
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18080)
    parser.add_argument('--role-port', action='append', default=[],
                        metavar='PORT=ROLE', help='另开一个端口，并把经它的调用记成这个身份')
    parser.add_argument('--state', default=os.environ.get('FEISHU_COUNTER_STATE') or DEFAULT_STATE)
    parser.add_argument('--selftest', action='store_true')
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    certs = Certificates(os.path.join(args.state, 'ca.crt'), os.path.join(args.state, 'ca.key'),
                         os.path.join(args.state, 'certs'))
    store = Store(os.path.join(args.state, 'counter.sqlite'))
    store.start()
    servers = [ProxyServer(('127.0.0.1', args.port), store, certs, role='cli')]
    for spec in args.role_port:
        port_text, _, role = spec.partition('=')
        servers.append(ProxyServer(('127.0.0.1', int(port_text)), store, certs, role=role or 'unknown'))
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f'feishu-counter listening on 127.0.0.1:{server.server_address[1]} as {server.role}', flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.shutdown()
        store.stop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
