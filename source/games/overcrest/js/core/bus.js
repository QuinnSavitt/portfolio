/* Overcrest — game event bus.
 *
 * The spine of the souvenir (artifact) system: sim and run logic emit typed
 * events, souvenirs and UI listen. Deterministic — emission happens inside
 * the fixed tick in a stable order, and handlers run synchronously in
 * subscription order.
 *
 * Event names (grow deliberately; document here):
 *   driftStart, driftEnd        {duration, angleMax, dir}
 *   driftSwitch                 {gap}  — clean L→R / R→L transition
 *   cornerDone                  {sev, dir, clean, drifted}
 *   tookOff, landed             {air, impact, clean}
 *   collision                   {impact}
 *   surfaceChange               {from, to}
 *   nearMiss                    {kind}
 *   pickup                      {kind, tier, sliding}
 *   boostStart, boostEnd        {}
 *   flowTier                    {tier, up}
 *   waystation                  {index}
 *   legStart                    {index, route}
 *   weatherChange, phaseChange  {...}
 */

export function makeBus() {
  const subs = new Map();     // name -> [fn]
  let depth = 0;              // re-entrancy guard: emits from handlers are fine,
  const MAX_DEPTH = 8;        // runaway trigger loops are not

  function on(name, fn) {
    let arr = subs.get(name);
    if (!arr) subs.set(name, (arr = []));
    arr.push(fn);
    return () => {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  function emit(name, data) {
    const arr = subs.get(name);
    if (!arr || !arr.length) return;
    if (depth >= MAX_DEPTH) return;   // swallow: prevents infinite chains, keeps sim alive
    depth++;
    // snapshot: handlers may unsubscribe during emission
    const list = arr.slice();
    for (let i = 0; i < list.length; i++) list[i](data);
    depth--;
  }

  function clear() { subs.clear(); }

  return { on, emit, clear };
}
