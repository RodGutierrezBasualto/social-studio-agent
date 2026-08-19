import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { scheduleStore, useScheduledPosts, type ScheduledPost } from "@/lib/schedule-store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { PostEditor } from "@/components/post-editor";

export const Route = createFileRoute("/calendario")({
  head: () => ({
    meta: [
      { title: "Calendar · Social Studio" },
      { name: "description", content: "Editorial calendar." },
    ],
  }),
  component: CalendarPage,
});

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfMonthGrid(d: Date) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  start.setHours(0, 0, 0, 0);
  return start;
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function platformColor(p: string) {
  switch (p) {
    case "linkedin":
      return "bg-blue-100 text-blue-900 border-blue-200";
    case "instagram":
      return "bg-pink-100 text-pink-900 border-pink-200";
    case "tiktok":
      return "bg-zinc-200 text-zinc-900 border-zinc-300";
    case "x":
      return "bg-neutral-200 text-neutral-900 border-neutral-300";
    case "facebook":
      return "bg-indigo-100 text-indigo-900 border-indigo-200";
    default:
      return "bg-muted text-foreground border-border";
  }
}

function CalendarPage() {
  const items = useScheduledPosts();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const gridStart = useMemo(() => startOfMonthGrid(cursor), [cursor]);
  const days = useMemo(
    () =>
      Array.from({ length: 42 }, (_, i) => {
        const d = new Date(gridStart);
        d.setDate(gridStart.getDate() + i);
        return d;
      }),
    [gridStart],
  );

  // Drafts awaiting approval (or rejected) never show on the calendar.
  const scheduled = items.filter(
    (i) => i.scheduledAt !== null && i.status !== "pending_approval" && i.status !== "rejected",
  );
  const drafts = items.filter((i) => i.scheduledAt === null);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, ScheduledPost[]>();
    scheduled.forEach((s) => {
      const d = new Date(s.scheduledAt!);
      const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const arr = map.get(k) ?? [];
      arr.push(s);
      map.set(k, arr);
    });
    return map;
  }, [scheduled]);

  const onDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDrop = (e: React.DragEvent, day: Date) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    if (!id) return;
    const existing = scheduleStore.getAll().find((p) => p.id === id);
    const base = existing?.scheduledAt ? new Date(existing.scheduledAt) : new Date();
    const d = new Date(day);
    d.setHours(base.getHours(), base.getMinutes(), 0, 0);
    scheduleStore.reschedule(id, d.getTime());
    setDragOver(null);
  };

  const sel = items.find((i) => i.id === selected) ?? null;

  return (
    <div className="px-6 py-10 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Calendar</p>
          <h1 className="mt-2 font-serif text-4xl">
            {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setCursor((d) => {
                const n = new Date(d);
                n.setMonth(n.getMonth() - 1);
                return n;
              })
            }
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const d = new Date();
              d.setDate(1);
              setCursor(d);
            }}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setCursor((d) => {
                const n = new Date(d);
                n.setMonth(n.getMonth() + 1);
                return n;
              })
            }
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_280px] gap-6">
        <div className="rounded-lg border border-border overflow-hidden bg-card">
          <div className="grid grid-cols-7 border-b border-border bg-muted/50">
            {DAYS.map((d) => (
              <div
                key={d}
                className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground"
              >
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 grid-rows-6">
            {days.map((day) => {
              const k = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
              const dayItems = itemsByDay.get(k) ?? [];
              const inMonth = day.getMonth() === cursor.getMonth();
              const isToday = sameDay(day, today);
              const isOver = dragOver === k;
              return (
                <div
                  key={k}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(k);
                  }}
                  onDragLeave={() => setDragOver((v) => (v === k ? null : v))}
                  onDrop={(e) => onDrop(e, day)}
                  className={`min-h-[110px] border-r border-b border-border p-1.5 space-y-1 transition-colors ${
                    inMonth ? "bg-background" : "bg-muted/30"
                  } ${isOver ? "bg-accent/10 ring-1 ring-accent inset" : ""}`}
                >
                  <div
                    className={`text-xs ${isToday ? "font-bold text-accent" : inMonth ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {day.getDate()}
                  </div>
                  {dayItems.map((it) => (
                    <button
                      key={it.id}
                      draggable
                      onDragStart={(e) => onDragStart(e, it.id)}
                      onClick={() => setSelected(it.id)}
                      className={`w-full text-left text-[11px] leading-tight rounded border px-1.5 py-1 cursor-grab active:cursor-grabbing ${platformColor(it.post.platform)} ${it.status === "published" ? "opacity-60 line-through" : ""}`}
                    >
                      <div className="font-medium capitalize">
                        {it.post.platform} ·{" "}
                        {new Date(it.scheduledAt!).toLocaleTimeString("en-US", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                      <div className="truncate text-foreground/80">
                        {it.post.caption.slice(0, 50)}
                      </div>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Summary</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Scheduled</span>
                <Badge variant="secondary">
                  {scheduled.filter((s) => s.status === "scheduled").length}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span>Drafts</span>
                <Badge variant="secondary">{drafts.length}</Badge>
              </div>
              <div className="flex justify-between">
                <span>Published</span>
                <Badge variant="secondary">
                  {items.filter((i) => i.status === "published").length}
                </Badge>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
              Unscheduled drafts
            </p>
            {drafts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Empty.{" "}
                <Link to="/crear" className="underline">
                  Create a post
                </Link>{" "}
                and save it as a draft.
              </p>
            ) : (
              <ul className="space-y-2">
                {drafts.map((d) => (
                  <li
                    key={d.id}
                    draggable
                    onDragStart={(e) => onDragStart(e, d.id)}
                    onClick={() => setSelected(d.id)}
                    className={`text-xs rounded border px-2 py-1.5 cursor-grab active:cursor-grabbing ${platformColor(d.post.platform)}`}
                  >
                    <div className="font-medium capitalize">{d.post.platform}</div>
                    <div className="truncate text-foreground/80">{d.post.caption.slice(0, 60)}</div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">
              Drag them onto a day in the calendar.
            </p>
          </div>

          <Link to="/crear" className="block">
            <Button variant="outline" className="w-full gap-2">
              <Sparkles className="h-4 w-4" /> Create post
            </Button>
          </Link>
        </aside>
      </div>

      <Sheet open={!!sel} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {sel && (
            <>
              <SheetHeader>
                <SheetTitle className="font-serif text-2xl capitalize">
                  {sel.post.platform}
                </SheetTitle>
              </SheetHeader>
              <div className="mt-4">
                <PostEditor item={sel} onClose={() => setSelected(null)} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
