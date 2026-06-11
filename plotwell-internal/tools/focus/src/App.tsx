import { useState } from "react";

// ─── Shared layout ────────────────────────────────────────────────────────────
function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8 font-sans">
      <div className="max-w-5xl mx-auto">{children}</div>
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DailyCheckIn {
  date: string;
  shipped: string;
  blockers: string;
  tomorrow: string;
  mood: 1 | 2 | 3 | 4 | 5;
  savedAt: string;
}

interface WeekGoal {
  id: string;
  text: string;
  done: boolean;
}

interface WeekPlan {
  weekStart: string;
  goals: WeekGoal[];
}

interface ShipEntry {
  id: string;
  title: string;
  description: string;
  type: "feature" | "fix" | "infra" | "content" | "ops";
  shippedAt: string;
}

interface HabitDef {
  id: string;
  name: string;
  emoji: string;
}

interface Commitment {
  id: string;
  text: string;
  dueDate: string;
  status: "active" | "done" | "missed";
  createdAt: string;
  completedAt?: string;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
const CHECKIN_KEY    = "focus-checkins";
const WEEK_KEY       = "focus-week";
const SHIPS_KEY      = "focus-ships";
const HABITS_KEY     = "focus-habits";
const HABIT_DONE_KEY = "focus-habit-done";
const COMMITS_KEY    = "focus-commitments";

function load<T>(key: string, fallback: T): T {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; }
  catch { return fallback; }
}
function save(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /**/ }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }

function getWeekStart(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr + "T12:00:00") : new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

function fmtShort(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function last21Days(): string[] {
  const days: string[] = [];
  const d = new Date();
  for (let i = 20; i >= 0; i--) {
    const dd = new Date(d);
    dd.setDate(dd.getDate() - i);
    days.push(dd.toISOString().slice(0, 10));
  }
  return days;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_HABITS: HabitDef[] = [
  { id: "deep-work", name: "Deep work",  emoji: "🧠" },
  { id: "writing",   name: "Writing",    emoji: "✍️" },
  { id: "exercise",  name: "Exercise",   emoji: "🏃" },
];

const SHIP_TYPES: { value: ShipEntry["type"]; label: string; color: string }[] = [
  { value: "feature", label: "Feature", color: "bg-blue-100 text-blue-700" },
  { value: "fix",     label: "Fix",     color: "bg-red-100 text-red-700" },
  { value: "infra",   label: "Infra",   color: "bg-gray-100 text-gray-600" },
  { value: "content", label: "Content", color: "bg-green-100 text-green-700" },
  { value: "ops",     label: "Ops",     color: "bg-amber-100 text-amber-700" },
];

const MOOD_OPTIONS: { value: 1|2|3|4|5; emoji: string; label: string }[] = [
  { value: 1, emoji: "😩", label: "Rough" },
  { value: 2, emoji: "😕", label: "Meh" },
  { value: 3, emoji: "😐", label: "OK" },
  { value: 4, emoji: "😊", label: "Good" },
  { value: 5, emoji: "🔥", label: "On fire" },
];

// ─── Daily Check-in ───────────────────────────────────────────────────────────
function DailyTab() {
  const today = todayStr();
  const allCheckIns = load<DailyCheckIn[]>(CHECKIN_KEY, []);
  const existing = allCheckIns.find(c => c.date === today);

  const [shipped,  setShipped]  = useState(existing?.shipped  ?? "");
  const [blockers, setBlockers] = useState(existing?.blockers ?? "");
  const [tomorrow, setTomorrow] = useState(existing?.tomorrow ?? "");
  const [mood,     setMood]     = useState<1|2|3|4|5>(existing?.mood ?? 3);
  const [saved,    setSaved]    = useState(!!existing);

  const handleSave = () => {
    const entry: DailyCheckIn = { date: today, shipped, blockers, tomorrow, mood, savedAt: new Date().toISOString() };
    save(CHECKIN_KEY, [entry, ...allCheckIns.filter(c => c.date !== today)].slice(0, 90));
    setSaved(true);
  };

  const recent = allCheckIns.filter(c => c.date !== today).slice(0, 7);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">
            🌅 {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </h3>
          {saved && <span className="text-xs text-green-600 font-medium">✓ Saved</span>}
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">What did you ship today?</label>
            <textarea rows={2} value={shipped} onChange={e => { setShipped(e.target.value); setSaved(false); }}
              placeholder="Launched the focus tool, fixed thumbnail modal…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Blockers / notes</label>
            <input value={blockers} onChange={e => { setBlockers(e.target.value); setSaved(false); }}
              placeholder="Waiting on design feedback, Stripe issue…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Tomorrow's #1 priority</label>
            <input value={tomorrow} onChange={e => { setTomorrow(e.target.value); setSaved(false); }}
              placeholder="Write landing page copy…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Mood</label>
            <div className="flex gap-2">
              {MOOD_OPTIONS.map(m => (
                <button key={m.value} onClick={() => { setMood(m.value); setSaved(false); }}
                  title={m.label}
                  className={`flex flex-col items-center gap-0.5 rounded-xl border-2 px-3 py-2 text-xl transition-all cursor-pointer ${mood === m.value ? "border-amber-400 bg-amber-50 scale-110" : "border-gray-200 bg-white hover:border-gray-300"}`}>
                  {m.emoji}
                  <span className="text-[9px] text-gray-500 font-medium">{m.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <button onClick={handleSave} disabled={!shipped.trim() && !tomorrow.trim()}
          className="w-full rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white font-semibold text-sm py-2.5 transition-colors cursor-pointer">
          Save check-in
        </button>
      </div>

      {recent.length > 0 && (
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Recent check-ins</p>
          <div className="space-y-2">
            {recent.map(c => (
              <div key={c.date} className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-gray-700">{fmtShort(c.date)}</span>
                  <span className="text-base">{MOOD_OPTIONS.find(m => m.value === c.mood)?.emoji}</span>
                </div>
                {c.shipped  && <p className="text-xs text-gray-600 leading-relaxed">🚢 {c.shipped}</p>}
                {c.tomorrow && <p className="text-xs text-gray-400 mt-0.5">→ {c.tomorrow}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Weekly Goals ─────────────────────────────────────────────────────────────
function WeekTab() {
  const weekStart = getWeekStart();
  const allWeeks  = load<WeekPlan[]>(WEEK_KEY, []);
  const existing  = allWeeks.find(w => w.weekStart === weekStart);
  const [goals, setGoals] = useState<WeekGoal[]>(
    existing?.goals ?? [
      { id: "g1", text: "", done: false },
      { id: "g2", text: "", done: false },
      { id: "g3", text: "", done: false },
    ]
  );
  const [saved, setSaved] = useState(!!existing);

  const persist = (next: WeekGoal[]) => {
    save(WEEK_KEY, [{ weekStart, goals: next }, ...allWeeks.filter(w => w.weekStart !== weekStart)].slice(0, 12));
  };

  const updateGoal = (id: string, patch: Partial<WeekGoal>) => {
    setGoals(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g));
    setSaved(false);
  };

  const toggle = (id: string) => {
    const next = goals.map(g => g.id === id ? { ...g, done: !g.done } : g);
    setGoals(next);
    persist(next);
    setSaved(true);
  };

  const handleSave = () => { persist(goals); setSaved(true); };

  const done  = goals.filter(g => g.done && g.text.trim()).length;
  const total = goals.filter(g => g.text.trim()).length;
  const weekEnd = new Date(weekStart + "T12:00:00");
  weekEnd.setDate(weekEnd.getDate() + 6);

  const pastWeeks = allWeeks.filter(w => w.weekStart !== weekStart).slice(0, 4);

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">🎯 This week</h3>
            <p className="text-xs text-gray-400 mt-0.5">{fmtShort(weekStart)} — {fmtShort(weekEnd.toISOString().slice(0, 10))}</p>
          </div>
          <div className="flex items-center gap-2">
            {total > 0 && (
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${done === total ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                {done}/{total}
              </span>
            )}
            {saved && <span className="text-xs text-green-600">✓</span>}
          </div>
        </div>

        <div className="space-y-2">
          {goals.map((g, i) => (
            <div key={g.id} className="flex items-center gap-3">
              <button onClick={() => g.text.trim() && toggle(g.id)}
                className={`shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors cursor-pointer ${g.done ? "border-green-500 bg-green-500" : "border-gray-300 hover:border-amber-400"}`}>
                {g.done && <span className="text-white text-[10px]">✓</span>}
              </button>
              <input value={g.text}
                onChange={e => updateGoal(g.id, { text: e.target.value })}
                placeholder={`Goal ${i + 1}…`}
                className={`flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${g.done ? "line-through text-gray-400" : ""}`} />
            </div>
          ))}
        </div>

        <button onClick={handleSave} disabled={!goals.some(g => g.text.trim())}
          className="w-full rounded-xl bg-gray-900 hover:bg-gray-700 disabled:opacity-40 text-white font-semibold text-sm py-2 transition-colors cursor-pointer">
          Save goals
        </button>
      </div>

      {pastWeeks.length > 0 && (
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Past weeks</p>
          <div className="space-y-3">
            {pastWeeks.map(w => {
              const d = w.goals.filter(g => g.done && g.text.trim()).length;
              const t = w.goals.filter(g => g.text.trim()).length;
              const we = new Date(w.weekStart + "T12:00:00");
              we.setDate(we.getDate() + 6);
              return (
                <div key={w.weekStart} className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-semibold text-gray-600">{fmtShort(w.weekStart)} — {fmtShort(we.toISOString().slice(0, 10))}</span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${t > 0 && d === t ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{d}/{t}</span>
                  </div>
                  <ul className="space-y-0.5">
                    {w.goals.filter(g => g.text.trim()).map(g => (
                      <li key={g.id} className={`text-xs ${g.done ? "text-gray-400 line-through" : "text-gray-600"}`}>
                        {g.done ? "✓" : "·"} {g.text}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Ship Log ─────────────────────────────────────────────────────────────────
function ShipsTab() {
  const [ships, setShips] = useState<ShipEntry[]>(() => load<ShipEntry[]>(SHIPS_KEY, []));
  const [title, setTitle] = useState("");
  const [desc,  setDesc]  = useState("");
  const [type,  setType]  = useState<ShipEntry["type"]>("feature");

  const addEntry = () => {
    if (!title.trim()) return;
    const entry: ShipEntry = {
      id: crypto.randomUUID(), title: title.trim(), description: desc.trim(),
      type, shippedAt: new Date().toISOString(),
    };
    const next = [entry, ...ships].slice(0, 200);
    setShips(next); save(SHIPS_KEY, next);
    setTitle(""); setDesc("");
  };

  const remove = (id: string) => {
    const next = ships.filter(s => s.id !== id);
    setShips(next); save(SHIPS_KEY, next);
  };

  const byType = SHIP_TYPES.map(t => ({
    ...t,
    count: ships.filter(s => s.type === t.value).length,
  }));

  return (
    <div className="space-y-5">
      {/* Stats bar */}
      {ships.length > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {byType.map(t => (
            <div key={t.value} className="rounded-xl px-3 py-2.5 text-center bg-gray-50">
              <p className="text-lg font-bold text-gray-900">{t.count}</p>
              <p className={`text-[10px] font-semibold ${t.color}`}>{t.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Add form */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">🚢 Log a ship</h3>
        <div className="flex gap-2">
          <input value={title} onChange={e => setTitle(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addEntry()}
            placeholder="What did you ship?"
            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
          <select value={type} onChange={e => setType(e.target.value as ShipEntry["type"])}
            className="rounded-lg border border-gray-200 px-2 py-2 text-sm focus:outline-none bg-white">
            {SHIP_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <button onClick={addEntry} disabled={!title.trim()}
            className="shrink-0 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white font-semibold text-sm px-4 py-2 cursor-pointer transition-colors">
            Log
          </button>
        </div>
        <input value={desc} onChange={e => setDesc(e.target.value)}
          placeholder="Short description (optional)"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
      </div>

      {/* Entries */}
      {ships.length === 0
        ? <p className="text-sm text-gray-400 text-center py-12">Nothing logged yet — ship something!</p>
        : (
          <div className="space-y-2">
            {ships.map(s => {
              const badge = SHIP_TYPES.find(t => t.value === s.type)!;
              return (
                <div key={s.id} className="flex items-start gap-2.5 rounded-xl border border-gray-200 bg-white px-3 py-2.5 group">
                  <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full mt-0.5 ${badge.color}`}>{badge.label}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 leading-tight">{s.title}</p>
                    {s.description && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{s.description}</p>}
                    <p className="text-[10px] text-gray-400 mt-1">
                      {new Date(s.shippedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                  <button onClick={() => remove(s.id)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 cursor-pointer transition-opacity mt-0.5">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )
      }
    </div>
  );
}

// ─── Habits ───────────────────────────────────────────────────────────────────
function HabitsTab() {
  const [habits,   setHabits]   = useState<HabitDef[]>(() => load<HabitDef[]>(HABITS_KEY, DEFAULT_HABITS));
  const [done,     setDone]     = useState<Set<string>>(() => new Set(load<string[]>(HABIT_DONE_KEY, [])));
  const [editMode, setEditMode] = useState(false);
  const today = todayStr();
  const days  = last21Days();

  const toggle = (habitId: string, date: string) => {
    const key = `${habitId}:${date}`;
    setDone(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      save(HABIT_DONE_KEY, [...next]);
      return next;
    });
  };

  const streak = (habitId: string): number => {
    let count = 0;
    const d = new Date();
    while (true) {
      const ds = d.toISOString().slice(0, 10);
      if (!done.has(`${habitId}:${ds}`)) break;
      count++;
      d.setDate(d.getDate() - 1);
    }
    return count;
  };

  const addHabit = () => {
    const next = [...habits, { id: crypto.randomUUID(), name: "New habit", emoji: "⭐" }];
    setHabits(next); save(HABITS_KEY, next);
  };
  const updateHabit = (id: string, patch: Partial<HabitDef>) => {
    const next = habits.map(h => h.id === id ? { ...h, ...patch } : h);
    setHabits(next); save(HABITS_KEY, next);
  };
  const removeHabit = (id: string) => {
    const next = habits.filter(h => h.id !== id);
    setHabits(next); save(HABITS_KEY, next);
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">🔥 Habits — last 21 days</h3>
        <button onClick={() => setEditMode(e => !e)}
          className="text-xs text-gray-400 hover:text-gray-700 cursor-pointer transition-colors">
          {editMode ? "Done" : "Edit habits"}
        </button>
      </div>

      {editMode ? (
        <div className="space-y-2">
          {habits.map(h => (
            <div key={h.id} className="flex items-center gap-2">
              <input value={h.emoji} onChange={e => updateHabit(h.id, { emoji: e.target.value })}
                className="w-10 rounded border border-gray-200 px-1.5 py-1 text-center text-base focus:outline-none" />
              <input value={h.name} onChange={e => updateHabit(h.id, { name: e.target.value })}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
              <button onClick={() => removeHabit(h.id)} className="text-gray-300 hover:text-red-400 cursor-pointer">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
          <button onClick={addHabit} className="text-xs text-amber-600 hover:text-amber-800 cursor-pointer font-medium">+ Add habit</button>
        </div>
      ) : (
        <div className="space-y-4">
          {habits.map(h => {
            const s = streak(h.id);
            return (
              <div key={h.id} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button onClick={() => toggle(h.id, today)}
                      className={`w-7 h-7 rounded-lg border-2 flex items-center justify-center text-base transition-all cursor-pointer ${done.has(`${h.id}:${today}`) ? "border-amber-400 bg-amber-50" : "border-gray-200 hover:border-amber-300 bg-white"}`}>
                      {h.emoji}
                    </button>
                    <span className="text-sm text-gray-800 font-medium">{h.name}</span>
                  </div>
                  {s > 0 && <span className="text-[11px] font-semibold text-amber-600">{s}🔥 streak</span>}
                </div>
                <div className="flex gap-0.5 pl-9">
                  {days.map(d => {
                    const isToday = d === today;
                    const isDone  = done.has(`${h.id}:${d}`);
                    return (
                      <button key={d} onClick={() => toggle(h.id, d)} title={d}
                        className={`w-4 h-4 rounded-sm cursor-pointer transition-colors ${isDone ? "bg-amber-400" : isToday ? "bg-gray-200 ring-1 ring-amber-300" : "bg-gray-100 hover:bg-gray-200"}`} />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Commitments ─────────────────────────────────────────────────────────────
function CommitmentsTab() {
  const [commits, setCommits] = useState<Commitment[]>(() => load<Commitment[]>(COMMITS_KEY, []));
  const [text,    setText]    = useState("");
  const [due,     setDue]     = useState("");

  const add = () => {
    if (!text.trim()) return;
    const entry: Commitment = {
      id: crypto.randomUUID(), text: text.trim(), dueDate: due,
      status: "active", createdAt: new Date().toISOString(),
    };
    const next = [entry, ...commits];
    setCommits(next); save(COMMITS_KEY, next);
    setText(""); setDue("");
  };

  const setStatus = (id: string, status: Commitment["status"]) => {
    const next = commits.map(c => c.id === id
      ? { ...c, status, completedAt: status !== "active" ? new Date().toISOString() : undefined }
      : c
    );
    setCommits(next); save(COMMITS_KEY, next);
  };

  const remove = (id: string) => {
    const next = commits.filter(c => c.id !== id);
    setCommits(next); save(COMMITS_KEY, next);
  };

  const active = commits.filter(c => c.status === "active");
  const closed = commits.filter(c => c.status !== "active");

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900">🤝 New commitment</h3>
        <div className="space-y-2">
          <input value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === "Enter" && add()}
            placeholder="I will ship ___ by ___"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
          <div className="flex gap-2">
            <input type="date" value={due} onChange={e => setDue(e.target.value)}
              className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none" />
            <button onClick={add} disabled={!text.trim()}
              className="shrink-0 rounded-lg bg-gray-900 hover:bg-gray-700 disabled:opacity-40 text-white font-semibold text-sm px-4 py-2 cursor-pointer transition-colors">
              Commit
            </button>
          </div>
        </div>
      </div>

      {active.length === 0 && closed.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-12">No commitments yet. Make one — missed ones stay visible.</p>
      )}

      {active.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Active</p>
          {active.map(c => (
            <div key={c.id} className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{c.text}</p>
                  {c.dueDate && <p className="text-xs text-blue-600 mt-0.5">Due {fmtShort(c.dueDate)}</p>}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => setStatus(c.id, "done")}
                    className="text-[11px] bg-green-100 hover:bg-green-200 text-green-700 font-medium rounded px-2 py-1 cursor-pointer transition-colors">Done ✓</button>
                  <button onClick={() => setStatus(c.id, "missed")}
                    className="text-[11px] bg-red-100 hover:bg-red-200 text-red-700 font-medium rounded px-2 py-1 cursor-pointer transition-colors">Missed</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Closed</p>
          {closed.map(c => (
            <div key={c.id} className={`rounded-xl border px-3 py-2 flex items-center justify-between gap-2 ${c.status === "done" ? "border-green-200 bg-green-50 opacity-70" : "border-red-200 bg-red-50 opacity-60"}`}>
              <div>
                <p className="text-sm text-gray-700">{c.status === "done" ? "✅" : "❌"} {c.text}</p>
                {c.completedAt && <p className="text-[10px] text-gray-400 mt-0.5">{fmtShort(c.completedAt.slice(0, 10))}</p>}
              </div>
              <button onClick={() => remove(c.id)} className="text-gray-300 hover:text-red-400 cursor-pointer shrink-0">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
function MetricsTab() {
  const checkIns = load<DailyCheckIn[]>(CHECKIN_KEY, []);
  const ships    = load<ShipEntry[]>(SHIPS_KEY, []);
  const commits  = load<Commitment[]>(COMMITS_KEY, []);
  const habits   = load<HabitDef[]>(HABITS_KEY, DEFAULT_HABITS);
  const donePx   = new Set(load<string[]>(HABIT_DONE_KEY, []));

  // Last 30 days
  const last30 = (() => {
    const days: string[] = [];
    const d = new Date();
    for (let i = 29; i >= 0; i--) {
      const dd = new Date(d);
      dd.setDate(dd.getDate() - i);
      days.push(dd.toISOString().slice(0, 10));
    }
    return days;
  })();

  const checkInMap = Object.fromEntries(checkIns.map(c => [c.date, c]));

  // Mood trend (last 14 check-ins)
  const moodData = checkIns.slice(0, 14).reverse();

  // Habit completion rate last 30 days per habit
  const habitStats = habits.map(h => {
    const done = last30.filter(d => donePx.has(`${h.id}:${d}`)).length;
    return { ...h, done, pct: Math.round((done / 30) * 100) };
  });

  // Ships by type (all time)
  const shipsByType = SHIP_TYPES.map(t => ({
    ...t,
    count: ships.filter(s => s.type === t.value).length,
  }));

  // Commitment rate
  const totalCommits = commits.length;
  const doneCommits  = commits.filter(c => c.status === "done").length;
  const missedCommits = commits.filter(c => c.status === "missed").length;
  const commitRate = totalCommits > 0 ? Math.round((doneCommits / totalCommits) * 100) : null;

  // Check-in streak
  const today = todayStr();
  let checkInStreak = 0;
  const d = new Date();
  while (true) {
    const ds = d.toISOString().slice(0, 10);
    if (!checkInMap[ds]) break;
    checkInStreak++;
    d.setDate(d.getDate() - 1);
  }

  // Ships last 30 days
  const recentShips = ships.filter(s => s.shippedAt.slice(0, 10) >= last30[0]).length;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-center">
          <p className="text-2xl font-bold text-amber-600">{checkInStreak}</p>
          <p className="text-xs text-gray-500 mt-1">Check-in streak</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-center">
          <p className="text-2xl font-bold text-gray-900">{ships.length}</p>
          <p className="text-xs text-gray-500 mt-1">Total ships</p>
          <p className="text-[10px] text-gray-400">{recentShips} last 30 days</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-center">
          <p className="text-2xl font-bold text-gray-900">{commitRate !== null ? `${commitRate}%` : "—"}</p>
          <p className="text-xs text-gray-500 mt-1">Commitment rate</p>
          <p className="text-[10px] text-gray-400">{doneCommits}✓ {missedCommits}✗ of {totalCommits}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-center">
          <p className="text-2xl font-bold text-gray-900">{checkIns.length}</p>
          <p className="text-xs text-gray-500 mt-1">Total check-ins</p>
        </div>
      </div>

      {/* Mood trend */}
      {moodData.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Mood — last check-ins</p>
          <div className="flex items-end gap-1.5 h-16">
            {moodData.map(c => {
              const h = (c.mood / 5) * 100;
              const colors = ["", "bg-red-300", "bg-orange-300", "bg-gray-300", "bg-green-300", "bg-amber-400"];
              return (
                <div key={c.date} className="flex-1 flex flex-col items-center gap-1" title={`${fmtShort(c.date)}: ${MOOD_OPTIONS.find(m => m.value === c.mood)?.label}`}>
                  <div className={`w-full rounded-sm ${colors[c.mood]} transition-all`} style={{ height: `${h}%` }} />
                  <span className="text-[8px] text-gray-400">{c.date.slice(5)}</span>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-2 text-[9px] text-gray-300">
            <span>Older</span><span>Recent</span>
          </div>
        </div>
      )}

      {/* Habit completion rates */}
      {habitStats.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Habit completion — last 30 days</p>
          {habitStats.map(h => (
            <div key={h.id} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-800">{h.emoji} {h.name}</span>
                <span className="text-xs font-semibold text-gray-500">{h.done}/30 · {h.pct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className={`h-full rounded-full ${h.pct >= 70 ? "bg-amber-400" : h.pct >= 40 ? "bg-amber-200" : "bg-gray-300"}`}
                  style={{ width: `${h.pct}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Ships breakdown */}
      {ships.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Ships by type</p>
          <div className="grid grid-cols-5 gap-2">
            {shipsByType.map(t => (
              <div key={t.value} className="rounded-xl border border-gray-100 bg-gray-50 p-2.5 text-center">
                <p className="text-xl font-bold text-gray-900">{t.count}</p>
                <p className={`text-[10px] font-semibold ${t.color}`}>{t.label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily heatmap — last 30 days */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Check-in heatmap — last 30 days</p>
        <div className="flex gap-1 flex-wrap">
          {last30.map(d => {
            const ci = checkInMap[d];
            const isToday = d === today;
            const moodColors: Record<number, string> = {
              1: "bg-red-200", 2: "bg-orange-200", 3: "bg-gray-200",
              4: "bg-green-200", 5: "bg-amber-400",
            };
            return (
              <div key={d} title={ci ? `${fmtShort(d)}: ${MOOD_OPTIONS.find(m => m.value === ci.mood)?.label}` : fmtShort(d)}
                className={`w-7 h-7 rounded flex items-center justify-center text-xs ${ci ? (moodColors[ci.mood] ?? "bg-gray-200") : isToday ? "bg-gray-100 ring-1 ring-amber-300" : "bg-gray-50 border border-gray-100"}`}>
                {ci ? MOOD_OPTIONS.find(m => m.value === ci.mood)?.emoji : <span className="text-gray-300 text-[10px]">{d.slice(8)}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {(checkIns.length === 0 && ships.length === 0) && (
        <p className="text-sm text-gray-400 text-center py-12">No data yet — start with a daily check-in.</p>
      )}
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
type FocusTab = "daily" | "week" | "ships" | "habits" | "commitments" | "metrics";

const TABS: { id: FocusTab; label: string; icon: string }[] = [
  { id: "daily",       label: "Daily",       icon: "🌅" },
  { id: "week",        label: "Week",         icon: "🎯" },
  { id: "ships",       label: "Ship log",     icon: "🚢" },
  { id: "habits",      label: "Habits",       icon: "🔥" },
  { id: "commitments", label: "Commitments",  icon: "🤝" },
  { id: "metrics",     label: "Metrics",      icon: "📊" },
];

export default function App() {
  const [tab, setTab] = useState<FocusTab>("daily");

  return (
    <PageShell>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Focus</h1>
        <p className="text-sm text-gray-400 mt-0.5">Personal founder accountability</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1 mb-6">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${tab === t.id ? "bg-white text-amber-700 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}>
            <span>{t.icon}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "daily"       && <DailyTab />}
      {tab === "week"        && <WeekTab />}
      {tab === "ships"       && <ShipsTab />}
      {tab === "habits"      && <HabitsTab />}
      {tab === "commitments" && <CommitmentsTab />}
      {tab === "metrics"     && <MetricsTab />}
    </PageShell>
  );
}
