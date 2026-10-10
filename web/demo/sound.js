// `?sound` for demo.html (both the `?game` flow and the plain demo): AdLib sound through the original driver
// (web/audio/pin-driver.js on data/player.pin + data/adlib.pin) and the OPL2 model (web/audio/opl2-chip.js).
// The ported engine's sound requests (1000:1CCF / 1D4C / 1DAE) arrive through `sim.sound(id, kind)` (web/engine/iteration.js);
// without this module that hook is absent and every request is a no-op. Browsers start audio only after a gesture, so
// requests made before the first key press or click are dropped (the engine does not queue them either).
import { rncUnpack } from '../core/rnc.js';
import { startWebAudio } from '../audio/opl-player.js';

export async function enableSound(sim, fetchBytes) {
  const [player, bank] = await Promise.all(['player.pin', 'adlib.pin'].map(async (n) => rncUnpack(await fetchBytes(`/data/${n}`)).data));
  let snd = null;
  const unlock = () => { if (!snd) { snd = startWebAudio(player, bank); window.__mpSound = snd; } else if (snd.ctx.state === 'suspended') snd.ctx.resume(); };
  addEventListener('keydown', unlock);
  addEventListener('pointerdown', unlock);
  sim.sound = (id, kind) => { if (snd) snd.player.sink(id, kind); };
  return { unlock, get started() { return !!snd; } };
}
