// Which shader a glow uses, named by the server so the look changes with a config edit (gamemode-config "glow").
//
// GroundedPasta, 30 Sep: the chest and salt outlines never showed. The client's default shaders for loot and locked,
// LifeDetected 146 and LifeDetectedUndead AAEB3, are particle-only (EFSH flags "No Membrane Shader"), so nothing is drawn
// on a container or an activator. A 0.3.73+ client plays the shader a dboGlow packet names ("shader": a form id) and
// keeps its old default otherwise; an older client ignores the field. With glow.membrane on, every dboGlow packet that
// names no shader gets its kind's from glow.shaders; off (the default until Nate's console check), packets go out as
// before. One value switches it. Loaded by gamemode.js, which wraps sendPacket with it.
'use strict';

module.exports = (cfg, idOf, log) => {
  const G = Object.assign({ membrane: false, shaders: {} }, (cfg && cfg.glow) || {});
  const ids = {};
  for (const [kind, desc] of Object.entries(G.shaders || {})) {
    const id = desc ? idOf(desc) >>> 0 : 0;
    if (id) ids[kind] = id;
    else if (desc && log) log(`glow: shader ${desc} for ${kind} is not in the load order; ${kind} keeps the client's default`);
  }
  const on = G.membrane === true && Object.keys(ids).length > 0;
  const withShader = (payload) => {
    if (!on || !payload || payload.customPacketType !== 'dboGlow' || payload.clear || payload.shader !== undefined) return payload;
    const id = ids[payload.kind || 'loot'];
    return id ? Object.assign({}, payload, { shader: id }) : payload;
  };
  withShader.state = on ? `membrane shaders ${Object.entries(ids).map(([k, v]) => `${k} ${v.toString(16)}`).join(', ')}` : "the client's defaults";
  return withShader;
};
