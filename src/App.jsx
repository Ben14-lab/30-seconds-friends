import { useState, useEffect, useRef } from "react";
import {
  Check,
  X,
  Plus,
  Trash2,
  Play,
  Trophy,
  RotateCcw,
  Users,
  Sparkles,
  Loader2,
  Crown,
  Eye,
  EyeOff,
  Copy,
  Check as CheckIcon,
} from "lucide-react";
import { supabase } from "./supabaseClient";

const TEAM_COLORS = ["#22C55E", "#38BDF8", "#FACC15", "#F87171", "#A78BFA", "#FB923C"];
const ROUND_SECONDS = 30;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeId() {
  return `p-${Math.random().toString(36).slice(2, 9)}`;
}
function genRoomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  return s;
}
function getRoomFromUrl() {
  return new URLSearchParams(window.location.search).get("room");
}
function setRoomInUrl(code) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  window.history.replaceState({}, "", url);
}

// Players on a team, in a stable order (by id) so rotation is consistent for everyone.
function teamMembersStable(players, teamIdx) {
  return players.filter((p) => p.teamIdx === teamIdx).sort((a, b) => a.id.localeCompare(b.id));
}
// Who should explain for this team, given how many rounds the team has already done.
function pickExplainer(players, teamIdx, turnCount) {
  const members = teamMembersStable(players, teamIdx);
  if (members.length === 0) return null;
  return members[turnCount % members.length].id;
}

// ---- Sound (Web Audio, no files needed) ----
let audioCtx = null;
function getAudioCtx() {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  return audioCtx;
}
function playTone(freq, durationMs, type = "sine", gainValue = 0.06) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainValue, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
}
// A soft, dull clock tick (tik-tak). Low sine tones, quiet, slight pitch rise near the end.
function playClockTick(timeLeft) {
  const ratio = Math.max(0, Math.min(1, (ROUND_SECONDS - timeLeft) / ROUND_SECONDS)); // 0 start -> ~1 end
  const baseFreq = 150 + ratio * 90; // 150Hz -> ~240Hz, low and woody
  // tik vs tak: alternate slightly so it sounds like a real clock
  const altFreq = timeLeft % 2 === 0 ? baseFreq : baseFreq * 1.12;
  const dur = 45;
  const gain = 0.025 + ratio * 0.02; // quiet, barely louder near the end
  playTone(altFreq, dur, "sine", gain);
}
function playEndChime() {
  playTone(523, 200, "sine", 0.06);
  setTimeout(() => playTone(659, 260, "sine", 0.06), 150);
  setTimeout(() => playTone(784, 420, "sine", 0.06), 340);
}

// Make a soft translucent version of a #rrggbb color for backgrounds.
function hexToSoftBg(hex, alpha = 0.14) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  if (!m) return "rgba(34,197,94,0.14)";
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// The set of teams currently in play: everyone normally, or only the tied leaders in a tiebreak.
function activeTeamIdxs(state) {
  if (state.tiebreakTeams && state.tiebreakTeams.length > 0) return state.tiebreakTeams;
  return state.teams.map((_, i) => i);
}

// Given the just-finished team, decide the next state after a turn ends.
// Rules:
//  - A "round" = every active team has had an equal number of turns.
//  - The game only ends at the END of a round (so everyone gets equal turns).
//  - If at round end one team leads alone AND someone reached target -> game over.
//  - If tied at the top at round end (and target reached) -> tiebreak among the tied leaders.
function computeNextTurn(latest) {
  const active = activeTeamIdxs(latest);
  const finishedTeam = latest.currentTeamIdx;
  const newCounts = { ...latest.teamTurnCounts, [finishedTeam]: (latest.teamTurnCounts[finishedTeam] || 0) + 1 };

  // position of finished team within the active order
  const pos = active.indexOf(finishedTeam);
  const isRoundComplete = pos === active.length - 1; // last active team just finished

  const scoreOf = (i) => latest.scores[i] || 0;

  if (isRoundComplete) {
    // Did anyone reach the target?
    const reached = active.some((i) => scoreOf(i) >= latest.target);
    if (reached) {
      // Find the top score among active teams and who shares it.
      const top = Math.max(...active.map(scoreOf));
      const leaders = active.filter((i) => scoreOf(i) === top);
      if (leaders.length === 1) {
        return { ...latest, status: "gameOver", teamTurnCounts: newCounts };
      }
      // Tie at the top -> play a tiebreak among the tied leaders only.
      const firstTb = leaders[0];
      return {
        ...latest,
        status: "turn",
        tiebreakTeams: leaders,
        teamTurnCounts: newCounts,
        currentTeamIdx: firstTb,
        designatedExplainerId: pickExplainer(latest.players, firstTb, newCounts[firstTb] || 0),
        ...resetRoundFields(),
      };
    }
    // No one reached target yet -> continue with next full round, starting from the first active team.
    const firstActive = active[0];
    return {
      ...latest,
      status: "turn",
      teamTurnCounts: newCounts,
      currentTeamIdx: firstActive,
      designatedExplainerId: pickExplainer(latest.players, firstActive, newCounts[firstActive] || 0),
      ...resetRoundFields(),
    };
  }

  // Round not complete yet -> move to the next active team.
  const nextTeam = active[pos + 1];
  return {
    ...latest,
    status: "turn",
    teamTurnCounts: newCounts,
    currentTeamIdx: nextTeam,
    designatedExplainerId: pickExplainer(latest.players, nextTeam, newCounts[nextTeam] || 0),
    ...resetRoundFields(),
  };
}

function resetRoundFields() {
  return {
    explainerId: null,
    explainerName: null,
    roundEndsAt: null,
    liveCorrectCount: 0,
    lastCorrectWord: null,
    roundCorrectWords: [],
    roundAllWords: [],
  };
}

const DEFAULT_STATE = {
  status: "lobby", // lobby | turn | playing | marking | roundEnd | gameOver
  hostId: null,
  teamMode: "choose", // "choose" = players pick their own team | "random" = host shuffles
  teams: [],
  target: 20,
  players: [],
  scores: {},
  currentTeamIdx: 0,
  teamTurnCounts: {}, // teamIdx -> how many rounds this team has done, for explainer rotation
  tiebreakTeams: null, // null = normal play; otherwise array of teamIdx still tied and playing it out
  designatedExplainerId: null, // the player the app picked to explain this round
  explainerId: null,
  explainerName: null,
  roundEndsAt: null,
  liveCorrectCount: 0,
  lastCorrectWord: null,
  roundCorrectWords: [],
  roundAllWords: [], // [{ word, correct }] — full reveal after marking
  remainingWords: [],
  wordBank: [],
  words: [],
};

async function fetchRoom(code) {
  try {
    const { data, error } = await supabase.from("game_rooms").select("state").eq("code", code).maybeSingle();
    if (error || !data) return null;
    return { ...DEFAULT_STATE, ...data.state };
  } catch {
    return null;
  }
}
async function ensureRoom(code) {
  const existing = await fetchRoom(code);
  if (existing) return existing;
  const initial = { ...DEFAULT_STATE };
  try {
    await supabase.from("game_rooms").insert({ code, state: initial });
  } catch {
    // ignore; another client may have created it at the same moment
  }
  return (await fetchRoom(code)) || initial;
}
// read-merge-write: mutator receives latest state, returns next state
async function updateRoom(code, mutator) {
  try {
    const latest = (await fetchRoom(code)) || { ...DEFAULT_STATE };
    const next = mutator(latest);
    const { error } = await supabase
      .from("game_rooms")
      .update({ state: next, updated_at: new Date().toISOString() })
      .eq("code", code);
    if (error) return null;
    return next;
  } catch {
    return null;
  }
}

export default function App() {
  const [myId] = useState(makeId);
  const [myNameDraft, setMyNameDraft] = useState("");
  const [roomCode, setRoomCode] = useState(getRoomFromUrl);
  const [joinCodeDraft, setJoinCodeDraft] = useState("");
  const [roomLoading, setRoomLoading] = useState(!!getRoomFromUrl());
  const [session, setSession] = useState(DEFAULT_STATE);
  const [syncing, setSyncing] = useState(false);
  const [wordDraft, setWordDraft] = useState("");

  const [localRoundWords, setLocalRoundWords] = useState([]);
  const [localMarks, setLocalMarks] = useState([]); // boolean per word, same index as localRoundWords
  const [now, setNow] = useState(Date.now());
  const endingRef = useRef(false);
  const iCreatedRoomRef = useRef(false);

  const me = session.players.find((p) => p.id === myId) || null;
  const isExplainer = session.explainerId === myId;
  const isHost = session.hostId === myId;

  // ---------- enter an existing room (from URL) ----------
  useEffect(() => {
    if (!roomCode) return;
    (async () => {
      setRoomLoading(true);
      const s = await ensureRoom(roomCode);
      setSession(s);
      setRoomLoading(false);
    })();
  }, [roomCode]);

  // ---------- realtime subscription + fallback poll ----------
  useEffect(() => {
    if (!roomCode) return;
    const channel = supabase
      .channel(`room-${roomCode}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "game_rooms", filter: `code=eq.${roomCode}` },
        (payload) => {
          if (payload.new && payload.new.state) setSession({ ...DEFAULT_STATE, ...payload.new.state });
        }
      )
      .subscribe();
    const poll = setInterval(async () => {
      const s = await fetchRoom(roomCode);
      if (s) setSession(s);
    }, 5000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(poll);
    };
  }, [roomCode]);

  // ---------- 1s clock for countdown ----------
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const timeLeft = session.roundEndsAt
    ? Math.max(0, Math.round((session.roundEndsAt - now) / 1000))
    : ROUND_SECONDS;

  // ---------- sound: clock tick every second of the round, chime at zero ----------
  const lastTickRef = useRef(null);
  useEffect(() => {
    if (session.status !== "playing" || !session.roundEndsAt) {
      lastTickRef.current = null;
      return;
    }
    if (timeLeft === lastTickRef.current) return;
    lastTickRef.current = timeLeft;
    if (timeLeft > 0) {
      playClockTick(timeLeft);
    } else if (timeLeft === 0) {
      playEndChime();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft, session.status, session.roundEndsAt]);

  // ---------- explainer: when time's up, move to marking phase (no more ticking after this) ----------
  useEffect(() => {
    if (!isExplainer || session.status !== "playing") {
      endingRef.current = false;
      return;
    }
    if (timeLeft <= 0 && !endingRef.current) {
      endingRef.current = true;
      goToMarking();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft, isExplainer, session.status]);

  const goToMarking = async () => {
    const next = await updateRoom(roomCode, (latest) => ({ ...latest, status: "marking", roundEndsAt: null }));
    if (next) setSession(next);
  };

  // ---------- room entry ----------
  const createRoom = async () => {
    const code = genRoomCode();
    iCreatedRoomRef.current = true;
    setRoomInUrl(code);
    setRoomLoading(true);
    setRoomCode(code);
  };
  const joinExistingRoom = async () => {
    const trimmed = joinCodeDraft.trim().toUpperCase();
    if (!trimmed) return;
    setRoomInUrl(trimmed);
    setRoomLoading(true);
    setRoomCode(trimmed);
  };

  // ---------- word pool (part of room state) ----------
  const addWords = async () => {
    const parts = wordDraft
      .split(/[\n,]/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    setWordDraft("");
    setSyncing(true);
    const next = await updateRoom(roomCode, (latest) => ({ ...latest, words: [...latest.words, ...parts] }));
    if (next) setSession(next);
    setSyncing(false);
  };
  const removeWord = async (idx) => {
    setSyncing(true);
    const wordToRemove = session.words[idx];
    const next = await updateRoom(roomCode, (latest) => {
      const i = latest.words.indexOf(wordToRemove);
      if (i === -1) return latest;
      return { ...latest, words: latest.words.filter((_, ix) => ix !== i) };
    });
    if (next) setSession(next);
    setSyncing(false);
  };
  const clearWords = async () => {
    setSyncing(true);
    const next = await updateRoom(roomCode, (latest) => ({ ...latest, words: [] }));
    if (next) setSession(next);
    setSyncing(false);
  };

  // ---------- lobby: join, teams, target ----------
  const joinSession = async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = await updateRoom(roomCode, (latest) => {
      const players = [...latest.players.filter((p) => p.id !== myId), { id: myId, name: trimmed, teamIdx: null }];
      // Become host only if: I created this room, OR there is no host yet and no other players present.
      const noHostYet = !latest.hostId;
      const becomeHost = iCreatedRoomRef.current || (noHostYet && latest.players.length === 0);
      let teams = latest.teams;
      if (becomeHost && teams.length === 0) {
        teams = [
          { name: "Team 1", color: TEAM_COLORS[0] },
          { name: "Team 2", color: TEAM_COLORS[1] },
        ];
      }
      return {
        ...latest,
        players,
        teams,
        hostId: becomeHost ? myId : latest.hostId,
      };
    });
    if (next) setSession(next);
  };
  const joinTeam = async (teamIdx) => {
    const next = await updateRoom(roomCode, (latest) => ({
      ...latest,
      players: latest.players.map((p) => (p.id === myId ? { ...p, teamIdx } : p)),
    }));
    if (next) setSession(next);
  };
  const setTeamMode = async (mode) => {
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.hostId !== myId) return latest;
      return { ...latest, teamMode: mode };
    });
    if (next) setSession(next);
  };
  const randomizeTeams = async () => {
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.hostId !== myId) return latest;
      if (latest.teams.length === 0) return latest;
      const shuffled = shuffle(latest.players);
      const players = shuffled.map((p, i) => ({ ...p, teamIdx: i % latest.teams.length }));
      return { ...latest, players };
    });
    if (next) setSession(next);
  };
  const addTeam = async () => {
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.hostId !== myId) return latest;
      if (latest.teams.length >= 6) return latest;
      return {
        ...latest,
        teams: [
          ...latest.teams,
          { name: `Team ${latest.teams.length + 1}`, color: TEAM_COLORS[latest.teams.length % TEAM_COLORS.length] },
        ],
      };
    });
    if (next) setSession(next);
  };
  const renameTeam = async (idx, name) => {
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.hostId !== myId) return latest;
      return { ...latest, teams: latest.teams.map((t, i) => (i === idx ? { ...t, name } : t)) };
    });
    if (next) setSession(next);
  };
  const removeTeam = async (idx) => {
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.hostId !== myId) return latest;
      if (latest.teams.length <= 2) return latest;
      return {
        ...latest,
        teams: latest.teams.filter((_, i) => i !== idx),
        players: latest.players.map((p) => (p.teamIdx === idx ? { ...p, teamIdx: null } : p)),
      };
    });
    if (next) setSession(next);
  };
  const setTarget = async (n) => {
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.hostId !== myId) return latest;
      return { ...latest, target: n };
    });
    if (next) setSession(next);
  };

  const everyoneHasTeam = session.players.length > 0 && session.players.every((p) => p.teamIdx !== null && p.teamIdx !== undefined);
  const everyTeamHasPlayer = session.teams.length > 0 && session.teams.every((_, i) => session.players.some((p) => p.teamIdx === i));
  const canStart = session.words.length >= 5 && session.teams.length >= 2 && everyoneHasTeam && everyTeamHasPlayer;

  const startGame = async () => {
    if (!canStart) return;
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.hostId !== myId) return latest;
      return {
        ...latest,
        status: "turn",
        currentTeamIdx: 0,
        teamTurnCounts: {},
        tiebreakTeams: null,
        designatedExplainerId: pickExplainer(latest.players, 0, 0),
        scores: {},
        wordBank: latest.words,
        remainingWords: shuffle(latest.words),
        explainerId: null,
        explainerName: null,
        roundEndsAt: null,
        liveCorrectCount: 0,
        lastCorrectWord: null,
        roundCorrectWords: [],
      };
    });
    if (next) setSession(next);
  };

  // ---------- designated explainer starts the round ----------
  const claimExplainer = async () => {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === "suspended") ctx.resume();
    let drawn = [];
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.explainerId) return latest; // round already started
      if (latest.designatedExplainerId !== myId) return latest; // only the chosen person may start
      let pool = latest.remainingWords;
      if (pool.length < 5) pool = shuffle(latest.wordBank);
      drawn = pool.slice(0, 5);
      const rest = pool.slice(5);
      return {
        ...latest,
        status: "playing",
        remainingWords: rest,
        explainerId: myId,
        explainerName: me ? me.name : "Iemand",
        roundEndsAt: Date.now() + ROUND_SECONDS * 1000,
        liveCorrectCount: 0,
        lastCorrectWord: null,
      };
    });
    if (next && next.explainerId === myId) {
      setLocalRoundWords(drawn);
      setLocalMarks(drawn.map(() => false));
      endingRef.current = false;
    }
    if (next) setSession(next);
  };

  const toggleMark = (idx) => {
    setLocalMarks((prev) => prev.map((v, i) => (i === idx ? !v : v)));
  };

  const confirmScore = async () => {
    const allWordsWithMarks = localRoundWords.map((w, i) => ({ word: w, correct: localMarks[i] }));
    const correctWords = localRoundWords.filter((_, i) => localMarks[i]);
    const next = await updateRoom(roomCode, (latest) => ({
      ...latest,
      status: "roundEnd",
      scores: { ...latest.scores, [latest.currentTeamIdx]: (latest.scores[latest.currentTeamIdx] || 0) + correctWords.length },
      roundCorrectWords: correctWords,
      roundAllWords: allWordsWithMarks,
    }));
    if (next) setSession(next);
    setLocalRoundWords([]);
    setLocalMarks([]);
  };

  // On the result screen, the explainer can still flip a word right/wrong; the team score adjusts by ±1.
  const toggleResultWord = async (idx) => {
    const next = await updateRoom(roomCode, (latest) => {
      if (latest.explainerId !== myId) return latest; // only that round's explainer may correct
      if (!latest.roundAllWords[idx]) return latest;
      const wasCorrect = latest.roundAllWords[idx].correct;
      const newAllWords = latest.roundAllWords.map((item, i) =>
        i === idx ? { ...item, correct: !item.correct } : item
      );
      const delta = wasCorrect ? -1 : 1;
      const teamIdx = latest.currentTeamIdx;
      const newTeamScore = Math.max(0, (latest.scores[teamIdx] || 0) + delta);
      return {
        ...latest,
        roundAllWords: newAllWords,
        roundCorrectWords: newAllWords.filter((it) => it.correct).map((it) => it.word),
        scores: { ...latest.scores, [teamIdx]: newTeamScore },
      };
    });
    if (next) setSession(next);
  };

  const nextTurn = async () => {
    const next = await updateRoom(roomCode, (latest) => computeNextTurn(latest));
    if (next) setSession(next);
  };

  const playAgainSameSetup = async () => {
    const next = await updateRoom(roomCode, (latest) => ({
      ...latest,
      status: "turn",
      currentTeamIdx: 0,
      teamTurnCounts: {},
      tiebreakTeams: null,
      designatedExplainerId: pickExplainer(latest.players, 0, 0),
      scores: {},
      remainingWords: shuffle(latest.wordBank),
      explainerId: null,
      explainerName: null,
      roundEndsAt: null,
      liveCorrectCount: 0,
      lastCorrectWord: null,
      roundCorrectWords: [],
      roundAllWords: [],
    }));
    if (next) setSession(next);
  };
  const backToLobby = async () => {
    const next = await updateRoom(roomCode, (latest) => ({ ...latest, status: "lobby", scores: {} }));
    if (next) setSession(next);
  };

  const leader = session.teams.length
    ? session.teams.reduce((best, _, i) => ((session.scores[i] || 0) > (session.scores[best] || 0) ? i : best), 0)
    : 0;

  if (!roomCode) {
    return (
      <div style={S.app}>
        <GlobalStyle />
        <RoomEntryScreen
          joinCodeDraft={joinCodeDraft}
          setJoinCodeDraft={setJoinCodeDraft}
          onCreate={createRoom}
          onJoin={joinExistingRoom}
        />
      </div>
    );
  }

  if (roomLoading) {
    return (
      <div style={S.app}>
        <GlobalStyle />
        <div style={S.centerWrap}>
          <Loader2 size={28} className="sg-spin" color="#22C55E" />
          <p style={S.subtitle}>Verbinden met room {roomCode}…</p>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div style={S.app}>
        <GlobalStyle />
        <JoinScreen roomCode={roomCode} myNameDraft={myNameDraft} setMyNameDraft={setMyNameDraft} onJoin={joinSession} />
      </div>
    );
  }

  return (
    <div style={S.app}>
      <GlobalStyle />

      {session.status === "lobby" && (
        <LobbyScreen
          me={me}
          session={session}
          roomCode={roomCode}
          isHost={isHost}
          addTeam={addTeam}
          removeTeam={removeTeam}
          renameTeam={renameTeam}
          joinTeam={joinTeam}
          setTarget={setTarget}
          setTeamMode={setTeamMode}
          randomizeTeams={randomizeTeams}
          wordDraft={wordDraft}
          setWordDraft={setWordDraft}
          addWords={addWords}
          removeWord={removeWord}
          clearWords={clearWords}
          syncing={syncing}
          canStart={canStart}
          everyoneHasTeam={everyoneHasTeam}
          startGame={startGame}
        />
      )}

      {session.status === "turn" && (
        <TurnScreen session={session} me={me} joinTeam={joinTeam} onClaim={claimExplainer} />
      )}

      {session.status === "playing" && isExplainer && (
        <ExplainerScreen session={session} timeLeft={timeLeft} roundWords={localRoundWords} me={me} />
      )}

      {session.status === "playing" && !isExplainer && <SpectatorScreen session={session} timeLeft={timeLeft} me={me} />}

      {session.status === "marking" && isExplainer && (
        <MarkingScreen
          session={session}
          roundWords={localRoundWords}
          marks={localMarks}
          onToggle={toggleMark}
          onConfirm={confirmScore}
          me={me}
        />
      )}

      {session.status === "marking" && !isExplainer && <MarkingWaitScreen session={session} />}

      {session.status === "roundEnd" && (
        <RoundEndScreen session={session} onNext={nextTurn} isExplainer={isExplainer} me={me} onToggleWord={toggleResultWord} />
      )}

      {session.status === "gameOver" && (
        <GameOverScreen session={session} leader={leader} onPlayAgain={playAgainSameSetup} onNewGame={backToLobby} />
      )}
    </div>
  );
}

function GlobalStyle() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      button { font-family: inherit; cursor: pointer; }
      input { font-family: inherit; }
      body { background: #0B1620; }
      .sg-btn { transition: transform 0.12s ease, filter 0.15s ease; }
      .sg-btn:active { transform: scale(0.97); }
      .sg-btn:hover { filter: brightness(1.05); }
      .sg-card-btn:hover { filter: brightness(1.08); }
      .sg-spin { animation: sg-spin 0.9s linear infinite; }
      @keyframes sg-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      @keyframes sg-pop { 0% { transform: scale(0.85); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
      .sg-pop { animation: sg-pop 0.22s ease; }
      .sg-checkpop { animation: sg-pop 0.22s ease; }
      @keyframes sg-confetti-fall {
        0% { transform: translateY(-20px) rotateZ(0deg); opacity: 1; }
        100% { transform: translateY(105vh) rotateZ(720deg); opacity: 0.9; }
      }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
    `}</style>
  );
}


function Confetti() {
  const pieces = Array.from({ length: 70 });
  const colors = ["#22C55E", "#38BDF8", "#FFFFFF", "#0EA5E9", "#4ADE80", "#FACC15"];
  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 50 }}>
      {pieces.map((_, i) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 2.5;
        const duration = 2.6 + Math.random() * 2;
        const size = 6 + Math.random() * 8;
        const color = colors[i % colors.length];
        const round = Math.random() > 0.5;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              top: "-20px",
              left: `${left}%`,
              width: `${size}px`,
              height: `${size * (round ? 1 : 1.6)}px`,
              background: color,
              borderRadius: round ? "50%" : "2px",
              animation: `sg-confetti-fall ${duration}s linear ${delay}s infinite`,
            }}
          />
        );
      })}
    </div>
  );
}

/* ----------------------------- ROOM ENTRY ----------------------------- */
function RoomEntryScreen({ joinCodeDraft, setJoinCodeDraft, onCreate, onJoin }) {
  return (
    <div style={S.centerWrap}>
      <div style={S.eyebrow}>PARTYSPEL · ONLINE MET VRIENDEN</div>
      <h1 style={S.title}>30 SECONDS</h1>
      <p style={S.subtitle}>Maak een nieuwe room aan, of voer een code in om bij je vrienden aan te sluiten.</p>

      <button style={S.startBtn} className="sg-btn" onClick={onCreate}>
        <Sparkles size={18} /> Nieuwe room aanmaken
      </button>

      <div style={S.orDivider}>of</div>

      <input
        style={{ ...S.teamInput, textAlign: "center", fontSize: "18px", width: "100%", letterSpacing: "0.1em" }}
        placeholder="CODE (bijv. AB3K)"
        value={joinCodeDraft}
        onChange={(e) => setJoinCodeDraft(e.target.value.toUpperCase())}
        maxLength={8}
        onKeyDown={(e) => e.key === "Enter" && onJoin()}
      />
      <button style={S.primaryGhostBtn} className="sg-btn" onClick={onJoin} disabled={!joinCodeDraft.trim()}>
        Room joinen
      </button>
    </div>
  );
}

/* ----------------------------- JOIN ----------------------------- */
function JoinScreen({ roomCode, myNameDraft, setMyNameDraft, onJoin }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = typeof window !== "undefined" ? window.location.href : "";

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard not available; ignore
    }
  };

  return (
    <div style={S.centerWrap}>
      <div style={S.eyebrow}>ROOM {roomCode}</div>
      <h1 style={S.title}>30 SECONDS</h1>
      <p style={S.subtitle}>Deel deze link met je vrienden, en vul je eigen naam in om mee te doen.</p>

      <button style={S.shareLinkBtn} className="sg-btn" onClick={copyLink}>
        {copied ? <CheckIcon size={16} /> : <Copy size={16} />}
        {copied ? "Link gekopieerd!" : shareUrl}
      </button>

      <input
        style={{ ...S.teamInput, textAlign: "center", fontSize: "16px", width: "100%" }}
        placeholder="Jouw naam"
        value={myNameDraft}
        onChange={(e) => setMyNameDraft(e.target.value)}
        maxLength={18}
        onKeyDown={(e) => e.key === "Enter" && onJoin(myNameDraft)}
      />
      <button style={S.startBtn} className="sg-btn" onClick={() => onJoin(myNameDraft)} disabled={!myNameDraft.trim()}>
        <Users size={18} /> Meedoen
      </button>
      <p style={S.helperText}>
        Als je deze pagina herlaadt, moet je opnieuw je naam invullen — de room, woorden en teams
        blijven bewaard.
      </p>
    </div>
  );
}

/* ----------------------------- LOBBY ----------------------------- */
function LobbyScreen({
  me,
  session,
  roomCode,
  isHost,
  addTeam,
  removeTeam,
  renameTeam,
  joinTeam,
  setTarget,
  setTeamMode,
  randomizeTeams,
  wordDraft,
  setWordDraft,
  addWords,
  removeWord,
  clearWords,
  syncing,
  canStart,
  everyoneHasTeam,
  startGame,
}) {
  const { teams, players, target, words, teamMode, hostId } = session;
  const [copied, setCopied] = useState(false);
  const shareUrl = typeof window !== "undefined" ? window.location.href : "";
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };
  const hostName = (players.find((p) => p.id === hostId) || {}).name || "de host";
  const canChooseTeam = teamMode === "choose" || isHost;
  const unassigned = players.filter((p) => p.teamIdx === null || p.teamIdx === undefined);

  return (
    <div style={S.setupWrap}>
      <div style={S.heroBlock}>
        <div style={S.eyebrow}>
          HOI {me.name.toUpperCase()} · ROOM {roomCode}
          {isHost ? " · JIJ BENT HOST" : ""}
        </div>
        <h1 style={S.title}>30 SECONDS</h1>
        <p style={S.subtitle}>
          {isHost
            ? "Jij regelt de opzet. Iedereen kan woorden toevoegen; jij stelt de teams en doelscore in en start het spel."
            : `${hostName} is de host en regelt de opzet. Voeg gerust woorden toe en kies je team.`}
        </p>
        <button style={S.shareLinkBtn} className="sg-btn" onClick={copyLink}>
          {copied ? <CheckIcon size={16} /> : <Copy size={16} />}
          {copied ? "Link gekopieerd!" : "Kopieer link voor vrienden"}
        </button>
      </div>

      <Section icon={<Users size={18} />} title="Teams" hint={`${players.length} spelers`}>
        {/* Team mode toggle — host only */}
        {isHost && (
          <div style={S.modeRow}>
            <button
              style={teamMode === "choose" ? S.modeBtnActive : S.modeBtn}
              className="sg-btn"
              onClick={() => setTeamMode("choose")}
            >
              Spelers kiezen zelf
            </button>
            <button
              style={teamMode === "random" ? S.modeBtnActive : S.modeBtn}
              className="sg-btn"
              onClick={() => setTeamMode("random")}
            >
              Willekeurig
            </button>
          </div>
        )}

        <div style={S.teamList}>
          {teams.map((t, i) => {
            const members = players.filter((p) => p.teamIdx === i);
            const isMine = me.teamIdx === i;
            return (
              <div key={i} style={S.teamBlock}>
                <div style={S.teamRow}>
                  <span style={{ ...S.teamDot, background: t.color }} />
                  {isHost ? (
                    <input style={S.teamInput} value={t.name} onChange={(e) => renameTeam(i, e.target.value)} maxLength={18} />
                  ) : (
                    <span style={S.teamNameStatic}>{t.name}</span>
                  )}
                  {isHost && teams.length > 2 && (
                    <button style={S.iconBtnGhost} onClick={() => removeTeam(i)} aria-label="Team verwijderen">
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                <div style={S.memberRow}>
                  <span style={S.memberNames}>{members.length ? members.map((m) => m.name).join(", ") : "nog niemand"}</span>
                  {canChooseTeam && (
                    <button style={isMine ? S.joinedBtn : S.joinBtn} className="sg-btn" onClick={() => joinTeam(i)}>
                      {isMine ? "Jij doet mee" : "Doe mee"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {isHost && teams.length < 6 && (
          <button style={S.dashedBtn} className="sg-btn" onClick={addTeam}>
            <Plus size={16} /> Team toevoegen
          </button>
        )}

        {/* Randomize button — host only, random mode */}
        {isHost && teamMode === "random" && (
          <button style={S.primaryGhostBtn} className="sg-btn" onClick={randomizeTeams}>
            <Sparkles size={16} /> Verdeel spelers willekeurig
          </button>
        )}

        {/* Status hints */}
        {teamMode === "random" && !isHost && (
          <p style={S.helperText}>{hostName} verdeelt de teams. Je hoeft zelf niets te kiezen.</p>
        )}
        {unassigned.length > 0 && (
          <p style={S.helperText}>
            Nog zonder team: {unassigned.map((p) => p.name).join(", ")}
          </p>
        )}
      </Section>

      <Section icon={<Sparkles size={18} />} title="Woorden" hint={`${words.length} woorden${words.length < 5 ? " · minimaal 5" : ""}`}>
        <textarea
          style={S.textarea}
          placeholder="Typ woorden, gescheiden door een komma of nieuwe regel. Bijv: fiets, ruimtevaart, omelet"
          value={wordDraft}
          onChange={(e) => setWordDraft(e.target.value)}
          rows={3}
        />
        <button style={S.primaryGhostBtn} className="sg-btn" onClick={addWords} disabled={syncing}>
          <Plus size={16} /> Toevoegen aan de gezamenlijke stapel
        </button>
        {words.length > 0 && (
          <>
            <div style={S.chipWrap}>
              {words.map((w, i) => (
                <span key={`${w}-${i}`} style={S.chip}>
                  {w}
                  <button style={S.chipX} onClick={() => removeWord(i)} aria-label={`${w} verwijderen`}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            {isHost && (
              <button style={S.textBtn} onClick={clearWords}>
                Alles wissen voor iedereen
              </button>
            )}
          </>
        )}
      </Section>

      <Section icon={<Trophy size={18} />} title="Doelscore" hint="punten om te winnen">
        <div style={S.targetRow}>
          {[10, 20, 30].map((n) => (
            <button
              key={n}
              style={target === n ? S.targetBtnActive : S.targetBtn}
              className="sg-btn"
              onClick={() => isHost && setTarget(n)}
              disabled={!isHost}
            >
              {n}
            </button>
          ))}
        </div>
        {!isHost && <p style={S.helperText}>{hostName} kiest de doelscore.</p>}
      </Section>

      {isHost ? (
        <>
          <button style={canStart ? S.startBtn : S.startBtnDisabled} className="sg-btn" onClick={startGame} disabled={!canStart}>
            <Play size={20} /> Start spel voor iedereen
          </button>
          {!canStart && (
            <p style={S.helperText}>
              {words.length < 5
                ? "Voeg minstens 5 woorden toe."
                : teams.length < 2
                ? "Er moeten minstens 2 teams zijn."
                : !everyoneHasTeam
                ? "Iedereen moet eerst in een team zitten."
                : "Elk team heeft minstens 1 speler nodig."}
            </p>
          )}
        </>
      ) : (
        <div style={S.waitHostBox}>
          <Loader2 size={18} className="sg-spin" />
          Wachten tot {hostName} het spel start…
        </div>
      )}
    </div>
  );
}

function Section({ icon, title, hint, children }) {
  return (
    <div style={S.section}>
      <div style={S.sectionHead}>
        <div style={S.sectionTitle}>
          {icon}
          <span>{title}</span>
        </div>
        {hint && <span style={S.sectionHint}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/* ----------------------------- TURN ----------------------------- */
function TurnScreen({ session, me, joinTeam, onClaim }) {
  const { teams, scores, currentTeamIdx, target, players, designatedExplainerId, tiebreakTeams } = session;
  const team = teams[currentTeamIdx];
  const explainer = players.find((p) => p.id === designatedExplainerId) || null;
  const iAmExplainer = designatedExplainerId === me.id;
  const onMyTurn = me.teamIdx === currentTeamIdx;

  // Is a team already at/over the target while the round finishes out? (equal-turns rule)
  const someoneReached = teams.some((_, i) => (scores[i] || 0) >= target);
  const inTiebreak = tiebreakTeams && tiebreakTeams.length > 0;

  return (
    <div style={S.centerWrap}>
      <ScoreStrip teams={teams} scores={scores} target={target} />

      {inTiebreak ? (
        <div style={S.tiebreakNotice}>
          <Trophy size={16} /> Gelijkspel! Beslissende ronde tussen:{" "}
          {tiebreakTeams.map((i) => teams[i].name).join(" & ")}
        </div>
      ) : someoneReached ? (
        <div style={S.finishNotice}>
          <Trophy size={16} /> Doelscore gehaald — deze ronde wordt afgemaakt zodat elk team
          evenveel beurten heeft.
        </div>
      ) : null}

      <div style={S.eyebrow}>VOLGENDE BEURT</div>
      <h2 style={{ ...S.bigTeamName, color: team.color }}>{team.name}</h2>
      <p style={S.subtitle}>
        Score: <strong style={{ color: "#F4F1EA" }}>{scores[currentTeamIdx] || 0}</strong> / {target}
      </p>

      {/* The app designates who explains, in rotation */}
      <div style={S.explainerBadge}>
        <Eye size={15} />
        {explainer ? (
          <span>
            <strong style={{ color: team.color }}>{explainer.name}</strong> is aan de beurt om uit te leggen
          </span>
        ) : (
          <span>Geen speler beschikbaar in dit team</span>
        )}
      </div>

      {iAmExplainer ? (
        <>
          <p style={S.turnHint}>
            Jij bent aan de beurt. Druk op start: alleen jij ziet de 5 woorden, de rest ziet de timer.
            Aanvinken kan pas nadat de tijd om is.
          </p>
          <button style={S.startBtn} className="sg-btn" onClick={onClaim}>
            <Play size={20} /> Ik leg deze ronde uit
          </button>
        </>
      ) : onMyTurn ? (
        <p style={S.turnHint}>
          Jouw team is aan zet — {explainer ? explainer.name : "je teamgenoot"} legt deze ronde uit. Help straks mee raden!
        </p>
      ) : me.teamIdx === null ? (
        <>
          <p style={S.turnHint}>Je bent nog niet bij een team — kies er snel een om mee te spelen.</p>
          <div style={S.targetRow}>
            {teams.map((t, i) => (
              <button key={i} style={{ ...S.targetBtn, color: t.color, borderColor: t.color }} className="sg-btn" onClick={() => joinTeam(i)}>
                {t.name}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p style={S.turnHint}>Wachten tot {explainer ? explainer.name : "het andere team"} op "start" drukt…</p>
      )}
    </div>
  );
}

function ScoreStrip({ teams, scores, target }) {
  return (
    <div style={S.scoreStrip}>
      {teams.map((t, i) => (
        <div key={i} style={S.scoreChip}>
          <span style={{ ...S.teamDotSm, background: t.color }} />
          {t.name}: {scores[i] || 0}
          {target ? ` / ${target}` : ""}
        </div>
      ))}
    </div>
  );
}

// A persistent bar showing which team YOU are on and who your teammates are.
function MyTeamBar({ session, me }) {
  if (!me || me.teamIdx === null || me.teamIdx === undefined) return null;
  const myTeam = session.teams[me.teamIdx];
  if (!myTeam) return null;
  const teammates = session.players
    .filter((p) => p.teamIdx === me.teamIdx && p.id !== me.id)
    .map((p) => p.name);
  return (
    <div style={{ ...S.myTeamBar, borderColor: myTeam.color }}>
      <span style={{ ...S.teamDot, background: myTeam.color }} />
      <div style={S.myTeamText}>
        <span style={S.myTeamLabel}>JOUW TEAM</span>
        <span style={{ ...S.myTeamName, color: myTeam.color }}>
          {myTeam.name}
          <span style={{ color: "#94A3B8", fontWeight: 600 }}>
            {teammates.length > 0 ? ` · met ${teammates.join(", ")}` : " · jij speelt solo"}
          </span>
        </span>
      </div>
    </div>
  );
}

/* ----------------------------- EXPLAINER (sees the words) ----------------------------- */
function ExplainerScreen({ session, timeLeft, roundWords, me }) {
  const team = session.teams[session.currentTeamIdx];
  const circumference = 2 * Math.PI * 20;
  const progress = timeLeft / ROUND_SECONDS;
  const urgent = timeLeft <= 10;

  return (
    <div style={S.playWrap}>
      <MyTeamBar session={session} me={me} />
      <div style={S.playHeader}>
        <span style={{ ...S.teamPill, background: team.color }}>{team.name}</span>
        <div style={S.ringWrapSm}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="20" fill="none" stroke="#26384A" strokeWidth="6" />
            <circle
              cx="32"
              cy="32"
              r="20"
              fill="none"
              stroke={urgent ? "#F87171" : "#22C55E"}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
              transform="rotate(-90 32 32)"
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
          </svg>
          <span style={{ ...S.ringNumberSm, color: urgent ? "#F87171" : "#F1F5F9" }}>{timeLeft}</span>
        </div>
        <span style={S.scorePill}>max 5</span>
      </div>
      <div style={S.eyeRow}>
        <Eye size={14} /> Alleen jij ziet deze woorden — aanvinken kan pas na de tijd
      </div>

      <div style={S.wordList}>
        {roundWords.map((w, idx) => (
          <div key={w + idx} style={S.wordRowReadOnly}>
            <span style={S.wordRowText}>{w}</span>
          </div>
        ))}
      </div>

      <p style={S.dragHint}>Leg uit, geef aanwijzingen — zodra de tijd om is mag je terugkijken en aanvinken.</p>
    </div>
  );
}

/* ----------------------------- MARKING (explainer checks off, no time pressure) ----------------------------- */
function MarkingScreen({ session, roundWords, marks, onToggle, onConfirm, me }) {
  const team = session.teams[session.currentTeamIdx];
  const correctCount = marks.filter(Boolean).length;

  return (
    <div style={S.playWrap}>
      <MyTeamBar session={session} me={me} />
      <div style={S.playHeader}>
        <span style={{ ...S.teamPill, background: team.color }}>{team.name}</span>
        <span style={S.scorePill}>{correctCount} / 5</span>
      </div>
      <div style={S.eyeRow}>
        <Eye size={14} /> Tijd is om — vink terug welke woorden goed geraden zijn
      </div>

      <div style={S.wordList}>
        {roundWords.map((w, idx) => {
          const checked = marks[idx];
          return (
            <button key={w + idx} style={checked ? S.wordRowChecked : S.wordRow} className="sg-btn sg-card-btn" onClick={() => onToggle(idx)}>
              <span style={checked ? S.wordRowTextChecked : S.wordRowText}>{w}</span>
              <span key={checked ? "on" : "off"} className={checked ? "sg-checkpop" : ""} style={checked ? S.wordRowCheckOn : S.wordRowCheck}>
                <Check size={18} />
              </span>
            </button>
          );
        })}
      </div>

      <button style={S.startBtn} className="sg-btn" onClick={onConfirm}>
        Bevestig score
      </button>
    </div>
  );
}

/* ----------------------------- MARKING WAIT (everyone else) ----------------------------- */
function MarkingWaitScreen({ session }) {
  const team = session.teams[session.currentTeamIdx];
  return (
    <div style={S.centerWrap}>
      <span style={{ ...S.teamPill, background: team.color }}>{team.name}</span>
      <div style={S.eyeRow}>
        <EyeOff size={14} /> {session.explainerName} bekijkt de antwoorden terug
      </div>
      <div style={S.hiddenCard}>
        <EyeOff size={28} color="#35506A" />
        <span style={S.hiddenCardText}>Even geduld…</span>
      </div>
      <p style={S.dragHint}>De uitslag verschijnt zodra {session.explainerName} de score bevestigt.</p>
    </div>
  );
}

/* ----------------------------- SPECTATOR (word hidden) ----------------------------- */
function SpectatorScreen({ session, timeLeft, me }) {
  const team = session.teams[session.currentTeamIdx];
  const isMyTeamPlaying = me.teamIdx === session.currentTeamIdx;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const progress = timeLeft / ROUND_SECONDS;
  const offset = circumference * (1 - progress);
  const urgent = timeLeft <= 10;
  // Your team plays: ring in your team color (red when urgent). Opponents: muted gray.
  const ringColor = isMyTeamPlaying ? (urgent ? "#F87171" : team.color) : "#64748B";

  return (
    <div style={S.playWrap}>
      <MyTeamBar session={session} me={me} />
      <div style={S.playHeader}>
        <span style={{ ...S.teamPill, background: team.color }}>{team.name}</span>
        <span style={S.scorePill}>max 5</span>
      </div>

      {isMyTeamPlaying ? (
        <div style={{ ...S.eyeRow, color: team.color }}>
          <Eye size={14} /> {session.explainerName} legt uit — jullie raden!
        </div>
      ) : (
        <div style={S.eyeRow}>
          <EyeOff size={14} /> {team.name} is aan de beurt — even wachten
        </div>
      )}

      <div style={S.ringWrap}>
        <svg width="140" height="140" viewBox="0 0 140 140">
          <circle cx="70" cy="70" r={radius} fill="none" stroke="#26384A" strokeWidth="8" />
          <circle
            cx="70"
            cy="70"
            r={radius}
            fill="none"
            stroke={ringColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform="rotate(-90 70 70)"
            style={{ transition: "stroke-dashoffset 1s linear" }}
          />
        </svg>
        <div style={{ ...S.ringNumber, color: isMyTeamPlaying && urgent ? "#F87171" : "#F1F5F9" }}>{timeLeft}</div>
      </div>

      {isMyTeamPlaying ? (
        <>
          <div style={{ ...S.guessBanner, background: hexToSoftBg(team.color), borderColor: team.color, color: team.color }}>
            <Sparkles size={18} /> Roep zoveel mogelijk antwoorden — jullie zijn aan zet!
          </div>
          <p style={S.dragHint}>Na de tijd bekijkt {session.explainerName} terug wat goed geraden is.</p>
        </>
      ) : (
        <>
          <div style={S.waitBanner}>
            <EyeOff size={18} /> Het andere team speelt. Jullie hoeven niets te doen.
          </div>
          <p style={S.dragHint}>Straks zijn jullie weer aan de beurt.</p>
        </>
      )}
    </div>
  );
}

/* ----------------------------- ROUND END ----------------------------- */
function RoundEndScreen({ session, onNext, isExplainer, me, onToggleWord }) {
  const team = session.teams[session.currentTeamIdx];
  const allWords = session.roundAllWords;
  const correctCount = session.roundCorrectWords.length;
  const myColor = me && me.teamIdx != null && session.teams[me.teamIdx] ? session.teams[me.teamIdx].color : "#22C55E";
  return (
    <div style={S.centerWrap}>
      <div style={S.eyebrow}>UITSLAG · {session.explainerName}</div>
      <h2 style={{ ...S.bigTeamName, color: team.color }}>{correctCount} goed geraden</h2>
      {allWords.length > 0 ? (
        <>
          <div style={S.chipWrap}>
            {allWords.map((item, i) => {
              const chipStyle = item.correct ? S.chipDone : S.chipMissed;
              if (isExplainer) {
                return (
                  <button
                    key={i}
                    style={{ ...chipStyle, cursor: "pointer" }}
                    className="sg-btn"
                    onClick={() => onToggleWord(i)}
                  >
                    {item.correct ? <Check size={12} /> : <X size={12} />} {item.word}
                  </button>
                );
              }
              return (
                <span key={i} style={chipStyle}>
                  {item.correct ? <Check size={12} /> : <X size={12} />} {item.word}
                </span>
              );
            })}
          </div>
          {isExplainer && (
            <p style={S.dragHint}>Klopt er iets niet? Tik op een woord om het alsnog goed of fout te zetten — de score past zich aan.</p>
          )}
        </>
      ) : (
        <p style={S.subtitle}>Geen woorden geraden deze ronde — volgende keer beter!</p>
      )}
      <ScoreStrip teams={session.teams} scores={session.scores} target={session.target} />
      {isExplainer ? (
        <button style={S.startBtn} className="sg-btn" onClick={onNext}>
          Volgende beurt
        </button>
      ) : (
        <p style={S.turnHint}>Wachten tot {session.explainerName} doorgaat naar de volgende beurt…</p>
      )}
    </div>
  );
}

/* ----------------------------- GAME OVER ----------------------------- */
function GameOverScreen({ session, leader, onPlayAgain, onNewGame }) {
  const ranked = session.teams
    .map((t, i) => ({ ...t, score: session.scores[i] || 0, idx: i }))
    .sort((a, b) => b.score - a.score);

  return (
    <div style={S.centerWrap}>
      <Confetti />
      <Crown size={42} color="#FACC15" />
      <div style={S.eyebrow}>EINDSTAND</div>
      <h2 style={{ ...S.bigTeamName, color: session.teams[leader].color }}>{session.teams[leader].name} wint!</h2>
      <div style={S.rankList}>
        {ranked.map((t, pos) => (
          <div key={t.idx} style={S.rankRow}>
            <span style={S.rankPos}>{pos + 1}</span>
            <span style={{ ...S.teamDotSm, background: t.color }} />
            <span style={S.rankName}>{t.name}</span>
            <span style={S.rankScore}>{t.score}</span>
          </div>
        ))}
      </div>
      <div style={S.gameOverButtons}>
        <button style={S.primaryGhostBtn} className="sg-btn" onClick={onPlayAgain}>
          <RotateCcw size={16} /> Opnieuw, zelfde woorden
        </button>
        <button style={S.startBtn} className="sg-btn" onClick={onNewGame}>
          Terug naar de lobby
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- STYLES ----------------------------- */
const FONT_DISPLAY = "'Space Grotesk', sans-serif";
const FONT_BODY = "'Inter', sans-serif";
const FONT_MONO = "'Space Mono', monospace";

const S = {
  app: {
    minHeight: "100vh",
    width: "100%",
    background: "transparent",
    color: "#F4F1EA",
    fontFamily: FONT_BODY,
    padding: "28px 18px 40px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    position: "relative",
    zIndex: 1,
  },
  setupWrap: { width: "100%", maxWidth: "480px", display: "flex", flexDirection: "column", gap: "20px" },
  heroBlock: { textAlign: "center", marginBottom: "4px", display: "flex", flexDirection: "column", gap: "10px", alignItems: "center" },
  eyebrow: { fontFamily: FONT_MONO, fontSize: "12px", letterSpacing: "0.12em", color: "#22C55E", marginBottom: "8px" },
  title: {
    fontFamily: FONT_DISPLAY,
    fontWeight: 700,
    fontSize: "44px",
    letterSpacing: "-0.01em",
    margin: "0 0 10px",
    color: "#F1F5F9",
  },
  subtitle: { color: "#94A3B8", fontSize: "14.5px", lineHeight: 1.5, margin: 0 },
  orDivider: { color: "#64748B", fontSize: "12px", fontFamily: FONT_MONO },
  shareLinkBtn: {
    background: "rgba(56,189,248,0.1)",
    border: "1px solid rgba(56,189,248,0.35)",
    borderRadius: "10px",
    color: "#7DD3FC",
    padding: "9px 14px",
    fontSize: "12.5px",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    maxWidth: "100%",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },

  section: { background: "#13212E", border: "1px solid #26384A", borderRadius: "16px", padding: "16px" },
  sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" },
  sectionTitle: { display: "flex", alignItems: "center", gap: "8px", fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: "16px" },
  sectionHint: { fontFamily: FONT_MONO, fontSize: "11px", color: "#8499AD" },

  teamList: { display: "flex", flexDirection: "column", gap: "10px", marginBottom: "10px" },
  teamBlock: { background: "#0F1C28", border: "1px solid #1B2C3A", borderRadius: "12px", padding: "10px" },
  modeRow: { display: "flex", gap: "8px", marginBottom: "12px" },
  modeBtn: { flex: 1, background: "#1B2C3A", border: "1px solid #2C4154", borderRadius: "10px", color: "#94A3B8", padding: "9px", fontSize: "12.5px", fontWeight: 600 },
  modeBtnActive: { flex: 1, background: "rgba(56,189,248,0.12)", border: "1px solid #38BDF8", borderRadius: "10px", color: "#7DD3FC", padding: "9px", fontSize: "12.5px", fontWeight: 700 },
  teamNameStatic: { flex: 1, fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: "15px", padding: "9px 0" },
  waitHostBox: { display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", background: "#13212E", border: "1px solid #26384A", borderRadius: "14px", padding: "16px", color: "#94A3B8", fontSize: "14px", fontWeight: 600 },
  explainerBadge: { display: "flex", alignItems: "center", gap: "8px", background: "#13212E", border: "1px solid #26384A", borderRadius: "999px", padding: "10px 18px", color: "#CBD5E1", fontSize: "13.5px" },
  finishNotice: { display: "flex", alignItems: "center", gap: "8px", background: "rgba(250,204,21,0.1)", border: "1px solid rgba(250,204,21,0.4)", borderRadius: "12px", padding: "10px 16px", color: "#FACC15", fontSize: "13px", lineHeight: 1.4, textAlign: "left" },
  tiebreakNotice: { display: "flex", alignItems: "center", gap: "8px", background: "rgba(248,113,113,0.12)", border: "1px solid #F87171", borderRadius: "12px", padding: "10px 16px", color: "#FCA5A5", fontSize: "13px", fontWeight: 600, lineHeight: 1.4, textAlign: "left" },
  myTeamBar: { display: "flex", alignItems: "center", gap: "12px", width: "100%", maxWidth: "440px", background: "#13212E", border: "1.5px solid #26384A", borderRadius: "12px", padding: "10px 16px" },
  myTeamText: { display: "flex", flexDirection: "column", gap: "2px", textAlign: "left" },
  myTeamLabel: { fontFamily: FONT_MONO, fontSize: "10px", letterSpacing: "0.1em", color: "#64748B" },
  myTeamName: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: "14px", color: "#F1F5F9" },
  guessBanner: { display: "flex", alignItems: "center", gap: "10px", background: "rgba(34,197,94,0.12)", border: "1px solid #22C55E", borderRadius: "14px", padding: "14px 18px", color: "#86EFAC", fontSize: "14px", fontWeight: 700, textAlign: "center" },
  waitBanner: { display: "flex", alignItems: "center", gap: "10px", background: "#13212E", border: "1px solid #26384A", borderRadius: "14px", padding: "14px 18px", color: "#94A3B8", fontSize: "14px", fontWeight: 600, textAlign: "center" },
  teamRow: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" },
  memberRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
  memberNames: { color: "#8499AD", fontSize: "12px", flex: 1 },
  joinBtn: { background: "transparent", border: "1px solid #35506A", borderRadius: "8px", color: "#94A3B8", padding: "6px 12px", fontSize: "12px", fontWeight: 600 },
  joinedBtn: { background: "rgba(34,197,94,0.15)", border: "1px solid #22C55E", borderRadius: "8px", color: "#22C55E", padding: "6px 12px", fontSize: "12px", fontWeight: 700 },
  teamDot: { width: "12px", height: "12px", borderRadius: "50%", flexShrink: 0 },
  teamDotSm: { width: "8px", height: "8px", borderRadius: "50%", display: "inline-block" },
  teamInput: { flex: 1, background: "#1B2C3A", border: "1px solid #2C4154", borderRadius: "10px", padding: "9px 12px", color: "#F4F1EA", fontSize: "14px", outline: "none" },
  iconBtnGhost: { background: "transparent", border: "none", color: "#8499AD", padding: "6px", borderRadius: "8px", display: "flex" },
  dashedBtn: { width: "100%", background: "transparent", border: "1.5px dashed #35506A", borderRadius: "10px", color: "#94A3B8", padding: "10px", fontSize: "13.5px", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" },
  textarea: { width: "100%", background: "#1B2C3A", border: "1px solid #2C4154", borderRadius: "10px", padding: "10px 12px", color: "#F4F1EA", fontSize: "14px", outline: "none", resize: "vertical", marginBottom: "10px", fontFamily: FONT_BODY },
  primaryGhostBtn: { background: "rgba(56,189,248,0.12)", border: "1px solid rgba(56,189,248,0.45)", borderRadius: "10px", color: "#38BDF8", padding: "10px 14px", fontSize: "13.5px", fontWeight: 600, display: "flex", alignItems: "center", gap: "6px", justifyContent: "center", width: "100%" },
  chipWrap: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "12px", justifyContent: "center" },
  chip: { display: "flex", alignItems: "center", gap: "6px", background: "#1B2C3A", border: "1px solid #2C4154", borderRadius: "999px", padding: "6px 6px 6px 12px", fontSize: "13px" },
  chipDone: { background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.4)", color: "#22C55E", borderRadius: "999px", padding: "6px 14px", fontSize: "13px", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "5px" },
  chipMissed: { background: "rgba(255,255,255,0.04)", border: "1px solid #2C4154", color: "#8499AD", borderRadius: "999px", padding: "6px 14px", fontSize: "13px", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "5px" },
  chipX: { background: "transparent", border: "none", color: "#8499AD", display: "flex", padding: 0 },
  textBtn: { background: "transparent", border: "none", color: "#8499AD", fontSize: "12.5px", marginTop: "10px", textDecoration: "underline" },

  targetRow: { display: "flex", gap: "10px", flexWrap: "wrap" },
  targetBtn: { flex: 1, background: "#1B2C3A", border: "1px solid #2C4154", borderRadius: "10px", color: "#94A3B8", padding: "12px", fontFamily: FONT_MONO, fontWeight: 700, fontSize: "15px", minWidth: "90px" },
  targetBtnActive: { flex: 1, background: "linear-gradient(100deg, #22C55E, #16A34A)", border: "none", borderRadius: "10px", color: "#06222F", padding: "12px", fontFamily: FONT_MONO, fontWeight: 700, fontSize: "16px", boxShadow: "0 4px 14px rgba(34,197,94,0.30)" },

  startBtn: { width: "100%", background: "linear-gradient(100deg, #22C55E, #16A34A)", border: "none", borderRadius: "14px", color: "#06222F", padding: "16px", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", fontFamily: FONT_DISPLAY, boxShadow: "0 6px 22px rgba(34,197,94,0.35)" },
  startBtnDisabled: { width: "100%", background: "#26384A", border: "none", borderRadius: "14px", color: "#8499AD", padding: "16px", fontSize: "16px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", fontFamily: FONT_DISPLAY },
  helperText: { textAlign: "center", color: "#8499AD", fontSize: "12.5px", marginTop: "-4px" },

  centerWrap: { width: "100%", maxWidth: "440px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "14px", paddingTop: "12px" },
  bigTeamName: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: "30px", margin: 0 },
  turnHint: { color: "#8499AD", fontSize: "13.5px", lineHeight: 1.5, maxWidth: "360px" },

  scoreStrip: { display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" },
  scoreChip: { display: "flex", alignItems: "center", gap: "6px", background: "#13212E", border: "1px solid #26384A", borderRadius: "999px", padding: "6px 12px", fontSize: "12.5px", fontFamily: FONT_MONO },

  playWrap: { width: "100%", maxWidth: "440px", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" },
  playHeader: { display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" },
  teamPill: { padding: "6px 14px", borderRadius: "999px", color: "#0B1620", fontWeight: 700, fontSize: "13px", fontFamily: FONT_DISPLAY },
  scorePill: { fontFamily: FONT_MONO, color: "#22C55E", fontSize: "13px" },
  eyeRow: { display: "flex", alignItems: "center", gap: "6px", color: "#8499AD", fontSize: "12px", fontFamily: FONT_MONO },

  ringWrap: { position: "relative", width: "140px", height: "140px" },
  ringNumber: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_MONO, fontWeight: 700, fontSize: "36px" },
  ringWrapSm: { position: "relative", width: "64px", height: "64px", flexShrink: 0 },
  ringNumberSm: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT_MONO, fontWeight: 700, fontSize: "16px" },

  wordList: { width: "100%", maxWidth: "320px", display: "flex", flexDirection: "column", gap: "10px" },
  wordRowReadOnly: {
    background: "#13212E",
    border: "1px solid #26384A",
    borderRadius: "14px",
    padding: "16px 18px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  wordRowWrap: { position: "relative" },
  wordRowGoodBg: { position: "absolute", inset: 0, background: "rgba(255,209,102,0.18)", borderRadius: "14px", display: "flex", alignItems: "center", paddingLeft: "18px" },
  wordRow: { width: "100%", position: "relative", background: "#13212E", border: "1px solid #26384A", borderRadius: "14px", padding: "14px 12px 14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", touchAction: "none", userSelect: "none" },
  wordRowChecked: { width: "100%", position: "relative", background: "rgba(34,197,94,0.12)", border: "1px solid #22C55E", borderRadius: "14px", padding: "14px 12px 14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", touchAction: "none", userSelect: "none", boxShadow: "0 0 18px rgba(34,197,94,0.25)" },
  wordRowText: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: "19px", color: "#F1F5F9" },
  wordRowTextChecked: { fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: "19px", color: "#86EFAC" },
  wordRowCheck: { flexShrink: 0, background: "rgba(255,255,255,0.05)", border: "1px solid #35506A", color: "#8499AD", borderRadius: "10px", padding: "8px", display: "flex", alignItems: "center", justifyContent: "center" },
  wordRowCheckOn: { flexShrink: 0, background: "rgba(34,197,94,0.15)", border: "1px solid #22C55E", color: "#22C55E", borderRadius: "10px", padding: "8px", display: "flex", alignItems: "center", justifyContent: "center" },
  rowSwipeBadge: { position: "absolute", top: "50%", right: "54px", transform: "translateY(-50%) rotate(6deg)", border: "2px solid #22C55E", color: "#22C55E", borderRadius: "8px", padding: "3px 8px", fontFamily: FONT_MONO, fontWeight: 700, fontSize: "11px", background: "#13212E" },
  wordCardEmpty: { color: "#8499AD", fontSize: "14px", fontFamily: FONT_DISPLAY },

  hiddenCard: { width: "280px", height: "180px", background: "#0F1C28", border: "1.5px dashed #26384A", borderRadius: "20px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px" },
  hiddenCardText: { color: "#64748B", fontSize: "13px", fontFamily: FONT_MONO },
  lastWordToast: { background: "rgba(34,197,94,0.15)", border: "1px solid #22C55E", color: "#22C55E", borderRadius: "999px", padding: "6px 16px", fontWeight: 700, fontSize: "14px" },

  dragHint: { color: "#8499AD", fontSize: "12px", textAlign: "center" },

  rankList: { width: "100%", display: "flex", flexDirection: "column", gap: "8px" },
  rankRow: { display: "flex", alignItems: "center", gap: "10px", background: "#13212E", border: "1px solid #26384A", borderRadius: "12px", padding: "10px 14px" },
  rankPos: { fontFamily: FONT_MONO, color: "#8499AD", width: "16px" },
  rankName: { flex: 1, textAlign: "left", fontWeight: 600, fontSize: "14px" },
  rankScore: { fontFamily: FONT_MONO, fontWeight: 700, fontSize: "16px", color: "#22C55E" },

  gameOverButtons: { display: "flex", flexDirection: "column", gap: "10px", width: "100%", marginTop: "8px" },
};
