import {
  advanceEra,
  advanceEraError,
  buildTower,
  placementError,
  sellTower,
  setTargeting,
  upgradeError,
  upgradeTower,
} from '../build.ts';
import { launchSortie, receiveSortie, sortieCost, sortieError, sortieKickback } from '../sortie.ts';
import { spawnCreep, towerById, type World } from '../world.ts';
import { beginWave } from './waves.ts';

/**
 * Drain the command queue. Runs as the first phase of every tick so that player
 * actions apply at a well-defined instant, before anything moves.
 *
 * Every branch re-validates rather than trusting the click that produced it:
 * money may have been spent, a wave may have started, or the tower may have
 * been sold between the pointer event and this tick.
 */
export function applyCommands(w: World): void {
  for (const cmd of w.commands) {
    switch (cmd.type) {
      case 'startWave':
        beginWave(w);
        break;

      // Refused where the mode does not offer it, rather than trusted from the
      // caller — the same posture every other branch here takes. Versus is the
      // only such mode; see `Rules.autoStart`.
      case 'setAutoStart': {
        const on = cmd.on && w.rules.autoStart;
        w.wave.autoStart = on;
        w.events.push({ type: 'autoStartSet', on });
        break;
      }

      case 'advanceEra': {
        const reason = advanceEraError(w);
        if (reason !== null) {
          w.events.push({ type: 'eraRejected', reason });
          break;
        }
        const cost = advanceEra(w);
        w.events.push({ type: 'eraAdvanced', era: w.era, cost });
        break;
      }

      case 'sortie': {
        const reason = sortieError(w, cmd.sortie, cmd.lane);
        if (reason !== null) {
          w.events.push({ type: 'sortieRejected', reason });
          break;
        }
        // Priced before charging, so the event carries the figure the kickback
        // will be a fraction of. Re-deriving it when the contact lands would
        // read the wave index at the wrong moment.
        const cost = sortieCost(cmd.sortie, w.wave.index, w);
        launchSortie(w, cmd.sortie);
        w.events.push({
          type: 'sortieLaunched',
          sortie: cmd.sortie,
          lane: cmd.lane,
          cost,
          kickback: sortieKickback(cost),
        });
        break;
      }

      case 'inbound':
        // No validation and no charge: this is not a purchase, it is a contact
        // the other player already paid for. The lane is clamped rather than
        // refused, because dropping it would silently eat something somebody
        // spent money on.
        receiveSortie(
          w,
          cmd.sortie,
          Math.min(Math.max(0, Math.trunc(cmd.lane)), w.map.routes.length - 1),
          cmd.kickback,
        );
        break;

      case 'creditSortie':
        w.money += cmd.amount;
        w.stats.sortieEarned += cmd.amount;
        break;

      case 'placeTower': {
        const reason = placementError(w, cmd.defId, cmd.col, cmd.row);
        if (reason !== null) {
          w.events.push({ type: 'buildRejected', reason });
          break;
        }
        const tower = buildTower(w, cmd.defId, cmd.col, cmd.row);
        w.events.push({ type: 'towerPlaced', id: tower.id, col: tower.col, row: tower.row });
        break;
      }

      case 'upgradeTower': {
        const t = towerById(w, cmd.id);
        const reason = upgradeError(w, t, cmd.path);
        if (reason !== null || t === undefined) {
          w.events.push({ type: 'towerActionRejected', reason: reason ?? 'noSuchTower' });
          break;
        }
        const cost = upgradeTower(w, t, cmd.path);
        w.events.push({
          type: 'towerUpgraded',
          id: t.id,
          path: cmd.path,
          tier: t.tiers[cmd.path],
          cost,
        });
        break;
      }

      case 'sellTower': {
        const t = towerById(w, cmd.id);
        if (t === undefined) {
          w.events.push({ type: 'towerActionRejected', reason: 'noSuchTower' });
          break;
        }
        const { col, row } = t;
        const refund = sellTower(w, t);
        w.events.push({ type: 'towerSold', id: t.id, col, row, refund });
        break;
      }

      case 'setTargeting': {
        const t = towerById(w, cmd.id);
        if (t === undefined) {
          w.events.push({ type: 'towerActionRejected', reason: 'noSuchTower' });
          break;
        }
        setTargeting(t, cmd.mode);
        break;
      }

      case 'spawnDebugCreep':
        spawnCreep(w, 'drifter');
        break;
    }
  }
  w.commands.length = 0;
}
