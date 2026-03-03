import { useState, useEffect } from "react";

const SEG_LEN = 4; // default, overridden per game

function bestSegLen(totalMins) {
  // Largest divisor of totalMins that is <= 4 and >= 3
  // Falls back to 4 with slight rounding if no clean divisor found
  for (let s = 4; s >= 3; s--) {
    if (totalMins % s === 0) return s;
  }
  // No clean divisor — use 4 and let the generator floor the segments
  return 4;
}
const DEFAULT_TOL = 0.08;
const STORAGE_KEY = "waukee_jam_rosters";

const RULE_TYPES = {
  ONLY_REST_IF:      "only_rest_if",
  ONLY_PLAY_IF_ALL:  "only_play_if_all",
  NEVER_TOGETHER:    "never_together",
  ALWAYS_TOGETHER:   "always_together",
  MAXIMIZE_TOGETHER: "maximize_together",
};

const RULE_LABELS = {
  only_rest_if:      "can only rest if",
  only_play_if_all:  "only plays if ALL of these play",
  never_together:    "never plays at same time as",
  always_together:   "always plays at same time as",
  maximize_together: "should maximize time on floor with",
};

const RULE_TEMPLATES = [
  { label: "Star player anchors the lineup", type: "only_rest_if",      hint: "Pick your anchor, then who must be on floor for her to rest" },
  { label: "Role player needs support",      type: "only_play_if_all",  hint: "Pick the role player, then who must be playing for her to get time" },
  { label: "Two players can't play together",type: "never_together",    hint: "Pick one player, then select who she can't share the floor with" },
  { label: "Pair always plays together",     type: "always_together",   hint: "Pick one player, then select her partner" },
  { label: "Maximize time together",         type: "maximize_together", hint: "Pick players you want on the floor at the same time as much as possible" },
];

const ALWAYS_SOFT = new Set([RULE_TYPES.MAXIMIZE_TOGETHER]);
const SOFT_SCORE = 12;

const COLORS = [
  "#f97316","#8b5cf6","#ec4899","#06b6d4",
  "#10b981","#f59e0b","#3b82f6","#ef4444",
  "#a78bfa","#34d399",
];

function bounds(target) {
  return {
    min: Math.max(0, Math.round(target * (1 - DEFAULT_TOL))),
    max: Math.round(target * (1 + DEFAULT_TOL)),
  };
}

function makeDefaultPlayers(count, totalMins) {
  const fairShare = Math.round((5 * totalMins) / count);
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Player ${i + 1}`,
    target: fairShare,
    color: COLORS[i % COLORS.length],
    starter: i < 5,
  }));
}

// ── localStorage helpers ────────────────────────────────────────────
function loadRosters() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}
function saveRosters(rosters) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rosters)); } catch {}
}

// ── Rotation generator ──────────────────────────────────────────────
function generateRotation(players, rules, totalMins, segLen) {
  const totalSegs = Math.floor(totalMins / segLen);
  const starters = players.filter(p => p.starter);
  const closingSegs = 1;
  const segsPerHalf = totalSegs / 2;

  const state = players.map(p => {
    const { min, max } = bounds(p.target);
    const hardCap = p.target + segLen;
    return { ...p, min, max, hardCap, played: 0, segments: [], benchStreak: 0, playStreak: 0, restedThisHalf: false };
  });

  const byId = (id) => state.find(p => p.id === id);
  const hardRules = rules.filter(r => !r.soft && !ALWAYS_SOFT.has(r.type));
  const softRules = rules.filter(r => r.soft || ALWAYS_SOFT.has(r.type));

  const validateLineup = (lineup) => {
    const onIds = new Set(lineup.map(p => p.id));
    for (const rule of hardRules) {
      const { type, playerId, targetIds } = rule;
      const isOn = onIds.has(playerId);
      if (type === RULE_TYPES.ONLY_REST_IF && !isOn)
        if (!targetIds.some(tid => onIds.has(tid))) return false;
      if (type === RULE_TYPES.ONLY_PLAY_IF_ALL && isOn)
        if (!targetIds.every(tid => onIds.has(tid))) return false;
      if (type === RULE_TYPES.NEVER_TOGETHER)
        if ([playerId, ...targetIds].every(id => onIds.has(id))) return false;
      if (type === RULE_TYPES.ALWAYS_TOGETHER) {
        const ids = [playerId, ...targetIds];
        if (ids.some(id => onIds.has(id)) && !ids.every(id => onIds.has(id))) return false;
      }
    }
    return true;
  };

  const softRuleScore = (lineup) => {
    const onIds = new Set(lineup.map(p => p.id));
    let score = 0;
    for (const rule of softRules) {
      const { type, playerId, targetIds } = rule;
      const isOn = onIds.has(playerId);
      if (type === RULE_TYPES.ONLY_REST_IF) {
        const canRest = targetIds.some(tid => onIds.has(tid));
        if (!isOn && !canRest) score -= SOFT_SCORE;
        if (!isOn && canRest) score += SOFT_SCORE * 0.5;
      }
      if (type === RULE_TYPES.ONLY_PLAY_IF_ALL) {
        const allTargetsOn = targetIds.every(tid => onIds.has(tid));
        if (isOn && allTargetsOn) score += SOFT_SCORE;
        if (isOn && !allTargetsOn) score -= SOFT_SCORE;
      }
      if (type === RULE_TYPES.NEVER_TOGETHER) {
        if ([playerId, ...targetIds].every(id => onIds.has(id))) score -= SOFT_SCORE;
      }
      if (type === RULE_TYPES.ALWAYS_TOGETHER) {
        const ids = [playerId, ...targetIds];
        const allOn = ids.every(id => onIds.has(id));
        const anyOn = ids.some(id => onIds.has(id));
        if (allOn) score += SOFT_SCORE;
        if (anyOn && !allOn) score -= SOFT_SCORE * 0.5;
      }
      if (type === RULE_TYPES.MAXIMIZE_TOGETHER) {
        const ids = [playerId, ...(targetIds || [])];
        if (ids.every(id => onIds.has(id))) score += SOFT_SCORE;
      }
    }
    return score;
  };

  const scoreLineup = (lineup, seg) => {
    const segsLeft = totalSegs - seg;
    const currentHalf = seg < segsPerHalf ? 0 : 1;
    const halfEnd = (currentHalf + 1) * segsPerHalf;
    const segsLeftInHalf = halfEnd - seg;
    let score = 0;

    for (const p of lineup) {
      score += p.benchStreak * 3;
      if (p.playStreak >= 2) score -= (p.playStreak - 1) * 4;
      const projectedPlayed = p.played + segLen;
      const minGap = Math.max(0, p.min - p.played);
      const urgencyFraction = segsLeft > 0 ? minGap / (segsLeft * segLen) : 0;
      score += urgencyFraction * 18;
      const distFromTarget = Math.abs(projectedPlayed - p.target);
      const rangeSize = Math.max(1, p.max - p.min);
      score -= (distFromTarget / rangeSize) * 6;
      if (projectedPlayed > p.hardCap) score -= 25;
      if (!p.restedThisHalf && segsLeftInHalf > 1) {
        const restUrgency = 1 - (segsLeftInHalf / segsPerHalf);
        score -= restUrgency * 14;
      }
      const remainingBudget = p.hardCap - p.played;
      const burnRate = remainingBudget / Math.max(1, segsLeft);
      if (burnRate < 0.5) score -= 6;
    }
    score += softRuleScore(lineup);
    return score;
  };

  const lineups = [];

  for (let seg = 0; seg < totalSegs; seg++) {
    const segsLeft = totalSegs - seg;
    const isFirst = seg === 0;
    const isClosing = seg >= totalSegs - closingSegs;
    let chosen = null;

    if (isFirst && starters.length === 5) {
      chosen = starters.map(s => byId(s.id));
    } else if (isClosing) {
      const closingStarters = starters.map(s => byId(s.id)).filter(Boolean);
      const startersFive = closingStarters.slice(0, 5);
      const needFill = 5 - startersFive.length;
      const bench = state.filter(p => !p.starter).sort((a, b) => b.benchStreak - a.benchStreak);
      chosen = [...startersFive, ...bench.slice(0, needFill)];
      if (!validateLineup(chosen)) {
        chosen = [...state].sort((a, b) => a.starter === b.starter ? b.benchStreak - a.benchStreak : a.starter ? -1 : 1).slice(0, 5);
      }
    } else {
      const sorted = [...state].sort((a, b) => {
        const aUrge = segsLeft > 0 ? Math.max(0, a.min - a.played) / (segsLeft * segLen) : 0;
        const bUrge = segsLeft > 0 ? Math.max(0, b.min - b.played) / (segsLeft * segLen) : 0;
        if (Math.abs(aUrge - bUrge) > 0.02) return bUrge - aUrge;
        if (b.benchStreak !== a.benchStreak) return b.benchStreak - a.benchStreak;
        return (b.hardCap - b.played) - (a.hardCap - a.played);
      });
      const pool = sorted.filter(p => p.played < p.hardCap);
      const mustPlay = sorted.filter(p => (p.min - p.played) >= segsLeft * segLen && p.played < p.hardCap).slice(0, 5);
      let best = null, bestScore = -Infinity;
      const tryBuild = (cur, remaining) => {
        if (cur.length === 5) {
          if (validateLineup(cur)) {
            const s = scoreLineup(cur, seg);
            if (s > bestScore) { bestScore = s; best = [...cur]; }
          }
          return;
        }
        for (const p of remaining) {
          if (cur.find(c => c.id === p.id)) continue;
          tryBuild([...cur, p], remaining.filter(x => x.id !== p.id));
          if (best && bestScore > 30) return;
        }
      };
      tryBuild(mustPlay, pool);
      chosen = best || pool.slice(0, 5);
    }

    if (!chosen || chosen.length < 5) chosen = state.filter(p => p.played < p.max).slice(0, 5);

    const onIds = new Set(chosen.map(p => p.id));
    lineups.push({ segment: seg + 1, startMin: seg * segLen, endMin: (seg + 1) * segLen, players: chosen.map(p => p.id) });

    if (seg === segsPerHalf - 1) state.forEach(p => { p.restedThisHalf = false; });
    state.forEach(p => {
      if (onIds.has(p.id)) { p.played += segLen; p.segments.push(seg + 1); p.benchStreak = 0; p.playStreak += 1; }
      else { p.benchStreak += 1; p.playStreak = 0; p.restedThisHalf = true; }
    });
  }

  return { lineups, playTime: state };
}

function mergeSegments(lineups) {
  if (!lineups.length) return [];
  const merged = [];
  let cur = { ...lineups[0] };
  for (let i = 1; i < lineups.length; i++) {
    const s = lineups[i];
    if (cur.players.length === s.players.length && cur.players.every(id => s.players.includes(id))) {
      cur.endMin = s.endMin;
    } else { merged.push(cur); cur = { ...s }; }
  }
  merged.push(cur);
  return merged;
}

// ── Shared styles ───────────────────────────────────────────────────
const inputBase = {
  background: "#0f1117", border: "1px solid #2a2f3e", borderRadius: 6,
  padding: "8px 12px", color: "#e8e4d9", fontSize: 14, fontFamily: "inherit", cursor: "pointer",
};

// ── Stepper ─────────────────────────────────────────────────────────
function Stepper({ value, onChange, min = 0, max = 99, color = "#e8e4d9" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, background: "#0f1117", borderRadius: 8, border: `1.5px solid ${color}50`, overflow: "hidden" }}>
      <button onClick={() => onChange(Math.max(min, value - 1))} style={{
        width: 28, height: 34, background: "transparent", border: "none",
        color: "#555", cursor: "pointer", fontSize: 16, fontFamily: "inherit",
        borderRight: "1px solid #1e2332",
      }}>−</button>
      <div style={{ width: 38, textAlign: "center", fontSize: 15, fontWeight: 700, color, userSelect: "none" }}>{value}</div>
      <button onClick={() => onChange(Math.min(max, value + 1))} style={{
        width: 28, height: 34, background: "transparent", border: "none",
        color: "#555", cursor: "pointer", fontSize: 16, fontFamily: "inherit",
        borderLeft: "1px solid #1e2332",
      }}>+</button>
    </div>
  );
}

// ── Hard/Soft Toggle ────────────────────────────────────────────────
function HardSoftToggle({ value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {[{ val: false, label: "Required", color: "#ef4444" }, { val: true, label: "Preferred", color: "#fbbf24" }].map(opt => (
        <button key={String(opt.val)} onClick={() => onChange(opt.val)} style={{
          padding: "4px 10px", borderRadius: 6,
          border: `1.5px solid ${value === opt.val ? opt.color : "#2a2f3e"}`,
          background: value === opt.val ? opt.color + "22" : "transparent",
          color: value === opt.val ? opt.color : "#444",
          cursor: "pointer", fontSize: 11, fontFamily: "inherit", fontWeight: value === opt.val ? 600 : 400,
        }}>{opt.label}</button>
      ))}
    </div>
  );
}

// ── Budget Meter ────────────────────────────────────────────────────
function BudgetMeter({ players, totalMins }) {
  const available = 5 * totalMins;
  const requested = players.reduce((sum, p) => sum + (p.target || 0), 0);
  const pct = Math.min(requested / available, 1.35);
  const over = requested > available;
  const barColor = requested > available * 1.2 ? "#ef4444" : over ? "#f59e0b" : "#10b981";
  return (
    <div style={{ background: "#1a1f2e", borderRadius: 10, padding: "14px 18px", border: `1px solid ${over ? barColor + "40" : "#10b98130"}`, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: 2, color: "#555", textTransform: "uppercase", marginBottom: 3 }}>Minute Budget</div>
          <div style={{ fontSize: 13, color: "#888" }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: over ? barColor : "#e8e4d9" }}>{requested}</span>
            <span style={{ color: "#444" }}> / {available} available player-minutes</span>
          </div>
        </div>
        <div style={{ fontSize: 12, color: over ? barColor : "#10b981" }}>
          {over ? `⚠ ${Math.abs(requested - available)} min over — planner will smooth` : "✓ Within budget"}
        </div>
      </div>
      <div style={{ height: 6, background: "#0f1117", borderRadius: 3, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: `${(1 / 1.35) * 100}%`, top: 0, bottom: 0, width: 1.5, background: "#2a2f3e", zIndex: 2 }} />
        <div style={{ height: "100%", borderRadius: 3, transition: "width 0.4s ease", background: over ? `linear-gradient(90deg, #10b981 ${(available / (available * 1.35)) * 100}%, ${barColor} 100%)` : barColor, width: `${pct * 100}%` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 10, color: "#3a4050" }}>
        <span>0</span><span style={{ color: "#555" }}>{available} cap</span><span>{Math.round(available * 1.35)}</span>
      </div>
    </div>
  );
}

// ── Save/Load Roster Modal ──────────────────────────────────────────
function RosterModal({ players, rules, onLoad, onClose }) {
  const [rosters, setRosters] = useState(loadRosters());
  const [saveName, setSaveName] = useState("");

  const handleSave = () => {
    if (!saveName.trim()) return;
    const updated = { ...rosters, [saveName.trim()]: { players, rules, savedAt: new Date().toLocaleDateString() } };
    saveRosters(updated);
    setRosters(updated);
    setSaveName("");
  };

  const handleDelete = (name) => {
    const updated = { ...rosters };
    delete updated[name];
    saveRosters(updated);
    setRosters(updated);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000bb", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#1a1f2e", borderRadius: 16, padding: 28, width: "100%", maxWidth: 440, border: "1px solid #2a2f3e" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div style={{ fontSize: 18, fontFamily: "'DM Serif Display',serif" }}>Saved Rosters</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 22 }}>×</button>
        </div>

        {/* Save current */}
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>Save Current Roster</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={saveName} onChange={e => setSaveName(e.target.value)}
              placeholder="e.g. Game vs. Ankeny, Week 6..."
              onKeyDown={e => e.key === "Enter" && handleSave()}
              style={{ ...inputBase, flex: 1, padding: "8px 12px", fontSize: 13 }} />
            <button onClick={handleSave} disabled={!saveName.trim()} style={{
              padding: "8px 16px", borderRadius: 8, border: "none",
              background: saveName.trim() ? "linear-gradient(135deg,#f97316,#ef4444)" : "#1e2332",
              color: saveName.trim() ? "#fff" : "#444",
              cursor: saveName.trim() ? "pointer" : "not-allowed",
              fontSize: 13, fontFamily: "inherit", fontWeight: 600,
            }}>Save</button>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "#3a4050" }}>
            Saves {players.length} players + {rules.length} rules to this device.
          </div>
        </div>

        {/* Saved list */}
        <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Saved</div>
        {Object.keys(rosters).length === 0 ? (
          <div style={{ padding: "20px", textAlign: "center", color: "#3a4050", fontSize: 13 }}>No saved rosters yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 260, overflowY: "auto" }}>
            {Object.entries(rosters).map(([name, data]) => (
              <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#0f1117", borderRadius: 8, padding: "10px 14px", border: "1px solid #2a2f3e" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#e8e4d9" }}>{name}</div>
                  <div style={{ fontSize: 11, color: "#555" }}>{data.players?.length} players · {data.rules?.length} rules · saved {data.savedAt}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => { onLoad(data.players, data.rules); onClose(); }} style={{
                    padding: "5px 12px", borderRadius: 6, border: "1px solid #f9731640",
                    background: "#f9731615", color: "#f97316",
                    cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                  }}>Load</button>
                  <button onClick={() => handleDelete(name)} style={{
                    padding: "5px 10px", borderRadius: 6, border: "1px solid #2a2f3e",
                    background: "transparent", color: "#444",
                    cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                  }}>×</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Game Config ─────────────────────────────────────────────────────
function GameConfig({ onStart }) {
  const [format, setFormat] = useState("halves");
  const [periodMins, setPeriodMins] = useState(20);
  const [rosterSize, setRosterSize] = useState(8);
  const totalMins = format === "halves" ? periodMins * 2 : periodMins * 4;
  const periods = format === "halves" ? 2 : 4;

  return (
    <div style={{ minHeight: "100vh", background: "#0f1117", fontFamily: "'DM Sans',sans-serif", color: "#e8e4d9" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');*{box-sizing:border-box;margin:0;padding:0;}body{background:#0f1117;}input::-webkit-inner-spin-button{-webkit-appearance:none;}`}</style>
      
      {/* Header */}
      <div style={{ borderBottom: "1px solid #2a2f3e", padding: "20px 40px", display: "flex", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: 4, color: "#f97316", textTransform: "uppercase", marginBottom: 2 }}>Waukee Jam</div>
          <div style={{ fontSize: 24, fontFamily: "'DM Serif Display',serif", letterSpacing: -0.5 }}>Rotation Planner</div>
        </div>
      </div>

      <div style={{ maxWidth: 960, margin: "0 auto", padding: "48px 40px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 48, alignItems: "start" }}>
        {/* Left: title + description */}
        <div>
          <div style={{ fontSize: 11, letterSpacing: 3, color: "#f97316", textTransform: "uppercase", marginBottom: 16 }}>Game Setup</div>
          <div style={{ fontSize: 42, fontFamily: "'DM Serif Display',serif", letterSpacing: -1, lineHeight: 1.1, marginBottom: 20 }}>Build your rotation in minutes.</div>
          <div style={{ fontSize: 15, color: "#555", lineHeight: 1.7 }}>
            Configure your game format, set target minutes per player, add any conditional rules, and generate an optimized rotation plan — ready to print or share.
          </div>
          <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 12 }}>
            {[["⚙ Setup", "Name players and set target minutes"], ["📋 Rules", "Add optional conditional rules"], ["📊 Plan", "Generate and export your rotation"]].map(([step, desc]) => (
              <div key={step} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ fontSize: 13, color: "#f97316", fontWeight: 600, width: 80 }}>{step}</div>
                <div style={{ fontSize: 13, color: "#444" }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: config form */}
        <div style={{ background: "#1a1f2e", borderRadius: 16, padding: 32, border: "1px solid #2a2f3e" }}>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 24 }}>Configure your game</div>

          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: "#666", letterSpacing: 2, textTransform: "uppercase", marginBottom: 12 }}>Game Format</div>
          <div style={{ display: "flex", gap: 10 }}>
            {[["halves", "2 Halves"], ["quarters", "4 Quarters"]].map(([val, label]) => (
              <button key={val} onClick={() => { setFormat(val); setPeriodMins(val === "halves" ? 20 : 8); }} style={{ flex: 1, padding: "14px", borderRadius: 10, border: `2px solid ${format === val ? "#f97316" : "#2a2f3e"}`, background: format === val ? "#f9731618" : "#1a1f2e", color: format === val ? "#f97316" : "#666", cursor: "pointer", fontSize: 15, fontFamily: "inherit", fontWeight: 600 }}>{label}</button>
            ))}
          </div>
        </div>

          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: "#666", letterSpacing: 2, textTransform: "uppercase", marginBottom: 12 }}>{format === "halves" ? "Minutes Per Half" : "Minutes Per Quarter"}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(format === "halves" ? [15, 18, 20, 25] : [6, 8, 10, 12]).map(m => (
              <button key={m} onClick={() => setPeriodMins(m)} style={{ flex: "1 1 60px", padding: "12px 8px", borderRadius: 8, border: `2px solid ${periodMins === m ? "#8b5cf6" : "#2a2f3e"}`, background: periodMins === m ? "#8b5cf618" : "#1a1f2e", color: periodMins === m ? "#8b5cf6" : "#555", cursor: "pointer", fontSize: 16, fontFamily: "inherit", fontWeight: 700 }}>{m}</button>
            ))}
            <div style={{ flex: "1 1 80px", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Stepper value={periodMins} onChange={setPeriodMins} min={1} max={60} color="#8b5cf6" />
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "#555" }}>Total: <span style={{ color: "#f97316", fontWeight: 600 }}>{totalMins} min</span> ({periods} × {periodMins} min)</div>
        </div>

          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, color: "#666", letterSpacing: 2, textTransform: "uppercase", marginBottom: 12 }}>Players on Roster Today</div>
          <div style={{ display: "flex", gap: 8 }}>
            {[6, 7, 8, 9, 10].map(n => (
              <button key={n} onClick={() => setRosterSize(n)} style={{ flex: 1, padding: "12px 8px", borderRadius: 8, border: `2px solid ${rosterSize === n ? "#10b981" : "#2a2f3e"}`, background: rosterSize === n ? "#10b98118" : "#1a1f2e", color: rosterSize === n ? "#10b981" : "#555", cursor: "pointer", fontSize: 16, fontFamily: "inherit", fontWeight: 700 }}>{n}</button>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "#555" }}>{rosterSize < 5 ? <span style={{ color: "#ef4444" }}>Need at least 5 players.</span> : `${rosterSize} players · ${rosterSize - 5} on bench at a time`}</div>
        </div>

          <button onClick={() => onStart({ format, periodMins, totalMins, periods, rosterSize })} disabled={rosterSize < 5} style={{ width: "100%", padding: "16px", background: rosterSize >= 5 ? "linear-gradient(135deg,#f97316,#ef4444)" : "#1e2332", border: "none", borderRadius: 12, color: rosterSize >= 5 ? "#fff" : "#444", fontSize: 16, fontFamily: "inherit", fontWeight: 700, cursor: rosterSize >= 5 ? "pointer" : "not-allowed", boxShadow: rosterSize >= 5 ? "0 4px 24px #f9731440" : "none" }}>Set Up Roster →</button>
        </div>
      </div>
    </div>
  );
}

// ── Main App ────────────────────────────────────────────────────────
export default function App() {
  const [gameConfig, setGameConfig] = useState(null);
  const [tab, setTab] = useState("setup");
  const [players, setPlayers] = useState([]);
  const [rules, setRules] = useState([]);
  const [plan, setPlan] = useState(null);
  const [nextRuleId, setNextRuleId] = useState(1);
  const [showRosterModal, setShowRosterModal] = useState(false);
  const [copyConfirm, setCopyConfirm] = useState(false);

  const handleStart = (config) => {
    setGameConfig(config);
    setPlayers(makeDefaultPlayers(config.rosterSize, config.totalMins));
    setRules([]);
    setPlan(null);
    setTab("setup");
  };

  if (!gameConfig) return <GameConfig onStart={handleStart} />;

  const { totalMins, periods, periodMins, format } = gameConfig;
  const totalSegs = Math.floor(totalMins / bestSegLen(totalMins));
  const starterCount = players.filter(p => p.starter).length;
  const canGenerate = starterCount === 5 && players.length >= 5;

  const updatePlayer = (id, field, val) => setPlayers(ps => ps.map(p => p.id === id ? { ...p, [field]: val } : p));
  const toggleStarter = (id) => {
    const p = players.find(p => p.id === id);
    if (!p.starter && starterCount >= 5) return;
    updatePlayer(id, "starter", !p.starter);
  };
  const removePlayer = (id) => setPlayers(ps => ps.filter(p => p.id !== id));

  const addRule = (type = RULE_TYPES.ONLY_REST_IF) => {
    setRules(rs => [...rs, { id: nextRuleId, type, playerId: players[0]?.id, targetIds: [players[1]?.id].filter(Boolean), soft: false }]);
    setNextRuleId(n => n + 1);
  };
  const updateRule = (id, field, val) => setRules(rs => rs.map(r => r.id === id ? { ...r, [field]: val } : r));
  const removeRule = (id) => setRules(rs => rs.filter(r => r.id !== id));

  const generate = () => { setPlan(generateRotation(players, rules, totalMins, bestSegLen(totalMins))); setTab("plan"); };

  const pName = (id) => players.find(p => p.id === id)?.name || "?";
  const pColor = (id) => players.find(p => p.id === id)?.color || "#888";

  const copyPlanAsText = () => {
    if (!plan) return;
    const merged = mergeSegments(plan.lineups);
    const lines = [`Waukee Jam — Rotation Plan`, `${periods} ${format} × ${periodMins} min | ${totalMins} min total`, ``];
    lines.push(`STARTING FIVE: ${(plan.lineups[0]?.players || []).map(pName).join(", ")}`);
    lines.push(`CLOSING FIVE:  ${(plan.lineups[plan.lineups.length - 1]?.players || []).map(pName).join(", ")}`);
    lines.push(``);
    lines.push(`MINUTES:`);
    plan.playTime.forEach(p => {
      const player = players.find(pl => pl.id === p.id);
      lines.push(`  ${player.name.padEnd(12)} ${p.played} min (target ${p.target})`);
    });
    lines.push(``);
    lines.push(`ROTATION:`);
    merged.forEach(seg => {
      lines.push(`  ${String(seg.startMin).padStart(2)}′–${String(seg.endMin).padStart(2)}′  ${seg.players.map(pName).join(", ")}`);
    });
    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopyConfirm(true);
      setTimeout(() => setCopyConfirm(false), 2000);
    });
  };

  return (
    <>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap');*{box-sizing:border-box;margin:0;padding:0;}body{background:#0f1117;}input::-webkit-inner-spin-button{-webkit-appearance:none;}@media print{.no-print{display:none!important;}body,html{background:white!important;color:#111!important;}}`}</style>

      {showRosterModal && (
        <RosterModal players={players} rules={rules}
          onLoad={(p, r) => { setPlayers(p); setRules(r); setPlan(null); }}
          onClose={() => setShowRosterModal(false)} />
      )}

      <div style={{ minHeight: "100vh", background: "#0f1117", fontFamily: "'DM Sans',sans-serif", color: "#e8e4d9" }}>
        <div className="no-print" style={{ background: "linear-gradient(135deg,#1a1f2e,#0f1117)", borderBottom: "1px solid #2a2f3e", padding: "13px 22px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div>
              <div style={{ fontSize: 9, letterSpacing: 4, color: "#f97316", textTransform: "uppercase", marginBottom: 1 }}>Waukee Jam</div>
              <div style={{ fontSize: 20, fontFamily: "'DM Serif Display',serif", letterSpacing: -0.5 }}>Rotation Planner</div>
            </div>
            <div style={{ fontSize: 11, color: "#555", borderLeft: "1px solid #2a2f3e", paddingLeft: 14, lineHeight: 1.6 }}>
              <div style={{ color: "#888" }}>{periods} {format === "halves" ? "halves" : "quarters"} × {periodMins} min</div>
              <div>{totalMins} min · {players.length} players</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
            <button onClick={() => setShowRosterModal(true)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #2a2f3e", background: "transparent", color: "#888", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>💾 Rosters</button>
            <button onClick={() => setGameConfig(null)} style={{ padding: "6px 11px", borderRadius: 6, border: "1px solid #2a2f3e", background: "transparent", color: "#555", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>↩ New Game</button>
            {[["setup", "⚙ Setup"], ["rules", "📋 Rules"], ["plan", "📊 Plan"]].map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${tab === key ? "#f97316" : "#2a2f3e"}`, background: tab === key ? "#f9731618" : "transparent", color: tab === key ? "#f97316" : "#555", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>{label}</button>
            ))}
            {plan && tab === "plan" && (
              <>
                <button onClick={copyPlanAsText} style={{ padding: "7px 13px", borderRadius: 8, border: "1px solid #8b5cf640", background: copyConfirm ? "#8b5cf620" : "transparent", color: copyConfirm ? "#10b981" : "#8b5cf6", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>{copyConfirm ? "✓ Copied!" : "📋 Copy"}</button>
                <button onClick={() => window.print()} style={{ padding: "7px 15px", borderRadius: 8, background: "linear-gradient(135deg,#f97316,#ef4444)", border: "none", color: "#fff", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600, boxShadow: "0 2px 12px #f9731440" }}>⬇ Export</button>
              </>
            )}
          </div>
        </div>

        <div style={{ maxWidth: 960, margin: "0 auto", padding: "20px 18px" }}>

          {/* SETUP */}
          {tab === "setup" && (
            <div>
              <BudgetMeter players={players} totalMins={totalMins} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase" }}>Roster</div>
                <div style={{ fontSize: 12, color: starterCount === 5 ? "#10b981" : "#f59e0b", fontWeight: 600 }}>
                  {starterCount}/5 starters {starterCount < 5 ? "— tap ☆ to select" : "✓ set"}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {players.map((p, i) => {
                  const { min, max } = bounds(p.target);
                  return (
                    <div key={p.id} style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr) auto 100px 90px 28px", gap: 8, alignItems: "center", background: "#1a1f2e", padding: "10px 13px", borderRadius: 10, borderLeft: `3px solid ${p.starter ? p.color : "#2a2f3e"}`, transition: "border-color 0.2s" }}>
                      <div style={{ width: 25, height: 25, borderRadius: "50%", background: p.color + "25", border: `1.5px solid ${p.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: p.color }}>{i + 1}</div>
                      <input value={p.name} onChange={e => updatePlayer(p.id, "name", e.target.value)} style={{ background: "#0f1117", border: "1px solid #2a2f3e", borderRadius: 6, padding: "5px 9px", color: "#e8e4d9", fontSize: 13, fontFamily: "inherit", minWidth: 0 }} />
                      <Stepper value={p.target} onChange={val => updatePlayer(p.id, "target", Math.max(0, Math.min(totalMins, val)))} min={0} max={totalMins} color={p.color} />
                      <div style={{ fontSize: 10, color: "#3a4050", lineHeight: 1.5 }}>
                        <span style={{ color: "#10b981" }}>{min}</span>–<span style={{ color: "#f97316" }}>{max}</span>
                        <span style={{ color: "#3a4050" }}> min range</span>
                      </div>
                      <button onClick={() => toggleStarter(p.id)} style={{ padding: "6px 0", borderRadius: 20, width: "100%", border: `1.5px solid ${p.starter ? "#fbbf24" : "#2a2f3e"}`, background: p.starter ? "#fbbf2420" : "transparent", color: p.starter ? "#fbbf24" : "#444", cursor: (p.starter || starterCount < 5) ? "pointer" : "not-allowed", fontSize: 11, fontFamily: "inherit", fontWeight: 600, textAlign: "center" }}>{p.starter ? "★ Starter" : "☆ Bench"}</button>
                      <button onClick={() => removePlayer(p.id)} style={{ background: "none", border: "none", color: "#3a4050", cursor: "pointer", fontSize: 16, padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 9, fontSize: 11, color: "#3a4050" }}>
                Use +/− to set target minutes · tolerance ±8% · starters close the game
              </div>
            </div>
          )}

          {/* RULES */}
          {tab === "rules" && (
            <div>
              <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 14 }}>Conditional Rules</div>

              {/* Hard/Soft legend */}
              <div style={{ display: "flex", gap: 20, marginBottom: 14, padding: "10px 14px", background: "#1a1f2e", borderRadius: 8, flexWrap: "wrap", alignItems: "center" }}>
                {[{ color: "#ef4444", label: "Required", desc: "always enforced, lineup rejected if violated" }, { color: "#fbbf24", label: "Preferred", desc: "strong preference, planner tries its best" }].map(({ color, label, desc }) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
                    <span style={{ fontSize: 11, color, fontWeight: 600 }}>{label}</span>
                    <span style={{ fontSize: 11, color: "#555" }}>— {desc}</span>
                  </div>
                ))}
              </div>

              {/* Rule templates — shown only when no rules exist */}
              {rules.length === 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Quick Start</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {RULE_TEMPLATES.map(t => (
                      <button key={t.type} onClick={() => addRule(t.type)} style={{ textAlign: "left", padding: "10px 14px", background: "#1a1f2e", border: "1px dashed #2a2f3e", borderRadius: 9, color: "#888", cursor: "pointer", fontFamily: "inherit" }}>
                        <div style={{ fontSize: 13, color: "#e8e4d9", fontWeight: 500, marginBottom: 2 }}>+ {t.label}</div>
                        <div style={{ fontSize: 11, color: "#555" }}>{t.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {rules.map(rule => {
                  const isAlwaysSoft = ALWAYS_SOFT.has(rule.type);
                  const effectivelySoft = isAlwaysSoft || rule.soft;
                  const accentColor = effectivelySoft ? "#fbbf24" : "#ef4444";
                  return (
                    <div key={rule.id} style={{ background: "#1a1f2e", borderRadius: 10, padding: "14px 16px", border: `1px solid ${accentColor}30` }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          {!isAlwaysSoft ? (
                            <HardSoftToggle value={rule.soft} onChange={val => updateRule(rule.id, "soft", val)} />
                          ) : (
                            <div style={{ padding: "4px 10px", borderRadius: 6, border: "1.5px solid #fbbf2440", background: "#fbbf2415", color: "#fbbf24", fontSize: 11, fontWeight: 600 }}>Preferred</div>
                          )}
                          <select value={rule.playerId} onChange={e => updateRule(rule.id, "playerId", +e.target.value)} style={inputBase}>
                            {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <select value={rule.type} onChange={e => updateRule(rule.id, "type", e.target.value)} style={{ ...inputBase, minWidth: 230 }}>
                            {Object.entries(RULE_LABELS).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                          </select>
                          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                            {players.filter(p => p.id !== rule.playerId).map(p => {
                              const on = rule.targetIds?.includes(p.id);
                              return (
                                <button key={p.id} onClick={() => { const cur = rule.targetIds || []; updateRule(rule.id, "targetIds", on ? cur.filter(id => id !== p.id) : [...cur, p.id]); }} style={{ padding: "4px 10px", borderRadius: 20, border: `1.5px solid ${on ? p.color : "#2a2f3e"}`, background: on ? p.color + "22" : "transparent", color: on ? p.color : "#444", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>{p.name}</button>
                              );
                            })}
                          </div>
                        </div>
                        <button onClick={() => removeRule(rule.id)} style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 20 }}>×</button>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 11, fontStyle: "italic", color: effectivelySoft ? "#a08040" : "#666" }}>
                        {rulePreview(rule, pName)}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button onClick={() => addRule()} style={{ marginTop: 10, padding: "11px", background: "transparent", border: "1px dashed #2a2f3e", borderRadius: 10, color: "#555", cursor: "pointer", fontSize: 13, fontFamily: "inherit", width: "100%" }}>+ Add Rule</button>
            </div>
          )}

          {/* PLAN */}
          {tab === "plan" && (
            <div>
              {!plan ? (
                <div style={{ textAlign: "center", padding: 80, color: "#3a4050" }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
                  <div style={{ marginBottom: 20 }}>Generate a rotation plan to see it here.</div>
                  <button onClick={generate} disabled={!canGenerate} style={{ padding: "12px 28px", background: canGenerate ? "linear-gradient(135deg,#f97316,#ef4444)" : "#1e2332", border: "none", borderRadius: 10, color: canGenerate ? "#fff" : "#444", fontSize: 15, fontFamily: "inherit", cursor: canGenerate ? "pointer" : "not-allowed", fontWeight: 600, boxShadow: canGenerate ? "0 4px 18px #f9731440" : "none" }}>Generate Rotation Plan →</button>
                  {!canGenerate && <div style={{ marginTop: 10, fontSize: 12, color: "#f59e0b" }}>⚠ Select exactly 5 starters in Setup first</div>}
                </div>
              ) : (
                <>
                  <PlanView plan={plan} players={players} rules={rules} pName={pName} pColor={pColor}
                    totalSegs={totalSegs} totalMins={totalMins} periods={periods} periodMins={periodMins} format={format} segLen={bestSegLen(totalMins)} />
                  <div style={{ marginTop: 20, display: "flex", justifyContent: "center" }}>
                    <button onClick={generate} style={{ padding: "11px 28px", background: "linear-gradient(135deg,#f97316,#ef4444)", border: "none", borderRadius: 10, color: "#fff", fontSize: 14, fontFamily: "inherit", cursor: "pointer", fontWeight: 600, boxShadow: "0 4px 18px #f9731440" }}>↺ Regenerate</button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab !== "plan" && (
            <div className="no-print" style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 }}>
              {starterCount !== 5 && <span style={{ fontSize: 12, color: "#f59e0b" }}>⚠ Select exactly 5 starters</span>}
              {players.length < 5 && <span style={{ fontSize: 12, color: "#ef4444" }}>⚠ Need at least 5 players</span>}
              <button onClick={generate} disabled={!canGenerate} style={{ padding: "11px 26px", background: canGenerate ? "linear-gradient(135deg,#f97316,#ef4444)" : "#1e2332", border: "none", borderRadius: 10, color: canGenerate ? "#fff" : "#444", fontSize: 14, fontFamily: "inherit", cursor: canGenerate ? "pointer" : "not-allowed", fontWeight: 600, transition: "all 0.2s", boxShadow: canGenerate ? "0 4px 18px #f9731440" : "none" }}>Generate Rotation Plan →</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Plan View ───────────────────────────────────────────────────────
function PlanView({ plan, players, rules, pName, pColor, totalSegs, totalMins, periods, periodMins, format, segLen }) {
  const merged = mergeSegments(plan.lineups);
  const minsPerPeriod = totalMins / periods;
  const periodGroups = Array.from({ length: periods }, (_, i) => ({
    label: format === "halves" ? (i === 0 ? "1st Half" : "2nd Half") : `Q${i + 1}`,
    segs: merged.filter(s => s.startMin >= i * minsPerPeriod && s.startMin < (i + 1) * minsPerPeriod),
  }));

  const startingFive = plan.lineups[0]?.players || [];
  const closingFive = plan.lineups[plan.lineups.length - 1]?.players || [];
  const violations = plan.playTime.filter(p => { const { min, max } = bounds(p.target); return p.played < min || p.played > max; });

  const softRuleSummary = rules.filter(r => r.soft || ALWAYS_SOFT.has(r.type)).map(rule => {
    const ids = [rule.playerId, ...(rule.targetIds || [])];
    const segsHonored = plan.lineups.filter(l => {
      const onIds = new Set(l.players);
      if (rule.type === RULE_TYPES.ONLY_PLAY_IF_ALL) return !onIds.has(rule.playerId) || rule.targetIds.every(id => onIds.has(id));
      if (rule.type === RULE_TYPES.MAXIMIZE_TOGETHER) return ids.every(id => onIds.has(id));
      return true;
    }).length;
    return { rule, pct: Math.round((segsHonored / plan.lineups.length) * 100), names: ids.map(pName) };
  });

  return (
    <div>
      {/* Starting / Closing Five */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
        {[["★ Starting Five", startingFive, "#fbbf24"], ["⏱ Closing Five", closingFive, "#10b981"]].map(([label, five, accent]) => (
          <div key={label} style={{ background: "linear-gradient(135deg,#1a1f2e,#1c2130)", borderRadius: 12, padding: "13px 16px", border: `1px solid ${accent}30` }}>
            <div style={{ fontSize: 10, letterSpacing: 3, color: accent, textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {five.map(id => <div key={id} style={{ padding: "5px 13px", borderRadius: 24, background: pColor(id) + "25", border: `2px solid ${pColor(id)}`, color: pColor(id), fontWeight: 600, fontSize: 12 }}>{pName(id)}</div>)}
            </div>
          </div>
        ))}
      </div>

      {/* Soft rule compliance */}
      {softRuleSummary.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 10, color: "#fbbf24", letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>✦ Soft Rule Results</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {softRuleSummary.map((item, i) => (
              <div key={i} style={{ background: "#1a1f2e", borderRadius: 10, padding: "10px 14px", border: "1px solid #fbbf2430", flex: "1 1 200px" }}>
                <div style={{ fontSize: 10, color: "#fbbf24", fontWeight: 600, marginBottom: 3 }}>{rulePreviewShort(item.rule, pName)}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: item.pct >= 80 ? "#10b981" : item.pct >= 60 ? "#f59e0b" : "#ef4444", lineHeight: 1 }}>{item.pct}<span style={{ fontSize: 11, color: "#555" }}>% honored</span></div>
                <div style={{ marginTop: 5, height: 3, background: "#0f1117", borderRadius: 2 }}>
                  <div style={{ height: 3, borderRadius: 2, background: item.pct >= 80 ? "#10b981" : item.pct >= 60 ? "#f59e0b" : "#ef4444", width: `${item.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Minutes summary */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Minutes Summary</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {plan.playTime.map(p => {
            const player = players.find(pl => pl.id === p.id);
            const { min, max } = bounds(p.target);
            const ok = p.played >= min && p.played <= max;
            const diff = p.played - p.target;
            return (
              <div key={p.id} style={{ background: "#1a1f2e", borderRadius: 10, padding: "10px 12px", borderLeft: `3px solid ${player.color}`, minWidth: 115, flex: "1 1 115px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 3 }}>{player.name}{player.starter && <span style={{ marginLeft: 4, fontSize: 8, color: "#fbbf24" }}>★</span>}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: ok ? "#e8e4d9" : "#ef4444", lineHeight: 1 }}>{p.played}</div>
                  <div style={{ fontSize: 10, color: "#555" }}>/ <span style={{ color: player.color }}>{p.target}</span></div>
                </div>
                <div style={{ fontSize: 10, color: ok ? "#555" : "#f59e0b", marginTop: 1 }}>{diff === 0 ? "on target" : diff > 0 ? `+${diff}m` : `${diff}m`} · {min}–{max}</div>
                <div style={{ marginTop: 5, height: 3, background: "#0f1117", borderRadius: 2, position: "relative" }}>
                  <div style={{ height: 3, borderRadius: 2, background: ok ? player.color : "#f59e0b", width: `${Math.min(100, (p.played / max) * 100)}%` }} />
                  <div style={{ position: "absolute", top: -2, width: 2, height: 7, background: player.color, borderRadius: 1, opacity: 0.9, left: `${Math.min(100, (p.target / max) * 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        {violations.length > 0 && (
          <div style={{ marginTop: 8, padding: "7px 12px", background: "#ef444412", border: "1px solid #ef444428", borderRadius: 8, fontSize: 11, color: "#ef4444" }}>
            ⚠ Outside tolerance: {violations.map(p => players.find(pl => pl.id === p.id)?.name).join(", ")} — try relaxing targets or softening rules
          </div>
        )}
      </div>

      {/* Rotation by period */}
      <div style={{ display: "grid", gridTemplateColumns: periods <= 2 ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 14, marginBottom: 20 }}>
        {periodGroups.map(({ label, segs }) => (
          <div key={label}>
            <div style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {segs.map((seg, i) => (
                <div key={i}>
                  <div style={{ fontSize: 10, color: "#444", marginBottom: 3 }}>{seg.startMin}′–{seg.endMin}′</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {players.map(p => {
                      const on = seg.players.includes(p.id);
                      return <div key={p.id} style={{ padding: "3px 9px", borderRadius: 20, background: on ? p.color + "28" : "transparent", border: `1px solid ${on ? p.color : "#1e2332"}`, color: on ? p.color : "#252d3d", fontSize: 11, fontWeight: on ? 600 : 400 }}>{p.name}</div>;
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Visual timeline */}
      <div>
        <div style={{ fontSize: 10, color: "#555", letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>
          Visual Timeline · each block = {segLen} min · <span style={{ color: "#10b981" }}>closing stretch reserved for starters</span>
        </div>
        {plan.playTime.map(p => {
          const segsOn = new Set(p.segments);
          const player = players.find(pl => pl.id === p.id);
          const closingStart = totalSegs - 1;
          return (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <div style={{ width: 68, fontSize: 10, textAlign: "right", color: player.color, fontWeight: 600 }}>{player.name}</div>
              <div style={{ display: "flex", gap: 1.5, flex: 1 }}>
                {Array.from({ length: totalSegs }, (_, i) => {
                  const playing = segsOn.has(i + 1);
                  const isPeriodBreak = (i + 1) % (totalSegs / periods) === 0 && i < totalSegs - 1;
                  const isClosingZone = i >= closingStart;
                  return <div key={i} style={{ flex: 1, height: 18, borderRadius: 3, background: playing ? player.color : isClosingZone ? "#1e2a1e" : "#1a1f2e", marginRight: isPeriodBreak ? 5 : 0, outline: isClosingZone && !playing ? "1px solid #10b98122" : "none" }} />;
                })}
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
          <div style={{ width: 68 }} />
          <div style={{ display: "flex", justifyContent: "space-between", flex: 1, fontSize: 9, color: "#2a3040" }}>
            {Array.from({ length: periods + 1 }, (_, i) => <span key={i}>{i * periodMins}′</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function rulePreview(rule, pName) {
  const name = pName(rule.playerId);
  const targets = (rule.targetIds || []).map(pName).join(" & ");
  const softTag = rule.soft && !ALWAYS_SOFT.has(rule.type) ? " (preferred)" : "";
  if (!targets) return "Select target players →";
  switch (rule.type) {
    case RULE_TYPES.ONLY_REST_IF:      return `"${name} can only sit if ${targets} is on the floor."${softTag}`;
    case RULE_TYPES.ONLY_PLAY_IF_ALL:  return `"${name} only plays when ${targets} are both on the floor."${softTag}`;
    case RULE_TYPES.NEVER_TOGETHER:    return `"${name} and ${targets} are never on the floor at the same time."${softTag}`;
    case RULE_TYPES.ALWAYS_TOGETHER:   return `"${name} and ${targets} are always on the floor together."${softTag}`;
    case RULE_TYPES.MAXIMIZE_TOGETHER: return `The planner will try to keep ${name} and ${targets} on the floor together as much as possible.`;
    default: return "";
  }
}

function rulePreviewShort(rule, pName) {
  const name = pName(rule.playerId);
  const targets = (rule.targetIds || []).map(pName).join(" + ");
  switch (rule.type) {
    case RULE_TYPES.ONLY_REST_IF:      return `${name} rests only if ${targets} plays`;
    case RULE_TYPES.ONLY_PLAY_IF_ALL:  return `${name} plays with ${targets}`;
    case RULE_TYPES.NEVER_TOGETHER:    return `${name} not with ${targets}`;
    case RULE_TYPES.ALWAYS_TOGETHER:   return `${name} always with ${targets}`;
    case RULE_TYPES.MAXIMIZE_TOGETHER: return `${name} + ${targets} together`;
    default: return "";
  }
}
