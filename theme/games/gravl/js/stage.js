/* Daily Rally — stage selection with automated test driving.
 *
 * Before a candidate becomes the daily, a deterministic bot drives it through
 * the real physics at a cautious 85% of the profile speeds. Candidates the
 * bot cannot bring home cleanly are rejected and the next-best takes over.
 * The bot and physics are bit-deterministic, so every player performs the
 * identical audition and lands on the identical stage.
 */

import { generateStage } from "./track.js";
import { makeCar, resetCar, step, botInput, DT } from "./physics.js";

export function testDrive(stage, skill, maxSeconds) {
  const car = makeCar();
  resetCar(car, stage);
  const sk = skill == null ? 0.85 : skill;
  let t = 0, offRoad = 0, finished = false;
  const maxTicks = Math.round((maxSeconds || 150) * 120);
  for (let i = 0; i < maxTicks; i++) {
    step(car, stage, botInput(car, stage, stage.profile, sk));
    t += DT;
    if (car.zone !== "road" && car.zone !== "shoulder") offRoad += DT;
    if (car.dead || car.stuckT > 5) break;
    if (car.s >= stage.finishS) { finished = true; break; }
  }
  return { finished, t, offRoad, damage: car.damage };
}

export function loadStage(day) {
  return generateStage(day, {
    validate: (st) => {
      const drive = testDrive(st);
      st.botDrive = drive;
      return drive.finished && drive.offRoad < 12 && drive.t / st.botTime < 1.6;
    },
  });
}
