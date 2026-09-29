/* Overcrest — the run: state machine, flow, boost, condition, score, stats.
 *
 * States: driving → arriving (auto pull-in at a waystation) → waystation
 * (engine idles, choices) → driving. Wreck or park → over.
 *
 * Flow is the pulse of a run: it rises with pace and clean driving, bleeds
 * slowly, drops on impacts, and its tier multiplies score. Boost is fed by
 * high flow (a sustainable loop) and, later, by souvenirs and pickups.
 * Condition is 100 minus scaled damage; degradation is gentle until it isn't.
 *
 * DOM-free. Reads car/world; writes run state; emits bus events.
 */

import { DT, G, KESTREL, steerLockAt, botInput } from "../sim/physics.js";
import { surfaceParams } from "../sim/surfaces.js";

export const FLOW_TIERS = [0, 20, 40, 60, 80, 95];

/* ------------------------------------------------------------ incidents
 *
 * THE THREE ENDS (Phase 25.2, owner order 2026-08-30: "runs should never
 * last forever, but a rare great one could last an hour or more"). The
 * bible forbids a hidden timer and impossible scaling, and the durability
 * builds (a Growth Ring, Scar Tissue) had made the wreck a promise the road
 * could no longer keep — so the road gained two failure axes that damage
 * cannot buy off: ATTITUDE (a rolled car on its roof) and POSITION (deep
 * water, a fall over an edge, bogged in the field or off the mapped world).
 * Each is an INCIDENT. An incident needs a SAVE — the spectators push a roof
 * over, a farmer tows the rest; one currency. The journey starts with NONE
 * (Quinn, 2026-08-30: "you shouldn't start with anything"): a save is EARNED
 * at the 1st, 5th, 10th and 20th waystation, and after that only a souvenir
 * gives one (or answers an incident itself). A rescue costs time (the sweep
 * does not wait), the zone (flow to nothing) and condition. No save left,
 * and the journey ends there — kindly, the way the Sweep ends it. The
 * bible's own law, with three doors instead of one: small mistakes recover,
 * major ones hurt, catastrophic ones can end a run. */
export const SAVE_AT = [1, 5, 10, 20];
export const RESCUE = { pushT: 7, towT: 12, pushCost: 12, towCost: 18 };
/* saves the journey has earned by its waystation count; `saveEvery` (a
 * souvenir) reopens the schedule past the last milestone, every N stops */
export function savesEarned(waystations, saveEvery) {
  let n = 0;
  for (const k of SAVE_AT) if (waystations >= k) n++;
  const last = SAVE_AT[SAVE_AT.length - 1];
  if (saveEvery > 0 && waystations > last) n += Math.floor((waystations - last) / saveEvery);
  return n;
}
const HOLD = () => ({ dir: 0, steerAnalog: 0, throttle: 0, brake: 0, handbrake: false, boost: false, hold: true });

/* ------------------------------------------------------------- the sweep
 *
 * THE SWEEP (Addendum I): the opt-in timed mode. An old tradition on these
 * roads — after the last runner, the sweep car drives the stage and closes
 * it. Here it is behind you: a virtual pursuer advancing at a fraction of
 * the pace-note profile, paused whenever you are (arrivals, waystations —
 * the stop is calm by design; no FOMO survives contact with the Sweep).
 *
 * The fraction tightens over the opening legs, then breathes with the
 * director's tier — and is HARD-CAPPED below the pace the harness bot
 * proves sustainable forever (0.92 clean), so the sweep is pressure and
 * never a death sentence: an exceptional driver stays ahead indefinitely,
 * by construction, which is the bible's difficulty law applied to time.
 * A danger-spiced tier does NOT speed the sweep (the spice already bought
 * margin at the card — charging twice would be mean): the factor reads the
 * tier capped at the band. */
/* THE LONG SWEEP (owner ruling 2026-08-25, ordered 2026-08-31: "it should
 * very slowly get harder but still possible... a run should require a good
 * build on the Sweep or it'll eventually get caught" — and, on the first
 * draft: "there should be no ceiling"). Past the opening, the factor
 * CLIMBS +0.004 a leg and never stops: past what a careful stock drive
 * holds (measured ~0.875 of the profile on technical roads, ~0.885 on
 * calm ones, whatever is bolted on), past what a speed build driven at
 * pace holds clean (~0.92 technical, ~0.95 calm: two-stroke heart,
 * meridian stone, tall gear, plating, iron shoes, rally tyres), past the
 * road's own pace in the mid-forties (leg 43 at a middling tier), and on. A stock car is
 * collected around the fourteenth stop on calm roads; a developed car
 * driven well lasts to the thirtieth and beyond; boost, which the
 * measuring bot never touches, is the human's margin on top of all of
 * it. Every Sweep ends: the build decides how late. The Drive builds for
 * stability, health and flow; the Sweep builds for speed and boost. */
export const SWEEP_CLIMB = 0.004;
/* the danger exchange (a spicy departure buys margin) FADES with the climb:
 * 350 m a pip through the opening, gone by the thirtieth leg. Without the
 * fade, spice was an endless margin pump — the harness showed a careful
 * stock drive picking the spiciest road every stop staying ahead of the
 * ceiling for 29 km — and the ruling's "eventually caught" never came.
 * Deep in, the marshals stop selling margin: the road is what it is. */
export function sweepExchange(legIndex) {
  return 350 * Math.max(0, 1 - Math.max(0, (legIndex || 0) - 3) / 27);
}
export function sweepFactor(plan, legIndex) {
  if (legIndex <= 0) return 0.76;
  if (legIndex === 1) return 0.80;
  if (legIndex === 2) return 0.82;
  const tier = plan ? Math.min(8, plan.tier) : 5;
  const base = 0.83 + Math.max(0, tier - 4) * 0.013;
  return base + SWEEP_CLIMB * Math.max(0, legIndex - 3);
}

/* ------------------------------------------------------------ pulling in
 *
 * The waystation arrival is the one stretch the car drives itself, so it
 * has to drive it like a driver: brake early, hold the road, then swing
 * out onto the apron in one calm movement and stop where the shed is.
 *
 * The controller that used to live here jabbed a steering KEY left and
 * right against a deadband, and stepped its lateral target from 0 to the
 * apron the instant the speed dropped under 20 m/s. At rally speeds that
 * is a flick, and a flick is a slide, and a slide is the car in the trees.
 * This one asks for a steering ANGLE (the physics takes an analog stick),
 * eases the target line across over the last 90 m, and never asks the
 * tyres for more than the surface has.
 */
const PARK_LANE = 3.6;      // metres past the road edge the car comes to rest
const PARK_AHEAD = 8;       // metres past the apron centre it stops
const APRON_TAIL = 45;      // ...and the furthest along the apron it may use
const PULL_IN = 80;         // over this distance the line eases to the apron
const V_IN = 14;            // speed we want by the time the swing-out starts
const A_PULL = 5.2;         // m/s² the pull-in is willing to brake at

function smooth01(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
function wrapPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function makeRun(world, car, bus) {
  const R = {
    state: "driving",
    time: 0, driveTime: 0,
    score: 0, flow: 0, tier: 0, boost: 25, boostOn: false,
    condition: 100, shield: false, gritT: 0, autoBoost: false,
    /* GRACE (the Drive, Addendum I): at tier 4+ the zone absorbs the first
     * real dent — the hit collapses the FLOW instead of the car. Armed only
     * by climbing from the bottom tiers, so it cannot be farmed by hovering
     * across the tier-4 line. Both flags ride the save. */
    graceArmed: false, graceLow: true, _dmgPrev: null,
    /* the Sweep (opt-in timed mode): the pursuer's road position and the
     * margin in seconds. sweepOn/sweepS ride the save; margin is derived. */
    sweepOn: false, sweepS: 0, sweepMarginS: 999, sweepBankS: 0,
    legIndex: 0, waystations: 0,
    dist: 0, topSpeed: 0, longestAir: 0, hits: 0, offRoadTime: 0,
    driftTime: 0, longestDrift: 0, curDrift: 0,
    // where the records happened — the summary tells them as moments
    airAt: 0, driftAt: 0, topAt: 0,
    // the journey record: where and how the kilometres actually happened
    nightDist: 0, rainDist: 0, coldDist: 0, climb: 0, descent: 0, pickups: 0,
    /* the three ends: saves spent and banked (ride the save file), saves
     * earned and left (derived each tick from the waystation count + the
     * build), the incident ledger, and the rescue in progress */
    savesUsed: 0, savesBanked: 0, savesEarned: 0, savesLeft: 0,
    incidents: 0, rolls: 0, rescues: 0,
    rescueT: 0, rescueLen: 0, rescueKind: null, rescueFree: false,
    bogT: 0,           // seconds creeping in the deep field (bogged → stranded)
    cleanCur: 0, cleanBest: 0, prevY: null,
    arriveT: 0, pullT: 0, ws: null, lastWs: -1, arriveSig: 0, parkJump: 0,
    over: false, overReason: null,
    lastS: car.s,
    wrecked: false,
  };
  const listeners = { arrived: [], departed: [], over: [] };
  let build = null;                     // set by setBuild(); optional (harness)
  const RM = () => (build ? build.runMods : { flowGain: 1, flowDecay: 1, boostDrain: 1, autoBoost: false, repairMul: 1, impactFlowLoss: 1, extraSaves: 0, saveEvery: 0, rescueTime: 1, rescueCost: 1 });
  const emit = (n, d) => (build ? build.emit(n, d) : bus.emit(n, d));
  const on = (n, fn) => listeners[n].push(fn);
  const fire = (n, d) => listeners[n].forEach((f) => f(d));

  function tierOf(flow) {
    let t = 0;
    for (let i = 1; i < FLOW_TIERS.length; i++) if (flow >= FLOW_TIERS[i]) t = i;
    return t;
  }

  /* Called every sim tick with the physics event flags. Returns an input
   * override while arriving/waiting, or null to pass player input through. */
  function tick(ev, input) {
    R.time += DT;
    if (R.over) return { dir: 0, steerAnalog: 0, throttle: 0, brake: 0, handbrake: false, boost: false, hold: true };
    refreshSaves();

    // ---- distance & stats
    const ds = Math.max(0, car.s - R.lastS);
    if (ds < 30) R.dist += ds;              // ignore recovery jumps
    R.lastS = car.s;
    if (car.vx > R.topSpeed) { R.topSpeed = car.vx; R.topAt = R.dist; }
    if (ev.landed && ev.air > R.longestAir) { R.longestAir = ev.air; R.airAt = R.dist; }
    if (ev.impact > 2) R.hits++;
    if (ev.rolled) R.rolls++;
    if (car.zone === "off") R.offRoadTime += DT;
    if (Math.abs(car.beta) > 0.22 && car.vx > 8) { R.curDrift += DT; R.driftTime += DT; }
    else { if (R.curDrift > R.longestDrift) { R.longestDrift = R.curDrift; R.driftAt = R.dist; } R.curDrift = 0; }
    // total climb and descent, and the longest clean stretch between hits
    if (R.prevY != null && R.state === "driving" && car.grounded) {
      const dy = car.y - R.prevY;
      if (Math.abs(dy) < 5) { if (dy > 0) R.climb += dy; else R.descent -= dy; }
    }
    R.prevY = car.y;
    if (ds < 30) R.cleanCur += ds;
    if (ev.impact > 2) { if (R.cleanCur > R.cleanBest) R.cleanBest = R.cleanCur; R.cleanCur = 0; }

    /* ---- grace: the zone absorbs the first real dent (Addendum I).
     * This tick's `ev` and the damage delta both describe LAST tick's
     * physics step, and the build's own refunds (shield → onDamage hooks →
     * hitCap) ran at the end of it — so the souvenir economy gets first
     * refusal and grace only sees what actually stuck. Sits above the
     * condition check so grace can catch a hit that would otherwise wreck.
     * Suspended while the boost is held: the Push is commitment, and a
     * mistake under it is on you. Catastrophic hits (a wall taken head-on)
     * are past what the zone can shrug. */
    const dPrev = R._dmgPrev == null ? car.damage : R._dmgPrev;
    if (R.state === "driving" && R.graceArmed && R.tier >= 4 && !(R.boostOn && !R.autoBoost)) {
      const dmgDelta = car.damage - dPrev;
      if (ev.impact > 4 && dmgDelta > 2 && dmgDelta <= 45) {
        car.damage = dPrev;              // the car shrugs it...
        R.flow = 0;                       // ...and the zone takes the hit
        R.graceArmed = false;             // re-arms only from the bottom tiers
        emit("grace", { impact: ev.impact, absorbed: dmgDelta });
      }
    }
    R._dmgPrev = car.damage;

    // ---- condition
    R.condition = Math.max(0, 100 - car.damage * 0.66);
    if (R.condition <= 0 && !R.wrecked && R.state === "driving") {
      R.wrecked = true;
      endRun("wrecked");
      return null;
    }

    if (R.state === "driving") {
      R.driveTime += DT;
      /* ---- the three ends: a car on its roof, stopped in deep water,
       * landed from a real fall, or stranded (bogged, wedged, or off the
       * mapped world). `ev` describes last tick's step; the roof persists. */
      const fell = car.lastG && car.y < car.lastG.y - 60;
      /* BOGGED (2026-08-31, found by the soak): a car sliding backwards down
       * a snowfield at walking pace for fifteen minutes was never "stuck",
       * because it never quite stopped. Deep in the soft field and barely
       * moving for eight seconds is stranded, whatever the odometer says. */
      const creeping = (car.deepOff || 0) >= 0.8 && Math.hypot(car.vx, car.vy) < 2.5;
      R.bogT = creeping ? (R.bogT || 0) + DT : 0;
      const kind = car.onRoof ? "roof" : ev.drowned ? "water" : ev.plunged ? "fall"
        : (car.oobT > 5 || car.stuckT > 6 || R.bogT > 8 || fell) ? "stranded" : null;
      if (kind) { R.bogT = 0; incident(kind); return R.over ? null : HOLD(); }
      // ---- flow
      const pace = world.profileAt(car.s);
      const ratio = pace > 1 ? car.vx / pace : 0;
      /* the Push (Addendum I): held boost is commitment, not free speed —
       * flow builds faster under it, mistakes cost double, grace stands
       * down (see the grace block above). Auto-boost souvenirs are their
       * own economy and stay out of it. */
      const pushing = !R.sweepOn && R.boostOn && !R.autoBoost;
      let gain = 0;
      if (car.zone === "road" || car.zone === "shoulder") {
        if (ratio > 0.86) gain = 5.5;
        else if (ratio > 0.7) gain = 2.2;
        else if (ratio > 0.5) gain = 0.6;
      }
      if (Math.abs(car.beta) > 0.25 && car.vx > 10 && car.zone === "road") gain += 2.5;   // sideways is style
      if (pushing) gain *= 1.45;
      let loss = 1.1;
      if (car.zone === "off") loss = 4;
      const rm = RM();
      R.flow = Math.max(0, Math.min(100, R.flow + (gain * rm.flowGain - loss * rm.flowDecay) * DT));
      // a souvenir may soften (or cancel) what a hit does to the zone
      if (ev.impact > 6) R.flow = Math.max(0, R.flow - Math.min(40, ev.impact * 2.2) * (pushing ? 2 : 1) * (rm.impactFlowLoss != null ? rm.impactFlowLoss : 1));
      const t = tierOf(R.flow);
      if (t !== R.tier) { emit("flowTier", { tier: t, up: t > R.tier }); R.tier = t; }
      /* grace arms by CLIMBING: only a zone entered from the bottom tiers
       * carries protection */
      if (t <= 1) R.graceLow = true;
      else if (t >= 4 && R.graceLow && !R.sweepOn) { R.graceArmed = true; R.graceLow = false; }

      // ---- boost economy: high flow trickles boost; firing drains it;
      // autoBoost (souvenir) fires for free. In the SWEEP the meters trade
      // masters: the trickle opens from the FIRST tier and scales with it
      // (clean committed driving literally buys the time you will spend),
      // and the reserve runs deeper (boost is time in your pocket — where
      // you spend it is the mode's skill).
      if (R.sweepOn) {
        if (R.tier >= 1) R.boost = Math.min(100, R.boost + R.tier * 1.05 * DT);
      } else if (R.tier >= 3) R.boost = Math.min(100, R.boost + (R.tier - 2) * 1.6 * DT);
      const auto = !!rm.autoBoost;
      const wantBoost = auto || (!!(input && input.boost) && R.boost > 1);
      if (wantBoost && !auto) R.boost = Math.max(0, R.boost - 24 * (R.sweepOn ? 0.72 : 1) * rm.boostDrain * DT);
      if (wantBoost !== R.boostOn) { R.boostOn = wantBoost; emit(wantBoost ? "boostStart" : "boostEnd", {}); }
      R.autoBoost = auto;
      // temporary grip compound (pickup)
      if (R.gritT > 0) R.gritT = Math.max(0, R.gritT - DT);

      // ---- score
      R.score += ds * (1 + 0.22 * R.tier);

      // ---- the sweep advances (and through a rescue, below — never at a stop)
      if (advanceSweep()) return null;

      // ---- waystation approach: take over exactly when the braking has to
      // start — the pull-in distance, plus whatever it takes to shed speed
      // down to the swing-out pace at a comfortable rate
      const ws = world.nextWaystation(car.s);
      if (ws && ws.index > R.lastWs) {
        const v = Math.abs(car.vx);
        const shed = Math.max(0, (v * v - V_IN * V_IN) / (2 * A_PULL));
        const stopS = ws.s + PARK_AHEAD;
        if (car.s > stopS - PULL_IN - shed) {
          R.state = "arriving";
          /* the margin BANKED at the boundary: this number buys the shelf
           * luck, so it is sampled once here and rides the save — a live
           * recompute at the apron would differ between a driven and a
           * resumed visit (the pull-in moves the car; the margin freezes) */
          if (R.sweepOn) R.sweepBankS = R.sweepMarginS;
          // the sweep car pulls in WITH you: the gap holds through the
          // pull-in at exactly its value here (see the arriving branch)
          R.arriveS0 = car.s; R.sweepS0 = R.sweepS;
          R.ws = ws;
          R.arriveT = 0;
          R.pullT = 0;
          R.arriveSig = car.sigma;         // take the wheel where the driver left it
          R.parkJump = 0;
          if (R.boostOn) { R.boostOn = false; bus.emit("boostEnd", {}); }
        }
      }
      return null;
    }

    if (R.state === "arriving") {
      R.arriveT += DT;
      /* the sweep car pulls in with you and waits: through the pull-in the
       * GAP holds at its value when the braking began. Pausing the sweep
       * here handed out ~150 m of free margin per stop (at the long
       * sweep's ceiling that outran the climb: the harness drove a careful
       * stock car 38 km uncaught and "eventually caught" never came);
       * running it at full pace charged ~100 m per stop against a car
       * crawling to the apron. Neutral is honest, and the stop stays calm. */
      if (R.sweepOn && R.arriveS0 != null) R.sweepS = R.sweepS0 + Math.max(0, car.s - R.arriveS0);
      /* The marshals' net. A car going NOWHERE under the pull-in — bogged
       * past the corridor, wedged on a post, wheels spinning on a bank, or
       * on its roof — used to sit there for the fifty-second last resort
       * (owner: "the auto-driver into waystations gets stuck completely").
       * Now six seconds without moving is the signal: near the apron the
       * marshals wave it straight in; further out they push it back onto
       * the road just ahead of where it lies, righted and drained, and the
       * approach carries on. A car on its way back across the field is
       * moving, so it is late, not stuck. */
      const moved = R.netX == null ? 99 : Math.hypot(car.x - R.netX, car.z - R.netZ);
      if (moved > 2.5) { R.netX = car.x; R.netZ = car.z; R.netT = 0; }
      else R.netT = (R.netT || 0) + DT;
      const atSpot = Math.abs(car.s - (R.ws.s + PARK_AHEAD)) < 6;
      const q = world.roadQuery(car.x, car.z, car.s);
      const hw = q ? q.hw : 3.7;
      const d = q ? q.d : car.d;
      const v = Math.max(1, Math.abs(car.vx));
      const grip = surfaceParams((q && q.surf) || car.surface, world.wetness || 0);
      const L = KESTREL.a + KESTREL.b;
      const off = wrapPi(car.yaw - (q ? q.heading : car.yaw));
      const stopped = Math.abs(car.vx) < 0.6 && Math.abs(car.vy) < 0.6;

      /* Out of time. The net has to sit ABOVE every branch below it — the
       * recovery especially, which used to return early and sail past the
       * limit entirely. But it is a net for a car that is STUCK, not for
       * one taking a long way back to the road: the pull-in's own clock
       * (`pullT`) stops while the recovery drives, so getting lost costs
       * you time rather than the whole attempt. Stop first, so whatever
       * the last resort must do, it does to a car already standing still. */
      if (R.arriveT > 50 && !stopped) {
        return { dir: 0, steerAnalog: 0, throttle: 0, brake: 0, handbrake: false, boost: false, hold: true };
      }
      /* The last resort outranks the recovery: a car that is STOPPED and
       * out of time parks from wherever it is. Below the net but above the
       * recovery, or the two alternate — hold stops the car, recovery
       * crawls it one tick, hold stops it again — and the approach inches
       * across a field at walking pace forever. */
      if (stopped && R.arriveT > 52) {
        arrive();
        return { dir: 0, steerAnalog: 0, throttle: 0, brake: 0, handbrake: false, boost: false, hold: true };
      }
      if (R.netT > 6 && R.arriveT > 3 && !(stopped && atSpot)) {
        R.netT = 0; R.netX = null;
        if (car.s >= R.ws.s - 30) {
          arrive();
          return { dir: 0, steerAnalog: 0, throttle: 0, brake: 0, handbrake: false, boost: false, hold: true };
        }
        const smp = world.sampleNear(car.s + 4);
        if (smp) {
          car.x = smp.x; car.z = smp.z; car.y = smp.y + 0.3; car.yaw = smp.heading; car.s = smp.s; car.d = 0;
          car.vx = 0; car.vy = 0; car.omega = 0; car.vyUp = 0; car.grounded = true; car.airTime = 0;
          car.onRoof = false; car.rollSpin = 0; car.rollE = 0; car.rollT = 0;
          car.drowned = false; car.plunged = false; car.waterT = 0; car.oobT = 0; car.stuckT = 0;
          R.arriveSig = 0; R.pullT = 0;
          R.marshalled = (R.marshalled || 0) + 1;
          emit("marshalled", { s: car.s });
        }
      }

      /* Arriving in a state no pull-in can rescue — buried in the verge,
       * pointing into the woods, or still spinning — the controller stops
       * pretending to park and just gets the car back on the road, the way
       * the bot does when it runs wide. Then the approach picks up again.
       * Anything else and a bad corner ends with the car being dragged
       * across half a kilometre by the safety net. */
      if (car.zone === "off" && (Math.abs(d) > hw + 4 || Math.abs(off) > 1.1)) {
        R.pullT = 0;                       // the approach starts again once it is back
        const bi = botInput(car, world, 0.7);
        return {
          dir: bi.dir, steerAnalog: bi.steerAnalog,
          // the deep field bogs the car eleven times over: half throttle never leaves it
          throttle: Math.min(bi.throttle, car.deepOff > 0.5 ? 0.9 : 0.55),
          brake: Math.abs(car.vx) > 15 ? 0.5 : bi.brake,
          handbrake: false, boost: false,
        };
      }

      /* Where it stops. Normally the apron's middle — but a car that comes
       * in far too hot is allowed to use more of the apron rather than be
       * asked for braking it doesn't have and flung past the whole thing. */
      let stopS = R.ws.s + PARK_AHEAD;
      const need = (v * v) / (2 * 5.5);
      if (car.s + need > stopS) stopS = Math.min(R.ws.s + APRON_TAIL, car.s + need);
      /* Still nowhere near the lane — a recovery that came back across the
       * field, usually — so spend some apron getting there rather than
       * stopping level with the bay and sixteen metres out of it. */
      const laneErr = Math.abs(hw + PARK_LANE - d);
      if (laneErr > 4) stopS = Math.min(R.ws.s + APRON_TAIL, Math.max(stopS, car.s + 20));
      const remaining = stopS - car.s;

      /* Arrived when it has actually stopped at the spot — checked FIRST,
       * because every branch below can return, and a "stop here" that
       * outranks the arrival leaves the car holding position at the end of
       * the apron forever. The long timeout is a net for a wreck of an
       * approach, not a routine path: the old 14 s one fired mid-corner at
       * 60 km/h and yanked the car 110 m. */
      const nearby = Math.abs(car.s - R.ws.s) < 80;
      if ((stopped && remaining < 4 && laneErr < 5) || (stopped && nearby && R.pullT > 8) || (stopped && R.arriveT > 52)) {
        arrive();
        return { dir: 0, steerAnalog: 0, throttle: 0, brake: 0, handbrake: false, boost: false, hold: true };
      }

      /* The line: dead centre until the apron is close, then a single
       * smooth sweep out to the parking lane. A stepped target is what
       * threw the car off the road — this one is continuous in distance,
       * so the steering never has to catch up with it. */
      const wantD = (hw + PARK_LANE) * smooth01((PULL_IN - remaining) / PULL_IN);

      /* Steering: an angle, not a key. Road curvature feeds forward, the
       * heading error and the cross-track error pull it onto the line, and
       * the yaw-rate term stops it hunting. Sideways, it does what any
       * driver does — steers into the slide and waits. */
      const sliding = Math.abs(car.beta) > 0.3 || Math.abs(car.omega) > 1.5;
      let steerDes;
      if (sliding) {
        steerDes = Math.sign(car.vy) * Math.min(0.5, Math.abs(car.beta) * 1.1);
      } else {
        const ahead = world.sampleNear((q ? q.s : car.s) + Math.max(6, v * 0.45));
        const near = world.sampleNear((q ? q.s : car.s) + 4);
        const curv = ahead ? ahead.curv : q ? q.curv : 0;
        const ff = Math.atan(L * curv);
        const psi = wrapPi((near ? near.heading : q ? q.heading : car.yaw) - car.yaw);
        const cross = Math.atan(((wantD - d) * 1.05) / Math.max(6, v));
        steerDes = ff + Math.max(-0.5, Math.min(0.5, psi)) * 0.7 + cross - 0.28 * (car.omega - v * curv);
        const dLim = Math.atan((L * grip.grip * G * 0.9) / Math.max(30, v * v)) + 0.08;
        steerDes = Math.max(-dLim, Math.min(dLim, steerDes));
      }
      const lock = steerLockAt(v, grip.grip, grip.bite);
      const want = Math.max(-1, Math.min(1, steerDes / Math.max(0.02, lock)));
      R.arriveSig += (want - R.arriveSig) * (sliding ? 0.25 : 0.12);

      /* Pace: a smooth deceleration curve down to walking speed at the
       * spot, never quicker than the road ahead allows, and calmer still
       * over the last stretch where the car is crossing onto the apron. */
      let vWant = Math.sqrt(1.4 + 2 * A_PULL * Math.max(0, remaining - 3));
      const pace = world.profileAt(car.s + 25);
      if (pace > 1) vWant = Math.min(vWant, pace * 0.94);
      if (remaining < PULL_IN) vWant = Math.min(vWant, V_IN);
      if (remaining < 25) vWant = Math.min(vWant, 8);
      if (remaining < 10) vWant = Math.min(vWant, 4.5);
      R.pullT += DT;
      let throttle = 0, brake = 0;
      // throttle only ever keeps the approach from dying — a pull-in that
      // accelerates is a pull-in the player is watching in disbelief
      if (v < Math.min(vWant, V_IN) - 0.6 && !sliding) throttle = Math.min(0.5, (vWant - v) * 0.2 + 0.12);
      else if (v > vWant + 0.4) brake = Math.min(1, (v - vWant) * 0.22 + 0.06);
      if (car.vx < 0) { throttle = 0.25; brake = 0; }      // rolled backwards: nose it forward
      // short of the spot and stationary: the speed curve asks for a metre
      // per second down here, which is not enough pedal to actually move a
      // car. Give it a proper creep rather than sit there and be towed.
      if (Math.abs(car.vx) < 1.5 && remaining > 3 && !sliding) throttle = Math.max(throttle, 0.35);
      if (remaining < 1.2) { throttle = 0; brake = 1; }
      // run out the far end of the apron: stop, rather than creep away
      if (remaining < -2) return { dir: 0, steerAnalog: 0, throttle: 0, brake: 0, handbrake: false, boost: false, hold: true };

      return { dir: 0, steerAnalog: R.arriveSig, throttle, brake, handbrake: false, boost: false };
    }

    if (R.state === "rescue") {
      /* the spectators are pushing / the tractor is coming: the car waits
       * where it lies, the sweep does not */
      R.rescueT += DT;
      if (advanceSweep()) return null;
      if (R.rescueT >= R.rescueLen) finishRescue();
      return HOLD();
    }

    if (R.state === "waystation") {
      return { dir: 0, steerAnalog: 0, throttle: 0, brake: 0, handbrake: false, boost: false, hold: true };
    }
    return null;
  }

  /* The sweep advances (driving and rescues only: arrivals and waystations
   * are paused — the stop stays calm by design). It runs at its fraction of
   * the profile HERE, so a technical stretch slows it exactly as it slows
   * you, and a car stuck against a rock loses real time — the mode's
   * pressure is honest cause and effect, never a script. Returns true when
   * the journey just ended. */
  function advanceSweep() {
    if (!R.sweepOn) return false;
    const sf = sweepFactor(world.legPlan, R.legIndex);
    const paceHere = Math.max(8, world.profileAt(car.s) || 0);
    R.sweepS += sf * paceHere * DT;
    const gap = car.s - R.sweepS;
    R.sweepMarginS = gap / Math.max(6, sf * paceHere);
    if (gap <= 0) {
      /* caught means COLLECTED, not wrecked: engine off, journey
       * recorded, the summary as always — the run ends kindly */
      endRun("swept");
      return true;
    }
    return false;
  }

  /* saves in hand: earned by the journey, given by the build, banked by a
   * clean drive, minus those spent — derived, so it can never drift from
   * the ledger it is made of. Refreshed every tick and at the arrival
   * itself (the sheet may open before the next tick). */
  function refreshSaves() {
    const rm = RM();
    R.savesEarned = savesEarned(R.waystations, rm.saveEvery || 0);
    R.savesLeft = R.savesEarned + (rm.extraSaves || 0) + R.savesBanked - R.savesUsed;
  }

  /* The arrival: parked, counted, announced — and at the milestone stops a
   * save is EARNED here (never at the start: the road owes a new driver
   * nothing until the first stop). */
  function arrive() {
    park();
    R.state = "waystation";
    R.waystations++;
    const before = R.savesEarned;
    refreshSaves();
    emit("waystation", { index: R.ws.index });
    if (R.savesEarned > before) emit("saveEarned", { waystations: R.waystations, saves: R.savesLeft });
    fire("arrived", R.ws);
  }

  /* An incident (see the header). The build gets first refusal — a souvenir
   * may answer it for free; otherwise a save is spent, if there is one.
   * Nothing left, and the journey ends here. */
  function incident(kind) {
    R.incidents++;
    const needsPush = kind === "roof";
    const help = build && build.incident ? build.incident(kind) : null;
    const helped = !!help || R.savesLeft > 0;
    if (!helped) {
      emit("incident", { kind, helped, free: false, savesLeft: R.savesLeft });
      endRun(kind === "roof" ? "rolled" : kind === "water" ? "drowned" : kind === "fall" ? "fell" : "stranded");
      return;
    }
    // spend BEFORE announcing: the message quotes what is left AFTER this
    // rescue, not before (owner: "one too high after the car gets saved")
    if (!help) { R.savesUsed++; R.savesLeft--; }
    emit("incident", { kind, helped, free: !!help, savesLeft: R.savesLeft });
    const rm = RM();
    R.state = "rescue";
    R.rescueKind = kind; R.rescueFree = !!help; R.rescueT = 0;
    R.rescueLen = (needsPush ? RESCUE.pushT : RESCUE.towT)
      * (help && help.time != null ? help.time : 1) * (rm.rescueTime != null ? rm.rescueTime : 1);
    R.flow = 0;                                   // the zone does not survive a tractor
    if (R.boostOn) { R.boostOn = false; bus.emit("boostEnd", {}); }
    car.stuckT = 0; car.oobT = 0;
  }

  /* The rescue lands: the cost, then the car back on the road — a roof is
   * righted onto the deck beside where it lies, a tow brings the car to the
   * road just ahead. Stopped, upright, whole enough to go on. */
  function finishRescue() {
    const kind = R.rescueKind, rm = RM();
    const cost = (kind === "roof" ? RESCUE.pushCost : RESCUE.towCost)
      * (R.rescueFree ? 0 : 1) * (rm.rescueCost != null ? rm.rescueCost : 1);
    if (cost > 0) car.damage += cost / 0.66;      // the souvenir economy gets its refusal next tick
    const smp = world.sampleNear(kind === "roof" ? car.s : car.s + 4);
    if (smp) {
      car.x = smp.x; car.z = smp.z; car.y = smp.y + 0.3; car.yaw = smp.heading;
      car.s = smp.s; car.d = 0;
    }
    car.vx = 0; car.vy = 0; car.omega = 0; car.vyUp = 0;
    car.onRoof = false; car.rollSpin = 0; car.rollE = 0; car.rollT = 0;
    car.drowned = false; car.plunged = false; car.waterT = 0; car.oobT = 0; car.stuckT = 0;
    car.grounded = true; car.airTime = 0; car.lastGroundY = car.y;
    R.rescues++;
    R.state = "driving";
    emit("rescue", { kind, free: R.rescueFree });
    R.rescueKind = null;
  }

  /* Settle the car on its apron spot. After a good pull-in this is a nudge
   * of a metre or so — which is the point: the drive in is the thing the
   * player watched, and it should be the thing that put the car here. The
   * jump is recorded so the harness can shout if it ever grows again. */
  function park() {
    const ws = R.ws;
    /* Park where the car actually came to rest, held inside the apron —
     * the drive in should be what put it there, not this function. A car
     * that OVERSHOT the whole apron (kicked sideways at speed on tarmac,
     * recovered, and ran long) missed the entrance: it parks up the road
     * where it stopped, on its own side, rather than being dragged a
     * hundred and fifty metres backwards to the bay — that drag was a
     * teleport wearing a parking brake. */
    const over = car.s > ws.s + APRON_TAIL + 4;
    const parkS = over ? car.s : Math.max(ws.s - 10, Math.min(ws.s + APRON_TAIL, car.s));
    const smp = world.sampleNear(parkS);
    if (!smp) return;
    const rx = -Math.sin(smp.heading), rz = Math.cos(smp.heading);
    // past the apron there is no flat pull-off: keep to the deck's edge
    const lat = over ? Math.max(-smp.hw + 1.2, Math.min(smp.hw - 1.2, car.d)) : smp.hw + PARK_LANE;
    const px = smp.x + rx * lat, pz = smp.z + rz * lat;
    R.parkJump = Math.hypot(px - car.x, pz - car.z);
    car.x = px; car.z = pz;
    const g = world.groundHeight(car.x, car.z, parkS);
    car.y = g ? g.y : smp.y;
    car.yaw = smp.heading;
    car.vx = 0; car.vy = 0; car.omega = 0; car.vyUp = 0;
    car.beta = 0; car.alphaF = 0; car.alphaR = 0; car.axS = 0; car.ayS = 0;
    car.grounded = true; car.airTime = 0;
    car.s = parkS; car.d = lat; car.sigma = 0; car.steer = 0;
    /* whatever state the car ARRIVED in, it leaves the waystation on its
     * wheels, dry and free: a roof or a lake taken under the marshals'
     * control is theirs to fix, never the next leg's first incident */
    car.onRoof = false; car.rollSpin = 0; car.rollE = 0; car.rollT = 0;
    car.drowned = false; car.plunged = false; car.waterT = 0; car.oobT = 0; car.stuckT = 0;
  }

  function depart(route) {
    R.lastWs = R.ws ? R.ws.index : R.lastWs;
    /* the Sweep's currency exchange: danger pips buy margin back — the
     * spicier road pushes the sweep down the road behind you. The gentle
     * card (danger 1) pays nothing; risk is what is being bought. */
    if (R.sweepOn && route && route.danger > 1) R.sweepS -= sweepExchange(R.legIndex) * (route.danger - 1);
    world.chooseRoute(route);
    R.legIndex = world.legIndex;
    R.state = "driving";
    R.ws = null;
    R.flow = Math.max(R.flow, 12);       // leave with a little in the meter
    emit("legStart", { index: R.legIndex, route });
    fire("departed", route);
  }

  function repair(amount) {
    car.damage = Math.max(0, car.damage - (amount * RM().repairMul) / 0.66);
    R.condition = Math.max(0, 100 - car.damage * 0.66);
  }

  function endRun(reason) {
    if (R.over) return;
    R.over = true;
    R.overReason = reason;
    if (R.curDrift > R.longestDrift) { R.longestDrift = R.curDrift; R.driftAt = R.dist; }
    if (R.cleanCur > R.cleanBest) R.cleanBest = R.cleanCur;
    fire("over", { reason });
  }

  function setBuild(b) { build = b; }
  return { R, tick, depart, repair, endRun, on, tierOf, setBuild, incident };
}




