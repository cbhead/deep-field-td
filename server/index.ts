/**
 * Race-mode relay server — N5: heartbeat, forfeit, resume.
 *
 * The server never runs game logic. Its whole job is: agree on a seed, ferry
 * status blobs between two clients, decide who won. In-memory rooms, zero
 * validation — cheating is a non-goal between two trusted friends.
 *
 * Binds 0.0.0.0 so the friend's machine can reach it over Tailscale — binding
 * localhost is the single most common first failure. The bare HTTP response
 * exists so reachability can be checked from a browser before any game client
 * exists: http://<tailscale-ip>:8787 should say the server is up.
 *
 * Connection lifecycle over the internet: sockets drop. A ws ping every 15s
 * finds dead ones; a dropped player's seat is held (roster survives players),
 * the opponent sees a peerConn badge, and a 90s timer settles the match for
 * the survivor if the seat stays empty. A client reclaims its seat by sending
 * hello with resume=<playerId>.
 */
import http from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  WS_PATH,
  decodeC2S,
  encode,
  type MatchMode,
  type S2C,
  type Standing,
} from '../src/net/protocol.ts';

const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
/** Env-overridable, like FORFEIT_MS: visual checks need to hold the countdown. */
const COUNTDOWN_MS = Number(process.env['COUNTDOWN_MS'] ?? 3000);
const HEARTBEAT_MS = 15_000;
/** Env-overridable so the forfeit path can be exercised in seconds in tests. */
const FORFEIT_MS = Number(process.env['FORFEIT_MS'] ?? 90_000);

/** Rematch reloads the page, so an emptied room must outlive its sockets. */
const EMPTY_ROOM_TTL_MS = 60_000;

type Player = { id: string; name: string; ready: boolean; ws: WebSocket };
type Room = {
  code: string;
  players: Player[];
  started: boolean;
  /** The creator's pick, re-dealt in every lobby and start. Unvalidated —
   *  clients fall back to the baseline if they don't recognise it. */
  level: string;
  diff: string;
  /**
   * Which game this room plays, from the creator's `hello`.
   *
   * The *only* thing the server does differently between the two, and it is
   * one branch: Race waits for both runs and ranks them; versus ends the
   * instant a core does, so the first `dead` settles it. Everything else here
   * — rooms, resume, forfeit, relay — is mode-blind and stays that way.
   */
  mode: MatchMode;
  /** Everyone who ever joined — a dropped player's seat, held for resume. */
  roster: Map<string, string>;
  /** Final figures per playerId — kept on the room, not the player, so a
   *  finished player who disconnects still counts toward the result. */
  finals: Map<string, Standing>;
  /** Last relayed status per playerId; the forfeit standings come from here. */
  lastStatus: Map<string, { wave: number; lives: number; elapsedMs: number }>;
  forfeitTimer: ReturnType<typeof setTimeout> | null;
};

const rooms = new Map<string, Room>();

// No lookalikes (O/0, I/1/L) — these get read aloud over a call.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newRoom(): Room {
  let code: string;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  const room: Room = {
    code, players: [], started: false, level: 'level01', diff: 'standard', mode: 'race',
    roster: new Map(), finals: new Map(), lastStatus: new Map(), forfeitTimer: null,
  };
  rooms.set(code, room);
  return room;
}

/** Ranking order: waves cleared, then lives remaining, then elapsed time. */
function rank(a: Standing, b: Standing): number {
  return b.wave - a.wave || b.lives - a.lives || a.elapsedMs - b.elapsedMs;
}

const send = (ws: WebSocket, msg: S2C): void => ws.send(encode(msg));

const broadcast = (room: Room, msg: S2C): void => room.players.forEach((p) => send(p.ws, msg));

const broadcastLobby = (room: Room): void =>
  broadcast(room, {
    t: 'lobby',
    players: room.players.map(({ id, name, ready }) => ({ playerId: id, name, ready })),
    level: room.level,
    diff: room.diff,
  });

const standingFor = (room: Room, id: string): Standing =>
  room.finals.get(id) ?? {
    playerId: id,
    name: room.roster.get(id) ?? '?',
    ...(room.lastStatus.get(id) ?? { wave: 0, lives: 0, elapsedMs: 0 }),
  };

function settle(room: Room, forfeitWinner?: string, coreLoser?: string): void {
  const standings = [...room.roster.keys()].map((id) => standingFor(room, id)).sort(rank);
  let winnerId: string | null;
  if (forfeitWinner !== undefined) {
    winnerId = forfeitWinner;
    standings.sort((a, b) => (a.playerId === forfeitWinner ? -1 : b.playerId === forfeitWinner ? 1 : 0));
  } else if (coreLoser !== undefined) {
    // Versus: whoever is still standing won, and the ranking is not consulted.
    // On an endless arc "waves cleared" has no finish line to be measured
    // against, so ranking two survivors would be comparing two numbers that
    // never meant anything relative to each other.
    winnerId = [...room.roster.keys()].find((id) => id !== coreLoser) ?? null;
    const survivor = winnerId;
    standings.sort((a, b) => (a.playerId === survivor ? -1 : b.playerId === survivor ? 1 : 0));
  } else {
    const [first, second] = standings;
    winnerId = first && second && rank(first, second) === 0 ? null : (first?.playerId ?? null);
  }
  const reason = forfeitWinner !== undefined ? 'forfeit' : coreLoser !== undefined ? 'core' : undefined;
  console.log(`[result] room ${room.code} winner=${winnerId ?? 'tie'}${reason ? ` (${reason})` : ''}`);
  broadcast(room, {
    t: 'result', winnerId, standings,
    ...(reason !== undefined ? { reason } : {}),
  });
  // Reset for a rematch: same room, fresh readies, next start deals a new seed.
  room.started = false;
  room.finals.clear();
  room.lastStatus.clear();
  if (room.forfeitTimer !== null) clearTimeout(room.forfeitTimer);
  room.forfeitTimer = null;
  room.players.forEach((p) => {
    p.ready = false;
  });
}

// N6: the same process serves the built client, so one URL on one port is the
// whole deployment: http://<tailscale-ip>:8787/?race for both players, and the
// ws URL derives from the page's own host. No CDN, no second process, and both
// clients always run the same build because it comes from here.
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.map': 'application/json', '.woff2': 'font/woff2', '.json': 'application/json',
};

/**
 * The machine's Tailscale IPv4 (CGNAT range 100.64.0.0/10), if any. The lobby
 * asks via /info so invite links carry the address the *friend* can reach,
 * even when the host opened the page as localhost.
 */
function tailscaleIp(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4') continue;
      const [first, second] = a.address.split('.').map(Number);
      if (first === 100 && second !== undefined && second >= 64 && second <= 127) return a.address;
    }
  }
  return null;
}

const httpServer = http.createServer((req, res) => {
  void (async () => {
    // Strip the query and any traversal; everything must resolve inside dist/.
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (rawPath === '/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tailscaleIp: tailscaleIp(), port }));
      return;
    }
    let path = normalize(decodeURIComponent(rawPath)).replace(/^(\.\.[/\\])+|^[/\\]+/, '');
    if (path === '' || path === '.') path = 'index.html';
    try {
      const body = await readFile(join(DIST, path));
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      // Before the first build (or for a stray path) keep the N0 sanity line:
      // reachability over Tailscale must be checkable with zero client built.
      res.writeHead(path === 'index.html' ? 200 : 404, { 'content-type': 'text/plain' });
      res.end(path === 'index.html' ? 'tower-defense race server is up — run `npm run play` to serve the game\n' : 'not found\n');
    }
  })();
});

const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

let nextPlayer = 1;

wss.on('connection', (ws: WebSocket, req) => {
  const from = req.socket.remoteAddress ?? '?';
  let me: Player | null = null;
  let room: Room | null = null;
  console.log(`[conn] ${from}`);

  // Heartbeat: browsers answer pings automatically, so a silent socket is a
  // dead one. Terminate fires 'close', which starts the forfeit clock.
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, HEARTBEAT_MS);

  ws.on('message', (data) => {
    const msg = decodeC2S(String(data));
    if (!msg) return;

    switch (msg.t) {
      case 'hello': {
        if (me) return;

        /**
         * Version skew is refused, out loud, before a seat is allocated.
         *
         * It was ignored while there was only one version, and that was fine.
         * It stops being fine the moment the two versions disagree about how a
         * match *ends*: a v1 client dropped into a versus room would play the
         * Race rules it knows, keep going after its core died, and be told it
         * had lost a match it never understood it was in. Every failure mode
         * here is silent and confusing, and the check is two lines.
         *
         * Named on both sides, because "update your client" is only actionable
         * if you can tell which end is behind.
         */
        if (msg.v !== PROTOCOL_VERSION) {
          console.log(`[skew] rejected v${msg.v} client (server speaks v${PROTOCOL_VERSION})`);
          send(ws, {
            t: 'error',
            reason: `protocol mismatch: you are v${msg.v}, this server is v${PROTOCOL_VERSION} — reload to update`,
          });
          ws.close();
          return;
        }

        // Resume: reclaim a held seat after a drop, before the forfeit fires.
        if (msg.resume !== undefined && msg.room !== undefined) {
          const wanted = rooms.get(msg.room.toUpperCase());
          const seatHeld = wanted?.roster.has(msg.resume) === true &&
            !wanted.players.some((p) => p.id === msg.resume);
          if (wanted && seatHeld) {
            room = wanted;
            me = { id: msg.resume, name: msg.name, ready: room.started, ws };
            room.players.push(me);
            if (room.forfeitTimer !== null) clearTimeout(room.forfeitTimer);
            room.forfeitTimer = null;
            console.log(`[resume] "${me.name}" reclaims ${me.id} in room ${room.code}`);
            send(ws, { t: 'joined', playerId: me.id, room: room.code });
            room.players.filter((p) => p !== me).forEach((p) => send(p.ws, { t: 'peerConn', connected: true }));
            if (!room.started) broadcastLobby(room);
            return;
          }
          // Seat gone (forfeit fired, room expired) — fall through to a normal
          // join attempt so the client gets an honest error.
        }

        if (msg.room !== undefined) {
          const wanted = rooms.get(msg.room.toUpperCase());
          if (!wanted) return send(ws, { t: 'error', reason: `no room ${msg.room.toUpperCase()}` });
          if (wanted.players.length >= 2 || wanted.started) return send(ws, { t: 'error', reason: 'room is full' });
          room = wanted;
        } else {
          room = newRoom();
          if (msg.level !== undefined) room.level = msg.level;
          if (msg.diff !== undefined) room.diff = msg.diff;
          // Absent means race, which is what a v1 client meant.
          if (msg.mode === 'versus') room.mode = 'versus';
        }
        me = { id: `p${nextPlayer++}`, name: msg.name, ready: false, ws };
        room.players.push(me);
        room.roster.set(me.id, me.name);
        console.log(`[hello] "${me.name}" → ${me.id} in room ${room.code} (${from})`);
        send(ws, { t: 'joined', playerId: me.id, room: room.code });
        broadcastLobby(room);
        break;
      }

      case 'ready': {
        if (!me || !room || room.started) return;
        me.ready = msg.ready ?? true;
        console.log(`[ready] ${me.name} (${me.id}) ${me.ready ? 'ready' : 'un-readied'} in room ${room.code}`);
        broadcastLobby(room);
        if (room.players.length === 2 && room.players.every((p) => p.ready)) {
          room.started = true;
          // A fresh match: only current seat-holders count toward the result.
          room.roster = new Map(room.players.map((p) => [p.id, p.name]));
          const seed = (Math.random() * 0x100000000) >>> 0;
          console.log(`[start] room ${room.code} seed=${seed} ${room.level}/${room.diff}`);
          broadcast(room, {
            t: 'start', seed, countdownMs: COUNTDOWN_MS,
            // The room's mode, so both clients boot the same game. The server
            // has always known this and used it to settle; it now says it.
            level: room.level, diff: room.diff, mode: room.mode,
          });
        }
        break;
      }

      // Relay, verbatim and unvalidated: the opponent's client is the only
      // consumer, and cheating is a non-goal between trusted friends.
      case 'status': {
        if (!me || !room) return;
        room.lastStatus.set(me.id, { wave: msg.wave, lives: msg.lives, elapsedMs: msg.elapsedMs });
        const other = room.players.find((p) => p !== me);
        if (other) {
          send(other.ws, {
            t: 'peer', wave: msg.wave, lives: msg.lives, elapsedMs: msg.elapsedMs,
            ...(msg.hidden !== undefined ? { hidden: msg.hidden } : {}),
            ...(msg.towers !== undefined ? { towers: msg.towers } : {}),
            ...(msg.era !== undefined ? { era: msg.era } : {}),
          });
        }
        break;
      }

      /**
       * Sorties and their kickbacks: relayed straight across, unread.
       *
       * The server does not know what a Monolith is and does not need to. It
       * has no world, no wave clock and no idea what either contact costs —
       * the sender's own sim has already charged them, and the receiver's will
       * scale what arrives to its own board. Two forwarding rules is the whole
       * of versus's netcode, which is the payoff for a mode where nothing in
       * either world depends on the other's state.
       */
      case 'sortie': {
        if (!me || !room || !room.started) return;
        const other = room.players.find((p) => p !== me);
        // Logged because it is the one versus frame a match-night failure
        // would hinge on: "I sent it and nothing arrived" is answerable from
        // here and nowhere else.
        console.log(`[sortie] ${me.name} → ${other?.name ?? '(nobody)'}: ${msg.sortie} lane ${msg.lane}`);
        if (other) {
          send(other.ws, {
            t: 'inbound', sortie: msg.sortie, lane: msg.lane, kickback: msg.kickback,
          });
        }
        break;
      }

      case 'landed': {
        if (!me || !room || !room.started) return;
        // Paid to the *other* player — this frame is the receiver telling the
        // room that somebody else's purchase arrived.
        const other = room.players.find((p) => p !== me);
        if (other) send(other.ws, { t: 'credit', amount: msg.kickback });
        break;
      }

      case 'dead': {
        if (!me || !room || !room.started) return;
        console.log(`[dead] ${me.name} (${me.id}) wave=${msg.wave} lives=${msg.lives}`);
        room.finals.set(me.id, {
          playerId: me.id, name: me.name,
          wave: msg.wave, lives: msg.lives, elapsedMs: msg.elapsedMs,
        });
        // Versus ends when a core does: the first report settles it, and the
        // other player is not waited for. Race still needs both runs, because
        // its result is a comparison rather than an elimination.
        if (room.mode === 'versus') settle(room, undefined, me.id);
        else if (room.finals.size === 2) settle(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    console.log(`[gone] ${me ? `${me.name} (${me.id})` : from}`);
    if (!room || !me) return;
    const r = room;
    const gone = me;
    r.players = r.players.filter((p) => p !== gone);

    if (r.players.length === 0) {
      // Both sides reload to rematch, so hold the room open briefly.
      r.started = false;
      if (r.forfeitTimer !== null) clearTimeout(r.forfeitTimer);
      r.forfeitTimer = null;
      setTimeout(() => {
        if (r.players.length === 0) rooms.delete(r.code);
      }, EMPTY_ROOM_TTL_MS);
      return;
    }

    if (r.started && !r.finals.has(gone.id)) {
      // Mid-match drop with an unfinished run: badge the survivor and start
      // the forfeit clock. A resume before it fires cancels it.
      broadcast(r, { t: 'peerConn', connected: false });
      if (r.forfeitTimer !== null) clearTimeout(r.forfeitTimer);
      r.forfeitTimer = setTimeout(() => {
        r.forfeitTimer = null;
        const survivor = r.players[0];
        if (r.started && survivor) {
          console.log(`[forfeit] ${gone.name} (${gone.id}) never returned to room ${r.code}`);
          settle(r, survivor.id);
        }
      }, FORFEIT_MS);
    } else {
      broadcastLobby(r);
    }
  });
});

httpServer.listen(port, '0.0.0.0', () => {
  const ts = tailscaleIp();
  console.log(`race server listening on 0.0.0.0:${port} (ws at ${WS_PATH})`);
  console.log(`  Single-player:       http://localhost:${port}`);
  if (ts) {
    console.log(`  Race with a friend:  http://${ts}:${port}/?race`);
    console.log(`                       open that, then send the invite link the lobby shows you`);
  } else {
    console.log(`  Race with a friend:  no Tailscale IP detected — invite links will only work on`);
    console.log(`                       this machine. Start Tailscale and restart the server.`);
  }
});
